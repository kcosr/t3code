package expo.modules.t3voice

import android.content.Context
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Service-owned concrete runtime. It owns one shared audio router and one instance of each native
 * media primitive, while mode sessions own only in-memory control state and HTTP credentials.
 */
internal class T3VoiceNativeRuntimeDriver(
  context: Context,
  private val callback: (generation: Long, callback: T3VoiceRuntimeCallback) -> Unit,
) : T3VoiceRuntimeDriver {
  private val lock = Any()
  private val applicationContext = context.applicationContext
  private val realtimeThreadTransfer = T3VoiceRealtimeThreadTransfer()
  private var realtimeSession: T3VoiceRealtimeSession? = null
  private var threadSession: T3VoiceThreadSession? = null
  private var shutdownStarted = false
  private val sharedMediaReleased = AtomicBoolean(false)
  private lateinit var webRtc: T3VoiceWebRtcSession
  private val audioRouter =
    T3VoiceAudioRouter(
      applicationContext,
      ::handleAudioFocusActions,
      ::handleAudioRouteChanged,
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

  init {
    webRtc =
      T3VoiceWebRtcSession(
        context = applicationContext,
        onStateChanged = { sessionId, connectionState, _ ->
          synchronized(lock) { realtimeSession }
            ?.onWebRtcStateChanged(sessionId, connectionState)
        },
        onRouteChanged = { _, _ ->
          synchronized(lock) { realtimeSession }?.onAudioRouteChanged()
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
    if (policy.drainsPlayout) session.closeAfterPlayoutDrain() else session.close()
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

  override fun setRealtimeAudioRoute(generation: Long, routeId: String) {
    requireRealtime(generation).setAudioRoute(routeId)
  }

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
    audioRouter.stop()
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
    }
  }

  private fun handleAudioRouteChanged(change: T3VoiceAudioRouteChange) {
    val realtime = synchronized(lock) { realtimeSession }
    if (realtime != null) webRtc.handleAudioRouteChanged(change)
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

/** Single-use credential transfer slot for the in-process Realtime-to-Thread mode switch. */
internal class T3VoiceRetainedNativeSession {
  private var value: T3VoiceNativeSessionConfig? = null

  @Synchronized
  fun retain(session: T3VoiceNativeSessionConfig) {
    check(value == null) { "A native session credential is already retained." }
    value = session
  }

  @Synchronized
  fun consume(): T3VoiceNativeSessionConfig? = value.also { value = null }

  @Synchronized
  fun clear() {
    value = null
  }

  @Synchronized
  internal fun hasValueForTest(): Boolean = value != null
}

/** Correlates the one narrow credential transfer with close/cancel races. */
internal class T3VoiceRealtimeThreadTransfer {
  private val retained = T3VoiceRetainedNativeSession()
  private var generation: Long? = null
  private var preserve = false

  @Synchronized
  fun begin(ownerGeneration: Long, preserveForThread: Boolean) {
    generation = ownerGeneration
    preserve = preserveForThread
    if (!preserveForThread) retained.clear()
  }

  @Synchronized
  fun complete(ownerGeneration: Long, session: T3VoiceNativeSessionConfig) {
    if (generation == ownerGeneration && preserve) retained.retain(session) else retained.clear()
    preserve = false
  }

  @Synchronized
  fun cancel(ownerGeneration: Long) {
    if (generation != ownerGeneration) return
    preserve = false
    generation = null
    retained.clear()
  }

  @Synchronized
  fun consume(): T3VoiceNativeSessionConfig? = retained.consume().also { generation = null }

  @Synchronized
  fun clear() {
    generation = null
    preserve = false
    retained.clear()
  }

  @Synchronized
  internal fun hasValueForTest(): Boolean = retained.hasValueForTest()
}
