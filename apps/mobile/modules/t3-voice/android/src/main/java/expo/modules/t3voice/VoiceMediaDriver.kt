package expo.modules.t3voice

import android.content.Context

internal sealed interface VoiceMediaDriverEvent {
  data class RecorderTerminated(
    val termination: T3VoiceRecordingTermination,
  ) : VoiceMediaDriverEvent

  data class PcmChunkConsumed(
    val playbackId: String,
    val chunkIndex: Int,
  ) : VoiceMediaDriverEvent

  data class PcmFinished(val playbackId: String) : VoiceMediaDriverEvent

  data class PcmFailed(
    val playbackId: String,
    val cause: Throwable,
  ) : VoiceMediaDriverEvent

  data object PlaybackFocusSuspended : VoiceMediaDriverEvent
  data object PlaybackFocusResumed : VoiceMediaDriverEvent
  data object PlaybackFocusTerminated : VoiceMediaDriverEvent

  data class RealtimeStateChanged(
    val sessionId: String,
    val connectionState: String,
    val muted: Boolean,
    val inputReady: Boolean,
  ) : VoiceMediaDriverEvent

  data class RealtimeRouteChanged(
    val sessionId: String,
    val change: T3VoiceAudioRouteChange,
  ) : VoiceMediaDriverEvent

  data class RealtimeAudioFocusChanged(
    val sessionId: String,
    val change: Int,
  ) : VoiceMediaDriverEvent

  data class RealtimeAudioDevicesChanged(
    val sessionId: String,
  ) : VoiceMediaDriverEvent

  data class RealtimeError(
    val sessionId: String,
    val code: String,
    val message: String,
    val recoverable: Boolean,
  ) : VoiceMediaDriverEvent

  data class RealtimeTerminated(
    val sessionId: String,
    val outcome: String,
    val code: String,
    val retryable: Boolean,
    val diagnosticGeneration: Long,
  ) : VoiceMediaDriverEvent
}

internal interface VoiceRawMediaDriverListener {
  fun onMediaEvent(event: VoiceMediaDriverEvent)

  fun onMediaEvent(epoch: VoiceKernelEpoch, event: VoiceMediaDriverEvent)
}

internal fun interface VoiceMediaDriverListener {
  fun onMediaEvent(epoch: VoiceKernelEpoch, event: VoiceMediaDriverEvent)
}

internal interface VoiceMediaDriverFactory<Recorder, Player, Focus, Cues, Router, Realtime> {
  fun createRecorder(listener: VoiceRawMediaDriverListener): Recorder
  fun createPlayer(listener: VoiceRawMediaDriverListener): Player
  fun createFocus(listener: VoiceRawMediaDriverListener): Focus
  fun createCues(): Cues
  fun createRouter(listener: VoiceRawMediaDriverListener): Router
  fun createRealtime(router: Router, listener: VoiceRawMediaDriverListener): Realtime
  fun releaseRecorder(recorder: Recorder)
  fun releasePlayer(player: Player)
  fun releaseCues(cues: Cues)
  fun releaseFocus(focus: Focus)
  fun releaseRealtime(realtime: Realtime)
}

/** Owns media component construction and preserves synchronized-lazy WebRTC initialization. */
internal class VoiceMediaDriver<Recorder, Player, Focus, Cues, Router, Realtime>(
  private val listener: VoiceMediaDriverListener,
  private val factory: VoiceMediaDriverFactory<Recorder, Player, Focus, Cues, Router, Realtime>,
) {
  private val recordingEpochs = java.util.concurrent.ConcurrentHashMap<String, VoiceKernelEpoch>()
  private val playbackEpochs = java.util.concurrent.ConcurrentHashMap<String, VoiceKernelEpoch>()
  private val realtimeEpochs = java.util.concurrent.ConcurrentHashMap<String, VoiceKernelEpoch>()
  @Volatile private var playbackFocusEpoch: VoiceKernelEpoch? = null
  private val rawListener = object : VoiceRawMediaDriverListener {
    override fun onMediaEvent(event: VoiceMediaDriverEvent) {
      val epoch = epochFor(event)
      if (epoch == null) {
        T3VoiceDiagnostics.record(
          generation = 0,
          category = T3VoiceDiagnosticCategory.KERNEL,
          code = T3VoiceDiagnosticCode.STALE_DRIVER_RESULT,
          primaryCount = VoiceKernelEpochStalenessDimension.ROOT_OPERATION.ordinal + 1,
        )
        return
      }
      listener.onMediaEvent(epoch, event)
    }

    override fun onMediaEvent(epoch: VoiceKernelEpoch, event: VoiceMediaDriverEvent) {
      listener.onMediaEvent(epoch, event)
    }
  }

  val cues: Cues = factory.createCues()
  val recorder: Recorder = factory.createRecorder(rawListener)
  val player: Player = factory.createPlayer(rawListener)
  val focus: Focus = factory.createFocus(rawListener)

  private val realtimeDelegate = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    factory.createRealtime(factory.createRouter(rawListener), rawListener)
  }
  val realtime: Realtime
    get() = realtimeDelegate.value

  fun armRecording(recordingId: String, epoch: VoiceKernelEpoch) {
    recordingEpochs[recordingId] = epoch
  }

  fun armPlayback(playbackId: String, epoch: VoiceKernelEpoch) {
    playbackEpochs[playbackId] = epoch
    playbackFocusEpoch = epoch
  }

  fun armRealtime(sessionId: String, epoch: VoiceKernelEpoch) {
    realtimeEpochs[sessionId] = epoch
  }

  fun disarmRecording(recordingId: String) {
    recordingEpochs.remove(recordingId)
  }

  fun disarmPlayback(playbackId: String) {
    playbackEpochs.remove(playbackId)
  }

  fun disarmRealtime(sessionId: String) {
    realtimeEpochs.remove(sessionId)
  }

  fun release() {
    factory.releaseRecorder(recorder)
    factory.releasePlayer(player)
    factory.releaseCues(cues)
    factory.releaseFocus(focus)
    if (realtimeDelegate.isInitialized()) factory.releaseRealtime(realtime)
  }

  /** Null for a disarmed (retired-root) id: the callback is dropped at the driver boundary. */
  private fun epochFor(event: VoiceMediaDriverEvent): VoiceKernelEpoch? =
    when (event) {
      is VoiceMediaDriverEvent.RecorderTerminated -> recordingEpochs[event.termination.recordingId()]
      is VoiceMediaDriverEvent.PcmChunkConsumed -> playbackEpochs[event.playbackId]
      is VoiceMediaDriverEvent.PcmFinished -> playbackEpochs[event.playbackId]
      is VoiceMediaDriverEvent.PcmFailed -> playbackEpochs[event.playbackId]
      VoiceMediaDriverEvent.PlaybackFocusSuspended,
      VoiceMediaDriverEvent.PlaybackFocusResumed,
      VoiceMediaDriverEvent.PlaybackFocusTerminated,
      -> playbackFocusEpoch
      is VoiceMediaDriverEvent.RealtimeStateChanged -> realtimeEpochs[event.sessionId]
      is VoiceMediaDriverEvent.RealtimeRouteChanged -> realtimeEpochs[event.sessionId]
      is VoiceMediaDriverEvent.RealtimeAudioFocusChanged -> realtimeEpochs[event.sessionId]
      is VoiceMediaDriverEvent.RealtimeAudioDevicesChanged -> realtimeEpochs[event.sessionId]
      is VoiceMediaDriverEvent.RealtimeError -> realtimeEpochs[event.sessionId]
      is VoiceMediaDriverEvent.RealtimeTerminated -> realtimeEpochs[event.sessionId]
    }
}

private fun T3VoiceRecordingTermination.recordingId(): String = when (this) {
  is T3VoiceRecordingTermination.Completed -> recording.recordingId
  is T3VoiceRecordingTermination.Cancelled -> recordingId
  is T3VoiceRecordingTermination.Failed -> recordingId
}

internal class AndroidVoiceMediaDriverFactory(
  context: Context,
) : VoiceMediaDriverFactory<
  T3VoiceRecorder,
  T3VoicePcmPlayer,
  T3VoicePlaybackAudioFocus,
  T3VoiceCueCoordinator,
  T3VoiceAudioRouter,
  T3VoiceWebRtcSession
> {
  private val applicationContext = context.applicationContext
  override fun createRecorder(listener: VoiceRawMediaDriverListener) =
    T3VoiceRecorder(applicationContext) { listener.onMediaEvent(VoiceMediaDriverEvent.RecorderTerminated(it)) }

  override fun createPlayer(listener: VoiceRawMediaDriverListener) = T3VoicePcmPlayer(
    onChunkConsumed = { playbackId, chunkIndex ->
      listener.onMediaEvent(VoiceMediaDriverEvent.PcmChunkConsumed(playbackId, chunkIndex))
    },
    onFinished = { listener.onMediaEvent(VoiceMediaDriverEvent.PcmFinished(it)) },
    onError = { playbackId, cause ->
      listener.onMediaEvent(VoiceMediaDriverEvent.PcmFailed(playbackId, cause))
    },
  )

  override fun createFocus(listener: VoiceRawMediaDriverListener) = T3VoicePlaybackAudioFocus(
    applicationContext,
    onSuspend = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusSuspended) },
    onResume = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusResumed) },
    onTerminate = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusTerminated) },
  )

  override fun createCues() = T3VoiceCueCoordinator()

  override fun createRouter(listener: VoiceRawMediaDriverListener): T3VoiceAudioRouter {
    return T3VoiceAudioRouter(
      applicationContext,
      onFocusChanged = { epoch, sessionId, change ->
        listener.onMediaEvent(
          epoch,
          VoiceMediaDriverEvent.RealtimeAudioFocusChanged(sessionId, change),
        )
      },
      onAudioDevicesChanged = { epoch, sessionId ->
        listener.onMediaEvent(
          epoch,
          VoiceMediaDriverEvent.RealtimeAudioDevicesChanged(sessionId),
        )
      },
      onRouteChanged = { epoch, sessionId, change ->
        listener.onMediaEvent(
          epoch,
          VoiceMediaDriverEvent.RealtimeRouteChanged(sessionId, change),
        )
      },
    )
  }

  override fun createRealtime(
    router: T3VoiceAudioRouter,
    listener: VoiceRawMediaDriverListener,
  ): T3VoiceWebRtcSession {
    val realtime = T3VoiceWebRtcSession(
      context = applicationContext,
      audioRouter = router,
      onStateChanged = { sessionId, state, muted, inputReady ->
        listener.onMediaEvent(
          VoiceMediaDriverEvent.RealtimeStateChanged(sessionId, state, muted, inputReady),
        )
      },
      onRouteChanged = { sessionId, change ->
        listener.onMediaEvent(VoiceMediaDriverEvent.RealtimeRouteChanged(sessionId, change))
      },
      onError = { sessionId, code, message, recoverable ->
        listener.onMediaEvent(
          VoiceMediaDriverEvent.RealtimeError(sessionId, code, message, recoverable),
        )
      },
      onTerminated = { sessionId, outcome, code, retryable, generation ->
        listener.onMediaEvent(
          VoiceMediaDriverEvent.RealtimeTerminated(sessionId, outcome, code, retryable, generation),
        )
      },
    )
    return realtime
  }

  override fun releaseRecorder(recorder: T3VoiceRecorder) = recorder.release()
  override fun releasePlayer(player: T3VoicePcmPlayer) = player.release()
  override fun releaseCues(cues: T3VoiceCueCoordinator) = cues.release()
  override fun releaseFocus(focus: T3VoicePlaybackAudioFocus) = focus.stop()
  override fun releaseRealtime(realtime: T3VoiceWebRtcSession) = realtime.release()
}
