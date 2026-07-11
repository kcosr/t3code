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

class T3VoiceRuntimeService : Service() {
  internal inner class VoiceBinder : Binder() {
    val state: StateFlow<T3VoiceRuntimeState>
      get() = T3VoiceStateStore.state

    val events: SharedFlow<T3VoiceRuntimeEvent>
      get() = T3VoiceStateStore.events

    fun startRecording(recordingId: String) {
      check(T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        "The voice runtime is already in use."
      }
      try {
        recorder.start(recordingId)
        T3VoiceStateStore.setRecording(recordingId)
      } catch (cause: Throwable) {
        stopRuntimeForeground()
        throw cause
      }
    }

    fun stopRecording(recordingId: String): Map<String, Any> {
      val result = recorder.stop(recordingId)
      T3VoiceStateStore.setRecording(null)
      stopRuntimeForeground()
      return result.toResultBody()
    }

    fun cancelRecording(recordingId: String) {
      recorder.cancel(recordingId)
      T3VoiceStateStore.setRecording(null)
      stopRuntimeForeground()
    }

    fun deleteRecording(recordingId: String, uri: String) {
      recorder.delete(recordingId, uri)
    }

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      check(T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        "The voice runtime is already in use."
      }
      try {
        player.start(playbackId, sampleRate, channelCount)
        T3VoiceStateStore.setPlayback(playbackId)
      } catch (cause: Throwable) {
        stopRuntimeForeground()
        throw cause
      }
    }

    fun enqueuePlaybackChunk(playbackId: String, chunkIndex: Int, pcmBase64: String) {
      player.enqueue(playbackId, chunkIndex, pcmBase64)
    }

    fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      player.finish(playbackId, finalChunkIndex)
    }

    fun cancelPlayback(playbackId: String) {
      player.cancel(playbackId)
      T3VoiceStateStore.setPlayback(null)
      stopRuntimeForeground()
    }

    fun prepareRealtimeSession(
      nativeSessionId: String,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      check(T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        "The voice runtime is already in use."
      }
      try {
        realtime.prepare(nativeSessionId, callback)
      } catch (cause: Throwable) {
        stopRuntimeForeground()
        throw cause
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

    fun setAudioRoute(nativeSessionId: String, routeId: String): List<Map<String, Any>> =
      realtime.selectRoute(nativeSessionId, routeId)
  }

  private val binder = VoiceBinder()
  private lateinit var recorder: T3VoiceRecorder
  private lateinit var player: T3VoicePcmPlayer
  private val realtimeDelegate =
    lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
      T3VoiceWebRtcSession(
        context = applicationContext,
        onStateChanged = { sessionId, connectionState, muted ->
          val ended = connectionState == "closed" || connectionState == "failed"
          T3VoiceStateStore.setRealtime(
            sessionId = if (ended) null else sessionId,
            connectionState = connectionState,
            muted = muted,
          )
          if (ended) stopRuntimeForeground()
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
      )
    }
  private val realtime: T3VoiceWebRtcSession
    get() = realtimeDelegate.value

  override fun onCreate() {
    super.onCreate()
    recorder = T3VoiceRecorder(applicationContext)
    player =
      T3VoicePcmPlayer(
        onChunkConsumed = { playbackId, chunkIndex ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.PlaybackChunkConsumed(playbackId, chunkIndex),
          )
        },
        onFinished = { playbackId ->
          if (T3VoiceStateStore.state.value.activePlaybackId == playbackId) {
            T3VoiceStateStore.setPlayback(null)
            stopRuntimeForeground()
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
          T3VoiceStateStore.setPlayback(null)
          stopRuntimeForeground()
        },
      )
    createNotificationChannel()
    T3VoiceStateStore.setServiceReady()
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> stopActiveOperation()
      ACTION_START_RECORDING -> startRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      ACTION_START_PLAYBACK ->
        startRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      ACTION_START_REALTIME ->
        startRuntimeForeground(
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      else -> stopSelf(startId)
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

  private fun stopActiveOperation() {
    val state = T3VoiceStateStore.state.value
    state.activeRecordingId?.let {
      runCatching { recorder.cancel(it) }
      T3VoiceStateStore.setRecording(null)
    }
    state.activePlaybackId?.let {
      runCatching { player.cancel(it) }
      T3VoiceStateStore.setPlayback(null)
    }
    state.activeRealtimeSessionId?.let {
      runCatching { realtime.stop(it) }
      T3VoiceStateStore.setRealtime(null, "closed", state.realtimeMuted)
    }
    stopRuntimeForeground()
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

    fun startForRecording(context: Context) {
      start(context, ACTION_START_RECORDING)
    }

    fun startForPlayback(context: Context) {
      start(context, ACTION_START_PLAYBACK)
    }

    fun startForRealtime(context: Context) {
      start(context, ACTION_START_REALTIME)
    }

    fun requestStop(context: Context) {
      start(context, ACTION_STOP)
    }

    private fun start(context: Context, action: String) {
      val intent = Intent(context, T3VoiceRuntimeService::class.java).setAction(action)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
