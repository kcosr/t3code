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

internal fun interface VoiceMediaDriverListener {
  fun onMediaEvent(event: VoiceMediaDriverEvent)
}

internal interface VoiceMediaDriverFactory<Recorder, Player, Focus, Cues, Router, Realtime> {
  fun createRecorder(listener: VoiceMediaDriverListener): Recorder
  fun createPlayer(listener: VoiceMediaDriverListener): Player
  fun createFocus(listener: VoiceMediaDriverListener): Focus
  fun createCues(): Cues
  fun createRouter(listener: VoiceMediaDriverListener): Router
  fun createRealtime(router: Router, listener: VoiceMediaDriverListener): Realtime
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
  val cues: Cues = factory.createCues()
  val recorder: Recorder = factory.createRecorder(listener)
  val player: Player = factory.createPlayer(listener)
  val focus: Focus = factory.createFocus(listener)

  private val realtimeDelegate = lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
    factory.createRealtime(factory.createRouter(listener), listener)
  }
  val realtime: Realtime
    get() = realtimeDelegate.value

  fun release() {
    factory.releaseRecorder(recorder)
    factory.releasePlayer(player)
    factory.releaseCues(cues)
    factory.releaseFocus(focus)
    if (realtimeDelegate.isInitialized()) factory.releaseRealtime(realtime)
  }
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
  private var focusActions: ((List<T3VoiceAudioFocusAction>) -> Unit)? = null
  private var routeChanged: ((T3VoiceAudioRouteChange) -> Unit)? = null

  override fun createRecorder(listener: VoiceMediaDriverListener) =
    T3VoiceRecorder(applicationContext) { listener.onMediaEvent(VoiceMediaDriverEvent.RecorderTerminated(it)) }

  override fun createPlayer(listener: VoiceMediaDriverListener) = T3VoicePcmPlayer(
    onChunkConsumed = { playbackId, chunkIndex ->
      listener.onMediaEvent(VoiceMediaDriverEvent.PcmChunkConsumed(playbackId, chunkIndex))
    },
    onFinished = { listener.onMediaEvent(VoiceMediaDriverEvent.PcmFinished(it)) },
    onError = { playbackId, cause ->
      listener.onMediaEvent(VoiceMediaDriverEvent.PcmFailed(playbackId, cause))
    },
  )

  override fun createFocus(listener: VoiceMediaDriverListener) = T3VoicePlaybackAudioFocus(
    applicationContext,
    onSuspend = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusSuspended) },
    onResume = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusResumed) },
    onTerminate = { listener.onMediaEvent(VoiceMediaDriverEvent.PlaybackFocusTerminated) },
  )

  override fun createCues() = T3VoiceCueCoordinator()

  override fun createRouter(listener: VoiceMediaDriverListener): T3VoiceAudioRouter {
    return T3VoiceAudioRouter(
      applicationContext,
      onFocusActions = { actions -> focusActions?.invoke(actions) },
      onRouteChanged = { change -> routeChanged?.invoke(change) },
    )
  }

  override fun createRealtime(
    router: T3VoiceAudioRouter,
    listener: VoiceMediaDriverListener,
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
    focusActions = realtime::handleAudioFocusActions
    routeChanged = realtime::handleAudioRouteChanged
    return realtime
  }

  override fun releaseRecorder(recorder: T3VoiceRecorder) = recorder.release()
  override fun releasePlayer(player: T3VoicePcmPlayer) = player.release()
  override fun releaseCues(cues: T3VoiceCueCoordinator) = cues.release()
  override fun releaseFocus(focus: T3VoicePlaybackAudioFocus) = focus.stop()
  override fun releaseRealtime(realtime: T3VoiceWebRtcSession) = realtime.release()
}
