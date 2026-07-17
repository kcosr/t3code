package expo.modules.t3voice

import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import com.facebook.react.bridge.ReadableMap
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
  private val pendingBinderOperations = T3VoiceBinderOperationRegistry<PendingBinderOperation>()
  private var runtimeSnapshotCollection: Job? = null
  private var eventCollection: Job? = null
  private var recordingTerminationCollection: Job? = null
  private var playbackTerminationCollection: Job? = null
  private var rebindScheduled = false
  private var rebindAttemptedSinceConnection = false

  private class PendingBinderOperation(
    val promise: Promise,
    val errorCode: String,
    val operation: (T3VoiceRuntimeService.VoiceBinder, BinderSettlement) -> Unit,
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
        val dispatches =
          synchronized(binderLock) {
            if (destroyed) return
            binder = connectedBinder
            rebindScheduled = false
            rebindAttemptedSinceConnection = false
            pendingBinderOperations.connected()
          }
        dispatches.forEach { dispatch ->
          cancelBinderTimeout(dispatch.value)
          executeBinderOperation(connectedBinder, dispatch)
        }
        runtimeSnapshotCollection?.cancel()
        runtimeSnapshotCollection =
          appContext.mainQueue.launch {
            connectedBinder.runtimeSnapshots.collectLatest { snapshot ->
              sendEvent(RUNTIME_SNAPSHOT_CHANGED_EVENT, snapshot.toBridgeBody())
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
        RUNTIME_SNAPSHOT_CHANGED_EVENT,
        PLAYBACK_CHUNK_CONSUMED_EVENT,
        PLAYBACK_TERMINATED_EVENT,
        RECORDING_TERMINATED_EVENT,
        RUNTIME_ERROR_EVENT,
      )

      Constants(
        "nativeRevision" to 10,
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

      AsyncFunction("getRuntimeSnapshotAsync") { promise: Promise ->
        withBinder(promise, "voice-runtime-snapshot-failed") { voice, result ->
          result.resolve(voice.runtimeSnapshot().toBridgeBody())
        }
      }

      AsyncFunction("startRealtimeAsync") { input: ReadableMap, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeBridgeInput.startRealtime(input.toHashMap()),
        )
      }

      AsyncFunction("startThreadAsync") { input: ReadableMap, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeBridgeInput.startThread(input.toHashMap()),
        )
      }

      AsyncFunction("switchRealtimeToThreadAsync") {
        input: ReadableMap, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeBridgeInput.switchRealtimeToThread(input.toHashMap()),
        )
      }

      AsyncFunction("stopRuntimeAsync") { promise: Promise ->
        dispatchRuntime(promise, T3VoiceRuntimeCommand.Stop)
      }

      AsyncFunction("setRealtimeAudioRouteAsync") {
        input: Map<String, Any?>, promise: Promise ->
        input.requireExactBridgeKeys("audio route input", setOf("routeId"))
        dispatchRuntime(
          promise,
          T3VoiceRuntimeCommand.SetRealtimeAudioRoute(
            input.requireBridgeArgumentIdentifier("routeId"),
          ),
        )
      }

      AsyncFunction("updateRealtimeContextAsync") {
        input: ReadableMap, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeCommand.UpdateRealtimeContext(
            T3VoiceRuntimeBridgeInput.realtimeContext(input.toHashMap()),
          ),
        )
      }

      AsyncFunction("decideRealtimeConfirmationAsync") {
        input: Map<String, Any?>, promise: Promise ->
        input.requireExactBridgeKeys(
          "confirmation decision input",
          setOf("confirmationId", "decision"),
        )
        val decision =
          when (input.requireBridgeArgumentText("decision", 16)) {
            "approve" -> T3VoiceConfirmationDecision.APPROVE
            "reject" -> T3VoiceConfirmationDecision.REJECT
            else -> error("decision must be approve or reject.")
          }
        dispatchRuntime(
          promise,
          T3VoiceRuntimeCommand.DecideRealtimeConfirmation(
            confirmationId = input.requireBridgeArgumentIdentifier("confirmationId"),
            decision = decision,
          ),
        )
      }

      AsyncFunction("completeRealtimeClientActionAsync") {
        input: Map<String, Any?>, promise: Promise ->
        input.requireAllowedBridgeKeys(
          "client action completion input",
          required = setOf("actionId", "outcome"),
          allowed = setOf("actionId", "outcome", "message"),
        )
        val outcome =
          when (input.requireBridgeArgumentText("outcome", 16)) {
            "succeeded" -> T3VoiceClientActionOutcome.SUCCEEDED
            "failed" -> T3VoiceClientActionOutcome.FAILED
            else -> error("outcome must be succeeded or failed.")
          }
        dispatchRuntime(
          promise,
          T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
            actionId = input.requireBridgeArgumentIdentifier("actionId"),
            outcome = outcome,
            message =
              if (input.containsKey("message")) {
                input.requireBridgeArgumentText("message", MAXIMUM_CLIENT_ACTION_MESSAGE_LENGTH)
              } else {
                null
              },
          ),
        )
      }

      AsyncFunction("finishThreadRecordingAsync") { promise: Promise ->
        dispatchRuntime(promise, T3VoiceRuntimeCommand.FinishThreadUtterance)
      }

      AsyncFunction("updateThreadReviewTranscriptAsync") {
        input: Map<String, Any?>, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeBridgeInput.updateThreadReviewTranscript(input),
        )
      }

      AsyncFunction("submitThreadTranscriptAsync") {
        input: Map<String, Any?>, promise: Promise ->
        dispatchRuntime(
          promise,
          T3VoiceRuntimeBridgeInput.submitThreadTranscript(input),
        )
      }

      AsyncFunction("getStateAsync") {
        T3VoiceStateStore.state.value.toEventBody()
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
        input.requireExactBridgeKeys(
          "recording start input",
          setOf("recordingId", "endpointDetection"),
        )
        val recordingId = input.requireBridgeArgumentIdentifier("recordingId")
        val endpointInput =
          input["endpointDetection"] as? Map<*, *>
            ?: error("endpointDetection must be an object.")
        endpointInput.requireAllowedBridgeKeys(
          "endpoint detection input",
          required = setOf("endSilenceMs", "maximumUtteranceMs"),
          allowed = setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs"),
        )
        val endpointConfig =
          T3VoiceEndpointDetectionConfig(
            endSilenceMs = endpointInput.requireBridgeLong("endSilenceMs"),
            noSpeechTimeoutMs = endpointInput.optionalBridgeLong("noSpeechTimeoutMs"),
            maximumUtteranceMs = endpointInput.requireBridgeLong("maximumUtteranceMs"),
          )
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        T3VoiceRuntimeService.startForRecording(context, recordingId)
        withBinder(promise, "recording-start-failed") { voice, result ->
          voice.startRecording(recordingId, endpointConfig)
          result.resolve()
        }
      }

      AsyncFunction("stopRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-stop-failed") { voice, result ->
          result.resolve(voice.stopRecording(input.requireBridgeArgumentIdentifier("recordingId")))
        }
      }

      AsyncFunction("cancelRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-cancel-failed") { voice, result ->
          voice.cancelRecording(input.requireBridgeArgumentIdentifier("recordingId"))
          result.resolve()
        }
      }

      AsyncFunction("deleteRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-delete-failed") { voice, result ->
          voice.deleteRecording(
            recordingId = input.requireBridgeArgumentIdentifier("recordingId"),
            uri =
              input.requireBridgeArgumentText(
                "uri",
                T3VoiceBridgeValidation.MAXIMUM_URI_LENGTH,
              ),
          )
          result.resolve()
        }
      }

      AsyncFunction("acknowledgeRecordingTerminationAsync") {
        input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-acknowledgement-failed") { voice, result ->
          voice.acknowledgeRecordingTermination(
            input.requireBridgeArgumentIdentifier("recordingId"),
          )
          result.resolve()
        }
      }

      AsyncFunction("startPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        val playbackId = input.requireBridgeArgumentIdentifier("playbackId")
        val sampleRate = input.requireBridgeInt("sampleRate")
        val channelCount = input.requireBridgeInt("channelCount")
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        T3VoiceRuntimeService.startForPlayback(context, playbackId)
        withBinder(promise, "playback-start-failed") { voice, result ->
          voice.startPlayback(playbackId, sampleRate, channelCount)
          result.resolve()
        }
      }

      AsyncFunction("enqueuePlaybackChunkAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-enqueue-failed") { voice, result ->
          voice.enqueuePlaybackChunk(
            playbackId = input.requireBridgeArgumentIdentifier("playbackId"),
            chunkIndex = input.requireBridgeInt("chunkIndex"),
            pcmBase64 =
              input.requireBridgeArgumentText(
                "pcmBase64",
                T3VoiceBridgeValidation.MAXIMUM_PCM_BASE64_LENGTH,
              ),
          )
          result.resolve()
        }
      }

      AsyncFunction("finishPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-finish-failed") { voice, result ->
          voice.finishPlayback(
            playbackId = input.requireBridgeArgumentIdentifier("playbackId"),
            finalChunkIndex = input.requireBridgeInt("finalChunkIndex"),
          )
          result.resolve()
        }
      }

      AsyncFunction("cancelPlaybackAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "playback-cancel-failed") { voice, result ->
          voice.cancelPlayback(input.requireBridgeArgumentIdentifier("playbackId"))
          result.resolve()
        }
      }

      AsyncFunction("acknowledgePlaybackTerminationAsync") {
        input: Map<String, String>, promise: Promise ->
        withBinder(promise, "playback-acknowledgement-failed") { voice, result ->
          voice.acknowledgePlaybackTermination(
            input.requireBridgeArgumentIdentifier("playbackId"),
          )
          result.resolve()
        }
      }

      AsyncFunction("getPendingPlaybackTerminationAsync") { promise: Promise ->
        withBinder(promise, "playback-termination-read-failed") { voice, result ->
          result.resolve(voice.pendingPlaybackTermination())
        }
      }

      AsyncFunction("setRealtimeMutedAsync") { input: Map<String, Any>, promise: Promise ->
        input.requireExactBridgeKeys("mute input", setOf("muted"))
        val muted = input.requireBridgeBoolean("muted")
        dispatchRuntime(promise, T3VoiceRuntimeCommand.SetRealtimeMuted(muted))
      }

      AsyncFunction("getDiagnosticsAsync") { promise: Promise ->
        withBinder(promise, "diagnostics-read-failed") { voice, result ->
          result.resolve(voice.getDiagnostics())
        }
      }

    }

  private fun handleBindingLoss(message: String, rebind: Boolean) {
    val disconnected =
      synchronized(binderLock) {
        binder = null
        pendingBinderOperations.disconnected()
      }
    cancelCollections()
    disconnected.forEach { entry -> rejectPendingOperation(entry.value, message) }
    if (rebind) scheduleServiceRebind()
  }

  private fun dispatchRuntime(
    promise: Promise,
    command: T3VoiceRuntimeCommand,
  ) {
    withBinder(promise, "voice-runtime-command-failed") { voice, result ->
      val dispatched = voice.dispatchRuntime(command)
      if (dispatched.outcome != T3VoiceCommandOutcome.REJECTED) {
        result.resolve()
      } else {
        val rejection = checkNotNull(dispatched.rejection)
        result.reject(
          "voice-runtime-${rejection.name.lowercase().replace('_', '-')}",
          when (rejection) {
            T3VoiceCommandRejection.BUSY -> "Another voice operation is active."
            T3VoiceCommandRejection.INVALID_STATE ->
              "The voice command is not valid in the current state."
            T3VoiceCommandRejection.STALE_GENERATION ->
              "The voice command targets an obsolete runtime generation."
            T3VoiceCommandRejection.STALE_REVIEW ->
              "The voice command targets an obsolete transcript review."
            T3VoiceCommandRejection.UNKNOWN_AUDIO_ROUTE ->
              "The requested audio route is not currently available."
          },
        )
      }
    }
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
    operation: (T3VoiceRuntimeService.VoiceBinder, BinderSettlement) -> Unit,
  ) {
    val pending = PendingBinderOperation(promise, errorCode, operation)
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
        executeBinderOperation(requireNotNull(connectedBinder), requireNotNull(dispatch))
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

  private fun executeBinderOperation(
    connectedBinder: T3VoiceRuntimeService.VoiceBinder,
    dispatch: T3VoiceBinderOperationRegistry.Dispatch<PendingBinderOperation>,
  ) {
    val pending = dispatch.value
    val settlement = BinderSettlement(pending, dispatch.binderGeneration)
    try {
      pending.operation(connectedBinder, settlement)
    } catch (cause: Throwable) {
      settlement.reject(pending.errorCode, cause.message ?: "The voice operation failed.", cause)
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

  private fun cancelCollections() {
    runtimeSnapshotCollection?.cancel()
    runtimeSnapshotCollection = null
    eventCollection?.cancel()
    eventCollection = null
    recordingTerminationCollection?.cancel()
    recordingTerminationCollection = null
    playbackTerminationCollection?.cancel()
    playbackTerminationCollection = null
  }

  companion object {
    private const val MODULE_NAME = "T3Voice"
    private const val RUNTIME_SNAPSHOT_CHANGED_EVENT = "runtimeSnapshotChanged"
    private const val PLAYBACK_CHUNK_CONSUMED_EVENT = "playbackChunkConsumed"
    private const val PLAYBACK_TERMINATED_EVENT = "playbackTerminated"
    private const val RECORDING_TERMINATED_EVENT = "recordingTerminated"
    private const val RUNTIME_ERROR_EVENT = "runtimeError"
    private const val BINDER_CONNECTION_TIMEOUT_MS = 5_000L
    private const val MAXIMUM_CLIENT_ACTION_MESSAGE_LENGTH = 512
  }
}
