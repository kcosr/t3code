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
  private val cueArming: T3VoiceCueArming = NoOpCueArming,
  private val api: T3VoiceThreadSessionApi = T3VoiceNativeVoiceApi(config),
  private val nowIso: () -> String = T3VoiceTime::nowIso,
  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
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
  private val cleanupExecutor =
    Executors.newSingleThreadExecutor { runnable ->
      Thread(runnable, "t3-voice-thread-cleanup-$generation")
    }
  private val active = AtomicBoolean(true)
  private val currentCalls = AtomicReference<T3VoiceHttpCallRegistry?>()
  private var terminalOutcome: TerminalOutcome? = null
  private var scheduledRearm: ScheduledFuture<*>? = null
  private var mediaOwner = MediaOwner.NONE
  private var recordingId: String? = null
  private var noInputRecordingId: String? = null
  private val completedRecording = T3VoiceCompletedRecordingSlot(::deleteRecording)
  private var submittedMessageId: String? = null
  private var assistantText: String? = null
  private var playbackId: String? = null
  private var pcmSink: T3VoicePcmStreamSink? = null
  private var playbackFocusSuspended = false
  private var inFlightMediaCallbacks = 0
  /** Set when Skip arrives before [playbackId] is assigned (WAITING→PLAYING handoff). */
  private var skipPending = false
  /** Playback id that has been asked to skip; cleared at the next recording cycle. */
  private var skipRequestedPlaybackId: String? = null

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
        val id = synchronized(lock) { recordingId } ?: return@execute
        when (val finish = media.finishRecording(id)) {
          is T3VoiceRecordingNoInput -> {
            val publish =
              synchronized(lock) {
                if (noInputRecordingId == id) {
                  false
                } else {
                  recordingId = null
                  mediaOwner = MediaOwner.NONE
                  noInputRecordingId = id
                  active.get()
                }
              }
            if (publish) {
              media.releaseAudio()
              emitIfActive(T3VoiceRuntimeCallback.ThreadNoSpeechDetected)
            }
          }
          is T3VoiceRecordingResult -> {
            val retained =
              synchronized(lock) {
                recordingId = null
                mediaOwner = MediaOwner.NONE
                if (active.get()) {
                  val existing = completedRecording.current()
                  if (existing == null) {
                    completedRecording.store(finish)
                  } else {
                    check(existing == finish) {
                      "Recorder finalization returned a different completed recording."
                    }
                  }
                  true
                } else {
                  false
                }
              }
            if (!retained) {
              deleteRecording(finish)
              return@execute
            }
            media.releaseAudio()
            emitIfActive(T3VoiceRuntimeCallback.ThreadRecordingFinalized)
          }
        }
      } catch (cause: Throwable) {
        synchronized(lock) {
          recordingId = null
          mediaOwner = MediaOwner.NONE
        }
        media.releaseAudio()
        failCycle(cause, "recording-finalization-failed", "Voice recording could not be finalized.")
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
        if (transcript.isBlank()) {
          emitIfActive(T3VoiceRuntimeCallback.ThreadNoSpeechDetected)
        } else {
          emitIfActive(T3VoiceRuntimeCallback.ThreadTranscriptReady(transcript))
        }
      } catch (cause: Throwable) {
        failCycle(cause, "transcription-failed", "Voice transcription failed.")
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
          // Interrupt or stop may already own release; only release if we still claim the id.
          if (claimPlaybackOwnership(id)) {
            media.releaseAudio()
          }
          return@execute
        }
        // Consume Skip that arrived during WAITING→PLAYING / STARTING_PLAYBACK.
        val skipAfterEstablish =
          synchronized(lock) {
            if (skipPending || skipRequestedPlaybackId == id) {
              skipPending = false
              skipRequestedPlaybackId = id
              true
            } else {
              false
            }
          }
        if (skipAfterEstablish) {
          sink.cancel()
          runCatching { media.cancelPlayback(id) }
          if (claimPlaybackOwnership(id)) {
            media.releaseAudio()
            emitIfActive(T3VoiceRuntimeCallback.ThreadPlaybackFinished)
          }
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
        // Intentional skip must not surface as a terminal playback failure.
        val skipped = synchronized(lock) { skipRequestedPlaybackId == id }
        if (claimPlaybackOwnership(id)) {
          media.releaseAudio()
          if (skipped) {
            emitIfActive(T3VoiceRuntimeCallback.ThreadPlaybackFinished)
          } else {
            fail(cause, "playback-failed", "Assistant response playback failed.")
          }
        }
      }
    }
  }

  /**
   * Cancels the current response playback without tearing down the Thread session.
   * Completes via [T3VoiceRuntimeCallback.ThreadPlaybackFinished] so the controller can rearm
   * or stop according to autoRearm. Idempotent for double headset presses.
   */
  fun interruptPlayback() {
    val id =
      synchronized(lock) {
        if (!active.get()) return
        val current = playbackId
        if (current == null) {
          skipPending = true
          return
        }
        if (
          mediaOwner != MediaOwner.PLAYBACK &&
            mediaOwner != MediaOwner.STARTING_PLAYBACK
        ) {
          return
        }
        if (skipRequestedPlaybackId == current) return
        skipRequestedPlaybackId = current
        inFlightMediaCallbacks += 1
        current
      }
    try {
      synchronized(lock) { pcmSink }?.cancel()
      // Player cancel deliberately fires no onFinished callback — we synthesize completion.
      runCatching { media.cancelPlayback(id) }
      if (claimPlaybackOwnership(id)) {
        media.releaseAudio()
        emitIfActive(T3VoiceRuntimeCallback.ThreadPlaybackFinished)
      }
    } finally {
      mediaCallbackFinished()
    }
  }

  /** Sole gate that nulls playback ownership so exactly one path emits finish/fail. */
  private fun claimPlaybackOwnership(id: String): Boolean =
    synchronized(lock) {
      if (playbackId != id) return false
      playbackId = null
      pcmSink = null
      playbackFocusSuspended = false
      mediaOwner = MediaOwner.NONE
      true
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
      } else if (termination is T3VoiceRecordingTermination.Cancelled) {
        noInputRecordingId = termination.recordingId
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
          failCycle(
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
    val skipped =
      synchronized(lock) {
        if (playbackId != id) return false
        skipRequestedPlaybackId == id
      }
    if (skipped) {
      // Same single-emit gate as interrupt/finish; fence terminal quiescence like onPlaybackFinished.
      synchronized(lock) {
        if (playbackId != id) return true
        inFlightMediaCallbacks += 1
      }
      try {
        if (claimPlaybackOwnership(id)) {
          media.releaseAudio()
          emitIfActive(T3VoiceRuntimeCallback.ThreadPlaybackFinished)
        }
      } finally {
        mediaCallbackFinished()
      }
      return true
    }
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
          // Never let a prior cycle's Skip latch affect the next rearm cycle.
          skipPending = false
          skipRequestedPlaybackId = null
          recordingId = id
          noInputRecordingId = null
          mediaOwner = MediaOwner.STARTING_RECORDING
        }
        // Establish MODE_IN_COMMUNICATION, focus, and the selected route before Ready. Without a
        // live communication output Android can accept the cue PCM while advancing zero frames.
        check(media.acquireAudio()) {
          "Android denied recording audio focus."
        }
        val settleMs =
          if (cueArming.isEnabled()) T3VoiceCueTiming.READY_TO_CAPTURE_SETTLE_MS else 0L
        // Keep STARTING until Ready completes (or cues fail open), then leave a short route settle
        // guard so the cue tail cannot enter the microphone capture.
        cueArming.requestReady(generation) { _ ->
          scheduleOpenRecorder(id, settleMs)
        }
        // terminate() sets active=false before cancelling this generation. If it won that race
        // just before requestReady(), cancel the newly admitted cue here as the matching fence.
        if (!active.get()) cueArming.cancel(generation)
      } catch (cause: Throwable) {
        synchronized(lock) {
          if (recordingId == id) recordingId = null
          mediaOwner = MediaOwner.NONE
        }
        runCatching { media.cancelRecording(id) }
        media.releaseAudio()
        failCycle(cause, "recording-start-failed", "Voice recording could not start.")
      }
    }
  }

  private fun scheduleOpenRecorder(id: String, settleMs: Long) {
    val open = {
      runCatching {
        controlExecutor.execute {
          if (!active.get()) return@execute
          openRecorder(id)
        }
      }
    }
    if (settleMs == 0L) {
      open()
      return
    }
    if (runCatching { scheduler.schedule(open, settleMs, TimeUnit.MILLISECONDS) }.isFailure) {
      // Fail open if the settle scheduler is unavailable while the session is still live.
      open()
    }
  }

  private fun openRecorder(id: String) {
    if (!active.get()) return
    try {
      synchronized(lock) {
        check(active.get()) { "Thread voice session stopped." }
        check(recordingId == id && mediaOwner == MediaOwner.STARTING_RECORDING) {
          "Thread recording arming ownership changed."
        }
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
        return
      }
      emitIfActive(T3VoiceRuntimeCallback.ThreadRecordingStarted)
    } catch (cause: Throwable) {
      synchronized(lock) {
        if (recordingId == id) recordingId = null
        mediaOwner = MediaOwner.NONE
      }
      runCatching { media.cancelRecording(id) }
      media.releaseAudio()
      failCycle(cause, "recording-start-failed", "Voice recording could not start.")
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
    terminate(TerminalOutcome.Failed(failure(cause, fallbackCode, message)))
  }

  private fun failCycle(cause: Throwable, fallbackCode: String, message: String) {
    val failure = failure(cause, fallbackCode, message)
    if (failure.recoverable) {
      emitIfActive(T3VoiceRuntimeCallback.ThreadCycleFailed(failure))
    } else {
      terminate(TerminalOutcome.Failed(failure))
    }
  }

  private fun failure(cause: Throwable, fallbackCode: String, message: String): T3VoiceFailure {
    val apiFailure = cause as? T3VoiceNativeApiException
    return T3VoiceFailure(
      code = safeFailureCode(apiFailure?.code, fallbackCode),
      message = message,
      recoverable = apiFailure?.retryable ?: true,
    )
  }

  private fun terminate(outcome: TerminalOutcome) {
    if (!active.compareAndSet(true, false)) return
    synchronized(lock) {
      check(terminalOutcome == null) { "Thread session already has a terminal outcome." }
      terminalOutcome = outcome
    }
    cueArming.cancel(generation)
    beginCleanup(
      playEnded =
        outcome is TerminalOutcome.Stopped &&
          runCatching { cueArming.isEnabled() }.getOrDefault(false),
    )
  }

  /**
   * Interrupts cancellable work immediately and moves native media release off the caller thread.
   * Android media calls can block while starting or stopping, so neither a bridge call nor a
   * notification/MediaSession callback may wait for them. The terminal callback remains deferred
   * until both serial media executors terminate and the cleanup executor runs a second sweep.
   */
  private fun beginCleanup(playEnded: Boolean) {
    val calls = currentCalls.getAndSet(null)
    scheduler.shutdownNow()
    cleanupExecutor.execute {
      runCatching { calls?.cancelAll() }
      // Stop capture/playback first, then keep (or reacquire) the selected communication route
      // through the bounded Ended drain. This mirrors the Ready fence in the opposite direction.
      cancelOwnedMedia(releaseAudio = !playEnded)
      if (playEnded) {
        val routeAcquired = runCatching { media.acquireAudio() }.getOrDefault(false)
        if (routeAcquired) {
          T3VoiceCueTiming.awaitEnded(cueArming, generation)
        }
        runCatching { media.releaseAudio() }
      }
    }
    controlExecutor.shutdownNow()
    speechExecutor.shutdownNow()
  }

  private fun cancelOwnedMedia(releaseAudio: Boolean = true) {
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
    if (releaseAudio) runCatching { media.releaseAudio() }
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
    cleanupExecutor.execute {
      val callback =
        try {
          cancelOwnedMedia()
          val outcome = synchronized(lock) { checkNotNull(terminalOutcome) }
          when (outcome) {
            TerminalOutcome.Stopped -> T3VoiceRuntimeCallback.ThreadStopped
            TerminalOutcome.Released -> null
            is TerminalOutcome.Failed -> T3VoiceRuntimeCallback.Failed(outcome.failure)
          }
        } finally {
          cleanupExecutor.shutdown()
        }
      onQuiesced(callback)
    }
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
    const val MEDIA_EXECUTOR_COUNT = 2
  }
}

/** A single worker whose termination hook runs only after its last task has fully returned. */
private class T3VoiceQuiescingExecutor(
  threadName: String,
  onTerminated: () -> Unit,
) {
  private val delegate =
    object : ThreadPoolExecutor(
      1,
      1,
      0L,
      TimeUnit.MILLISECONDS,
      LinkedBlockingQueue(),
      { runnable -> Thread(runnable, threadName) },
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
}

internal fun safeFailureCode(value: String?, fallback: String): String =
  value?.takeIf { FAILURE_CODE.matches(it) } ?: fallback

private val FAILURE_CODE = Regex("^[a-z0-9][a-z0-9_-]{0,63}$")
