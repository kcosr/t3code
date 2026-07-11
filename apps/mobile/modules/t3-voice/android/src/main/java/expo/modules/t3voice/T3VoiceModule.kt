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
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class T3VoiceModule : Module() {
  @Volatile private var binder: T3VoiceRuntimeService.VoiceBinder? = null
  @Volatile private var serviceBound = false
  @Volatile private var destroyed = false
  private val binderLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private val pendingBinderOperations = T3VoiceBinderOperationRegistry<PendingBinderOperation>()
  private val bindingRealtimeOwner = T3VoiceBindingRealtimeOwnerPolicy()
  private var stateCollection: Job? = null
  private var eventCollection: Job? = null
  private var realtimeTerminationCollection: Job? = null
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
          executeBinderOperation(connectedBinder, dispatch)
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
            connectedBinder.events.collectLatest { event ->
              when (event) {
                is T3VoiceRuntimeEvent.PlaybackChunkConsumed ->
                  sendEvent(PLAYBACK_CHUNK_CONSUMED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.RuntimeError ->
                  sendEvent(RUNTIME_ERROR_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.AudioRouteChanged ->
                  sendEvent(AUDIO_ROUTE_CHANGED_EVENT, event.toEventBody())
                is T3VoiceRuntimeEvent.RealtimeTerminated ->
                  sendEvent(REALTIME_TERMINATED_EVENT, event.toEventBody())
              }
            }
          }
        realtimeTerminationCollection?.cancel()
        realtimeTerminationCollection =
          appContext.mainQueue.launch {
            connectedBinder.realtimeTermination.collectLatest { event ->
              if (event != null) sendEvent(REALTIME_TERMINATED_EVENT, event.toEventBody())
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
        RUNTIME_ERROR_EVENT,
        AUDIO_ROUTE_CHANGED_EVENT,
        REALTIME_TERMINATED_EVENT,
      )

      Constants(
        "nativeRevision" to 4,
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
          "orderedPcmPlayback" to true,
          "realtimeWebRtc" to true,
          "bluetoothRouting" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S),
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

      AsyncFunction("startRecordingAsync") { input: Map<String, String>, promise: Promise ->
        val recordingId = requireIdentifier(input, "recordingId")
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        T3VoiceRuntimeService.startForRecording(context, recordingId)
        withBinder(promise, "recording-start-failed") { voice, result ->
          voice.startRecording(recordingId)
          result.resolve()
        }
      }

      AsyncFunction("stopRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-stop-failed") { voice, result ->
          result.resolve(voice.stopRecording(requireIdentifier(input, "recordingId")))
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
            uri = requireIdentifier(input, "uri"),
          )
          result.resolve()
        }
      }

      AsyncFunction("startPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        val playbackId = requireIdentifier(input, "playbackId")
        val sampleRate = requireInt(input, "sampleRate")
        val channelCount = requireInt(input, "channelCount")
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
            playbackId = requireIdentifier(input, "playbackId"),
            chunkIndex = requireInt(input, "chunkIndex"),
            pcmBase64 = requireIdentifier(input, "pcmBase64"),
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

      AsyncFunction("prepareRealtimeSessionAsync") { input: Map<String, String>, promise: Promise ->
        val nativeSessionId = requireIdentifier(input, "nativeSessionId")
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        try {
          T3VoiceRuntimeService.startForRealtime(context, nativeSessionId)
          withBinder(
            promise,
            "realtime-prepare-failed",
          ) { voice, settlement ->
            voice.prepareRealtimeSession(
              nativeSessionId,
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
        val sdp = requireIdentifier(input, "sdp")
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
        withBinder(promise, "realtime-stop-failed") { voice, result ->
          result.resolve(voice.stopRealtimeSession(requireIdentifier(input, "nativeSessionId")))
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

  private fun requireIdentifier(input: Map<String, *>, key: String): String {
    val value = input[key] as? String
    require(!value.isNullOrBlank()) { "$key must be a non-empty string." }
    return value
  }

  private fun requireInt(input: Map<String, Any>, key: String): Int {
    val value = input[key] as? Number ?: error("$key must be a number.")
    return value.toInt()
  }

  private fun cancelCollections() {
    stateCollection?.cancel()
    stateCollection = null
    eventCollection?.cancel()
    eventCollection = null
    realtimeTerminationCollection?.cancel()
    realtimeTerminationCollection = null
  }

  private fun publicRealtimeFailureMessage(code: String): String =
    when (code) {
      "realtime-answer-rejected" -> "The Realtime answer was rejected."
      "realtime-ice-timeout" -> "The Realtime connection timed out."
      "realtime-offer-failed" -> "The Realtime offer could not be created."
      else -> "The Realtime media session could not be prepared."
    }

  companion object {
    private const val MODULE_NAME = "T3Voice"
    private const val STATE_CHANGED_EVENT = "stateChanged"
    private const val PLAYBACK_CHUNK_CONSUMED_EVENT = "playbackChunkConsumed"
    private const val RUNTIME_ERROR_EVENT = "runtimeError"
    private const val AUDIO_ROUTE_CHANGED_EVENT = "audioRouteChanged"
    private const val REALTIME_TERMINATED_EVENT = "realtimeTerminated"
    private const val BINDER_CONNECTION_TIMEOUT_MS = 5_000L
  }
}
