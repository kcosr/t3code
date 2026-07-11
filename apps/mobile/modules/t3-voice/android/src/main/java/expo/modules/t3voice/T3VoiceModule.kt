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
  private val pendingBinderOperations = mutableListOf<PendingBinderOperation>()
  private var stateCollection: Job? = null
  private var eventCollection: Job? = null
  private var realtimeTerminationCollection: Job? = null

  private class PendingBinderOperation(
    val promise: Promise,
    val errorCode: String,
    val stopServiceOnFailure: Boolean,
    val operation: (T3VoiceRuntimeService.VoiceBinder) -> Unit,
  ) {
    lateinit var timeout: Runnable
  }

  private val serviceConnection =
    object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        val connectedBinder = service as? T3VoiceRuntimeService.VoiceBinder ?: return
        val pending =
          synchronized(binderLock) {
            if (destroyed) return
            binder = connectedBinder
            pendingBinderOperations.toList().also { pendingBinderOperations.clear() }
          }
        pending.forEach { operation ->
          mainHandler.removeCallbacks(operation.timeout)
          executeBinderOperation(connectedBinder, operation)
        }
        stateCollection?.cancel()
        stateCollection =
          appContext.mainQueue.launch {
            connectedBinder.state.collectLatest { state ->
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
        synchronized(binderLock) { binder = null }
        cancelCollections()
      }
    }

  override fun definition() =
    ModuleDefinition {
      Name(MODULE_NAME)
      Events(
        STATE_CHANGED_EVENT,
        PLAYBACK_CHUNK_CONSUMED_EVENT,
        RUNTIME_ERROR_EVENT,
        REALTIME_TERMINATED_EVENT,
      )

      Constants(
        "nativeRevision" to 3,
      )

      OnCreate {
        destroyed = false
        val context = appContext.reactContext ?: return@OnCreate
        val intent = Intent(context, T3VoiceRuntimeService::class.java)
        serviceBound = context.bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE)
      }

      OnDestroy {
        destroyed = true
        cancelCollections()
        val context = appContext.reactContext
        rejectPendingBinderOperations(context)
        if (serviceBound && context != null) {
          context.unbindService(serviceConnection)
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
        T3VoiceRuntimeService.startForRecording(context)
        withBinder(promise, "recording-start-failed", stopServiceOnFailure = true) { voice ->
          voice.startRecording(recordingId)
          promise.resolve()
        }
      }

      AsyncFunction("stopRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-stop-failed") { voice ->
          promise.resolve(voice.stopRecording(requireIdentifier(input, "recordingId")))
        }
      }

      AsyncFunction("cancelRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-cancel-failed") { voice ->
          voice.cancelRecording(requireIdentifier(input, "recordingId"))
          promise.resolve()
        }
      }

      AsyncFunction("deleteRecordingAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "recording-delete-failed") { voice ->
          voice.deleteRecording(
            recordingId = requireIdentifier(input, "recordingId"),
            uri = requireIdentifier(input, "uri"),
          )
          promise.resolve()
        }
      }

      AsyncFunction("startPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        val playbackId = requireIdentifier(input, "playbackId")
        val sampleRate = requireInt(input, "sampleRate")
        val channelCount = requireInt(input, "channelCount")
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        T3VoiceRuntimeService.startForPlayback(context)
        withBinder(promise, "playback-start-failed", stopServiceOnFailure = true) { voice ->
          voice.startPlayback(playbackId, sampleRate, channelCount)
          promise.resolve()
        }
      }

      AsyncFunction("enqueuePlaybackChunkAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-enqueue-failed") { voice ->
          voice.enqueuePlaybackChunk(
            playbackId = requireIdentifier(input, "playbackId"),
            chunkIndex = requireInt(input, "chunkIndex"),
            pcmBase64 = requireIdentifier(input, "pcmBase64"),
          )
          promise.resolve()
        }
      }

      AsyncFunction("finishPlaybackAsync") { input: Map<String, Any>, promise: Promise ->
        withBinder(promise, "playback-finish-failed") { voice ->
          voice.finishPlayback(
            playbackId = requireIdentifier(input, "playbackId"),
            finalChunkIndex = requireInt(input, "finalChunkIndex"),
          )
          promise.resolve()
        }
      }

      AsyncFunction("cancelPlaybackAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "playback-cancel-failed") { voice ->
          voice.cancelPlayback(requireIdentifier(input, "playbackId"))
          promise.resolve()
        }
      }

      AsyncFunction("prepareRealtimeSessionAsync") { input: Map<String, String>, promise: Promise ->
        val nativeSessionId = requireIdentifier(input, "nativeSessionId")
        val context = requireNotNull(appContext.reactContext) { "React context is unavailable." }
        try {
          T3VoiceRuntimeService.startForRealtime(context)
          withBinder(promise, "realtime-prepare-failed", stopServiceOnFailure = true) { voice ->
            voice.prepareRealtimeSession(
              nativeSessionId,
              object : T3VoiceWebRtcResultCallback<String> {
                override fun onSuccess(result: String) {
                  promise.resolve(
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
                  promise.reject(code, publicRealtimeFailureMessage(code), null)
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
          withBinder(promise, "realtime-answer-rejected") { voice ->
            voice.applyRealtimeAnswer(
              nativeSessionId,
              sdp,
              object : T3VoiceWebRtcResultCallback<Unit> {
                override fun onSuccess(result: Unit) {
                  promise.resolve()
                }

                override fun onFailure(
                  code: String,
                  @Suppress("UNUSED_PARAMETER") message: String,
                  @Suppress("UNUSED_PARAMETER") cause: Throwable?,
                ) {
                  promise.reject(code, publicRealtimeFailureMessage(code), null)
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
        withBinder(promise, "realtime-stop-failed") { voice ->
          promise.resolve(voice.stopRealtimeSession(requireIdentifier(input, "nativeSessionId")))
        }
      }

      AsyncFunction("setRealtimeMutedAsync") { input: Map<String, Any>, promise: Promise ->
        val muted = input["muted"] as? Boolean ?: error("muted must be a boolean.")
        withBinder(promise, "realtime-mute-failed") { voice ->
          voice.setRealtimeMuted(
            nativeSessionId = requireIdentifier(input, "nativeSessionId"),
            muted = muted,
          )
          promise.resolve()
        }
      }

      AsyncFunction("getAudioRoutesAsync") { promise: Promise ->
        withBinder(promise, "audio-routes-failed") { voice ->
          promise.resolve(voice.getAudioRoutes())
        }
      }

      AsyncFunction("setAudioRouteAsync") { input: Map<String, String>, promise: Promise ->
        withBinder(promise, "audio-route-selection-failed") { voice ->
          promise.resolve(
            voice.setAudioRoute(
              nativeSessionId = requireIdentifier(input, "nativeSessionId"),
              routeId = requireIdentifier(input, "routeId"),
            ),
          )
        }
      }
    }

  private fun withBinder(
    promise: Promise,
    errorCode: String,
    stopServiceOnFailure: Boolean = false,
    operation: (T3VoiceRuntimeService.VoiceBinder) -> Unit,
  ) {
    val pending = PendingBinderOperation(promise, errorCode, stopServiceOnFailure, operation)
    val connected =
      synchronized(binderLock) {
        val current = binder
        if (current == null && !destroyed && serviceBound) {
          pending.timeout = Runnable { timeoutBinderOperation(pending) }
          pendingBinderOperations += pending
          mainHandler.postDelayed(pending.timeout, BINDER_CONNECTION_TIMEOUT_MS)
        }
        current
      }
    when {
      connected != null -> executeBinderOperation(connected, pending)
      destroyed -> promise.reject(errorCode, "The T3 voice module was destroyed.", null)
      !serviceBound -> promise.reject(errorCode, "The T3 voice runtime service could not be bound.", null)
    }
  }

  private fun timeoutBinderOperation(pending: PendingBinderOperation) {
    val removed = synchronized(binderLock) { pendingBinderOperations.remove(pending) }
    if (!removed) return
    if (pending.stopServiceOnFailure) {
      appContext.reactContext?.let(T3VoiceRuntimeService::requestStop)
    }
    pending.promise.reject(
      pending.errorCode,
      "The T3 voice runtime service did not connect in time.",
      null,
    )
  }

  private fun executeBinderOperation(
    connectedBinder: T3VoiceRuntimeService.VoiceBinder,
    pending: PendingBinderOperation,
  ) {
    try {
      pending.operation(connectedBinder)
    } catch (cause: Throwable) {
      if (pending.stopServiceOnFailure) {
        appContext.reactContext?.let(T3VoiceRuntimeService::requestStop)
      }
      pending.promise.reject(pending.errorCode, cause.message, cause)
    }
  }

  private fun rejectPendingBinderOperations(context: Context?) {
    val pending =
      synchronized(binderLock) {
        pendingBinderOperations.toList().also { pendingBinderOperations.clear() }
      }
    pending.forEach { operation ->
      mainHandler.removeCallbacks(operation.timeout)
      if (operation.stopServiceOnFailure && context != null) {
        T3VoiceRuntimeService.requestStop(context)
      }
      operation.promise.reject(
        operation.errorCode,
        "The T3 voice module was destroyed before the service connected.",
        null,
      )
    }
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
    private const val REALTIME_TERMINATED_EVENT = "realtimeTerminated"
    private const val BINDER_CONNECTION_TIMEOUT_MS = 5_000L
  }
}
