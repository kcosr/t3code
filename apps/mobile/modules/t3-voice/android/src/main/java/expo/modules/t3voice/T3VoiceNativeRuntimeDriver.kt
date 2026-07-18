package expo.modules.t3voice

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Service-owned concrete runtime. It owns one shared audio router and one instance of each native
 * media primitive, while mode sessions own only in-memory control state and HTTP credentials.
 */
internal class T3VoiceNativeRuntimeDriver(
  context: Context,
  private val callback: (generation: Long, callback: T3VoiceRuntimeCallback) -> Unit,
  private val onUnownedAudioFocusActions: (List<T3VoiceAudioFocusAction>) -> Unit = {},
) : T3VoiceRuntimeDriver {
  private val lock = Any()
  private val applicationContext = context.applicationContext
  private val realtimeThreadTransfer = T3VoiceRealtimeThreadTransfer()
  private var realtimeSession: T3VoiceRealtimeSession? = null
  private var threadSession: T3VoiceThreadSession? = null
  private var shutdownStarted = false
  private val sharedMediaReleased = AtomicBoolean(false)
  private lateinit var audioRoutePreferenceState: MutableStateFlow<T3VoiceAudioRoutePreference>
  private lateinit var webRtc: T3VoiceWebRtcSession
  private val audioRouter =
    T3VoiceAudioRouter(
      applicationContext,
      ::handleAudioFocusActions,
      ::handleAudioRoutePreferenceChanged,
    )
  private val recorder = T3VoiceRecorder(applicationContext, onTerminated = ::handleRecorderTermination)
  private val player =
    T3VoicePcmPlayer(
      onChunkConsumed = { playbackId, chunkIndex ->
        synchronized(lock) { threadSession }
          ?.onPlaybackChunkConsumed(playbackId, chunkIndex)
      },
      onFinished = { playbackId ->
        synchronized(lock) { threadSession }?.onPlaybackFinished(playbackId)
      },
      onError = { playbackId, cause ->
        synchronized(lock) { threadSession }?.onPlaybackError(playbackId, cause)
      },
    )
  private val threadMedia = T3VoiceAndroidThreadMedia(recorder, player, audioRouter)
  private val cueArming: T3VoiceCueArming =
    T3VoiceCueArmingLive(T3VoiceCueSettingsStore(applicationContext))

  init {
    audioRoutePreferenceState = MutableStateFlow(audioRouter.preference())
    webRtc =
      T3VoiceWebRtcSession(
        context = applicationContext,
        onStateChanged = { sessionId, connectionState, _ ->
          synchronized(lock) { realtimeSession }
            ?.onWebRtcStateChanged(sessionId, connectionState)
        },
        onError = { sessionId, code, _, recoverable ->
          synchronized(lock) { realtimeSession }
            ?.onWebRtcError(sessionId, code, recoverable)
        },
        onTerminated = { sessionId, _, code, retryable ->
          synchronized(lock) { realtimeSession }
            ?.onWebRtcTerminated(sessionId, code, retryable)
        },
        sharedAudioRouter = audioRouter,
      )
  }

  fun voiceCuesEnabled(): Boolean = cueArming.isEnabled()

  fun setVoiceCuesEnabled(enabled: Boolean): Map<String, Any?> {
    val next = cueArming.setEnabled(enabled)
    return mapOf(
      "enabled" to next.enabled,
      "generation" to next.generation,
    )
  }

  fun voiceCueStartupPreRollMs(): Int = cueArming.settings().startupPreRollMs

  fun setVoiceCueStartupPreRollMs(startupPreRollMs: Int): Map<String, Any?> {
    val live = cueArming as? T3VoiceCueArmingLive
    val next =
      live?.setStartupPreRollMs(startupPreRollMs) ?: cueArming.settings()
    return mapOf(
      "startupPreRollMs" to next.startupPreRollMs,
      "generation" to next.generation,
    )
  }

  override fun startRealtime(
    generation: Long,
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ) {
    lateinit var created: T3VoiceRealtimeSession
    synchronized(lock) {
      check(!shutdownStarted) { "The native voice runtime is shut down." }
      check(realtimeSession == null && threadSession == null) {
        "A native voice runtime operation is already active."
      }
      realtimeThreadTransfer.clear()
      created =
        T3VoiceRealtimeSession(
          generation = generation,
          target = target,
          sessionConfig = session,
          webRtc = webRtc,
          audioRouter = audioRouter,
          emit = { event -> handleRealtimeCallback(generation, event) },
          onQuiesced = { result -> handleRealtimeQuiesced(created, generation, result) },
          cueArming = cueArming,
        )
      realtimeSession = created
    }
    created.start()
  }

  override fun closeRealtime(
    generation: Long,
    policy: T3VoiceRealtimeClosePolicy,
  ) {
    val session = requireRealtime(generation)
    realtimeThreadTransfer.begin(generation, policy.preservesSessionForThread)
    val handoff = policy.preservesSessionForThread
    if (policy.drainsPlayout) {
      session.closeAfterPlayoutDrain(forHandoff = handoff)
    } else {
      session.close(forHandoff = handoff)
    }
  }

  override fun cancelRealtimeToThreadSwitch(generation: Long) {
    val session =
      synchronized(lock) {
        val current = realtimeSession
        if (current != null && current.generation != generation) return
        realtimeThreadTransfer.cancel(generation)
        current
      }
    session?.close()
  }

  override fun setRealtimeMuted(generation: Long, muted: Boolean) {
    requireRealtime(generation).setMuted(muted)
  }

  fun audioRoutePreference(): T3VoiceAudioRoutePreference = audioRouter.preference()

  val audioRoutePreferences: StateFlow<T3VoiceAudioRoutePreference>
    get() = audioRoutePreferenceState.asStateFlow()

  fun setAudioRoutePreference(route: String): T3VoiceAudioRoutePreference =
    audioRouter.setPreference(route)

  fun acquireLegacyAudio(): Boolean =
    audioRouter.start().transition.state != T3VoiceAudioFocusState.TERMINATED

  fun releaseLegacyAudio() = audioRouter.stop()

  override fun updateRealtimeContext(generation: Long, context: T3VoiceRealtimeContext) {
    requireRealtime(generation).admitContext(context)
  }

  override fun decideRealtimeConfirmation(
    generation: Long,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  ) {
    requireRealtime(generation).decideConfirmation(confirmationId, decision)
  }

  override fun startInitialThread(
    generation: Long,
    start: T3VoiceThreadStart,
    session: T3VoiceNativeSessionConfig,
  ) {
    startThread(generation, start, session)
  }

  override fun startThreadAfterRealtime(generation: Long, start: T3VoiceThreadStart) {
    val session = synchronized(lock) { realtimeThreadTransfer.consume() }
      ?: error("The Realtime session credential was not retained for the Thread switch.")
    startThread(generation, start, session)
  }

  override fun rearmThreadRecording(generation: Long) {
    requireThread(generation).rearmRecording()
  }

  override fun acknowledgeRealtimeClientAction(
    generation: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ) {
    requireRealtime(generation).acknowledgeClientAction(actionId, outcome, message)
  }

  override fun finishThreadRecording(generation: Long) {
    requireThread(generation).finishRecording()
  }

  override fun uploadAndTranscribeThreadRecording(generation: Long) {
    requireThread(generation).uploadAndTranscribe()
  }

  override fun submitThreadTranscript(generation: Long, transcript: String) {
    requireThread(generation).submitTranscript(transcript)
  }

  override fun waitForThreadResponse(generation: Long) {
    requireThread(generation).waitForResponse()
  }

  override fun startThreadPlayback(generation: Long) {
    requireThread(generation).startPlayback()
  }

  override fun cancelThreadPlayback(generation: Long) {
    requireThread(generation).interruptPlayback()
  }

  override fun scheduleThreadRearm(generation: Long, delayMs: Long) {
    requireThread(generation).scheduleRearm(delayMs)
  }

  override fun stopThread(generation: Long) {
    requireThread(generation).stop(reportStopped = true)
  }

  override fun releaseAll(generation: Long): Boolean {
    val realtime: T3VoiceRealtimeSession?
    val thread: T3VoiceThreadSession?
    synchronized(lock) {
      realtime = realtimeSession?.takeIf { it.generation == generation }
      thread = threadSession?.takeIf { it.generation == generation }
      realtimeThreadTransfer.clear()
    }
    realtime?.forceRelease()
    thread?.stop(reportStopped = false)
    audioRouter.stop()
    return realtime != null || thread != null
  }

  fun shutdown() {
    val realtime: T3VoiceRealtimeSession?
    val thread: T3VoiceThreadSession?
    synchronized(lock) {
      shutdownStarted = true
      realtime = realtimeSession
      thread = threadSession
      realtimeThreadTransfer.clear()
    }
    realtime?.forceRelease()
    thread?.stop(reportStopped = false)
    audioRouter.stop()
    if (realtime == null && thread == null) releaseSharedMedia()
  }

  private fun startThread(
    generation: Long,
    start: T3VoiceThreadStart,
    session: T3VoiceNativeSessionConfig,
  ) {
    lateinit var created: T3VoiceThreadSession
    synchronized(lock) {
      check(!shutdownStarted) { "The native voice runtime is shut down." }
      check(realtimeSession == null && threadSession == null) {
        "A native voice runtime operation is already active."
      }
      realtimeThreadTransfer.clear()
      created =
        T3VoiceThreadSession(
          generation = generation,
          start = start,
          config = session,
          media = threadMedia,
          emit = { event -> handleThreadCallback(generation, event) },
          onQuiesced = { event -> handleThreadQuiesced(created, generation, event) },
          cueArming = cueArming,
        )
      threadSession = created
    }
    created.start()
  }

  private fun handleRealtimeCallback(generation: Long, event: T3VoiceRuntimeCallback) {
    synchronized(lock) {
      realtimeSession?.takeIf { it.generation == generation } ?: return
      if (event is T3VoiceRuntimeCallback.Failed) {
        realtimeThreadTransfer.clear()
      }
    }
    callback(generation, event)
  }

  private fun handleRealtimeQuiesced(
    session: T3VoiceRealtimeSession,
    generation: Long,
    result: T3VoiceRealtimeTerminalResult,
  ) {
    val finishShutdown =
      synchronized(lock) {
        if (realtimeSession !== session) return
        realtimeSession = null
        if (
          !result.publishedBeforeQuiescence &&
            result.callback == T3VoiceRuntimeCallback.RealtimeClosed
        ) {
          realtimeThreadTransfer.complete(generation, session.sessionConfig)
        } else {
          realtimeThreadTransfer.clear()
        }
        shutdownStarted && threadSession == null
      }
    when {
      result.publishedBeforeQuiescence ->
        callback(generation, T3VoiceRuntimeCallback.NativeReleaseQuiesced)
      result.callback != null -> callback(generation, result.callback)
      else -> callback(generation, T3VoiceRuntimeCallback.NativeReleaseQuiesced)
    }
    if (finishShutdown) releaseSharedMedia()
  }

  private fun handleThreadCallback(generation: Long, event: T3VoiceRuntimeCallback) {
    synchronized(lock) {
      threadSession?.takeIf { it.generation == generation } ?: return
    }
    callback(generation, event)
  }

  private fun handleThreadQuiesced(
    session: T3VoiceThreadSession,
    generation: Long,
    terminalCallback: T3VoiceRuntimeCallback?,
  ) {
    val finishShutdown =
      synchronized(lock) {
        if (threadSession !== session) return
        threadSession = null
        shutdownStarted
      }
    if (terminalCallback != null) {
      callback(generation, terminalCallback)
    } else {
      callback(generation, T3VoiceRuntimeCallback.NativeReleaseQuiesced)
    }
    if (finishShutdown) releaseSharedMedia()
  }

  private fun releaseSharedMedia() {
    if (!sharedMediaReleased.compareAndSet(false, true)) return
    cueArming.release()
    audioRouter.shutdown()
    recorder.release()
    player.release()
    webRtc.release()
  }

  private fun handleRecorderTermination(termination: T3VoiceRecordingTermination) {
    val handled =
      synchronized(lock) { threadSession }?.onRecorderTerminated(termination) == true
    if (!handled && termination is T3VoiceRecordingTermination.Completed) {
      runCatching {
        recorder.delete(termination.recording.recordingId, termination.recording.uri)
      }
    }
  }

  private fun handleAudioFocusActions(actions: List<T3VoiceAudioFocusAction>) {
    val realtime: T3VoiceRealtimeSession?
    val thread: T3VoiceThreadSession?
    synchronized(lock) {
      realtime = realtimeSession
      thread = threadSession
    }
    when {
      realtime != null -> webRtc.handleAudioFocusActions(actions)
      thread != null -> thread.onAudioFocusActions(actions)
      else -> onUnownedAudioFocusActions(actions)
    }
  }

  private fun handleAudioRoutePreferenceChanged(preference: T3VoiceAudioRoutePreference) {
    if (this::audioRoutePreferenceState.isInitialized) {
      audioRoutePreferenceState.value = preference
    }
  }

  private fun requireRealtime(generation: Long): T3VoiceRealtimeSession =
    synchronized(lock) {
      realtimeSession?.takeIf { it.generation == generation }
        ?: error("No Realtime session owns generation $generation.")
    }

  private fun requireThread(generation: Long): T3VoiceThreadSession =
    synchronized(lock) {
      threadSession?.takeIf { it.generation == generation }
        ?: error("No Thread session owns generation $generation.")
    }
}

/** Correlates the one narrow credential transfer with close/cancel races. */
internal class T3VoiceRealtimeThreadTransfer {
  private var retainedSession: T3VoiceNativeSessionConfig? = null
  private var generation: Long? = null
  private var preserve = false

  @Synchronized
  fun begin(ownerGeneration: Long, preserveForThread: Boolean) {
    generation = ownerGeneration
    preserve = preserveForThread
    if (!preserveForThread) retainedSession = null
  }

  @Synchronized
  fun complete(ownerGeneration: Long, session: T3VoiceNativeSessionConfig) {
    if (generation == ownerGeneration && preserve) {
      check(retainedSession == null) { "A native session credential is already retained." }
      retainedSession = session
    } else {
      retainedSession = null
    }
    preserve = false
  }

  @Synchronized
  fun cancel(ownerGeneration: Long) {
    if (generation != ownerGeneration) return
    preserve = false
    generation = null
    retainedSession = null
  }

  @Synchronized
  fun consume(): T3VoiceNativeSessionConfig? = retainedSession.also {
    retainedSession = null
    generation = null
  }

  @Synchronized
  fun clear() {
    generation = null
    preserve = false
    retainedSession = null
  }

  @Synchronized
  internal fun hasValueForTest(): Boolean = retainedSession != null
}
