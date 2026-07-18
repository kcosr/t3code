package expo.modules.t3voice

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceThreadSessionLifecycleTest {
  @Test
  fun `one shot Thread lifecycle transcribes edited review submits plays and stops`() {
    val media = LifecycleMedia()
    val api = LifecycleApi()
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    lateinit var voice: T3VoiceThreadSession
    voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          when (callback) {
            T3VoiceRuntimeCallback.ThreadRecordingFinalized -> voice.uploadAndTranscribe()
            is T3VoiceRuntimeCallback.ThreadTranscriptReady ->
              voice.submitTranscript("edited review transcript")
            T3VoiceRuntimeCallback.ThreadSubmitted -> voice.waitForResponse()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> voice.startPlayback()
            T3VoiceRuntimeCallback.ThreadPlaybackFinished -> voice.stop(reportStopped = true)
            else -> Unit
          }
        },
        onQuiesced = { terminal ->
          terminal?.let(callbacks::add)
          quiesced.countDown()
        },
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()
    assertTrue(media.playbackPrepared.await(2, TimeUnit.SECONDS))
    val playbackId = media.completePlayback()
    assertTrue(voice.onPlaybackFinished(playbackId))
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))

    assertEquals(
      listOf(
        T3VoiceRuntimeCallback.ThreadRecordingStarted,
        T3VoiceRuntimeCallback.ThreadRecordingFinalized,
        T3VoiceRuntimeCallback.ThreadTranscriptReady("draft transcript"),
        T3VoiceRuntimeCallback.ThreadSubmitted,
        T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = true),
        T3VoiceRuntimeCallback.ThreadPlaybackFinished,
        T3VoiceRuntimeCallback.ThreadStopped,
      ),
      callbacks,
    )
    assertEquals(
      listOf(T3VoiceMediaOperation.TRANSCRIPTION, T3VoiceMediaOperation.SPEECH),
      api.ticketOperations,
    )
    assertEquals(listOf("edited review transcript"), api.submittedTranscripts)
    assertEquals(api.dispatchedMessageId.get(), api.requestedResponseMessageId.get())
    assertEquals(1, media.deletedRecordings.size)
    assertEquals(checkNotNull(media.finishedRecording.get()), media.deletedRecordings.single())
    assertEquals(0, media.finalPlaybackChunkIndex.get())
  }

  @Test
  fun `manual no input skips transcription and remains an ordinary cycle outcome`() {
    val media = LifecycleMedia(finishAsNoInput = true)
    val api = LifecycleApi()
    val noInput = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    lateinit var voice: T3VoiceThreadSession
    voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadRecordingFinalized) {
            voice.uploadAndTranscribe()
          }
          if (callback == T3VoiceRuntimeCallback.ThreadNoSpeechDetected) noInput.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()

    assertTrue(noInput.await(1, TimeUnit.SECONDS))
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadRecordingFinalized })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertTrue(api.ticketOperations.isEmpty())
    assertTrue(media.deletedRecordings.isEmpty())

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `blank defensive transcription becomes no input and deletes media once`() {
    val media = LifecycleMedia()
    val api = BlankTranscriptionApi()
    val noInput = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    lateinit var voice: T3VoiceThreadSession
    voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadRecordingFinalized) {
            voice.uploadAndTranscribe()
          }
          if (callback == T3VoiceRuntimeCallback.ThreadNoSpeechDetected) noInput.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()

    assertTrue(noInput.await(1, TimeUnit.SECONDS))
    assertTrue(media.recordingDeleted.await(1, TimeUnit.SECONDS))
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.ThreadTranscriptReady })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(1, media.deletedRecordings.size)
    assertEquals(checkNotNull(media.finishedRecording.get()), media.deletedRecordings.single())

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(1, media.deletedRecordings.size)
  }

  @Test
  fun `recoverable transcription failure reports a cycle failure without terminating the session`() {
    val media = LifecycleMedia()
    val cycleFailed = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    lateinit var voice: T3VoiceThreadSession
    voice =
      session(
        generation = 1,
        media = media,
        api = FailingTranscriptionApi(),
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadRecordingFinalized) {
            voice.uploadAndTranscribe()
          }
          if (callback is T3VoiceRuntimeCallback.ThreadCycleFailed) cycleFailed.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()

    assertTrue(cycleFailed.await(1, TimeUnit.SECONDS))
    assertEquals(1L, quiesced.count)
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    voice.rearmRecording()
    assertTrue(media.secondRecordingStarted.await(1, TimeUnit.SECONDS))

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `ambiguous submission failure remains terminal and never becomes a cycle failure`() {
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    val terminal = AtomicReference<T3VoiceRuntimeCallback?>()
    val voice =
      session(
        generation = 1,
        media = LifecycleMedia(),
        api = AmbiguousSubmissionApi(),
        emit = callbacks::add,
        onQuiesced = { callback ->
          terminal.set(callback)
          quiesced.countDown()
        },
      )

    voice.submitTranscript("dispatch once")

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    val failed = terminal.get() as T3VoiceRuntimeCallback.Failed
    assertEquals("submission-ambiguous", failed.failure.code)
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.ThreadCycleFailed })
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadSubmitted })
  }

  @Test
  fun `retryable Thread dispatch reuses one idempotency identity and emits one submission`() {
    val api = RetryableDispatchApi()
    val submitted = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = LifecycleMedia(),
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadSubmitted) submitted.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.submitTranscript("submit exactly once")

    assertTrue(submitted.await(2, TimeUnit.SECONDS))
    assertEquals(2, api.attempts.size)
    assertEquals(1, api.attempts.map(DispatchAttempt::commandId).distinct().size)
    assertEquals(1, api.attempts.map(DispatchAttempt::messageId).distinct().size)
    assertEquals(1, api.attempts.map(DispatchAttempt::createdAt).distinct().size)
    assertEquals(
      listOf("submit exactly once", "submit exactly once"),
      api.attempts.map(DispatchAttempt::transcript),
    )
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadSubmitted })

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `stop waits for blocked transcription and deletes its recording exactly once`() {
    val media = LifecycleMedia()
    val api = BlockingPhaseApi(block = BlockingPhase.TRANSCRIPTION)
    val finalized = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadRecordingFinalized) finalized.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()
    assertTrue(finalized.await(1, TimeUnit.SECONDS))
    voice.uploadAndTranscribe()
    assertTrue(api.entered.await(1, TimeUnit.SECONDS))

    voice.stop(reportStopped = false)
    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    api.allowReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(listOf(checkNotNull(media.finishedRecording.get())), media.deletedRecordings)
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.ThreadTranscriptReady })
  }

  @Test
  fun `stop waits for blocked dispatch without publishing submission`() {
    val api = BlockingPhaseApi(block = BlockingPhase.DISPATCH)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = LifecycleMedia(),
        api = api,
        emit = callbacks::add,
        onQuiesced = { quiesced.countDown() },
      )

    voice.submitTranscript("blocked dispatch")
    assertTrue(api.entered.await(1, TimeUnit.SECONDS))

    voice.stop(reportStopped = false)
    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    api.allowReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadSubmitted })
  }

  @Test
  fun `Ready CANCELLED still opens the recorder when the session is live`() {
    val media = LifecycleMedia()
    val arming = ScriptedCueArming(T3VoiceCueOutcome.CANCELLED)
    val voice =
      session(
        generation = 1,
        media = media,
        api = LifecycleApi(),
        emit = {},
        onQuiesced = {},
        cueArming = arming,
      )

    voice.start()
    assertTrue(media.recordingStarted.await(1, TimeUnit.SECONDS))
    assertEquals(1, arming.readyRequests.get())
    voice.stop(reportStopped = true)
  }

  @Test
  fun `Ready completion after stop does not open the recorder`() {
    val media = LifecycleMedia()
    val arming = DeferredCueArming()
    val quiesced = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = media,
        api = LifecycleApi(),
        emit = {},
        onQuiesced = { quiesced.countDown() },
        cueArming = arming,
      )

    voice.start()
    assertTrue(arming.readyRequested.await(1, TimeUnit.SECONDS))
    assertEquals(1, arming.readyRequests.get())
    // stop() cancels the pending Ready (CANCELLED completion); session is inactive so openRecorder is skipped.
    voice.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertFalse(media.recordingStarted.await(150, TimeUnit.MILLISECONDS))
  }

  @Test
  fun `stop waits for blocked response polling without publishing response`() {
    val api = BlockingPhaseApi(block = BlockingPhase.RESPONSE)
    val submitted = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val quiesced = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = LifecycleMedia(),
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadSubmitted) submitted.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.submitTranscript("wait for this response")
    assertTrue(submitted.await(1, TimeUnit.SECONDS))
    voice.waitForResponse()
    assertTrue(api.entered.await(1, TimeUnit.SECONDS))

    voice.stop(reportStopped = false)
    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    api.allowReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.ThreadResponseReady })
  }

  private fun session(
    generation: Long,
    media: T3VoiceThreadMedia,
    api: T3VoiceThreadSessionApi,
    emit: (T3VoiceRuntimeCallback) -> Unit,
    onQuiesced: (T3VoiceRuntimeCallback?) -> Unit,
    cueArming: T3VoiceCueArming = NoOpCueArming,
  ): T3VoiceThreadSession =
    T3VoiceThreadSession(
      generation = generation,
      start = START,
      config = SESSION,
      media = media,
      emit = emit,
      onQuiesced = onQuiesced,
      cueArming = cueArming,
      api = api,
    )

  private class ScriptedCueArming(
    private val readyOutcome: T3VoiceCueOutcome,
  ) : T3VoiceCueArming {
    val readyRequests = AtomicInteger(0)

    override fun isEnabled(): Boolean = true

    override fun setEnabled(enabled: Boolean): T3VoiceCueSettings = T3VoiceCueSettings(enabled)

    override fun settings(): T3VoiceCueSettings = T3VoiceCueSettings(enabled = true)

    override fun requestReady(
      generation: Long,
      completion: (T3VoiceCueCompletion) -> Unit,
    ): Boolean {
      readyRequests.incrementAndGet()
      completion(
        T3VoiceCueCompletion(
          generation = generation,
          cue = T3VoiceCue.READY,
          outcome = readyOutcome,
        ),
      )
      return true
    }

    override fun requestEnded(generation: Long) = Unit

    override fun cancel(generation: Long) = Unit

    override fun cancelAll() = Unit

    override fun release() = Unit
  }

  private class DeferredCueArming : T3VoiceCueArming {
    val readyRequests = AtomicInteger(0)
    private val pending = AtomicReference<((T3VoiceCueCompletion) -> Unit)?>(null)
    private val generationRef = AtomicReference(0L)

    override fun isEnabled(): Boolean = true

    override fun setEnabled(enabled: Boolean): T3VoiceCueSettings = T3VoiceCueSettings(enabled)

    override fun settings(): T3VoiceCueSettings = T3VoiceCueSettings(enabled = true)

    override fun requestReady(
      generation: Long,
      completion: (T3VoiceCueCompletion) -> Unit,
    ): Boolean {
      readyRequests.incrementAndGet()
      generationRef.set(generation)
      pending.set(completion)
      return true
    }

    fun complete(outcome: T3VoiceCueOutcome) {
      val completion = checkNotNull(pending.getAndSet(null))
      completion(
        T3VoiceCueCompletion(
          generation = generationRef.get(),
          cue = T3VoiceCue.READY,
          outcome = outcome,
        ),
      )
    }

    override fun requestEnded(generation: Long) = Unit

    override fun cancel(generation: Long) {
      complete(T3VoiceCueOutcome.CANCELLED)
    }

    override fun cancelAll() = Unit

    override fun release() = Unit
  }

  private class LifecycleMedia(
    private val finishAsNoInput: Boolean = false,
  ) : T3VoiceThreadMedia {
    val recordingStarted = CountDownLatch(1)
    val secondRecordingStarted = CountDownLatch(1)
    val recordingDeleted = CountDownLatch(1)
    val playbackPrepared = CountDownLatch(1)
    val deletedRecordings = CopyOnWriteArrayList<T3VoiceRecordingResult>()
    val finalPlaybackChunkIndex = AtomicInteger(-1)
    val finishedRecording = AtomicReference<T3VoiceRecordingResult?>()
    private val recordingStartCount = AtomicInteger(0)
    private val activeRecording = AtomicReference<String?>()
    private val activePlayback = AtomicReference<String?>()

    override fun acquireAudio(): Boolean = true

    override fun releaseAudio() = Unit

    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      check(activeRecording.compareAndSet(null, recordingId))
      when (recordingStartCount.incrementAndGet()) {
        1 -> recordingStarted.countDown()
        2 -> secondRecordingStarted.countDown()
      }
    }

    override fun finishRecording(recordingId: String): T3VoiceThreadRecordingFinish {
      check(activeRecording.compareAndSet(recordingId, null))
      if (finishAsNoInput) return T3VoiceRecordingNoInput(recordingId)
      return T3VoiceRecordingResult(
        recordingId = recordingId,
        uri = "file:///$recordingId.m4a",
        durationMs = 1_000,
        byteLength = 4_096,
      ).also { check(finishedRecording.compareAndSet(null, it)) }
    }

    override fun cancelRecording(recordingId: String) {
      check(activeRecording.compareAndSet(recordingId, null))
    }

    override fun deleteRecording(recording: T3VoiceRecordingResult) {
      deletedRecordings += recording
      recordingDeleted.countDown()
    }

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      check(activePlayback.compareAndSet(null, playbackId))
    }

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) {
      check(activePlayback.get() == playbackId)
      check(chunkIndex == 0)
      check(pcm.contentEquals(byteArrayOf(1, 2)))
    }

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      check(activePlayback.get() == playbackId)
      finalPlaybackChunkIndex.set(finalChunkIndex)
      playbackPrepared.countDown()
    }

    override fun cancelPlayback(playbackId: String) {
      check(activePlayback.compareAndSet(playbackId, null))
    }

    override fun pausePlayback(playbackId: String) = Unit

    override fun resumePlayback(playbackId: String) = Unit

    fun completePlayback(): String = checkNotNull(activePlayback.getAndSet(null))
  }

  private class LifecycleApi : ThreadApiAdapter() {
    val ticketOperations = CopyOnWriteArrayList<T3VoiceMediaOperation>()
    val submittedTranscripts = CopyOnWriteArrayList<String>()
    val dispatchedMessageId = AtomicReference<String?>()
    val requestedResponseMessageId = AtomicReference<String?>()

    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ): T3VoiceMediaTicket {
      ticketOperations += operation
      return T3VoiceMediaTicket("ticket-$requestId", "2099-01-01T00:00:00Z")
    }

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = "draft transcript"

    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long {
      submittedTranscripts += transcript
      check(dispatchedMessageId.compareAndSet(null, messageId))
      return 1
    }

    override fun getMessageTurn(
      calls: T3VoiceHttpCallRegistry,
      threadId: String,
      messageId: String,
    ): T3VoiceMessageTurn {
      check(requestedResponseMessageId.compareAndSet(null, messageId))
      return T3VoiceMessageTurn(
        messageId = messageId,
        state = T3VoiceMessageTurnState.COMPLETED,
        turnId = "turn-lifecycle",
        assistantMessage =
          T3VoiceAssistantMessage("assistant-lifecycle", "spoken assistant response"),
      )
    }

    override fun synthesize(
      calls: T3VoiceHttpCallRegistry,
      ticket: T3VoiceMediaTicket,
      requestId: String,
      playbackId: String,
      segment: T3VoiceSpeechSegment,
      onPcm: T3VoiceHttpChunkCallback,
    ): Long {
      onPcm.onChunk(byteArrayOf(1, 2))
      return 2
    }
  }

  private class BlankTranscriptionApi : ThreadApiAdapter() {
    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ) = T3VoiceMediaTicket("blank-ticket", "2099-01-01T00:00:00Z")

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = "   "
  }

  private class FailingTranscriptionApi : ThreadApiAdapter() {
    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ) = T3VoiceMediaTicket("failing-ticket", "2099-01-01T00:00:00Z")

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = throw T3VoiceNativeApiException("transcription-timeout", retryable = true)
  }

  private class AmbiguousSubmissionApi : ThreadApiAdapter() {
    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long = throw T3VoiceNativeApiException("submission-ambiguous", retryable = false)
  }

  private data class DispatchAttempt(
    val transcript: String,
    val commandId: String,
    val messageId: String,
    val createdAt: String,
  )

  private class RetryableDispatchApi : ThreadApiAdapter() {
    val attempts = CopyOnWriteArrayList<DispatchAttempt>()

    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long {
      attempts += DispatchAttempt(transcript, commandId, messageId, createdAt)
      if (attempts.size == 1) {
        throw T3VoiceNativeApiException("temporary-dispatch-failure", retryable = true)
      }
      return 1
    }
  }

  private enum class BlockingPhase {
    TRANSCRIPTION,
    DISPATCH,
    RESPONSE,
  }

  private class BlockingPhaseApi(
    private val block: BlockingPhase,
  ) : ThreadApiAdapter() {
    val entered = CountDownLatch(1)
    val allowReturn = CountDownLatch(1)

    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ) = T3VoiceMediaTicket("blocking-ticket", "2099-01-01T00:00:00Z")

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String {
      check(block == BlockingPhase.TRANSCRIPTION)
      blockUntilReleased()
      return "late transcript"
    }

    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long {
      if (block == BlockingPhase.DISPATCH) blockUntilReleased()
      return 1
    }

    override fun getMessageTurn(
      calls: T3VoiceHttpCallRegistry,
      threadId: String,
      messageId: String,
    ): T3VoiceMessageTurn {
      check(block == BlockingPhase.RESPONSE)
      blockUntilReleased()
      return T3VoiceMessageTurn(
        messageId = messageId,
        state = T3VoiceMessageTurnState.COMPLETED,
        turnId = "late-turn",
        assistantMessage = T3VoiceAssistantMessage("late-assistant", "late response"),
      )
    }

    private fun blockUntilReleased() {
      entered.countDown()
      var interrupted = false
      while (true) {
        try {
          allowReturn.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  private abstract class ThreadApiAdapter : T3VoiceThreadSessionApi {
    open override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ): T3VoiceMediaTicket = error("Media tickets are not used by this test.")

    open override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = error("Transcription is not used by this test.")

    open override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long = error("Thread dispatch is not used by this test.")

    open override fun getMessageTurn(
      calls: T3VoiceHttpCallRegistry,
      threadId: String,
      messageId: String,
    ): T3VoiceMessageTurn = error("Response polling is not used by this test.")

    open override fun synthesize(
      calls: T3VoiceHttpCallRegistry,
      ticket: T3VoiceMediaTicket,
      requestId: String,
      playbackId: String,
      segment: T3VoiceSpeechSegment,
      onPcm: T3VoiceHttpChunkCallback,
    ): Long = error("Synthesis is not used by this test.")
  }

  private companion object {
    val SESSION =
      T3VoiceNativeSessionConfig(
        baseUrl = "https://environment.example.test",
        accessToken = "native-token",
        expiresAt = "2099-01-01T00:00:00Z",
      )
    val START =
      T3VoiceThreadStart(
        target =
          T3VoiceThreadTarget(
            environmentId = "environment-a",
            projectId = "project-a",
            threadId = "thread-a",
            modelSelection =
              T3VoiceModelSelection(
                instanceId = "codex",
                model = "gpt-5.4",
                options = null,
              ),
            runtimeMode = T3VoiceThreadRuntimeMode.FULL_ACCESS,
            interactionMode = T3VoiceThreadInteractionMode.DEFAULT,
          ),
        settings =
          T3VoiceThreadSettings(
            submissionPolicy = T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT,
            playResponses = true,
            autoRearm = true,
            endpointDetection =
              T3VoiceThreadEndpointDetection(
                endSilenceMs = 900,
                noSpeechTimeoutMs = 10_000,
                maximumUtteranceMs = 120_000,
              ),
            rearmDelayMs = 750,
            transcriptionTimeoutMs = 600_000,
            submissionTimeoutMs = 30_000,
            responseTimeoutMs = 600_000,
          ),
      )
  }
}
