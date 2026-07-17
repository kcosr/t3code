package expo.modules.t3voice

import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/** One in-memory Thread voice cycle owner. No state in this class survives process termination. */
internal class T3VoiceThreadSession(
  val generation: Long,
  private val start: T3VoiceThreadStart,
  config: T3VoiceNativeSessionConfig,
  private val media: T3VoiceThreadMedia,
  private val emit: (T3VoiceRuntimeCallback) -> Unit,
  private val onQuiesced: (T3VoiceRuntimeCallback?) -> Unit,
  private val api: T3VoiceThreadSessionApi = T3VoiceNativeVoiceApi(config),
  private val nowIso: () -> String = T3VoiceTime::nowIso,
  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
  private val stopQuiescenceWaitMs: Long = DEFAULT_STOP_QUIESCENCE_WAIT_MS,
) {
  private enum class MediaOwner {
    NONE,
    STARTING_RECORDING,
    RECORDING,
    STARTING_PLAYBACK,
    PLAYBACK,
  }

  private sealed interface TerminalOutcome {
    data object Stopped : TerminalOutcome

    data object Released : TerminalOutcome

    data class Failed(val failure: T3VoiceFailure) : TerminalOutcome
  }

  private val lock = Any()
  private val terminatedMediaExecutors = AtomicInteger(0)
  private val terminalCompleted = AtomicBoolean(false)
  private val controlExecutor =
    T3VoiceQuiescingExecutor("t3-voice-thread-control-$generation", ::mediaExecutorTerminated)
  private val speechExecutor =
    T3VoiceQuiescingExecutor("t3-voice-thread-speech-$generation", ::mediaExecutorTerminated)
  private val active = AtomicBoolean(true)
  private val currentCalls = AtomicReference<T3VoiceHttpCallRegistry?>()
  private var terminalOutcome: TerminalOutcome? = null
  private var scheduledRearm: ScheduledFuture<*>? = null
  private var mediaOwner = MediaOwner.NONE
  private var recordingId: String? = null
  private val completedRecording = T3VoiceCompletedRecordingSlot(::deleteRecording)
  private var submittedMessageId: String? = null
  private var assistantText: String? = null
  private var playbackId: String? = null
  private var pcmSink: T3VoicePcmStreamSink? = null
  private var playbackFocusSuspended = false
  private var inFlightMediaCallbacks = 0

  init {
    require(stopQuiescenceWaitMs >= 0) { "stopQuiescenceWaitMs must be non-negative." }
  }

  fun start() = startRecording()

  fun rearmRecording() = startRecording()

  fun finishRecording() {
    controlExecutor.execute {
      if (!active.get()) return@execute
      val alreadyFinalized = completedRecording.current()
      if (alreadyFinalized != null) {
        emitIfActive(T3VoiceRuntimeCallback.ThreadRecordingFinalized)
        return@execute
      }
      try {
        val id = synchronized(lock) { checkNotNull(recordingId) }
        val result = media.finishRecording(id)
        val retained =
          synchronized(lock) {
            recordingId = null
            mediaOwner = MediaOwner.NONE
            if (active.get()) {
              val existing = completedRecording.current()
              if (existing == null) {
                completedRecording.store(result)
              } else {
                check(existing == result) {
                  "Recorder finalization returned a different completed recording."
                }
              }
              true
            } else {
              false
            }
          }
        if (!retained) {
          deleteRecording(result)
          return@execute
        }
        media.releaseAudio()
        emitIfActive(T3VoiceRuntimeCallback.ThreadRecordingFinalized)
      } catch (cause: Throwable) {
        fail(cause, "recording-finalization-failed", "Voice recording could not be finalized.")
      }
    }
  }

  fun uploadAndTranscribe() {
    controlExecutor.execute {
      if (!active.get()) return@execute
      val recording = completedRecording.current()
        ?: return@execute fail(
          IllegalStateException("No finalized recording."),
          "recording-missing",
          "The voice recording was unavailable.",
        )
      try {
        val transcript =
          withBoundedCalls(start.settings.transcriptionTimeoutMs, "transcription-timeout") { calls ->
            val requestId = UUID.randomUUID().toString()
            val ticket = api.createMediaTicket(calls, T3VoiceMediaOperation.TRANSCRIPTION, requestId)
            api.transcribe(calls, recording, requestId, ticket)
          }
        emitIfActive(T3VoiceRuntimeCallback.ThreadTranscriptReady(transcript))
      } catch (cause: Throwable) {
        fail(cause, "transcription-failed", "Voice transcription failed.")
      } finally {
        completedRecording.delete(recording)
      }
    }
  }

  fun submitTranscript(transcript: String) {
    controlExecutor.execute {
      if (!active.get()) return@execute
      val commandId = UUID.randomUUID().toString()
      val messageId = UUID.randomUUID().toString()
      val createdAt = nowIso()
      try {
        withBoundedCalls(start.settings.submissionTimeoutMs, "submission-timeout") { calls ->
          retryUntilDeadline(start.settings.submissionTimeoutMs) {
            api.dispatchThreadTurn(
              calls = calls,
              target = start.target,
              transcript = transcript,
              commandId = commandId,
              messageId = messageId,
              createdAt = createdAt,
            )
          }
        }
        synchronized(lock) { submittedMessageId = messageId }
        emitIfActive(T3VoiceRuntimeCallback.ThreadSubmitted)
      } catch (cause: Throwable) {
        fail(cause, "submission-failed", "The Thread message could not be submitted.")
      }
    }
  }

  fun waitForResponse() {
    controlExecutor.execute {
      if (!active.get()) return@execute
      val messageId = synchronized(lock) { submittedMessageId }
        ?: return@execute fail(
          IllegalStateException("No submitted message."),
          "submission-missing",
          "The submitted Thread message was unavailable.",
        )
      val deadlineNanos = System.nanoTime() +
        TimeUnit.MILLISECONDS.toNanos(start.settings.responseTimeoutMs)
      var attention: T3VoiceThreadAttention? = null
      try {
        val response =
          withBoundedCalls(start.settings.responseTimeoutMs, "response-timeout") { calls ->
            while (active.get() && System.nanoTime() < deadlineNanos) {
              val outcome =
                readThreadOutcomeWithRetry(
                  deadlineNanos = deadlineNanos,
                  isActive = active::get,
                  nowNanos = System::nanoTime,
                  sleep = ::sleepInterruptibly,
                ) {
                  api.getMessageTurn(calls, start.target.threadId, messageId)
                }
              when (outcome.state) {
                T3VoiceMessageTurnState.PENDING,
                T3VoiceMessageTurnState.RUNNING,
                -> {
                  if (attention != null) {
                    attention = null
                    emitIfActive(T3VoiceRuntimeCallback.ThreadAttentionChanged(null))
                  }
                  sleepPollingDelay()
                }
                T3VoiceMessageTurnState.APPROVAL_REQUIRED -> {
                  if (attention != T3VoiceThreadAttention.APPROVAL_REQUIRED) {
                    attention = T3VoiceThreadAttention.APPROVAL_REQUIRED
                    emitIfActive(T3VoiceRuntimeCallback.ThreadAttentionChanged(attention))
                  }
                  sleepPollingDelay()
                }
                T3VoiceMessageTurnState.USER_INPUT_REQUIRED -> {
                  if (attention != T3VoiceThreadAttention.USER_INPUT_REQUIRED) {
                    attention = T3VoiceThreadAttention.USER_INPUT_REQUIRED
                    emitIfActive(T3VoiceRuntimeCallback.ThreadAttentionChanged(attention))
                  }
                  sleepPollingDelay()
                }
                T3VoiceMessageTurnState.COMPLETED ->
                  return@withBoundedCalls outcome.assistantMessage?.text?.takeIf(String::isNotBlank)
                T3VoiceMessageTurnState.INTERRUPTED ->
                  throw T3VoiceNativeApiException("thread-interrupted", retryable = true)
                T3VoiceMessageTurnState.FAILED ->
                  throw T3VoiceNativeApiException("thread-failed", retryable = true)
                T3VoiceMessageTurnState.AMBIGUOUS ->
                  throw T3VoiceNativeApiException("thread-ambiguous", retryable = true)
              }
            }
            throw T3VoiceNativeApiException("response-timeout", retryable = true)
          }
        synchronized(lock) { assistantText = response }
        if (attention != null) {
          emitIfActive(T3VoiceRuntimeCallback.ThreadAttentionChanged(null))
        }
        emitIfActive(T3VoiceRuntimeCallback.ThreadResponseReady(response != null))
      } catch (cause: Throwable) {
        fail(cause, "response-failed", "Waiting for the Thread response failed.")
      }
    }
  }

  fun startPlayback() {
    speechExecutor.execute {
      if (!active.get()) return@execute
      val response = synchronized(lock) { assistantText }
        ?: return@execute fail(
          IllegalStateException("No assistant response."),
          "playback-response-missing",
          "The assistant response was unavailable for playback.",
        )
      val segments = T3VoiceSpeechSegmenter.segment(response)
      val id = UUID.randomUUID().toString()
      val sink = T3VoicePcmStreamSink(id, media::enqueueOwnedPlaybackPcm)
      try {
        synchronized(lock) {
          check(active.get()) { "Thread voice session stopped." }
          check(mediaOwner == MediaOwner.NONE) { "Thread media is already active." }
          playbackId = id
          pcmSink = sink
          playbackFocusSuspended = false
          mediaOwner = MediaOwner.STARTING_PLAYBACK
        }
        check(media.acquireAudio()) {
          "Android denied playback audio focus."
        }
        media.startPlayback(id, SPEECH_SAMPLE_RATE, SPEECH_CHANNEL_COUNT)
        val focusSuspended =
          synchronized(lock) {
            if (
              active.get() &&
                playbackId == id &&
                mediaOwner == MediaOwner.STARTING_PLAYBACK
            ) {
              mediaOwner = MediaOwner.PLAYBACK
              playbackFocusSuspended
            } else {
              null
            }
          }
        if (focusSuspended == null) {
          sink.cancel()
          runCatching { media.cancelPlayback(id) }
          media.releaseAudio()
          return@execute
        }
        if (focusSuspended) media.pausePlayback(id)
        withBoundedCalls(MAXIMUM_PLAYBACK_MILLIS, "playback-timeout") { calls ->
          segments.forEach { segment ->
            check(active.get()) { "Playback stopped." }
            val requestId = UUID.randomUUID().toString()
            val ticket = api.createMediaTicket(calls, T3VoiceMediaOperation.SPEECH, requestId)
            api.synthesize(calls, ticket, requestId, id, segment, sink::accept)
          }
        }
        check(active.get()) { "Playback stopped." }
        media.finishPlayback(id, sink.finish())
      } catch (cause: Throwable) {
        sink.cancel()
        runCatching { media.cancelPlayback(id) }
        synchronized(lock) {
          if (playbackId == id) {
            playbackId = null
            pcmSink = null
            playbackFocusSuspended = false
            mediaOwner = MediaOwner.NONE
          }
        }
        media.releaseAudio()
        fail(cause, "playback-failed", "Assistant response playback failed.")
      }
    }
  }

  fun scheduleRearm(delayMs: Long) {
    if (!active.get()) return
    synchronized(lock) {
      scheduledRearm?.cancel(false)
      scheduledRearm =
        scheduler.schedule(
          { emitIfActive(T3VoiceRuntimeCallback.ThreadRearmReady) },
          delayMs,
          TimeUnit.MILLISECONDS,
        )
    }
  }

  fun onRecorderTerminated(termination: T3VoiceRecordingTermination): Boolean {
    val terminationId =
      when (termination) {
        is T3VoiceRecordingTermination.Completed -> termination.recording.recordingId
        is T3VoiceRecordingTermination.Cancelled -> termination.recordingId
        is T3VoiceRecordingTermination.Failed -> termination.recordingId
      }
    synchronized(lock) {
      if (!active.get() || recordingId != terminationId) return false
      recordingId = null
      mediaOwner = MediaOwner.NONE
      if (termination is T3VoiceRecordingTermination.Completed) {
        completedRecording.store(termination.recording)
      }
      inFlightMediaCallbacks += 1
    }
    try {
      media.releaseAudio()
      when (termination) {
        is T3VoiceRecordingTermination.Completed ->
          emitIfActive(T3VoiceRuntimeCallback.ThreadEndpointDetected)
        is T3VoiceRecordingTermination.Cancelled ->
          emitIfActive(T3VoiceRuntimeCallback.ThreadNoSpeechDetected)
        is T3VoiceRecordingTermination.Failed ->
          fail(
            IllegalStateException("Recorder finalization failed."),
            "recording-finalization-failed",
            "Voice recording could not be finalized.",
          )
      }
    } finally {
      mediaCallbackFinished()
    }
    return true
  }

  fun onPlaybackChunkConsumed(id: String, chunkIndex: Int): Boolean {
    val sink = synchronized(lock) { pcmSink?.takeIf { playbackId == id } } ?: return false
    sink.consumed(chunkIndex)
    return true
  }

  fun onPlaybackFinished(id: String): Boolean {
    synchronized(lock) {
      if (!active.get() || playbackId != id) return false
      playbackId = null
      pcmSink = null
      playbackFocusSuspended = false
      mediaOwner = MediaOwner.NONE
      inFlightMediaCallbacks += 1
    }
    try {
      media.releaseAudio()
      emitIfActive(T3VoiceRuntimeCallback.ThreadPlaybackFinished)
    } finally {
      mediaCallbackFinished()
    }
    return true
  }

  fun onPlaybackError(id: String, cause: Throwable): Boolean {
    val owned = synchronized(lock) { playbackId == id }
    if (!owned) return false
    fail(cause, "pcm-playback-failed", "Assistant response playback failed.")
    return true
  }

  fun onAudioFocusActions(actions: List<T3VoiceAudioFocusAction>) {
    val owner = synchronized(lock) { mediaOwner }
    when (owner) {
      MediaOwner.STARTING_RECORDING,
      MediaOwner.RECORDING -> {
        if (
          T3VoiceAudioFocusAction.MUTE_CAPTURE in actions ||
            T3VoiceAudioFocusAction.TERMINATE_SESSION in actions
        ) {
          fail(
            T3VoiceNativeApiException("thread-audio-focus-lost", retryable = true),
            "thread-audio-focus-lost",
            "Thread recording lost audio focus.",
          )
        }
      }
      MediaOwner.STARTING_PLAYBACK,
      MediaOwner.PLAYBACK -> {
        if (T3VoiceAudioFocusAction.TERMINATE_SESSION in actions) {
          fail(
            T3VoiceNativeApiException("thread-audio-focus-lost", retryable = true),
            "thread-audio-focus-lost",
            "Thread playback lost audio focus.",
          )
          return
        }
        val id =
          synchronized(lock) {
            when (mediaOwner) {
              MediaOwner.STARTING_PLAYBACK -> {
                if (T3VoiceAudioFocusAction.PAUSE_PLAYBACK in actions) {
                  playbackFocusSuspended = true
                }
                if (T3VoiceAudioFocusAction.RESUME_PLAYBACK in actions) {
                  playbackFocusSuspended = false
                }
                null
              }
              MediaOwner.PLAYBACK -> {
                if (T3VoiceAudioFocusAction.PAUSE_PLAYBACK in actions) {
                  playbackFocusSuspended = true
                }
                if (T3VoiceAudioFocusAction.RESUME_PLAYBACK in actions) {
                  playbackFocusSuspended = false
                }
                playbackId
              }
              else -> null
            }
          } ?: return
        actions.forEach { action ->
          when (action) {
            T3VoiceAudioFocusAction.PAUSE_PLAYBACK -> runCatching { media.pausePlayback(id) }
            T3VoiceAudioFocusAction.RESUME_PLAYBACK -> runCatching { media.resumePlayback(id) }
            T3VoiceAudioFocusAction.TERMINATE_SESSION -> Unit
            T3VoiceAudioFocusAction.MUTE_CAPTURE,
            T3VoiceAudioFocusAction.UNMUTE_CAPTURE,
            -> Unit
          }
        }
      }
      MediaOwner.NONE -> Unit
    }
  }

  fun stop(reportStopped: Boolean) {
    terminate(
      if (reportStopped) TerminalOutcome.Stopped else TerminalOutcome.Released,
    )
  }

  private fun startRecording() {
    controlExecutor.execute {
      if (!active.get()) return@execute
      val id = UUID.randomUUID().toString()
      try {
        synchronized(lock) {
          check(active.get()) { "Thread voice session stopped." }
          check(mediaOwner == MediaOwner.NONE) { "Thread media is already active." }
          recordingId = id
          mediaOwner = MediaOwner.STARTING_RECORDING
        }
        check(media.acquireAudio()) {
          "Android denied recording audio focus."
        }
        media.startRecording(
          id,
          T3VoiceEndpointDetectionConfig(
            endSilenceMs = start.settings.endpointDetection.endSilenceMs,
            noSpeechTimeoutMs = start.settings.endpointDetection.noSpeechTimeoutMs,
            maximumUtteranceMs = start.settings.endpointDetection.maximumUtteranceMs,
          ),
        )
        val retained =
          synchronized(lock) {
            if (
              active.get() &&
                recordingId == id &&
                mediaOwner == MediaOwner.STARTING_RECORDING
            ) {
              completedRecording.delete()
              submittedMessageId = null
              assistantText = null
              mediaOwner = MediaOwner.RECORDING
              true
            } else {
              false
            }
          }
        if (!retained) {
          runCatching { media.cancelRecording(id) }
          media.releaseAudio()
          return@execute
        }
        emitIfActive(T3VoiceRuntimeCallback.ThreadRecordingStarted)
      } catch (cause: Throwable) {
        media.releaseAudio()
        fail(cause, "recording-start-failed", "Voice recording could not start.")
      }
    }
  }

  private fun <T> withBoundedCalls(
    timeoutMs: Long,
    timeoutCode: String,
    block: (T3VoiceHttpCallRegistry) -> T,
  ): T {
    check(active.get()) { "Thread voice session stopped." }
    val calls = T3VoiceHttpCallRegistry()
    check(currentCalls.compareAndSet(null, calls)) { "A Thread network operation is already active." }
    val timedOut = AtomicBoolean(false)
    val timeout =
      scheduler.schedule(
        {
          timedOut.set(true)
          calls.cancelAll()
        },
        timeoutMs,
        TimeUnit.MILLISECONDS,
      )
    return try {
      block(calls)
    } catch (cause: T3VoiceNativeApiException) {
      if (timedOut.get()) {
        throw T3VoiceNativeApiException(timeoutCode, retryable = true)
      }
      throw cause
    } finally {
      timeout.cancel(false)
      currentCalls.compareAndSet(calls, null)
    }
  }

  private fun <T> retryUntilDeadline(timeoutMs: Long, action: () -> T): T {
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
    var delayMs = INITIAL_RETRY_DELAY_MS
    while (true) {
      try {
        return action()
      } catch (cause: T3VoiceNativeApiException) {
        if (!cause.retryable || System.nanoTime() >= deadline || !active.get()) throw cause
        sleepInterruptibly(minOf(delayMs, remainingMillis(deadline)))
        delayMs = (delayMs * 2).coerceAtMost(MAXIMUM_RETRY_DELAY_MS)
      }
    }
  }

  private fun sleepPollingDelay() = sleepInterruptibly(THREAD_OUTCOME_POLL_DELAY_MS)

  private fun sleepInterruptibly(delayMs: Long) {
    if (delayMs <= 0 || !active.get()) return
    Thread.sleep(delayMs)
    check(active.get()) { "Thread voice session stopped." }
  }

  private fun remainingMillis(deadlineNanos: Long): Long =
    TimeUnit.NANOSECONDS.toMillis((deadlineNanos - System.nanoTime()).coerceAtLeast(0))

  private fun fail(cause: Throwable, fallbackCode: String, message: String) {
    val apiFailure = cause as? T3VoiceNativeApiException
    terminate(
      TerminalOutcome.Failed(
        T3VoiceFailure(
          code = safeFailureCode(apiFailure?.code, fallbackCode),
          message = message,
          recoverable = apiFailure?.retryable ?: true,
        ),
      ),
    )
  }

  private fun terminate(outcome: TerminalOutcome) {
    if (!active.compareAndSet(true, false)) return
    synchronized(lock) {
      check(terminalOutcome == null) { "Thread session already has a terminal outcome." }
      terminalOutcome = outcome
    }
    beginCleanup()
    awaitMediaQuiescence()
  }

  /**
   * Interrupts cancellable work immediately. A start call already inside an Android media API may
   * publish ownership after this first sweep, so the terminal callback is deferred until both
   * serial media executors have terminated and a second sweep has run.
   */
  private fun beginCleanup() {
    runCatching { currentCalls.getAndSet(null)?.cancelAll() }
    scheduler.shutdownNow()
    cancelOwnedMedia()
    controlExecutor.shutdownNow()
    speechExecutor.shutdownNow()
  }

  private fun cancelOwnedMedia() {
    val rearm: ScheduledFuture<*>?
    val sink: T3VoicePcmStreamSink?
    val activeRecording: String?
    val activePlayback: String?
    synchronized(lock) {
      rearm = scheduledRearm.also { scheduledRearm = null }
      sink = pcmSink.also { pcmSink = null }
      activeRecording = recordingId.also { recordingId = null }
      activePlayback = playbackId.also { playbackId = null }
      playbackFocusSuspended = false
      mediaOwner = MediaOwner.NONE
    }
    rearm?.cancel(false)
    sink?.cancel()
    if (activeRecording != null) runCatching { media.cancelRecording(activeRecording) }
    completedRecording.delete()
    if (activePlayback != null) runCatching { media.cancelPlayback(activePlayback) }
    runCatching { media.releaseAudio() }
  }

  private fun awaitMediaQuiescence() {
    if (stopQuiescenceWaitMs == 0L) return
    if (controlExecutor.ownsCurrentThread() || speechExecutor.ownsCurrentThread()) return
    val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(stopQuiescenceWaitMs)
    try {
      for (executor in listOf(controlExecutor, speechExecutor)) {
        val remaining = deadline - System.nanoTime()
        if (remaining <= 0L) return
        executor.awaitTermination(remaining)
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  private fun mediaExecutorTerminated() {
    terminatedMediaExecutors.incrementAndGet()
    tryCompleteTerminal()
  }

  /** External recorder/player callbacks must quiesce before their generation releases its slot. */
  private fun mediaCallbackFinished() {
    val terminalReady =
      synchronized(lock) {
        check(inFlightMediaCallbacks > 0) { "Thread media callback ownership underflow." }
        inFlightMediaCallbacks -= 1
        !active.get() && inFlightMediaCallbacks == 0
      }
    if (terminalReady) tryCompleteTerminal()
  }

  private fun tryCompleteTerminal() {
    if (terminatedMediaExecutors.get() != MEDIA_EXECUTOR_COUNT) return
    if (synchronized(lock) { inFlightMediaCallbacks != 0 }) return
    if (!terminalCompleted.compareAndSet(false, true)) return
    cancelOwnedMedia()
    val outcome = synchronized(lock) { checkNotNull(terminalOutcome) }
    val callback =
      when (outcome) {
        TerminalOutcome.Stopped -> T3VoiceRuntimeCallback.ThreadStopped
        TerminalOutcome.Released -> null
        is TerminalOutcome.Failed -> T3VoiceRuntimeCallback.Failed(outcome.failure)
      }
    onQuiesced(callback)
  }

  private fun deleteRecording(recording: T3VoiceRecordingResult) {
    runCatching { media.deleteRecording(recording) }
  }

  private fun emitIfActive(callback: T3VoiceRuntimeCallback) {
    if (active.get()) emit(callback)
  }

  private companion object {
    const val SPEECH_SAMPLE_RATE = 24_000
    const val SPEECH_CHANNEL_COUNT = 1
    const val INITIAL_RETRY_DELAY_MS = 250L
    const val MAXIMUM_RETRY_DELAY_MS = 2_000L
    const val MAXIMUM_PLAYBACK_MILLIS = 15L * 60L * 1_000L
    const val DEFAULT_STOP_QUIESCENCE_WAIT_MS = 100L
    const val MEDIA_EXECUTOR_COUNT = 2
  }
}

/** A single worker whose termination hook runs only after its last task has fully returned. */
private class T3VoiceQuiescingExecutor(
  threadName: String,
  onTerminated: () -> Unit,
) {
  private val workerThread = AtomicReference<Thread?>()
  private val delegate =
    object : ThreadPoolExecutor(
      1,
      1,
      0L,
      TimeUnit.MILLISECONDS,
      LinkedBlockingQueue(),
      { runnable -> Thread(runnable, threadName).also(workerThread::set) },
    ) {
      override fun terminated() {
        try {
          onTerminated()
        } finally {
          super.terminated()
        }
      }
    }

  fun execute(action: () -> Unit) = delegate.execute(action)

  fun shutdownNow() = delegate.shutdownNow()

  @Throws(InterruptedException::class)
  fun awaitTermination(timeoutNanos: Long): Boolean =
    delegate.awaitTermination(timeoutNanos, TimeUnit.NANOSECONDS)

  fun ownsCurrentThread(): Boolean = workerThread.get() === Thread.currentThread()
}

internal fun safeFailureCode(value: String?, fallback: String): String =
  value?.takeIf { FAILURE_CODE.matches(it) } ?: fallback

private val FAILURE_CODE = Regex("^[a-z0-9][a-z0-9_-]{0,63}$")
