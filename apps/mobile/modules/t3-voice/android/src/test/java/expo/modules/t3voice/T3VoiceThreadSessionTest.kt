package expo.modules.t3voice

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceThreadSessionTest {
  @Test
  fun `stale recorder completion after replacement is deleted once without releasing new audio`() {
    val media = GenerationAwareMedia()
    val firstQuiesced = CountDownLatch(1)
    val secondQuiesced = CountDownLatch(1)
    lateinit var second: T3VoiceThreadSession
    val first =
      session(
        generation = 1,
        media = media,
        emit = {},
        onQuiesced = {
          second =
            session(
              generation = 2,
              media = media,
              emit = {},
              onQuiesced = { secondQuiesced.countDown() },
            )
          second.start()
          firstQuiesced.countDown()
        },
      )

    first.start()
    assertTrue(media.firstRecordingStarted.await(1, TimeUnit.SECONDS))
    val staleId = media.recordingIds.single()
    first.stop(reportStopped = false)
    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(media.secondRecordingStarted.await(1, TimeUnit.SECONDS))
    val replacementId = media.recordingIds.last()
    val stale = media.completedRecording(staleId)
    val releaseCountBeforeStaleCallback = media.releaseCount.get()

    val handled =
      first.onRecorderTerminated(
        T3VoiceRecordingTermination.Completed(stale, "speech-ended"),
      )
    if (!handled) media.deleteRecording(stale)

    assertFalse(handled)
    assertEquals(listOf(stale), media.deletedRecordings)
    assertEquals(releaseCountBeforeStaleCallback, media.releaseCount.get())
    assertEquals(replacementId, media.audioOwner())

    second.stop(reportStopped = false)
    assertTrue(secondQuiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `recorder terminal release blocks quiescence and replacement admission`() {
    val media = GenerationAwareMedia(blockFirstRelease = true)
    val firstQuiesced = CountDownLatch(1)
    val secondQuiesced = CountDownLatch(1)
    lateinit var second: T3VoiceThreadSession
    val first =
      session(
        generation = 1,
        media = media,
        emit = {},
        onQuiesced = {
          second =
            session(
              generation = 2,
              media = media,
              emit = {},
              onQuiesced = { secondQuiesced.countDown() },
            )
          second.start()
          firstQuiesced.countDown()
        },
      )
    first.start()
    assertTrue(media.firstRecordingStarted.await(1, TimeUnit.SECONDS))
    val oldId = media.recordingIds.single()
    val completed = media.completeActiveRecording()
    val callbackHandled = AtomicBoolean(false)
    val callback =
      thread {
        callbackHandled.set(
          first.onRecorderTerminated(
            T3VoiceRecordingTermination.Completed(completed, "speech-ended"),
          ),
        )
      }
    assertTrue(media.firstReleaseEntered.await(1, TimeUnit.SECONDS))
    first.stop(reportStopped = false)

    val quiescedWhileReleaseBlocked = firstQuiesced.await(100, TimeUnit.MILLISECONDS)
    media.allowFirstRelease.countDown()

    assertFalse(quiescedWhileReleaseBlocked)
    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(media.secondRecordingStarted.await(1, TimeUnit.SECONDS))
    callback.join()
    assertTrue(callbackHandled.get())
    assertEquals(oldId, media.releasedOwners.first())
    assertEquals(media.recordingIds.last(), media.audioOwner())
    assertEquals(listOf(completed), media.deletedRecordings)

    second.stop(reportStopped = false)
    assertTrue(secondQuiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `playback finish release blocks quiescence and replacement admission`() {
    val media = GenerationAwareMedia(blockFirstRelease = true)
    val api = CompletedResponseApi(providePcm = true)
    val submitted = CountDownLatch(1)
    val responseReady = CountDownLatch(1)
    val firstQuiesced = CountDownLatch(1)
    val secondQuiesced = CountDownLatch(1)
    lateinit var second: T3VoiceThreadSession
    val first =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          when (callback) {
            T3VoiceRuntimeCallback.ThreadSubmitted -> submitted.countDown()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> responseReady.countDown()
            else -> Unit
          }
        },
        onQuiesced = {
          second =
            session(
              generation = 2,
              media = media,
              emit = {},
              onQuiesced = { secondQuiesced.countDown() },
            )
          second.start()
          firstQuiesced.countDown()
        },
      )
    first.submitTranscript("hello")
    assertTrue(submitted.await(1, TimeUnit.SECONDS))
    first.waitForResponse()
    assertTrue(responseReady.await(1, TimeUnit.SECONDS))
    first.startPlayback()
    assertTrue(media.playbackPrepared.await(1, TimeUnit.SECONDS))
    val oldPlaybackId = media.completeActivePlayback()
    val callbackHandled = AtomicBoolean(false)
    val callback =
      thread {
        callbackHandled.set(first.onPlaybackFinished(oldPlaybackId))
      }
    assertTrue(media.firstReleaseEntered.await(1, TimeUnit.SECONDS))
    first.stop(reportStopped = false)

    val quiescedWhileReleaseBlocked = firstQuiesced.await(100, TimeUnit.MILLISECONDS)
    media.allowFirstRelease.countDown()

    assertFalse(quiescedWhileReleaseBlocked)
    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(media.firstRecordingStarted.await(1, TimeUnit.SECONDS))
    callback.join()
    assertTrue(callbackHandled.get())
    assertEquals(oldPlaybackId, media.releasedOwners.first())
    assertEquals(media.recordingIds.single(), media.audioOwner())

    second.stop(reportStopped = false)
    assertTrue(secondQuiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `response callback can start playback after response HTTP ownership is released`() {
    val media = GenerationAwareMedia()
    val api = CompletedResponseApi(providePcm = true)
    val submitted = CountDownLatch(1)
    val responseReady = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val playbackAdmittedDuringCallback = AtomicBoolean(false)
    lateinit var voice: T3VoiceThreadSession
    voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          when (callback) {
            T3VoiceRuntimeCallback.ThreadSubmitted -> submitted.countDown()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> {
              voice.startPlayback()
              playbackAdmittedDuringCallback.set(api.ticketCreated.await(1, TimeUnit.SECONDS))
              responseReady.countDown()
            }
            else -> Unit
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.submitTranscript("hello")
    assertTrue(submitted.await(1, TimeUnit.SECONDS))
    voice.waitForResponse()

    assertTrue(responseReady.await(2, TimeUnit.SECONDS))
    assertTrue(playbackAdmittedDuringCallback.get())
    assertTrue(media.playbackPrepared.await(1, TimeUnit.SECONDS))

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `permanent playback focus loss cancels blocked synthesis without queued continuation`() {
    val media = BlockingSynthesisMedia()
    val api = BlockingSynthesisApi()
    val recordingStarted = CountDownLatch(1)
    val submitted = CountDownLatch(1)
    val responseReady = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val terminal = AtomicReference<T3VoiceRuntimeCallback?>()
    val session =
      T3VoiceThreadSession(
        generation = 1,
        start = START,
        config = SESSION,
        media = media,
        emit = { callback ->
          when (callback) {
            T3VoiceRuntimeCallback.ThreadRecordingStarted -> recordingStarted.countDown()
            T3VoiceRuntimeCallback.ThreadSubmitted -> submitted.countDown()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> responseReady.countDown()
            else -> Unit
          }
        },
        onQuiesced = { callback ->
          terminal.set(callback)
          quiesced.countDown()
        },
        api = api,
      )

    session.start()
    assertTrue(recordingStarted.await(1, TimeUnit.SECONDS))
    val recordingId = media.finishEndpointCancellation()
    assertTrue(
      session.onRecorderTerminated(
        T3VoiceRecordingTermination.Cancelled(recordingId, "test-endpoint"),
      ),
    )
    session.submitTranscript("read the response")
    assertTrue(submitted.await(1, TimeUnit.SECONDS))
    session.waitForResponse()
    assertTrue(responseReady.await(1, TimeUnit.SECONDS))
    session.startPlayback()
    assertTrue(api.synthesisEntered.await(1, TimeUnit.SECONDS))

    val startedAt = System.nanoTime()
    session.onAudioFocusActions(listOf(T3VoiceAudioFocusAction.TERMINATE_SESSION))
    assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt) < 250)
    assertTrue(media.playbackCancelled.await(1, TimeUnit.SECONDS))
    assertNull(media.activePlayback.get())
    assertEquals(1L, quiesced.count)
    assertEquals(0, media.finishCount.get())

    api.allowSynthesisToReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    val failed = terminal.get() as T3VoiceRuntimeCallback.Failed
    assertEquals("thread-audio-focus-lost", failed.failure.code)
    assertEquals(0, media.finishCount.get())
    assertEquals(0, media.resumeCount.get())
    assertNull(media.activePlayback.get())
  }

  @Test
  fun `skip mid-synthesis emits playback finished without terminal failure`() {
    val media = BlockingSynthesisMedia()
    val api = BlockingSynthesisApi()
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.startPlayback()
    assertTrue(api.synthesisEntered.await(1, TimeUnit.SECONDS))

    session.interruptPlayback()
    assertTrue(media.playbackCancelled.await(1, TimeUnit.SECONDS))
    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(1L, quiesced.count)

    api.allowSynthesisToReturn.countDown()
    // Speech executor may still unwind; skip must not terminal-fail the session.
    Thread.sleep(100)
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })

    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `double skip mid-synthesis emits playback finished once`() {
    val media = BlockingSynthesisMedia()
    val api = BlockingSynthesisApi()
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.startPlayback()
    assertTrue(api.synthesisEntered.await(1, TimeUnit.SECONDS))
    session.interruptPlayback()
    session.interruptPlayback()
    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    api.allowSynthesisToReturn.countDown()
    Thread.sleep(50)
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `skip before playback id is assigned latches and finishes once playback starts`() {
    val media = DelayedPlaybackMedia()
    val api = CompletedResponseApi(providePcm = true)
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    // Skip during the WAITING→PLAYING handoff before startPlayback runs.
    session.interruptPlayback()
    session.startPlayback()
    assertTrue(media.startEntered.await(1, TimeUnit.SECONDS))
    media.allowStartToReturn.countDown()

    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(0, api.synthesisCount.get())

    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `skip during blocked playback start finishes without terminal failure`() {
    val media = DelayedPlaybackMedia()
    val api = CompletedResponseApi(providePcm = true)
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.startPlayback()
    assertTrue(media.startEntered.await(1, TimeUnit.SECONDS))
    session.interruptPlayback()
    media.allowStartToReturn.countDown()

    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(0, api.synthesisCount.get())

    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `skip then stop reports clean stopped terminal without double failure`() {
    val media = BlockingSynthesisMedia()
    val api = BlockingSynthesisApi()
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val terminal = AtomicReference<T3VoiceRuntimeCallback?>()
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { callback ->
          terminal.set(callback)
          quiesced.countDown()
        },
      )

    session.startPlayback()
    assertTrue(api.synthesisEntered.await(1, TimeUnit.SECONDS))
    session.interruptPlayback()
    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    session.stop(reportStopped = true)
    api.allowSynthesisToReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(T3VoiceRuntimeCallback.ThreadStopped, terminal.get())
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
  }

  @Test
  fun `skipPending after natural finish is cleared by rearm so next playback runs`() {
    val media = GenerationAwareMedia()
    val api = CompletedResponseApi(providePcm = true)
    val firstFinished = CountDownLatch(1)
    val secondFinished = CountDownLatch(1)
    val recordingStarted = CountDownLatch(1)
    val playbackFinishedCount = AtomicInteger(0)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          when (callback) {
            T3VoiceRuntimeCallback.ThreadRecordingStarted -> recordingStarted.countDown()
            T3VoiceRuntimeCallback.ThreadPlaybackFinished -> {
              val n = playbackFinishedCount.incrementAndGet()
              if (n == 1) firstFinished.countDown() else secondFinished.countDown()
            }
            else -> Unit
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.startPlayback()
    assertTrue(media.playbackPrepared.await(2, TimeUnit.SECONDS))
    val firstId = media.completeActivePlayback()
    assertTrue(session.onPlaybackFinished(firstId))
    assertTrue(firstFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, media.playbackIds.size)

    // Spurious skip after ownership is gone latches skipPending.
    session.interruptPlayback()

    // Rearm clears latches at startRecording. End the rearm recording so media is free.
    session.rearmRecording()
    assertTrue(recordingStarted.await(2, TimeUnit.SECONDS))
    val rearmRecordingId = media.cancelActiveRecordingForEndpoint()
    assertTrue(
      session.onRecorderTerminated(
        T3VoiceRecordingTermination.Cancelled(rearmRecordingId, "test-endpoint"),
      ),
    )

    session.submitTranscript("second turn")
    Thread.sleep(50)
    session.waitForResponse()
    Thread.sleep(50)
    session.startPlayback()
    // Wait until a second playback id is established.
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
    while (media.playbackIds.size < 2 && System.nanoTime() < deadline) {
      Thread.sleep(10)
    }
    assertEquals(2, media.playbackIds.size)
    // Still only one finish — second cycle is actively playing, not auto-skipped.
    assertEquals(1, playbackFinishedCount.get())
    val secondId = media.completeActivePlayback()
    assertTrue(session.onPlaybackFinished(secondId))
    assertTrue(secondFinished.await(1, TimeUnit.SECONDS))
    assertEquals(2, playbackFinishedCount.get())
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })

    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `onPlaybackError during skip emits finished not failed`() {
    val media = BlockingSynthesisMedia()
    val api = BlockingSynthesisApi()
    val playbackFinished = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val session =
      readyForPlaybackSession(
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadPlaybackFinished) {
            playbackFinished.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.startPlayback()
    assertTrue(api.synthesisEntered.await(1, TimeUnit.SECONDS))
    val playbackId = checkNotNull(media.activePlayback.get())
    // Race: player error while skip is in flight. interruptPlayback claims first.
    session.interruptPlayback()
    // After claim, a late error must not convert the skip into a terminal failure.
    assertFalse(
      session.onPlaybackError(playbackId, IllegalStateException("stale player error")),
    )
    assertTrue(playbackFinished.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadPlaybackFinished })
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })

    api.allowSynthesisToReturn.countDown()
    session.stop(reportStopped = true)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }


  @Test
  fun `manual finish accepts the exact automatic finalization already in progress`() {
    val media = ConcurrentFinalizationMedia()
    val recordingStarted = CountDownLatch(1)
    val recordingFinalized = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val voice =
      session(
        generation = 1,
        media = media,
        emit = { callback ->
          callbacks += callback
          when (callback) {
            T3VoiceRuntimeCallback.ThreadRecordingStarted -> recordingStarted.countDown()
            T3VoiceRuntimeCallback.ThreadRecordingFinalized -> recordingFinalized.countDown()
            else -> Unit
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()
    assertTrue(media.finishEntered.await(1, TimeUnit.SECONDS))

    assertTrue(
      voice.onRecorderTerminated(
        T3VoiceRecordingTermination.Completed(media.completedRecording, "speech-ended"),
      ),
    )
    media.allowFinishToReturn.countDown()

    assertTrue(recordingFinalized.await(1, TimeUnit.SECONDS))
    assertTrue(callbacks.none { it is T3VoiceRuntimeCallback.Failed })
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadRecordingFinalized })

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(listOf(media.completedRecording), media.deletedRecordings)
  }

  @Test
  fun `manual finish joins automatic no input already in progress exactly once`() {
    val media = ConcurrentFinalizationMedia(finishAsNoInput = true)
    val api = CompletedResponseApi()
    val recordingStarted = CountDownLatch(1)
    val noInput = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          when (callback) {
            T3VoiceRuntimeCallback.ThreadRecordingStarted -> recordingStarted.countDown()
            T3VoiceRuntimeCallback.ThreadNoSpeechDetected -> noInput.countDown()
            else -> Unit
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(recordingStarted.await(1, TimeUnit.SECONDS))
    voice.finishRecording()
    assertTrue(media.finishEntered.await(1, TimeUnit.SECONDS))
    val recordingId = media.finalizingRecordingId()

    assertTrue(
      voice.onRecorderTerminated(
        T3VoiceRecordingTermination.Cancelled(recordingId, "no-speech"),
      ),
    )
    media.allowFinishToReturn.countDown()

    assertTrue(noInput.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadNoSpeechDetected })
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadRecordingFinalized })
    assertEquals(1L, api.ticketCreated.count)

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `manual finish after automatic no input is an exact no op`() {
    val media = GenerationAwareMedia()
    val api = CompletedResponseApi()
    val noInput = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val voice =
      session(
        generation = 1,
        media = media,
        api = api,
        emit = { callback ->
          callbacks += callback
          if (callback == T3VoiceRuntimeCallback.ThreadNoSpeechDetected) noInput.countDown()
        },
        onQuiesced = { quiesced.countDown() },
      )

    voice.start()
    assertTrue(media.firstRecordingStarted.await(1, TimeUnit.SECONDS))
    val recordingId = media.cancelActiveRecordingForEndpoint()
    assertTrue(
      voice.onRecorderTerminated(
        T3VoiceRecordingTermination.Cancelled(recordingId, "no-speech"),
      ),
    )
    assertTrue(noInput.await(1, TimeUnit.SECONDS))

    voice.finishRecording()
    voice.rearmRecording()
    assertTrue(media.secondRecordingStarted.await(1, TimeUnit.SECONDS))
    assertEquals(1, callbacks.count { it == T3VoiceRuntimeCallback.ThreadNoSpeechDetected })
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadRecordingFinalized })
    assertEquals(1L, api.ticketCreated.count)

    voice.stop(reportStopped = false)
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `permanent focus loss cancels a blocked recording start before it can publish`() {
    val media = DelayedFirstRecordingMedia()
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val voice =
      session(
        generation = 1,
        media = media,
        emit = callbacks::add,
        onQuiesced = { callback ->
          if (callback != null) callbacks += callback
          quiesced.countDown()
        },
      )

    voice.start()
    assertTrue(media.firstStartEntered.await(1, TimeUnit.SECONDS))

    voice.onAudioFocusActions(listOf(T3VoiceAudioFocusAction.TERMINATE_SESSION))

    assertEquals(1L, quiesced.count)
    assertNull(media.activeRecordingId())
    media.allowFirstStartToReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertNull(media.activeRecordingId())
    assertEquals(1, media.cancelledRecordingIds.size)
    assertTrue(callbacks.none { it == T3VoiceRuntimeCallback.ThreadRecordingStarted })
    val failure = callbacks.filterIsInstance<T3VoiceRuntimeCallback.Failed>().single().failure
    assertEquals("thread-audio-focus-lost", failure.code)
  }

  @Test
  fun `permanent focus loss cancels a blocked playback start before synthesis`() {
    val media = DelayedPlaybackMedia()
    val api = CompletedResponseApi()
    val submitted = CountDownLatch(1)
    val responseReady = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val callbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val voice =
      session(
        generation = 1,
        media = media,
        emit = { callback ->
          callbacks += callback
          when (callback) {
            T3VoiceRuntimeCallback.ThreadSubmitted -> submitted.countDown()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> responseReady.countDown()
            else -> Unit
          }
        },
        onQuiesced = { callback ->
          if (callback != null) callbacks += callback
          quiesced.countDown()
        },
        api = api,
      )
    voice.submitTranscript("hello")
    assertTrue(submitted.await(1, TimeUnit.SECONDS))
    voice.waitForResponse()
    assertTrue(responseReady.await(1, TimeUnit.SECONDS))

    voice.startPlayback()
    assertTrue(media.startEntered.await(1, TimeUnit.SECONDS))
    voice.onAudioFocusActions(listOf(T3VoiceAudioFocusAction.TERMINATE_SESSION))

    assertEquals(1L, quiesced.count)
    assertNull(media.activePlaybackId())
    media.allowStartToReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertNull(media.activePlaybackId())
    assertEquals(1, media.cancelledPlaybackIds.size)
    assertEquals(0, api.synthesisCount.get())
    val failure = callbacks.filterIsInstance<T3VoiceRuntimeCallback.Failed>().single().failure
    assertEquals("thread-audio-focus-lost", failure.code)
  }

  @Test
  fun `delayed recorder start quiesces before stop acknowledgement and next generation`() {
    val media = DelayedFirstRecordingMedia()
    val firstQuiesced = CountDownLatch(1)
    val secondRecordingStarted = CountDownLatch(1)
    val secondQuiesced = CountDownLatch(1)
    val terminalCallbacks = CopyOnWriteArrayList<T3VoiceRuntimeCallback?>()
    lateinit var second: T3VoiceThreadSession

    val first =
      session(
        generation = 1,
        media = media,
        emit = {},
        onQuiesced = { terminalCallback ->
          terminalCallbacks += terminalCallback
          assertNull(media.activeRecordingId())
          second =
            session(
              generation = 2,
              media = media,
              emit = { event ->
                if (event == T3VoiceRuntimeCallback.ThreadRecordingStarted) {
                  secondRecordingStarted.countDown()
                }
              },
              onQuiesced = { secondQuiesced.countDown() },
            )
          second.start()
          firstQuiesced.countDown()
        },
      )

    first.start()
    assertTrue(media.firstStartEntered.await(1, TimeUnit.SECONDS))

    first.stop(reportStopped = true)

    assertEquals(1L, firstQuiesced.count)
    assertEquals(1, media.startCount.get())
    assertNull(media.activeRecordingId())

    media.allowFirstStartToReturn.countDown()

    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(secondRecordingStarted.await(1, TimeUnit.SECONDS))
    assertEquals(listOf(T3VoiceRuntimeCallback.ThreadStopped), terminalCallbacks)
    assertEquals(2, media.startCount.get())
    assertEquals(1, media.cancelledRecordingIds.size)
    assertFalse(media.overlapDetected.get())

    second.stop(reportStopped = false)
    assertTrue(secondQuiesced.await(1, TimeUnit.SECONDS))
    assertNull(media.activeRecordingId())
  }

  @Test
  fun `stop returns before a quiescence callback finishes`() {
    val media = GenerationAwareMedia()
    val callbackEntered = CountDownLatch(1)
    val allowCallbackReturn = CountDownLatch(1)
    val stopReturned = CountDownLatch(1)
    val voice =
      session(
        generation = 1,
        media = media,
        emit = {},
        onQuiesced = {
          callbackEntered.countDown()
          var interrupted = false
          while (true) {
            try {
              allowCallbackReturn.await()
              break
            } catch (_: InterruptedException) {
              interrupted = true
            }
          }
          if (interrupted) Thread.currentThread().interrupt()
        },
      )

    voice.start()
    assertTrue(media.firstRecordingStarted.await(1, TimeUnit.SECONDS))
    val stopThread =
      thread {
        voice.stop(reportStopped = true)
        stopReturned.countDown()
      }

    assertTrue(callbackEntered.await(1, TimeUnit.SECONDS))
    val returnedBeforeCallback = stopReturned.await(1, TimeUnit.SECONDS)
    allowCallbackReturn.countDown()
    stopThread.join(1_000)

    assertTrue("Stop must not wait for its terminal callback.", returnedBeforeCallback)
    assertFalse(stopThread.isAlive)
  }

  @Test
  fun `immediate stop runs both cleanup sweeps before terminal callback`() {
    val media = GenerationAwareMedia()
    val quiesced = CountDownLatch(1)
    val releaseCountAtCallback = AtomicInteger(-1)
    val terminal = AtomicReference<T3VoiceRuntimeCallback?>()
    val voice =
      session(
        generation = 1,
        media = media,
        emit = {},
        onQuiesced = { callback ->
          terminal.set(callback)
          releaseCountAtCallback.set(media.releaseCount.get())
          quiesced.countDown()
        },
      )

    voice.stop(reportStopped = true)

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(T3VoiceRuntimeCallback.ThreadStopped, terminal.get())
    assertEquals(2, releaseCountAtCallback.get())
  }

  private fun session(
    generation: Long,
    media: T3VoiceThreadMedia,
    emit: (T3VoiceRuntimeCallback) -> Unit,
    onQuiesced: (T3VoiceRuntimeCallback?) -> Unit,
    api: T3VoiceThreadSessionApi? = null,
  ): T3VoiceThreadSession =
    T3VoiceThreadSession(
      generation = generation,
      start = START,
      config = SESSION,
      media = media,
      emit = emit,
      onQuiesced = onQuiesced,
      api = api ?: CompletedResponseApi(),
    )

  /** Submits a turn and waits until the response is ready so tests can exercise playback. */
  private fun readyForPlaybackSession(
    media: T3VoiceThreadMedia,
    api: T3VoiceThreadSessionApi,
    emit: (T3VoiceRuntimeCallback) -> Unit,
    onQuiesced: (T3VoiceRuntimeCallback?) -> Unit,
  ): T3VoiceThreadSession {
    val submitted = CountDownLatch(1)
    val responseReady = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        media = media,
        emit = { callback ->
          when (callback) {
            T3VoiceRuntimeCallback.ThreadSubmitted -> submitted.countDown()
            is T3VoiceRuntimeCallback.ThreadResponseReady -> responseReady.countDown()
            else -> Unit
          }
          emit(callback)
        },
        onQuiesced = onQuiesced,
        api = api,
      )
    session.submitTranscript("read the response")
    check(submitted.await(2, TimeUnit.SECONDS)) { "Thread submit timed out." }
    session.waitForResponse()
    check(responseReady.await(2, TimeUnit.SECONDS)) { "Thread response timed out." }
    return session
  }

  private class GenerationAwareMedia(
    private val blockFirstRelease: Boolean = false,
  ) : T3VoiceThreadMedia {
    val firstRecordingStarted = CountDownLatch(1)
    val secondRecordingStarted = CountDownLatch(1)
    val playbackPrepared = CountDownLatch(1)
    val firstReleaseEntered = CountDownLatch(1)
    val allowFirstRelease = CountDownLatch(1)
    val releaseCount = AtomicInteger(0)
    val recordingIds = CopyOnWriteArrayList<String>()
    val playbackIds = CopyOnWriteArrayList<String>()
    val releasedOwners = CopyOnWriteArrayList<String>()
    val deletedRecordings = CopyOnWriteArrayList<T3VoiceRecordingResult>()
    private val lock = Any()
    private var activeRecording: String? = null
    private var activePlayback: String? = null
    private var audioOwner: String? = null

    override fun acquireCaptureAudio(): Boolean = true

    override fun acquirePlaybackAudio(): Boolean = true

    override fun releaseAudio() {
      val release = releaseCount.incrementAndGet()
      if (blockFirstRelease && release == 1) {
        firstReleaseEntered.countDown()
        awaitIgnoringInterrupt(allowFirstRelease)
      }
      val released =
        synchronized(lock) {
          audioOwner.also { audioOwner = null }
        }
      releasedOwners += released ?: NO_AUDIO_OWNER
    }

    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      val recordingNumber =
        synchronized(lock) {
          check(activeRecording == null) { "A recording is already active." }
          activeRecording = recordingId
          audioOwner = recordingId
          recordingIds += recordingId
          recordingIds.size
        }
      when (recordingNumber) {
        1 -> firstRecordingStarted.countDown()
        2 -> secondRecordingStarted.countDown()
      }
    }

    override fun finishRecording(recordingId: String): T3VoiceRecordingResult =
      error("Manual recording finalization is not used by this test media.")

    override fun cancelRecording(recordingId: String) {
      synchronized(lock) {
        check(activeRecording == recordingId) { "$recordingId does not own the recorder." }
        activeRecording = null
      }
    }

    override fun deleteRecording(recording: T3VoiceRecordingResult) {
      deletedRecordings += recording
    }

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      synchronized(lock) {
        check(activePlayback == null) { "A playback is already active." }
        activePlayback = playbackId
        audioOwner = playbackId
        playbackIds += playbackId
      }
    }

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) = Unit

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      synchronized(lock) {
        check(activePlayback == playbackId) { "$playbackId does not own playback." }
      }
      playbackPrepared.countDown()
    }

    override fun cancelPlayback(playbackId: String) {
      synchronized(lock) {
        check(activePlayback == playbackId) { "$playbackId does not own playback." }
        activePlayback = null
      }
    }

    override fun pausePlayback(playbackId: String) = Unit

    override fun resumePlayback(playbackId: String) = Unit

    fun completeActiveRecording(): T3VoiceRecordingResult =
      synchronized(lock) {
        val recordingId = checkNotNull(activeRecording)
        activeRecording = null
        completedRecording(recordingId)
      }

    fun cancelActiveRecordingForEndpoint(): String =
      synchronized(lock) {
        checkNotNull(activeRecording).also { activeRecording = null }
      }

    fun completeActivePlayback(): String =
      synchronized(lock) {
        checkNotNull(activePlayback).also { activePlayback = null }
      }

    fun completedRecording(recordingId: String) =
      T3VoiceRecordingResult(
        recordingId = recordingId,
        uri = "file:///$recordingId.m4a",
        durationMs = 1_000,
        byteLength = 4_096,
      )

    fun audioOwner(): String? = synchronized(lock) { audioOwner }

    private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
      var interrupted = false
      while (true) {
        try {
          latch.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
    }

    private companion object {
      const val NO_AUDIO_OWNER = "<none>"
    }
  }

  private class ConcurrentFinalizationMedia(
    private val finishAsNoInput: Boolean = false,
  ) : T3VoiceThreadMedia {
    val finishEntered = CountDownLatch(1)
    val allowFinishToReturn = CountDownLatch(1)
    private val baseCompletedRecording =
      T3VoiceRecordingResult(
        recordingId = "unused",
        uri = "file:///recording.m4a",
        durationMs = 1_000,
        byteLength = 4_096,
      )
    val deletedRecordings = CopyOnWriteArrayList<T3VoiceRecordingResult>()
    private var activeRecordingId: String? = null
    private var finalizingRecordingId: String? = null

    val completedRecording: T3VoiceRecordingResult
      @Synchronized get() =
        baseCompletedRecording.copy(recordingId = checkNotNull(finalizingRecordingId))

    override fun acquireCaptureAudio(): Boolean = true

    override fun acquirePlaybackAudio(): Boolean = true

    override fun releaseAudio() = Unit

    @Synchronized
    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      check(activeRecordingId == null)
      activeRecordingId = recordingId
    }

    override fun finishRecording(recordingId: String): T3VoiceThreadRecordingFinish {
      synchronized(this) {
        check(activeRecordingId == recordingId)
        activeRecordingId = null
        finalizingRecordingId = recordingId
      }
      finishEntered.countDown()
      awaitIgnoringInterrupt(allowFinishToReturn)
      return if (finishAsNoInput) T3VoiceRecordingNoInput(recordingId) else completedRecording
    }

    @Synchronized
    fun finalizingRecordingId(): String = checkNotNull(finalizingRecordingId)

    @Synchronized
    override fun cancelRecording(recordingId: String) {
      check(activeRecordingId == recordingId)
      activeRecordingId = null
    }

    override fun deleteRecording(recording: T3VoiceRecordingResult) {
      deletedRecordings += recording
    }

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) =
      error("Playback is not used by this test.")

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) =
      error("Playback is not used by this test.")

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) =
      error("Playback is not used by this test.")

    override fun cancelPlayback(playbackId: String) = error("Playback is not used by this test.")

    override fun pausePlayback(playbackId: String) = error("Playback is not used by this test.")

    override fun resumePlayback(playbackId: String) = error("Playback is not used by this test.")

    private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
      var interrupted = false
      while (true) {
        try {
          latch.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  private class DelayedPlaybackMedia : T3VoiceThreadMedia {
    val startEntered = CountDownLatch(1)
    val allowStartToReturn = CountDownLatch(1)
    val cancelledPlaybackIds = CopyOnWriteArrayList<String>()
    private val lock = Any()
    private var activePlayback: String? = null

    override fun acquireCaptureAudio(): Boolean =
      error("Playback-only test media must not acquire communication audio")

    override fun acquirePlaybackAudio(): Boolean = true

    override fun releaseAudio() = Unit

    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) = error("Recording is not used by this test.")

    override fun finishRecording(recordingId: String): T3VoiceRecordingResult =
      error("Recording is not used by this test.")

    override fun cancelRecording(recordingId: String) = error("Recording is not used by this test.")

    override fun deleteRecording(recording: T3VoiceRecordingResult) = Unit

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      startEntered.countDown()
      awaitIgnoringInterrupt(allowStartToReturn)
      synchronized(lock) {
        check(activePlayback == null)
        activePlayback = playbackId
      }
    }

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) =
      error("Synthesis must not begin after focus loss.")

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) =
      error("Synthesis must not begin after focus loss.")

    override fun cancelPlayback(playbackId: String) {
      synchronized(lock) {
        check(activePlayback == playbackId) { "$playbackId does not own playback." }
        activePlayback = null
      }
      cancelledPlaybackIds += playbackId
    }

    override fun pausePlayback(playbackId: String) = Unit

    override fun resumePlayback(playbackId: String) = Unit

    fun activePlaybackId(): String? = synchronized(lock) { activePlayback }

    private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
      var interrupted = false
      while (true) {
        try {
          latch.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  private class CompletedResponseApi(
    private val providePcm: Boolean = false,
  ) : T3VoiceThreadSessionApi {
    val synthesisCount = AtomicInteger(0)
    val ticketCreated = CountDownLatch(1)

    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ): T3VoiceMediaTicket {
      ticketCreated.countDown()
      return T3VoiceMediaTicket("ticket", "2099-01-01T00:00:00Z")
    }

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = error("Transcription is not used by this test.")

    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long = 1

    override fun getMessageTurn(
      calls: T3VoiceHttpCallRegistry,
      threadId: String,
      messageId: String,
    ) =
      T3VoiceMessageTurn(
        messageId = messageId,
        state = T3VoiceMessageTurnState.COMPLETED,
        turnId = "turn",
        assistantMessage = T3VoiceAssistantMessage("assistant", "response"),
      )

    override fun synthesize(
      calls: T3VoiceHttpCallRegistry,
      ticket: T3VoiceMediaTicket,
      requestId: String,
      playbackId: String,
      segment: T3VoiceSpeechSegment,
      onPcm: T3VoiceHttpChunkCallback,
    ): Long {
      synthesisCount.incrementAndGet()
      if (!providePcm) return 0
      val pcm = byteArrayOf(0, 0)
      onPcm.onChunk(pcm)
      return pcm.size.toLong()
    }
  }

  private class DelayedFirstRecordingMedia : T3VoiceThreadMedia {
    val firstStartEntered = CountDownLatch(1)
    val allowFirstStartToReturn = CountDownLatch(1)
    val startCount = AtomicInteger(0)
    val overlapDetected = AtomicBoolean(false)
    val cancelledRecordingIds = CopyOnWriteArrayList<String>()
    private val lock = Any()
    private var activeRecording: String? = null

    override fun acquireCaptureAudio(): Boolean = true

    override fun acquirePlaybackAudio(): Boolean = true

    override fun releaseAudio() = Unit

    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      if (startCount.incrementAndGet() == 1) {
        firstStartEntered.countDown()
        awaitIgnoringInterrupt(allowFirstStartToReturn)
      }
      synchronized(lock) {
        if (activeRecording != null) overlapDetected.set(true)
        check(activeRecording == null) { "Recording generations overlapped." }
        activeRecording = recordingId
      }
    }

    override fun finishRecording(recordingId: String): T3VoiceRecordingResult =
      error("Recording finalization is not used by this test.")

    override fun cancelRecording(recordingId: String) {
      synchronized(lock) {
        check(activeRecording == recordingId) { "$recordingId does not own the recorder." }
        activeRecording = null
      }
      cancelledRecordingIds += recordingId
    }

    override fun deleteRecording(recording: T3VoiceRecordingResult) = Unit

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) =
      error("Playback is not used by this test.")

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) =
      error("Playback is not used by this test.")

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) =
      error("Playback is not used by this test.")

    override fun cancelPlayback(playbackId: String) =
      error("Playback is not used by this test.")

    override fun pausePlayback(playbackId: String) = error("Playback is not used by this test.")

    override fun resumePlayback(playbackId: String) = error("Playback is not used by this test.")

    fun activeRecordingId(): String? = synchronized(lock) { activeRecording }

    private fun awaitIgnoringInterrupt(latch: CountDownLatch) {
      var interrupted = false
      while (true) {
        try {
          latch.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
    }
  }

  private class BlockingSynthesisMedia : T3VoiceThreadMedia {
    val activePlayback = AtomicReference<String?>()
    val playbackCancelled = CountDownLatch(1)
    val finishCount = AtomicInteger(0)
    val resumeCount = AtomicInteger(0)
    private val activeRecording = AtomicReference<String?>()

    override fun acquireCaptureAudio(): Boolean = true

    override fun acquirePlaybackAudio(): Boolean = true

    override fun releaseAudio() = Unit

    override fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      check(activeRecording.compareAndSet(null, recordingId))
    }

    override fun finishRecording(recordingId: String): T3VoiceRecordingResult =
      error("Recording finalization is not used by this test.")

    override fun cancelRecording(recordingId: String) {
      activeRecording.compareAndSet(recordingId, null)
    }

    override fun deleteRecording(recording: T3VoiceRecordingResult) = Unit

    override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      check(activePlayback.compareAndSet(null, playbackId))
    }

    override fun enqueueOwnedPlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) = Unit

    override fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      finishCount.incrementAndGet()
      activePlayback.compareAndSet(playbackId, null)
    }

    override fun cancelPlayback(playbackId: String) {
      activePlayback.compareAndSet(playbackId, null)
      playbackCancelled.countDown()
    }

    override fun pausePlayback(playbackId: String) = Unit

    override fun resumePlayback(playbackId: String) {
      resumeCount.incrementAndGet()
    }

    fun finishEndpointCancellation(): String =
      checkNotNull(activeRecording.getAndSet(null))
  }

  private class BlockingSynthesisApi : T3VoiceThreadSessionApi {
    val synthesisEntered = CountDownLatch(1)
    val allowSynthesisToReturn = CountDownLatch(1)

    override fun createMediaTicket(
      calls: T3VoiceHttpCallRegistry,
      operation: T3VoiceMediaOperation,
      requestId: String,
    ) = T3VoiceMediaTicket("media-ticket", "2099-01-01T00:00:00Z")

    override fun transcribe(
      calls: T3VoiceHttpCallRegistry,
      recording: T3VoiceRecordingResult,
      requestId: String,
      ticket: T3VoiceMediaTicket,
    ): String = error("Transcription is not used by this test.")

    override fun dispatchThreadTurn(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceThreadTarget,
      transcript: String,
      commandId: String,
      messageId: String,
      createdAt: String,
    ): Long = 1

    override fun getMessageTurn(
      calls: T3VoiceHttpCallRegistry,
      threadId: String,
      messageId: String,
    ) =
      T3VoiceMessageTurn(
        messageId = messageId,
        state = T3VoiceMessageTurnState.COMPLETED,
        turnId = "turn-a",
        assistantMessage = T3VoiceAssistantMessage("assistant-a", "Spoken response."),
      )

    override fun synthesize(
      calls: T3VoiceHttpCallRegistry,
      ticket: T3VoiceMediaTicket,
      requestId: String,
      playbackId: String,
      segment: T3VoiceSpeechSegment,
      onPcm: T3VoiceHttpChunkCallback,
    ): Long {
      synthesisEntered.countDown()
      var interrupted = false
      while (true) {
        try {
          allowSynthesisToReturn.await()
          break
        } catch (_: InterruptedException) {
          interrupted = true
        }
      }
      if (interrupted) Thread.currentThread().interrupt()
      onPcm.onChunk(byteArrayOf(1, 2, 3, 4))
      return 4
    }
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
