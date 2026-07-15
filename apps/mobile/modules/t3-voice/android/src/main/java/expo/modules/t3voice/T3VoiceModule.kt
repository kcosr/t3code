package expo.modules.t3voice

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import java.time.Instant
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class T3VoiceModule : Module() {
  @Volatile private var binder: T3VoiceRuntimeService.VoiceBinder? = null
  @Volatile private var serviceBound = false
  @Volatile private var destroyed = false
  private val binderLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  // Android media APIs require a Looper even though Binder work must stay off the main thread.
  private val binderOperationThread = HandlerThread("t3-voice-binder").apply { start() }
  private val binderOperationHandler = Handler(binderOperationThread.looper)
  // Stop commands must be able to cancel a synchronous start that is blocked on its Binder lane.
  private val binderInterruptThread = HandlerThread("t3-voice-binder-interrupt").apply { start() }
  private val binderInterruptHandler = Handler(binderInterruptThread.looper)
  private val binderOperationDispatcher =
    T3VoiceBinderOperationDispatcher(
      orderedPost = binderOperationHandler::post,
      interruptPost = binderInterruptHandler::post,
    )
  private val pendingBinderOperations = T3VoiceBinderOperationRegistry<PendingBinderOperation>()
  private val bindingRealtimeOwner = T3VoiceBindingRealtimeOwnerPolicy()
  private var stateCollection: Job? = null
  private var eventCollection: Job? = null
  private var recordingTerminationCollection: Job? = null
  private var playbackTerminationCollection: Job? = null
  private var realtimeTerminationCollection: Job? = null
  private var threadVoiceHandoffCollection: Job? = null
  private var voiceCommandCollection: Job? = null
  private var rebindScheduled = false
  private var rebindAttemptedSinceConnection = false
  private var registeredControllerGeneration: Long? = null

  private class PendingBinderOperation(
    val promise: Promise,
    val errorCode: String,
    val lane: T3VoiceBinderOperationLane,
    val ordering: T3VoiceBinderOperationOrdering?,
    val operation: (
      T3VoiceRuntimeService.VoiceBinder,
      BinderSettlement,
      T3VoiceBinderOperationAdmission,
    ) -> Unit,
  ) {
    lateinit var ticket: T3VoiceBinderOperationRegistry.Ticket
    var timeout: Runnable? = null
  }

  private inner class BinderSettlement(
    private val pending: PendingBinderOperation,
    private val binderGeneration: Long,
  ) {
    fun resolve(value: Any? = null) {
      if (completePending(pending, binderGeneration)) pending.promise.resolve(value)
    }

    fun reject(code: String, message: String, cause: Throwable? = null) {
      if (!completePending(pending, binderGeneration)) return
      pending.promise.reject(code, message, cause)
    }
  }

  private val serviceConnection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        val connectedBinder = service as? T3VoiceRuntimeService.VoiceBinder ?: return
        val (bindingGeneration, dispatches) =
          synchronized(binderLock) {
            if (destroyed) return
            val generation = bindingRealtimeOwner.connected()
            binder = connectedBinder
            bindingRealtimeOwner.observe(
              generation,
              connectedBinder.state.value.activeRealtimeSessionId,
            )
            rebindScheduled = false
            rebindAttemptedSinceConnection = false
            generation to pendingBinderOperations.connected()
          }
        dispatches.forEach { dispatch ->
          cancelBinderTimeout(dispatch.value)
          scheduleBinderOperation(connectedBinder, dispatch)
        }
        stateCollection?.cancel()
        stateCollection =
          appContext.mainQueue.launch {
            connectedBinder.state.collectLatest { state ->
              synchronized(binderLock) {
                if (binder === connectedBinder) {
                  bindingRealtimeOwner.observe(bindingGeneration, state.activeRealtimeSessionId)
                }
              }
              sendEvent(STATE_CHANGED_EVENT, state.toEventBody())
            }
          }
        eventCollection?.cancel()
        eventCollection =
          appContext.mainQueue.launch {
            connectedBinder.events.collect { event ->
              when (event) {
                is T3VoiceRuntimeEvent.PlaybackChunkConsumed ->
                  sendEvent(PLAYBACK_CHUNK_CONSUMED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.PlaybackTerminated -> Unit
                is T3VoiceRuntimeEvent.RecordingTerminated -> Unit
                is T3VoiceRuntimeEvent.RuntimeError ->
                  sendEvent(RUNTIME_ERROR_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.AudioRouteChanged ->
                  sendEvent(AUDIO_ROUTE_CHANGED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.RealtimeTerminated ->
                  sendEvent(REALTIME_TERMINATED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.ThreadVoiceHandoff -> Unit
                is T3VoiceRuntimeEvent.ReadinessDisabled ->
                  sendEvent(READINESS_DISABLED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.VoiceRuntimeWake ->
                  sendEvent(VOICE_RUNTIME_WAKE_EVENT, event.toEventBody())
              }
            }
          }
        recordingTerminationCollection?.cancel()
        recordingTerminationCollection =
          appContext.mainQueue.launch {
            connectedBinder.recordingTermination.collectLatest { event ->
              if (event != null) sendEvent(RECORDING_TERMINATED_EVENT, event.toEventBody())
            }
          }
        playbackTerminationCollection?.cancel()
        playbackTerminationCollection =
          appContext.mainQueue.launch {
            connectedBinder.playbackTermination.collectLatest { event ->
              if (event != null) sendEvent(PLAYBACK_TERMINATED_EVENT, event.toEventBody())
            }
          }
        realtimeTerminationCollection?.cancel()
        realtimeTerminationCollection =
          appContext.mainQueue.launch {
            connectedBinder.realtimeTermination.collectLatest { event ->
              if (event != null) sendEvent(REALTIME_TERMINATED_EVENT, event.toEventBody())
            }
          }
        threadVoiceHandoffCollection?.cancel()
        threadVoiceHandoffCollection =
          appContext.mainQueue.launch {
            connectedBinder.threadVoiceHandoff.collectLatest { event ->
              if (event != null) sendEvent(THREAD_VOICE_HANDOFF_EVENT, event.toEventBody())
            }
          }
        voiceCommandCollection?.cancel()
        voiceCommandCollection =
          appContext.mainQueue.launch {
            connectedBinder.voiceCommands.collectLatest { command ->
              if (command != null) sendEvent(VOICE_COMMAND_EVENT, command.toEventBody())
            }
          }
      }

      override fun onServiceDisconnected(name: ComponentName?) {
        handleBindingLoss(
          "The T3 voice runtime service disconnected during the operation.",
          rebind = false,
        )
      }

      override fun onBindingDied(name: ComponentName?) {
        handleBindingLoss(
          "The T3 voice runtime service binding died during the operation.",
          rebind = true,
        )
      }

      override fun onNullBinding(name: ComponentName?) {
        handleBindingLoss(
          "The T3 voice runtime service returned an invalid binding.",
          rebind = true,
        )
      }
    }

  override fun definition() =
    ModuleDefinition {
      Name(MODULE_NAME)
      Events(
        STATE_CHANGED_EVENT,
        PLAYBACK_CHUNK_CONSUMED_EVENT,
        PLAYBACK_TERMINATED_EVENT,
        RECORDING_TERMINATED_EVENT,
        RUNTIME_ERROR_EVENT,
        AUDIO_ROUTE_CHANGED_EVENT,
        REALTIME_TERMINATED_EVENT,
        THREAD_VOICE_HANDOFF_EVENT,
        VOICE_COMMAND_EVENT,
        READINESS_DISABLED_EVENT,
        VOICE_RUNTIME_WAKE_EVENT,
      )

      Constants(
        "nativeRevision" to 14,
      )

      OnCreate {
        synchronized(binderLock) {
          destroyed = false
          rebindScheduled = false
          rebindAttemptedSinceConnection = false
        }
        val context = appContext.reactContext ?: return@OnCreate
        val intent = Intent(context, T3VoiceRuntimeService::class.java)
        serviceBound = context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
      }

      OnDestroy {
        destroyed = true
        cancelCollections()
        val context = appContext.reactContext
        val connectedBinder = binder
        registeredControllerGeneration?.let { generation ->
          connectedBinder?.unregisterVoiceController(generation)
        }
        registeredControllerGeneration = null
        val pending = synchronized(binderLock) { pendingBinderOperations.destroy() }
        pending.forEach { entry ->
          rejectPendingOperation(
            entry.value,
            "The T3 voice module was destroyed before the operation completed.",
          )
        }
        if (serviceBound && context != null) {
          runCatching { context.unbindService(serviceConnection) }
        }
        synchronized(binderLock) { binder = null }
        serviceBound = false
        binderOperationHandler.removeCallbacksAndMessages(null)
        binderInterruptHandler.removeCallbacksAndMessages(null)
        binderOperationThread.quitSafely()
        binderInterruptThread.quitSafely()
      }

      AsyncFunction("getMediaCapabilitiesAsync") {
        mapOf(
          "microphone" to true,
          "boundedRecording" to true,
          "automaticEndpointDetection" to true,
          "orderedPcmPlayback" to true,
          "realtimeWebRtc" to true,
          "bluetoothRouting" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
        )
      }

      AsyncFunction("getStateAsync") {
        T3VoiceStateStore.state.value.toEventBody()
      }

      AsyncFunction("describeVoiceRuntimeAsync") {
        VoiceRuntimeBridge.descriptorBody()
      }

      AsyncFunction("getVoiceRuntimeSnapshotAsync") { promise: Promise ->
        withBinder(promise, "voice-runtime-snapshot-failed") { service, settlement ->
          settlement.resolve(VoiceRuntimeBridge.snapshotBody(service.voiceRuntimeSnapshot()))
        }
      }

      AsyncFunction("prepareVoiceRuntimeAuthorityAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        val (readiness, preparation) = parseAuthorityPreparation(input)
        withBinder(promise, "voice-runtime-authority-prepare-failed") { service, settlement ->
          val result = service.prepareVoiceRuntimeAuthority(readiness, preparation)
          settlement.resolve(authorityPreparationBody(result))
        }
      }

      AsyncFunction("inspectVoiceRuntimeAuthorityAsync") {
        promise: Promise,
        ->
        withBinder(promise, "voice-runtime-authority-inspection-failed") { service, settlement ->
          settlement.resolve(
            service.inspectVoiceRuntimeAuthority()?.let(::authorityInspectionBody),
          )
        }
      }

      AsyncFunction("configureVoiceRuntimeAuthorityAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        val authority = VoiceRuntimeBridge.parseAuthority(input)
        withBinder(promise, "voice-runtime-authority-failed") { service, settlement ->
          settlement.resolve(
            VoiceRuntimeBridge.snapshotBody(
              service.configureVoiceRuntimeAuthority(authority),
            ),
          )
        }
      }

      AsyncFunction("clearVoiceRuntimeAuthorityAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        val (commandId, identity) = VoiceRuntimeBridge.parseAuthorityClear(input)
        withBinder(promise, "voice-runtime-authority-clear-failed") { service, settlement ->
          settlement.resolve(
            VoiceRuntimeBridge.snapshotBody(service.clearVoiceRuntimeAuthority(commandId, identity)),
          )
        }
      }

      AsyncFunction("attachVoiceRuntimeAsync") { input: Map<String, Any?>, promise: Promise ->
        requireExactKeys(
          input,
          setOf("runtimeId", "runtimeInstanceId", "generation", "presentation"),
        )
        withBinder(promise, "voice-runtime-attach-failed") { service, settlement ->
          val snapshot = service.voiceRuntimeSnapshot()
          check(requireText(input, "runtimeId", 192) == snapshot.identity.runtimeId)
          check(requireText(input, "runtimeInstanceId", 192) == snapshot.identity.runtimeInstanceId)
          check(requireLong(input, "generation") == snapshot.identity.generation)
          settlement.resolve(
            VoiceRuntimeBridge.leaseBody(
              service.attachVoiceRuntime(
                VoiceRuntimeBridge.parsePresentation(requireText(input, "presentation", 32)),
              ),
            ),
          )
        }
      }

      AsyncFunction("updateVoiceRuntimeAttachmentAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        requireExactKeys(input, setOf("lease", "presentation"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        val presentation =
          VoiceRuntimeBridge.parsePresentation(requireText(input, "presentation", 32))
        withBinder(promise, "voice-runtime-attachment-update-failed") { service, settlement ->
          settlement.resolve(
            VoiceRuntimeBridge.leaseBody(service.updateVoiceRuntimeAttachment(lease, presentation)),
          )
        }
      }

      AsyncFunction("detachVoiceRuntimeAsync") { input: Map<String, Any?>, promise: Promise ->
        withBinder(promise, "voice-runtime-detach-failed") { service, settlement ->
          service.detachVoiceRuntime(VoiceRuntimeBridge.parseLease(input))
          settlement.resolve()
        }
      }

      AsyncFunction("readVoiceRuntimeAsync") { input: Map<String, Any?>, promise: Promise ->
        requireExactKeys(input, setOf("lease", "after"))
        @Suppress("UNCHECKED_CAST")
        val leaseInput = input["lease"] as? Map<String, Any?>
          ?: error("lease must be an object.")
        @Suppress("UNCHECKED_CAST")
        val cursorInput = input["after"] as? Map<String, Any?>
        withBinder(promise, "voice-runtime-read-failed") { service, settlement ->
          settlement.resolve(
            VoiceRuntimeBridge.deliveryBody(
              service.readVoiceRuntime(
                VoiceRuntimeBridge.parseLease(leaseInput),
                cursorInput?.let(VoiceRuntimeBridge::parseCursor),
              ),
            ),
          )
        }
      }

      AsyncFunction("acknowledgeVoiceRuntimeAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        requireExactKeys(input, setOf("lease", "through"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        @Suppress("UNCHECKED_CAST")
        val through = VoiceRuntimeBridge.parseCursor(
          input["through"] as? Map<String, Any?> ?: error("through must be an object."),
        )
        withBinder(promise, "voice-runtime-acknowledgement-failed") { service, settlement ->
          service.acknowledgeVoiceRuntime(lease, through)
          settlement.resolve()
        }
      }

      AsyncFunction("acknowledgeVoiceRuntimeRetainedRecordAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        val (identity, key) = VoiceRuntimeBridge.parseRetainedRecordAcknowledgement(input)
        withBinder(promise, "voice-runtime-retained-acknowledgement-failed") {
          service, settlement,
          ->
          service.acknowledgeVoiceRuntimeRetainedRecord(identity, key)
          settlement.resolve()
        }
      }

      AsyncFunction("dispatchVoiceRuntimeAsync") { input: Map<String, Any?>, promise: Promise ->
        val command = VoiceRuntimeBridge.parseCommand(input)
        withBinderAdmission(
          promise,
          "voice-runtime-command-failed",
          T3VoiceBinderOperationLanePolicy.forCommand(command),
          T3VoiceBinderOperationLanePolicy.orderingForCommand(command),
        ) { service, settlement, admission ->
          settlement.resolve(
            VoiceRuntimeBridge.receiptBody(service.dispatchVoiceRuntime(command, admission)),
          )
        }
      }

      AsyncFunction("readVoiceRuntimeDraftArtifactAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        requireExactKeys(input, setOf("lease", "artifactId"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        val artifactId = requireText(input, "artifactId", 256)
        withBinder(promise, "voice-runtime-draft-read-failed") { service, settlement ->
          settlement.resolve(VoiceRuntimeBridge.draftBody(service.readVoiceRuntimeDraft(lease, artifactId)))
        }
      }

      AsyncFunction("acknowledgeVoiceRuntimeDraftArtifactAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        requireExactKeys(input, setOf("lease", "artifactId", "outcome"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        val outcome = requireText(input, "outcome", 32)
        require(outcome in setOf("appended", "discarded"))
        withBinder(promise, "voice-runtime-draft-ack-failed") { service, settlement ->
          service.acknowledgeVoiceRuntimeDraft(
            lease,
            requireText(input, "artifactId", 256),
            outcome,
          )
          settlement.resolve()
        }
      }

      AsyncFunction("claimVoiceRuntimePresentationActionAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        requireExactKeys(input, setOf("lease", "actionId"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        withBinder(promise, "voice-runtime-action-claim-failed") { service, settlement ->
          settlement.resolve(VoiceRuntimeBridge.presentationActionBody(
            service.claimVoiceRuntimePresentationAction(
              lease,
              requireText(input, "actionId", 256),
            ),
          ))
        }
      }

      AsyncFunction("acknowledgeVoiceRuntimePresentationActionAsync") {
        input: Map<String, Any?>, promise: Promise,
        ->
        require(input.keys == setOf("lease", "actionId", "outcome") ||
          input.keys == setOf("lease", "actionId", "outcome", "message"))
        @Suppress("UNCHECKED_CAST")
        val lease = VoiceRuntimeBridge.parseLease(
          input["lease"] as? Map<String, Any?> ?: error("lease must be an object."),
        )
        val outcome = requireText(input, "outcome", 32)
        require(outcome in setOf("succeeded", "failed"))
        input["message"]?.let { require(it is String && it.isNotBlank() && it.length <= 512) }
        withBinder(promise, "voice-runtime-action-ack-failed") { service, settlement ->
          service.acknowledgeVoiceRuntimePresentationAction(
            lease,
            requireText(input, "actionId", 256),
            outcome,
            input["message"] as? String,
          )
          settlement.resolve()
        }
      }

      AsyncFunction("disableVoiceRuntimeReadinessAsync") { promise: Promise ->
        withBinder(promise, "voice-readiness-disable-failed") { service, settlement ->
          service.disableRuntimeVoiceReadiness()
          settlement.resolve(VoiceRuntimeBridge.snapshotBody(service.voiceRuntimeSnapshot()))
        }
      }

      AsyncFunction("clearVoiceRuntimeAuthorityIfIdleAsync") {
        input: Map<String, Any?>,
        promise: Promise,
        ->
        requireExactKeys(input, setOf("runtimeId", "generation"))
        val runtimeId = input["runtimeId"]?.let { requireText(input, "runtimeId", 128) }
        val generation = optionalLong(input, "generation")
        withBinder(promise, "voice-readiness-disable-failed") { service, settlement ->
          settlement.resolve(
            service.disableRuntimeVoiceReadinessIfIdle(runtimeId, generation)?.let {
              VoiceRuntimeBridge.snapshotBody(service.voiceRuntimeSnapshot())
            },
          )
        }
      }

      AsyncFunction("getPendingVoiceRuntimeAuthorityRevocationAsync") { promise: Promise ->
        withBinder(promise, "voice-runtime-revocation-read-failed") { service, settlement ->
          settlement.resolve(service.pendingRuntimeRevocation()?.let(::runtimeRevocationBody))
        }
      }

      AsyncFunction("getVoiceRuntimeOwnershipAsync") { promise: Promise ->
        withBinder(promise, "voice-ownership-read-failed") { service, settlement ->
          settlement.resolve(service.runtimeVoiceOwnership())
        }
      }

      AsyncFunction("acknowledgeVoiceRuntimeAuthorityRevocationAsync") {
        input: Map<String, Any?>,
        promise: Promise,
        ->
        requireExactKeys(input, setOf("runtimeId", "environmentOrigin"))
        val expected =
          T3VoicePendingRuntimeRevocation(
            requireText(input, "runtimeId", 128),
            VoiceRuntimeOriginPolicy.normalize(
              requireText(input, "environmentOrigin", 2_048),
            ),
          )
        withBinder(promise, "voice-runtime-revocation-acknowledgement-failed") {
          service,
          settlement,
          ->
          check(service.acknowledgeRuntimeRevocation(expected)) {
            "The pending runtime voice runtime revocation is stale."
          }
          settlement.resolve()
        }
      }

      AsyncFunction("setReadinessSnapshotAsync") { input: Map<String, Any?>, promise: Promise ->
        withBinder(promise, "voice-readiness-update-failed") { service, settlement ->
          settlement.resolve(readinessBody(service.setReadinessSnapshot(parseReadinessConfig(input))))
        }
      }

      AsyncFunction("setVoiceCuesEnabledAsync") { input: Map<String, Any>, promise: Promise ->
        requireExactKeys(input, setOf("enabled"))
        val enabled = input["enabled"] as? Boolean ?: error("enabled must be a boolean.")
        withBinder(promise, "voice-cue-settings-update-failed") { service, settlement ->
          service.setVoiceCuesEnabled(enabled)
          settlement.resolve()
        }
      }

      AsyncFunction("registerVoiceControllerAsync") { input: Map<String, Any>, promise: Promise ->
        requireExactKeys(input, setOf("controllerGeneration"))
        val generation = requireLong(input, "controllerGeneration")
        withBinder(promise, "voice-controller-registration-failed") { service, settlement ->
          service.registerVoiceController(generation)
          registeredControllerGeneration = generation
          settlement.resolve()
        }
      }

      AsyncFunction("unregisterVoiceControllerAsync") { input: Map<String, Any>, promise: Promise ->
        requireExactKeys(input, setOf("controllerGeneration"))
        val generation = requireLong(input, "controllerGeneration")
        withBinder(promise, "voice-controller-unregistration-failed") { service, settlement ->
          service.unregisterVoiceController(generation)
          if (registeredControllerGeneration == generation) registeredControllerGeneration = null
          settlement.resolve()
        }
      }

      AsyncFunction("getPendingVoiceCommandAsync") { promise: Promise ->
        withBinder(promise, "voice-command-read-failed") { service, settlement ->
          settlement.resolve(service.pendingVoiceCommand())
        }
      }

      AsyncFunction("getPendingReadinessDisabledAsync") { promise: Promise ->
        withBinder(promise, "readiness-disabled-read-failed") { service, settlement ->
          settlement.resolve(service.pendingReadinessDisabled())
        }
      }

      AsyncFunction("acknowledgeReadinessDisabledAsync") {
        input: Map<String, Any>, promise: Promise ->
        requireExactKeys(input, setOf("readinessGeneration"))
        val generation = requireLong(input, "readinessGeneration")
        withBinder(promise, "readiness-disabled-acknowledgement-failed") {
          service,
          settlement,
          ->
          check(service.acknowledgeReadinessDisabled(generation)) {
            "The readiness-disabled event is stale."
          }
          settlement.resolve()
        }
      }

      AsyncFunction("completeVoiceCommandAsync") { input: Map<String, Any>, promise: Promise ->
        requireExactKeys(input, setOf("commandId", "controllerGeneration", "outcome"))
        val commandId = requireIdentifier(input, "commandId")
        val generation = requireLong(input, "controllerGeneration")
        val outcome = input["outcome"] as? String
          ?: throw IllegalArgumentException("outcome must be success or failure.")
        require(outcome == "success" || outcome == "failure") {
          "outcome must be success or failure."
        }
        withBinder(promise, "voice-command-completion-failed") { service, settlement ->
          check(service.completeVoiceCommand(commandId, generation, outcome)) {
            "The voice command is stale or owned by another controller."
          }
          settlement.resolve()
        }
      }

      AsyncFunction("getMicrophonePermissionAsync") { promise: Promise ->
        Permissions.getPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.RECORD_AUDIO,
        )
      }

      AsyncFunction("requestMicrophonePermissionAsync") { promise: Promise ->
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.RECORD_AUDIO,
        )
      }

      AsyncFunction("getNotificationPermissionAsync") { promise: Promise ->
        Permissions.getPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.POST_NOTIFICATIONS,
        )
      }

      AsyncFunction("requestNotificationPermissionAsync") { promise: Promise ->
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.POST_NOTIFICATIONS,
        )
      }

      AsyncFunction("getBluetoothPermissionAsync") { promise: Promise ->
        Permissions.getPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.BLUETOOTH_CONNECT,
        )
      }

      AsyncFunction("requestBluetoothPermissionAsync") { promise: Promise ->
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.BLUETOOTH_CONNECT,
        )
      }

      AsyncFunction("startRecordingAsync") { input: Map<String, Any?>, promise: Promise ->
        requireExactKeys(input, setOf("recordingId", "endpointDetection"))
        val recordingId = requireIdentifier(input, "recordingId")
        val endpointInput =
          input["endpointDetection"] as? Map<*, *>
            ?: error("endpointDetection must be an object.")
        requireAllowedKeys(
          endpointInput,
          required = setOf("endSilenceMs", "maximumUtteranceMs"),
          allowed = setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs"),
        )
        val endpointConfig =
          T3VoiceEndpointDetectionConfig(
            endSilenceMs = requireLong(endpointInput, "endSilenceMs"),
            noSpeechTimeoutMs = optionalLong(endpointInput, "noSpeechTimeoutMs"),
            maximumUtteranceMs = requireLong(endpointInput, "maximumUtteranceMs"),
          )
        withBinder(promise, "recording-start-failed") { voice, result ->
          voice.startRecording(recordingId, endpointConfig)
          result.resolve()
        }
      }

      AsyncFunction("stopRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-stop-failed") { voice, result ->
          try {
            result.resolve(voice.stopRecording(requireIdentifier(input, "recordingId")))
          } catch (cause: T3VoiceRecordingNotStartedException) {
            result.reject("recording-not-started", cause.message ?: "Recording was cancelled.", cause)
          }
        }
      }

      AsyncFunction("cancelRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-cancel-failed") { voice, result ->
          voice.cancelRecording(requireIdentifier(input, "recordingId"))
          result.resolve()
        }
      }

      AsyncFunction("deleteRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-delete-failed") { voice, result ->
          voice.deleteRecording(
            recordingId = requireIdentifier(input, "recordingId"),
            uri = requireText(input, "uri", T3VoiceBridgeValidation.MAXIMUM_URI_LENGTH),
          )
          result.resolve()
        }
      }

      AsyncFunction("acknowledgeRecordingTerminationAsync") {
        input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-acknowledgement-failed") { voice, result ->
          voice.acknowledgeRecordingTermination(requireIdentifier(input, "recordingId"))
          result.resolve()
        }
      }

      AsyncFunction("discardUnownedRecordingTerminationAsync") {
        input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-orphan-discard-failed") { voice, result ->
          result.resolve(
            voice.discardUnownedRecordingTermination(requireIdentifier(input, "recordingId")),
          )
        }
      }

      AsyncFunction("startPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        val playbackId = requireIdentifier(input, "playbackId")
        val sampleRate = requireInt(input, "sampleRate")
        val channelCount = requireInt(input, "channelCount")
        withBinder(promise, "playback-start-failed") { voice, result ->
          voice.startPlayback(playbackId, sampleRate, channelCount)
          result.resolve()
        }
      }

      AsyncFunction("enqueuePlaybackChunkAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-enqueue-failed") { voice, result ->
          voice.enqueuePlaybackChunk(
            playbackId = requireIdentifier(input, "playbackId"),
            chunkIndex = requireInt(input, "chunkIndex"),
            pcmBase64 =
              requireText(input, "pcmBase64", T3VoiceBridgeValidation.MAXIMUM_PCM_BASE64_LENGTH),
          )
          result.resolve()
        }
      }

      AsyncFunction("finishPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-finish-failed") { voice, result ->
          voice.finishPlayback(
            playbackId = requireIdentifier(input, "playbackId"),
            finalChunkIndex = requireInt(input, "finalChunkIndex"),
          )
          result.resolve()
        }
      }

      AsyncFunction("cancelPlaybackAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "playback-cancel-failed") { voice, result ->
          voice.cancelPlayback(requireIdentifier(input, "playbackId"))
          result.resolve()
        }
      }

      AsyncFunction("acknowledgePlaybackTerminationAsync") {
        input: Map<String, String>, promise: Promise ->
        withBinder(promise, "playback-acknowledgement-failed") { voice, result ->
          voice.acknowledgePlaybackTermination(requireIdentifier(input, "playbackId"))
          result.resolve()
        }
      }

      AsyncFunction("getPendingPlaybackTerminationAsync") { promise: Promise ->
        withBinder(promise, "playback-termination-read-failed") { voice, result ->
          result.resolve(voice.pendingPlaybackTermination())
        }
      }

      AsyncFunction("getPendingRecordingTerminationAsync") { promise: Promise ->
        withBinder(promise, "recording-termination-query-failed") { voice, result ->
          result.resolve(voice.pendingRecordingTermination())
        }
      }

      AsyncFunction("getPendingThreadVoiceHandoffAsync") { promise: Promise ->
        withBinder(promise, "thread-voice-handoff-query-failed") { voice, result ->
          result.resolve(voice.pendingThreadVoiceHandoff())
        }
      }

      AsyncFunction("acknowledgeThreadVoiceHandoffAsync") { input: Map<String, String>, promise: Promise ->
        requireExactKeys(input, setOf("actionId", "outcome"))
        withBinder(promise, "thread-voice-handoff-acknowledgement-failed") { voice, result ->
          val outcome = requireText(input, "outcome", 16)
          check(outcome == "adopted" || outcome == "failed") {
            "outcome must be adopted or failed."
          }
          voice.acknowledgeThreadVoiceHandoff(requireIdentifier(input, "actionId"), outcome)
          result.resolve()
        }
      }

      AsyncFunction("armThreadVoiceHandoffAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "thread-voice-handoff-arm-failed") { voice, result ->
          voice.armThreadVoiceHandoff(requireIdentifier(input, "nativeSessionId"))
          result.resolve()
        }
      }

      AsyncFunction("prepareRealtimeSessionAsync") { input: Map<String, Any>, promise: Promise ->
        requireExactKeys(
          input,
          setOf("nativeSessionId", "environmentOrigin", "audioRouteId", "runtimeControlGrant"),
        )
        val nativeSessionId = requireIdentifier(input, "nativeSessionId")
        val environmentOrigin = requireText(input, "environmentOrigin", 2_048)
        val audioRouteId = requireText(input, "audioRouteId", 64)
        @Suppress("UNCHECKED_CAST")
        val grantInput =
          input["runtimeControlGrant"] as? Map<String, Any>
            ?: error("runtimeControlGrant is required.")
        requireExactKeys(
          grantInput,
          setOf(
            "token",
            "sessionId",
            "leaseGeneration",
            "expiresAt",
            "heartbeatIntervalSeconds",
            "failureGraceSeconds",
          ),
        )
        val grantSessionId = requireIdentifier(grantInput, "sessionId")
        check(grantSessionId == nativeSessionId) { "Native control grant session does not match." }
        val runtimeControlGrant =
          VoiceRuntimeControlGrant(
            token = requireText(grantInput, "token", 128),
            sessionId = grantSessionId,
            leaseGeneration = requireLong(grantInput, "leaseGeneration"),
            expiresAtEpochMillis =
              Instant.parse(requireText(grantInput, "expiresAt", 128)).toEpochMilli(),
            heartbeatIntervalMillis =
              Math.multiplyExact(requireLong(grantInput, "heartbeatIntervalSeconds"), 1_000L),
            failureGraceMillis =
              Math.multiplyExact(requireLong(grantInput, "failureGraceSeconds"), 1_000L),
          )
        check(runtimeControlGrant.leaseGeneration > 0) { "leaseGeneration must be positive." }
        check(runtimeControlGrant.heartbeatIntervalMillis > 0) {
          "heartbeatIntervalSeconds must be positive."
        }
        check(runtimeControlGrant.failureGraceMillis > 0) {
          "failureGraceSeconds must be positive."
        }
        if (
          runCatching {
              VoiceRuntimeControlOriginPolicy.heartbeatUrl(environmentOrigin, nativeSessionId)
            }
            .isFailure
        ) {
          promise.reject(
            "realtime-secure-environment-required",
            publicRealtimeFailureMessage("realtime-secure-environment-required"),
            null,
          )
        } else try {
          withBinder(
            promise,
            "realtime-prepare-failed",
          ) { voice, settlement ->
            voice.prepareRealtimeSession(
              nativeSessionId,
              environmentOrigin,
              audioRouteId,
              runtimeControlGrant,
              object : T3VoiceWebRtcResultCallback<String> {
                override fun onSuccess(result: String) {
                  settlement.resolve(
                    mapOf(
                      "nativeSessionId" to nativeSessionId,
                      "sdp" to result,
                    ),
                  )
                }

                override fun onFailure(
                  code: String,
                  @Suppress("UNUSED_PARAMETER") message: String,
                  @Suppress("UNUSED_PARAMETER") cause: Throwable?,
                ) {
                  settlement.reject(code, publicRealtimeFailureMessage(code))
                }
              },
            )
          }
        } catch (_: Throwable) {
          promise.reject(
            "realtime-prepare-failed",
            publicRealtimeFailureMessage("realtime-prepare-failed"),
            null,
          )
        }
      }

      AsyncFunction("applyRealtimeAnswerAsync") { input: Map<String, String>, promise: Promise ->
        val nativeSessionId = requireIdentifier(input, "nativeSessionId")
        val sdp = requireText(input, "sdp", T3VoiceBridgeValidation.MAXIMUM_SDP_LENGTH)
        try {
          withBinder(promise, "realtime-answer-rejected") { voice, settlement ->
            voice.applyRealtimeAnswer(
              nativeSessionId,
              sdp,
              object : T3VoiceWebRtcResultCallback<Unit> {
                override fun onSuccess(result: Unit) {
                  settlement.resolve()
                }

                override fun onFailure(
                  code: String,
                  @Suppress("UNUSED_PARAMETER") message: String,
                  @Suppress("UNUSED_PARAMETER") cause: Throwable?,
                ) {
                  settlement.reject(code, publicRealtimeFailureMessage(code))
                }
              },
            )
          }
        } catch (_: Throwable) {
          promise.reject(
            "realtime-answer-rejected",
            publicRealtimeFailureMessage("realtime-answer-rejected"),
            null,
          )
        }
      }

      AsyncFunction("stopRealtimeSessionAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(
          promise,
          "realtime-stop-failed",
          T3VoiceBinderOperationLane.INTERRUPT,
        ) { voice, result ->
          result.resolve(voice.stopRealtimeSession(requireIdentifier(input, "nativeSessionId")))
        }
      }

      AsyncFunction("drainAndStopRealtimeSessionAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(
          promise,
          "realtime-drained-stop-failed",
          T3VoiceBinderOperationLane.INTERRUPT,
        ) { voice, result ->
          voice.drainAndStopRealtimeSession(requireIdentifier(input, "nativeSessionId"))
          result.resolve()
        }
      }

      AsyncFunction("setRealtimeMutedAsync") { input: Map<String, Any>, promise: Promise ->
        val muted = input["muted"] as? Boolean ?: error("muted must be a boolean.")
        withBinder(promise, "realtime-mute-failed") { voice, result ->
          voice.setRealtimeMuted(
            nativeSessionId = requireIdentifier(input, "nativeSessionId"),
            muted = muted,
          )
          result.resolve()
        }
      }

      AsyncFunction("getAudioRoutesAsync") { promise: Promise ->
        withBinder(promise, "audio-routes-failed") { voice, result ->
          result.resolve(voice.getAudioRoutes())
        }
      }

      AsyncFunction("getDiagnosticsAsync") { promise: Promise ->
        withBinder(promise, "diagnostics-read-failed") { voice, result ->
          result.resolve(voice.getDiagnostics())
        }
      }

      AsyncFunction("recordThreadVoiceHandoffClientStageAsync") {
        input: Map<String, String>, promise: Promise ->
        requireExactKeys(input, setOf("stage"))
        withBinder(promise, "handoff-diagnostic-failed") { voice, result ->
          voice.recordThreadVoiceHandoffClientStage(requireText(input, "stage", 64))
          result.resolve()
        }
      }

      AsyncFunction("beginThreadVoiceHandoffAdoptionAsync") {
        input: Map<String, String>, promise: Promise ->
        requireExactKeys(input, setOf("actionId"))
        withBinder(promise, "handoff-adoption-claim-failed") { voice, result ->
          result.resolve(voice.beginThreadVoiceHandoffAdoption(requireIdentifier(input, "actionId")))
        }
      }

      AsyncFunction("setAudioRouteAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "audio-route-selection-failed") { voice, result ->
          result.resolve(
            voice.setAudioRoute(
              nativeSessionId = requireIdentifier(input, "nativeSessionId"),
              routeId = requireIdentifier(input, "routeId"),
            ),
          )
        }
      }
    }

  private fun handleBindingLoss(message: String, rebind: Boolean) {
    val (disconnected, realtimeOwner) =
      synchronized(binderLock) {
        val owner = bindingRealtimeOwner.disconnected()
        binder = null
        pendingBinderOperations.disconnected() to owner
      }
    cancelCollections()
    if (realtimeOwner != null) {
      sendEvent(
        REALTIME_TERMINATED_EVENT,
        T3VoiceRuntimeEvent.RealtimeTerminated(
          nativeSessionId = realtimeOwner.sessionId,
          outcome = "failed",
          code = "realtime-service-disconnected",
          retryable = true,
        ).toEventBody(),
      )
    }
    disconnected.forEach { entry -> rejectPendingOperation(entry.value, message) }
    if (rebind) scheduleServiceRebind()
  }

  private fun scheduleServiceRebind() {
    val shouldSchedule =
      synchronized(binderLock) {
        if (destroyed || rebindScheduled) {
          false
        } else {
          rebindScheduled = true
          true
        }
      }
    if (!shouldSchedule) return

    mainHandler.post {
      val context = appContext.reactContext
      val shouldRebind =
        synchronized(binderLock) {
          if (!rebindScheduled) return@post
          rebindScheduled = false
          if (destroyed || context == null) {
            false
          } else if (rebindAttemptedSinceConnection) {
            false
          } else {
            rebindAttemptedSinceConnection = true
            true
          }
        }
      if (serviceBound && context != null) {
        runCatching { context.unbindService(serviceConnection) }
        serviceBound = false
      }
      if (!shouldRebind || context == null) return@post

      synchronized(binderLock) {
        if (destroyed) return@post
        serviceBound =
          runCatching {
            context.bindService(
              Intent(context, T3VoiceRuntimeService::class.java),
              serviceConnection,
              Context.BIND_AUTO_CREATE,
            )
          }.getOrDefault(false)
      }
    }
  }

  private fun withBinder(
    promise: Promise,
    errorCode: String,
    lane: T3VoiceBinderOperationLane = T3VoiceBinderOperationLane.ORDERED,
    ordering: T3VoiceBinderOperationOrdering? = null,
    operation: (T3VoiceRuntimeService.VoiceBinder, BinderSettlement) -> Unit,
  ) = withBinderAdmission(promise, errorCode, lane, ordering) { service, settlement, admission ->
    check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
    operation(service, settlement)
  }

  private fun withBinderAdmission(
    promise: Promise,
    errorCode: String,
    lane: T3VoiceBinderOperationLane = T3VoiceBinderOperationLane.ORDERED,
    ordering: T3VoiceBinderOperationOrdering? = null,
    operation: (
      T3VoiceRuntimeService.VoiceBinder,
      BinderSettlement,
      T3VoiceBinderOperationAdmission,
    ) -> Unit,
  ) {
    val pending = PendingBinderOperation(promise, errorCode, lane, ordering, operation)
    var dispatch: T3VoiceBinderOperationRegistry.Dispatch<PendingBinderOperation>? = null
    var connectedBinder: T3VoiceRuntimeService.VoiceBinder? = null
    var unavailableMessage: String? = null
    synchronized(binderLock) {
      when {
        destroyed -> unavailableMessage = "The T3 voice module was destroyed."
        !serviceBound ->
          unavailableMessage = "The T3 voice runtime service could not be bound."
        else -> {
          val registration = pendingBinderOperations.register(pending)
          pending.ticket = registration.first
          dispatch = registration.second
          connectedBinder = binder
          if (dispatch == null) {
            val timeout = Runnable { timeoutBinderOperation(pending.ticket) }
            pending.timeout = timeout
            mainHandler.postDelayed(timeout, BINDER_CONNECTION_TIMEOUT_MS)
          }
        }
      }
    }
    when {
      unavailableMessage != null -> promise.reject(errorCode, unavailableMessage, null)
      dispatch != null && connectedBinder != null ->
        scheduleBinderOperation(requireNotNull(connectedBinder), requireNotNull(dispatch))
      dispatch != null -> {
        val failed =
          synchronized(binderLock) {
            pendingBinderOperations.complete(
              pending.ticket,
              requireNotNull(dispatch).binderGeneration,
            )
          }
        if (failed != null) {
          rejectPendingOperation(failed.value, "The T3 voice runtime service disconnected.")
        }
      }
    }
  }

  private fun timeoutBinderOperation(ticket: T3VoiceBinderOperationRegistry.Ticket) {
    val timedOut = synchronized(binderLock) { pendingBinderOperations.timeout(ticket) } ?: return
    rejectPendingOperation(
      timedOut.value,
      "The T3 voice runtime service did not connect in time.",
    )
  }

  private fun scheduleBinderOperation(
    connectedBinder: T3VoiceRuntimeService.VoiceBinder,
    dispatch: T3VoiceBinderOperationRegistry.Dispatch<PendingBinderOperation>,
  ) {
    val pending = dispatch.value
    val accepted = binderOperationDispatcher.post(
      lane = pending.lane,
      ordering = pending.ordering,
    ) operation@{ admission ->
      val active = synchronized(binderLock) {
        pendingBinderOperations.isActive(dispatch.ticket, dispatch.binderGeneration)
      }
      if (!active) return@operation
      val settlement = BinderSettlement(pending, dispatch.binderGeneration)
      val startedAt = SystemClock.elapsedRealtime()
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.LIFECYCLE,
        T3VoiceDiagnosticCode.BRIDGE_OPERATION_STARTED,
      )
      try {
        pending.operation(connectedBinder, settlement, admission)
      } catch (cause: Throwable) {
        settlement.reject(pending.errorCode, cause.message ?: "The voice operation failed.", cause)
      } finally {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.LIFECYCLE,
          T3VoiceDiagnosticCode.BRIDGE_OPERATION_FINISHED,
          primaryCount = (SystemClock.elapsedRealtime() - startedAt)
            .coerceAtMost(Int.MAX_VALUE.toLong())
            .toInt(),
        )
      }
    }
    if (!accepted) {
      BinderSettlement(pending, dispatch.binderGeneration).reject(
        pending.errorCode,
        "The T3 voice module is no longer accepting operations.",
        null,
      )
    }
  }

  private fun completePending(
    pending: PendingBinderOperation,
    binderGeneration: Long,
  ): Boolean =
    synchronized(binderLock) {
      pendingBinderOperations.complete(pending.ticket, binderGeneration) != null
    }.also { completed ->
      if (completed) cancelBinderTimeout(pending)
    }

  private fun rejectPendingOperation(
    pending: PendingBinderOperation,
    message: String,
  ) {
    cancelBinderTimeout(pending)
    pending.promise.reject(pending.errorCode, message, null)
  }

  private fun cancelBinderTimeout(pending: PendingBinderOperation) {
    pending.timeout?.let(mainHandler::removeCallbacks)
    pending.timeout = null
  }

  private fun requireIdentifier(input: Map<String, *>, key: String): String {
    return requireText(input, key, T3VoiceBridgeValidation.MAXIMUM_IDENTIFIER_LENGTH)
  }

  private fun parseReadinessConfig(input: Map<String, Any?>): T3VoiceReadinessConfig {
    requireExactKeys(input, READINESS_FIELDS)
    val enabled = input["enabled"] as? Boolean
      ?: throw IllegalArgumentException("enabled must be a boolean.")
    val mode =
      when (input["mode"] as? String) {
        "realtime" -> T3VoiceReadinessMode.REALTIME
        "thread" -> T3VoiceReadinessMode.THREAD
        else -> throw IllegalArgumentException("mode must be realtime or thread.")
      }
    val targetId =
      when (val value = input["targetId"]) {
        null -> null
        is String -> value.takeIf(String::isNotBlank)
          ?: throw IllegalArgumentException("targetId must not be blank.")
        else -> throw IllegalArgumentException("targetId must be a string or null.")
      }
    val audioRouteId = input["audioRouteId"] as? String
      ?: throw IllegalArgumentException("audioRouteId must be a string.")
    require(audioRouteId.isNotBlank()) { "audioRouteId must not be blank." }
    return T3VoiceReadinessConfig(
      enabled = enabled,
      mode = mode,
      targetId = targetId,
      audioRouteId = audioRouteId,
      autoRearm = input["autoRearm"] as? Boolean
        ?: throw IllegalArgumentException("autoRearm must be a boolean."),
      microphonePermissionGranted = input["microphonePermissionGranted"] as? Boolean
        ?: throw IllegalArgumentException("microphonePermissionGranted must be a boolean."),
      notificationPermissionGranted = input["notificationPermissionGranted"] as? Boolean
        ?: throw IllegalArgumentException("notificationPermissionGranted must be a boolean."),
    )
  }

  private fun parseAuthorityPreparation(
    input: Map<String, Any?>,
  ): Pair<T3VoiceReadinessConfig, VoiceRuntimeAuthorityPreparation> {
    requireExactKeys(input, AUTHORITY_PREPARATION_FIELDS)
    @Suppress("UNCHECKED_CAST")
    val readiness = parseReadinessConfig(
      input["readiness"] as? Map<String, Any?>
        ?: throw IllegalArgumentException("readiness must be an object."),
    )
    @Suppress("UNCHECKED_CAST")
    val targetInput = input["target"] as? Map<String, Any?>
      ?: throw IllegalArgumentException("target must be an object.")
    val operation = T3VoiceRuntimeGrantOperation.fromWireValue(requireText(input, "operation", 64))
    val target = when (operation) {
      T3VoiceRuntimeGrantOperation.REALTIME_START -> VoiceRuntimeBridge.parseRealtimeTarget(targetInput)
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START -> VoiceRuntimeBridge.parseThreadTarget(targetInput)
    }
    return readiness to VoiceRuntimeAuthorityPreparation(
      requireText(input, "runtimeId", 128),
      requireText(input, "runtimeInstanceId", 128),
      requireText(input, "provisioningOperationId", 256),
      requireLong(input, "expectedCurrentGeneration"),
      requireLong(input, "generation"),
      requireText(input, "targetDigest", 64),
      target,
      operation,
      requireText(input, "environmentOrigin", 2_048),
      readiness.enabled,
    )
  }

  private fun authorityPreparationBody(
    result: VoiceRuntimeAuthorityPreparationResult,
  ): Map<String, Any?> = authorityReservationBody(result.preparation) + mapOf(
    "state" to "prepared",
    "refreshCredentialHash" to result.refreshCredentialHash,
  )

  private fun authorityReservationBody(
    input: VoiceRuntimeAuthorityPreparation,
  ): Map<String, Any?> = mapOf(
    "runtimeId" to input.runtimeId,
    "runtimeInstanceId" to input.runtimeInstanceId,
    "provisioningOperationId" to input.provisioningOperationId,
    "expectedCurrentGeneration" to input.expectedCurrentGeneration.toDouble(),
    "generation" to input.generation.toDouble(),
    "targetDigest" to input.targetDigest,
    "target" to VoiceRuntimeBridge.targetBody(input.target),
    "operation" to input.operation.wireValue,
    "environmentOrigin" to VoiceRuntimeOriginPolicy.normalize(input.environmentOrigin),
    "readinessEnabled" to input.readinessEnabled,
  )

  private fun authorityInspectionBody(
    inspection: VoiceRuntimeAuthorityInspection,
  ): Map<String, Any?> {
    val input = inspection.preparation
    return authorityReservationBody(input) + mapOf(
      "state" to inspection.state,
      "readiness" to readinessBody(inspection.readiness),
      "refreshCredentialHash" to inspection.refreshCredentialHash,
      "issuedAt" to inspection.issuedAtEpochMillis?.let { java.time.Instant.ofEpochMilli(it).toString() },
      "expiresAt" to inspection.expiresAtEpochMillis?.let { java.time.Instant.ofEpochMilli(it).toString() },
      "refreshRotationCounter" to inspection.refreshRotationCounter?.toDouble(),
    )
  }

  private fun parseRuntimeGrantMetadata(
    input: Map<String, Any?>,
    expiresAtEpochMillis: Long,
  ): T3VoiceRuntimeGrantMetadata =
    T3VoiceRuntimeGrantMetadata(
      runtimeId = requireText(input, "runtimeId", 128),
      readinessGeneration = requireLong(input, "readinessGeneration"),
      environmentOrigin = requireText(input, "environmentOrigin", 2_048),
      operation = T3VoiceRuntimeGrantOperation.fromWireValue(requireText(input, "operation", 64)),
      targetIdentityDigest =
        T3VoiceRuntimeTargetIdentity.digest(
          requireText(input, "targetIdentity", MAXIMUM_TARGET_IDENTITY_LENGTH),
        ),
      expiresAtEpochMillis = expiresAtEpochMillis,
    )

  private fun authorityBody(snapshot: VoiceRuntimeAuthoritySnapshot): Map<String, Any?> =
    mapOf(
      "state" to snapshot.state.wireValue,
      "runtimeId" to snapshot.runtimeId,
      "readiness" to readinessBody(snapshot.config),
      "environmentOrigin" to snapshot.environmentOrigin,
      "operation" to snapshot.operation.wireValue,
      "expiresAtEpochMillis" to snapshot.expiresAtEpochMillis?.toDouble(),
      "refreshPending" to snapshot.refreshPending,
    )

  private fun runtimeRevocationBody(
    revocation: T3VoicePendingRuntimeRevocation,
  ): Map<String, Any> =
    mapOf(
      "runtimeId" to revocation.runtimeId,
      "environmentOrigin" to VoiceRuntimeOriginPolicy.normalize(revocation.environmentOrigin),
    )

  private fun readinessBody(snapshot: T3VoiceReadinessConfig): Map<String, Any?> =
    mapOf(
      "enabled" to snapshot.enabled,
      "mode" to snapshot.mode.name.lowercase(),
      "targetId" to snapshot.targetId,
      "audioRouteId" to snapshot.audioRouteId,
      "autoRearm" to snapshot.autoRearm,
      "microphonePermissionGranted" to snapshot.microphonePermissionGranted,
      "notificationPermissionGranted" to snapshot.notificationPermissionGranted,
      "generation" to snapshot.generation.toDouble(),
    )

  private fun requireInt(input: Map<String, Any>, key: String): Int {
    return T3VoiceBridgeValidation.requireInt(input, key)
  }

  private fun requireLong(input: Map<*, *>, key: String): Long =
    optionalLong(input, key) ?: error("$key must be an integer.")

  private fun optionalLong(input: Map<*, *>, key: String): Long? {
    val value = input[key] ?: return null
    val number = value as? Number ?: error("$key must be an integer or null.")
    val long = number.toLong()
    check(number.toDouble() == long.toDouble()) { "$key must be an integer." }
    return long
  }

  private fun requireExactKeys(input: Map<*, *>, expected: Set<String>) {
    check(input.keys == expected) { "Input fields must be exactly ${expected.sorted().joinToString()}." }
  }

  private fun requireAllowedKeys(
    input: Map<*, *>,
    required: Set<String>,
    allowed: Set<String>,
  ) {
    check(input.keys.containsAll(required) && allowed.containsAll(input.keys)) {
      "Input fields must include ${required.sorted().joinToString()} and may include " +
        allowed.sorted().joinToString() + "."
    }
  }

  private fun requireText(input: Map<String, *>, key: String, maximumLength: Int): String =
    T3VoiceBridgeValidation.requireText(input, key, maximumLength)

  private fun cancelCollections() {
    stateCollection?.cancel()
    stateCollection = null
    eventCollection?.cancel()
    eventCollection = null
    realtimeTerminationCollection?.cancel()
    realtimeTerminationCollection = null
    threadVoiceHandoffCollection?.cancel()
    threadVoiceHandoffCollection = null
    voiceCommandCollection?.cancel()
    voiceCommandCollection = null
    recordingTerminationCollection?.cancel()
    recordingTerminationCollection = null
    playbackTerminationCollection?.cancel()
    playbackTerminationCollection = null
  }

  private fun publicRealtimeFailureMessage(code: String): String =
    when (code) {
      "realtime-secure-environment-required" ->
        "Realtime voice requires an HTTPS environment."
      "realtime-answer-rejected" -> "The Realtime answer was rejected."
      "realtime-ice-timeout" -> "The Realtime connection timed out."
      "realtime-offer-failed" -> "The Realtime offer could not be created."
      else -> "The Realtime media session could not be prepared."
    }

  companion object {
    private const val MODULE_NAME = "T3Voice"
    private const val STATE_CHANGED_EVENT = "stateChanged"
    private const val PLAYBACK_CHUNK_CONSUMED_EVENT = "playbackChunkConsumed"
    private const val PLAYBACK_TERMINATED_EVENT = "playbackTerminated"
    private const val RECORDING_TERMINATED_EVENT = "recordingTerminated"
    private const val RUNTIME_ERROR_EVENT = "runtimeError"
    private const val AUDIO_ROUTE_CHANGED_EVENT = "audioRouteChanged"
    private const val REALTIME_TERMINATED_EVENT = "realtimeTerminated"
    private const val THREAD_VOICE_HANDOFF_EVENT = "threadVoiceHandoff"
    private const val VOICE_COMMAND_EVENT = "voiceCommand"
    private const val READINESS_DISABLED_EVENT = "readinessDisabled"
    private const val VOICE_RUNTIME_WAKE_EVENT = "voiceRuntimeWake"
    private const val BINDER_CONNECTION_TIMEOUT_MS = 5_000L
    private const val MAXIMUM_TARGET_IDENTITY_LENGTH = 4_096
    private val READINESS_FIELDS =
      setOf(
        "enabled",
        "mode",
        "targetId",
        "audioRouteId",
        "autoRearm",
        "microphonePermissionGranted",
        "notificationPermissionGranted",
      )
    private val AUTHORITY_PREPARATION_FIELDS = setOf(
      "readiness", "runtimeId", "runtimeInstanceId", "provisioningOperationId",
      "expectedCurrentGeneration", "generation", "targetDigest", "target", "operation",
      "environmentOrigin",
    )
  }
}

internal enum class T3VoiceBinderOperationLane { ORDERED, INTERRUPT }

internal data class T3VoiceBinderOperationFence(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
)

internal sealed interface T3VoiceBinderOperationOrdering {
  val fence: T3VoiceBinderOperationFence

  data class Activation(
    override val fence: T3VoiceBinderOperationFence,
  ) : T3VoiceBinderOperationOrdering

  data class Stop(
    override val fence: T3VoiceBinderOperationFence,
  ) : T3VoiceBinderOperationOrdering
}

internal fun interface T3VoiceBinderOperationAdmission {
  fun tryAdmit(): Boolean
}

internal data class T3VoiceBinderOrderingRetention(
  val pendingActivationCount: Int,
  val stopSequenceCount: Int,
)

internal object T3VoiceBinderOperationLanePolicy {
  fun forCommand(command: VoiceRuntimeNativeCommand): T3VoiceBinderOperationLane =
    if (command is VoiceRuntimeNativeCommand.StopMode) {
      T3VoiceBinderOperationLane.INTERRUPT
    } else {
      T3VoiceBinderOperationLane.ORDERED
    }

  fun orderingForCommand(command: VoiceRuntimeNativeCommand): T3VoiceBinderOperationOrdering? {
    val fence = T3VoiceBinderOperationFence(command.identity, command.modeSessionId)
    return when (command) {
      is VoiceRuntimeNativeCommand.StartRealtime ->
        T3VoiceBinderOperationOrdering.Activation(fence)
      is VoiceRuntimeNativeCommand.StopMode -> T3VoiceBinderOperationOrdering.Stop(fence)
      is VoiceRuntimeNativeCommand.Thread -> when (command.command) {
        is VoiceRuntimeThreadCommand.Start,
        is VoiceRuntimeThreadCommand.Resume,
        -> T3VoiceBinderOperationOrdering.Activation(fence)
        else -> null
      }
      else -> null
    }
  }
}

internal class T3VoiceBinderOperationDispatcher(
  private val orderedPost: (Runnable) -> Boolean,
  private val interruptPost: (Runnable) -> Boolean,
) {
  private enum class StopPostingState { REGISTERING, ACCEPTED, REJECTED }

  private data class StopTombstone(
    val sequence: Long,
    var postingState: StopPostingState = StopPostingState.REGISTERING,
    var finished: Boolean = false,
  )

  private data class Registration(
    val sequence: Long,
    val ordering: T3VoiceBinderOperationOrdering?,
    val stopTombstone: StopTombstone?,
    val previousStopTombstone: StopTombstone?,
    var admissionAttempted: Boolean = false,
    var finished: Boolean = false,
  )

  private val lock = Any()
  private var nextSequence = 0L
  private val pendingActivations = mutableMapOf<T3VoiceBinderOperationFence, MutableSet<Long>>()
  private val stopSequences = mutableMapOf<T3VoiceBinderOperationFence, StopTombstone>()

  fun post(
    lane: T3VoiceBinderOperationLane,
    ordering: T3VoiceBinderOperationOrdering? = null,
    operation: (T3VoiceBinderOperationAdmission) -> Unit,
  ): Boolean {
    val registration = synchronized(lock) { register(ordering) }
    val runnable = Runnable {
      if (!beforeRun(registration)) return@Runnable
      try {
        operation(T3VoiceBinderOperationAdmission { admit(registration) })
      } finally {
        synchronized(lock) { finishRegistration(registration) }
      }
    }
    val postAccepted = when (lane) {
      T3VoiceBinderOperationLane.ORDERED -> orderedPost(runnable)
      T3VoiceBinderOperationLane.INTERRUPT -> interruptPost(runnable)
    }
    val accepted = synchronized(lock) {
      if (postAccepted) markAccepted(registration)
      val stopAdmitted = registration.stopTombstone?.postingState == StopPostingState.ACCEPTED
      if (!postAccepted && !stopAdmitted) rollback(registration)
      postAccepted || stopAdmitted
    }
    return accepted
  }

  private fun register(ordering: T3VoiceBinderOperationOrdering?): Registration {
    nextSequence += 1
    val sequence = nextSequence
    var stopTombstone: StopTombstone? = null
    val previousStopTombstone = when (ordering) {
      is T3VoiceBinderOperationOrdering.Activation -> {
        pendingActivations.getOrPut(ordering.fence) { mutableSetOf() }.add(sequence)
        null
      }
      is T3VoiceBinderOperationOrdering.Stop -> {
        val next = StopTombstone(sequence)
        stopTombstone = next
        stopSequences.put(ordering.fence, next)
      }
      null -> null
    }
    return Registration(sequence, ordering, stopTombstone, previousStopTombstone)
  }

  private fun beforeRun(registration: Registration): Boolean = synchronized(lock) {
    !registration.finished
  }

  private fun admit(registration: Registration): Boolean = synchronized(lock) {
    if (registration.finished || registration.admissionAttempted) return@synchronized false
    registration.admissionAttempted = true
    when (registration.ordering) {
      is T3VoiceBinderOperationOrdering.Activation ->
        !finishActivation(registration, evaluateCancellation = true)
      is T3VoiceBinderOperationOrdering.Stop -> {
        markAccepted(registration)
        true
      }
      null -> true
    }
  }

  private fun finishRegistration(registration: Registration) {
    if (registration.finished) return
    when (val ordering = registration.ordering) {
      is T3VoiceBinderOperationOrdering.Activation ->
        finishActivation(registration, evaluateCancellation = false)
      is T3VoiceBinderOperationOrdering.Stop -> {
        registration.finished = true
        registration.stopTombstone?.let { tombstone ->
          tombstone.finished = true
          retireStopIfCovered(ordering.fence, tombstone)
        }
      }
      null -> registration.finished = true
    }
  }

  private fun finishActivation(
    registration: Registration,
    evaluateCancellation: Boolean,
  ): Boolean {
    if (registration.finished) return false
    registration.finished = true
    val activation = registration.ordering as? T3VoiceBinderOperationOrdering.Activation
      ?: return false
    val pending = pendingActivations[activation.fence]
    pending?.remove(registration.sequence)
    if (pending?.isEmpty() == true) pendingActivations.remove(activation.fence)
    val stopTombstone = stopSequences[activation.fence]
    val cancelled = evaluateCancellation &&
      stopTombstone?.postingState == StopPostingState.ACCEPTED &&
      stopTombstone.sequence > registration.sequence
    if (stopTombstone != null) retireStopIfCovered(activation.fence, stopTombstone)
    return cancelled
  }

  private fun retireStopIfCovered(
    fence: T3VoiceBinderOperationFence,
    tombstone: StopTombstone,
  ) {
    if (stopSequences[fence] === tombstone &&
      tombstone.postingState == StopPostingState.ACCEPTED && tombstone.finished &&
      !coversEarlierActivation(fence, tombstone)) {
      stopSequences.remove(fence, tombstone)
    }
  }

  private fun coversEarlierActivation(
    fence: T3VoiceBinderOperationFence,
    tombstone: StopTombstone,
  ): Boolean = pendingActivations[fence].orEmpty().any { it < tombstone.sequence }

  private fun markAccepted(registration: Registration) {
    val ordering = registration.ordering as? T3VoiceBinderOperationOrdering.Stop ?: return
    val tombstone = registration.stopTombstone ?: return
    if (tombstone.postingState != StopPostingState.REGISTERING) return
    tombstone.postingState = StopPostingState.ACCEPTED
    if (stopSequences[ordering.fence] == null && coversEarlierActivation(ordering.fence, tombstone)) {
      stopSequences[ordering.fence] = tombstone
    }
    retireStopIfCovered(ordering.fence, tombstone)
  }

  private fun rollback(registration: Registration) {
    when (val ordering = registration.ordering) {
      is T3VoiceBinderOperationOrdering.Activation -> {
        registration.finished = true
        val pending = pendingActivations[ordering.fence]
        pending?.remove(registration.sequence)
        if (pending?.isEmpty() == true) pendingActivations.remove(ordering.fence)
        stopSequences[ordering.fence]?.let { retireStopIfCovered(ordering.fence, it) }
      }
      is T3VoiceBinderOperationOrdering.Stop -> {
        val rejected = registration.stopTombstone
        rejected?.postingState = StopPostingState.REJECTED
        if (rejected != null && stopSequences[ordering.fence] === rejected) {
          val previous = registration.previousStopTombstone
          if (previous?.postingState == StopPostingState.ACCEPTED &&
            coversEarlierActivation(ordering.fence, previous)) {
            stopSequences[ordering.fence] = previous
          } else {
            stopSequences.remove(ordering.fence, rejected)
          }
        }
      }
      null -> Unit
    }
  }

  internal fun retainedOrderingCounts(): T3VoiceBinderOrderingRetention = synchronized(lock) {
    T3VoiceBinderOrderingRetention(
      pendingActivations.values.sumOf { it.size },
      stopSequences.size,
    )
  }
}
