package expo.modules.t3voice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.IBinder
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

internal class T3VoiceForegroundReleaseCoordinator(
  private val isIdle: () -> Boolean,
  private val releaseForeground: () -> Unit,
) {
  val lock = Any()

  fun releaseWhileLocked() {
    check(Thread.holdsLock(lock)) { "Foreground release must hold the operation lock." }
    check(isIdle()) { "Cannot release foreground ownership while voice is active." }
    releaseForeground()
  }
}

class T3VoiceRuntimeService : Service() {
  internal inner class VoiceBinder : Binder() {
    val state: StateFlow<T3VoiceRuntimeState>
      get() = T3VoiceStateStore.state

    val events: SharedFlow<T3VoiceRuntimeEvent>
      get() = T3VoiceStateStore.events

    val realtimeTermination: StateFlow<T3VoiceRuntimeEvent.RealtimeTerminated?>
      get() = T3VoiceStateStore.realtimeTermination

    val recordingTermination: StateFlow<T3VoiceRuntimeEvent.RecordingTerminated?>
      get() = T3VoiceStateStore.recordingTermination

    fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      synchronized(operationLock) {
        val owner =
          checkNotNull(T3VoiceStateStore.claimRecording(recordingId)) {
            "The voice runtime is already in use."
          }
        recordingOwner = owner
        try {
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
          recorder.start(recordingId, endpointConfig)
        } catch (cause: Throwable) {
          releaseRecordingLocked(owner)
          throw cause
        }
      }
    }

    fun stopRecording(recordingId: String): Map<String, Any> =
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
        try {
          recorder.stop(recordingId).toResultBody()
        } finally {
          releaseRecordingLocked(owner)
        }
      }

    fun cancelRecording(recordingId: String) {
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
        try {
          recorder.cancel(recordingId)
        } finally {
          releaseRecordingLocked(owner)
        }
      }
    }

    fun deleteRecording(recordingId: String, uri: String) {
      recorder.delete(recordingId, uri)
      T3VoiceStateStore.clearRecordingTermination(recordingId)
    }

    fun acknowledgeRecordingTermination(recordingId: String) {
      T3VoiceStateStore.clearRecordingTermination(recordingId)
    }

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      synchronized(operationLock) {
        val owner =
          checkNotNull(T3VoiceStateStore.claimPlayback(playbackId)) {
            "The voice runtime is already in use."
          }
        playbackOwner = owner
        try {
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
          player.start(playbackId, sampleRate, channelCount)
        } catch (cause: Throwable) {
          releasePlaybackLocked(owner)
          throw cause
        }
      }
    }

    fun enqueuePlaybackChunk(playbackId: String, chunkIndex: Int, pcmBase64: String) {
      player.enqueue(playbackId, chunkIndex, pcmBase64)
    }

    fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      player.finish(playbackId, finalChunkIndex)
    }

    fun cancelPlayback(playbackId: String) {
      synchronized(operationLock) {
        val owner = requirePlaybackOwner(playbackId)
        try {
          player.cancel(playbackId)
        } finally {
          releasePlaybackLocked(owner)
        }
      }
    }

    fun prepareRealtimeSession(
      nativeSessionId: String,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      synchronized(operationLock) {
        check(T3VoiceStateStore.claimRealtime(nativeSessionId)) {
          "The voice runtime is already in use."
        }
        try {
          ensureRuntimeForeground(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
          )
          realtime.prepare(nativeSessionId, callback)
        } catch (cause: Throwable) {
          T3VoiceStateStore.releaseRealtimeClaim(nativeSessionId)
          stopRuntimeForegroundLocked()
          throw cause
        }
      }
    }

    fun applyRealtimeAnswer(
      nativeSessionId: String,
      sdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) {
      realtime.applyAnswer(nativeSessionId, sdp, callback)
    }

    fun stopRealtimeSession(nativeSessionId: String): Boolean = realtime.stop(nativeSessionId)

    fun setRealtimeMuted(nativeSessionId: String, muted: Boolean) {
      realtime.setMuted(nativeSessionId, muted)
    }

    fun getAudioRoutes(): List<Map<String, Any>> = realtime.routes()

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()

    fun setAudioRoute(nativeSessionId: String, routeId: String): List<Map<String, Any>> =
      realtime.selectRoute(nativeSessionId, routeId)
  }

  private val binder = VoiceBinder()
  private val foregroundReleaseCoordinator =
    T3VoiceForegroundReleaseCoordinator(
      isIdle = { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE },
      releaseForeground = ::stopRuntimeForeground,
    )
  private val operationLock = foregroundReleaseCoordinator.lock
  private var recordingOwner: T3VoiceOperationOwner? = null
  private var playbackOwner: T3VoiceOperationOwner? = null
  private lateinit var recorder: T3VoiceRecorder
  private lateinit var player: T3VoicePcmPlayer
  private val realtimeDelegate =
    lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
      T3VoiceWebRtcSession(
        context = applicationContext,
        onStateChanged = { sessionId, connectionState, muted ->
          T3VoiceStateStore.setRealtime(
            sessionId = sessionId,
            connectionState = connectionState,
            muted = muted,
          )
        },
        onRouteChanged = { sessionId, change ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.AudioRouteChanged(
              nativeSessionId = sessionId,
              routeId = change.routeId,
              routeType = change.routeType,
              reason = change.reason.name.lowercase().replace('_', '-'),
            ),
          )
        },
        onError = { sessionId, code, message, recoverable ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "realtime:$sessionId",
              code = code,
              message = message,
              recoverable = recoverable,
            ),
          )
        },
        onTerminated = { sessionId, outcome, code, retryable ->
          synchronized(operationLock) {
            val terminated =
              T3VoiceStateStore.terminateRealtime(
                T3VoiceRuntimeEvent.RealtimeTerminated(
                  nativeSessionId = sessionId,
                  outcome = outcome,
                  code = code,
                  retryable = retryable,
                ),
              )
            if (terminated) stopRuntimeForegroundLocked()
          }
        },
      )
    }
  private val realtime: T3VoiceWebRtcSession
    get() = realtimeDelegate.value

  override fun onCreate() {
    super.onCreate()
    recorder =
      T3VoiceRecorder(applicationContext) { termination ->
        synchronized(operationLock) {
          val owner =
            recordingOwner?.takeIf {
              it.id ==
                when (termination) {
                  is T3VoiceRecordingTermination.Completed -> termination.recording.recordingId
                  is T3VoiceRecordingTermination.Cancelled -> termination.recordingId
                  is T3VoiceRecordingTermination.Failed -> termination.recordingId
                }
            } ?: return@T3VoiceRecorder
          when (termination) {
            is T3VoiceRecordingTermination.Completed ->
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recording.recordingId,
                  recording = termination.recording,
                  outcome = "completed",
                  reason = termination.reason,
                ),
              )
            is T3VoiceRecordingTermination.Cancelled ->
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recordingId,
                  recording = null,
                  outcome = "cancelled",
                  reason = termination.reason,
                ),
              )
            is T3VoiceRecordingTermination.Failed -> {
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recordingId,
                  recording = null,
                  outcome = "failed",
                  reason = "finalization-failed",
                ),
              )
            }
          }
        }
      }
    recorder.sweepStaleCache()
    T3VoiceStateStore.recordingTermination.value?.recording?.let(recorder::restoreCompleted)
    player =
      T3VoicePcmPlayer(
        onChunkConsumed = { playbackId, chunkIndex ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.PlaybackChunkConsumed(playbackId, chunkIndex),
          )
        },
        onFinished = { playbackId ->
          synchronized(operationLock) {
            playbackOwner?.takeIf { it.id == playbackId }?.let(::releasePlaybackLocked)
          }
        },
        onError = { playbackId, cause ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "playback:$playbackId",
              code = "pcm-playback-failed",
              message = cause.message ?: "PCM playback failed.",
              recoverable = true,
            ),
          )
          synchronized(operationLock) {
            playbackOwner?.takeIf { it.id == playbackId }?.let(::releasePlaybackLocked)
          }
        },
      )
    createNotificationChannel()
    T3VoiceStateStore.setServiceReady()
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(operationLock) {
      when (intent?.action) {
        ACTION_STOP -> stopActiveOperationLocked()
        ACTION_START_RECORDING ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activeRecordingId,
            foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            startId = startId,
          )
        ACTION_START_PLAYBACK ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activePlaybackId,
            foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            startId = startId,
          )
        ACTION_START_REALTIME ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activeRealtimeSessionId,
            foregroundServiceType =
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            startId = startId,
          )
        else -> stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    recorder.release()
    player.release()
    if (realtimeDelegate.isInitialized()) realtime.release()
    T3VoiceStateStore.setInactive()
    super.onDestroy()
  }

  private fun startRuntimeForeground(foregroundServiceType: Int) {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, foregroundServiceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    T3VoiceStateStore.setForeground(true)
  }

  private fun reconcileStartCommand(
    expectedOwnerId: String?,
    activeOwnerId: String?,
    foregroundServiceType: Int,
    startId: Int,
  ) {
    when (T3VoiceStartCommandPolicy.decide(expectedOwnerId, activeOwnerId)) {
      T3VoiceStartCommandDecision.PROMOTE_ACTIVE_OWNER ->
        ensureRuntimeForeground(foregroundServiceType)
      T3VoiceStartCommandDecision.STOP_STALE_START -> stopSelf(startId)
    }
  }

  private fun ensureRuntimeForeground(foregroundServiceType: Int) {
    check(Thread.holdsLock(operationLock)) {
      "Foreground acquisition must hold the operation lock."
    }
    if (!T3VoiceStateStore.state.value.isForeground) {
      startRuntimeForeground(foregroundServiceType)
    }
    check(T3VoiceStateStore.state.value.isForeground) {
      "Android could not acquire foreground voice ownership."
    }
  }

  private fun stopActiveOperationLocked() {
    val state = T3VoiceStateStore.state.value
    recordingOwner?.takeIf { it.id == state.activeRecordingId }?.let { owner ->
      runCatching { recorder.cancel(owner.id) }
      releaseRecordingLocked(owner, stopForeground = false)
    }
    playbackOwner?.takeIf { it.id == state.activePlaybackId }?.let { owner ->
      runCatching { player.cancel(owner.id) }
      releasePlaybackLocked(owner, stopForeground = false)
    }
    state.activeRealtimeSessionId?.let {
      val stopped = runCatching { realtime.stop(it) }.getOrDefault(false)
      if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(it)
    }
    stopRuntimeForegroundLocked()
  }

  private fun requireRecordingOwner(recordingId: String): T3VoiceOperationOwner =
    checkNotNull(recordingOwner?.takeIf { it.id == recordingId }) {
      "Recording $recordingId does not own the active recorder."
    }

  private fun requirePlaybackOwner(playbackId: String): T3VoiceOperationOwner =
    checkNotNull(playbackOwner?.takeIf { it.id == playbackId }) {
      "Playback $playbackId does not own the active player."
    }

  private fun releaseRecordingLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.releaseRecording(owner)) return
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminateRecordingLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
  ) {
    if (!T3VoiceStateStore.terminateRecording(owner, event)) return
    if (recordingOwner == owner) recordingOwner = null
    stopRuntimeForegroundLocked()
  }

  private fun releasePlaybackLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.releasePlayback(owner)) return
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun stopRuntimeForegroundLocked() {
    foregroundReleaseCoordinator.releaseWhileLocked()
  }

  private fun stopRuntimeForeground() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    T3VoiceStateStore.setForeground(false)
    stopSelf()
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val channel =
      NotificationChannel(
        NOTIFICATION_CHANNEL_ID,
        "T3 voice",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Active T3 voice sessions"
        setSound(null, null)
      }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  @Suppress("DEPRECATION")
  private fun buildNotification(): Notification {
    val stopIntent =
      Intent(this, T3VoiceRuntimeService::class.java).apply {
        action = ACTION_STOP
      }
    val stopPendingIntent =
      PendingIntent.getService(
        this,
        STOP_REQUEST_CODE,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent =
      launchIntent?.let {
        PendingIntent.getActivity(
          this,
          CONTENT_REQUEST_CODE,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
      } else {
        Notification.Builder(this)
      }
    return builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("T3 voice is active")
      .setContentText("Tap Stop to end the active voice operation.")
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
      .build()
  }

  companion object {
    private const val NOTIFICATION_CHANNEL_ID = "t3_voice_runtime"
    private const val NOTIFICATION_ID = 3107
    private const val STOP_REQUEST_CODE = 3108
    private const val CONTENT_REQUEST_CODE = 3109
    private const val ACTION_STOP = "expo.modules.t3voice.action.STOP"
    private const val ACTION_START_RECORDING = "expo.modules.t3voice.action.START_RECORDING"
    private const val ACTION_START_PLAYBACK = "expo.modules.t3voice.action.START_PLAYBACK"
    private const val ACTION_START_REALTIME = "expo.modules.t3voice.action.START_REALTIME"
    private const val EXTRA_OPERATION_ID = "operationId"

    fun startForRecording(context: Context, recordingId: String) {
      start(context, ACTION_START_RECORDING, recordingId)
    }

    fun startForPlayback(context: Context, playbackId: String) {
      start(context, ACTION_START_PLAYBACK, playbackId)
    }

    fun startForRealtime(context: Context, nativeSessionId: String) {
      start(context, ACTION_START_REALTIME, nativeSessionId)
    }

    fun requestStop(context: Context) {
      start(context, ACTION_STOP, null)
    }

    private fun start(context: Context, action: String, operationId: String?) {
      val intent =
        Intent(context, T3VoiceRuntimeService::class.java).apply {
          this.action = action
          if (operationId != null) putExtra(EXTRA_OPERATION_ID, operationId)
        }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
