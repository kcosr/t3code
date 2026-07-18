package expo.modules.t3voice

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceRealtimeSessionTest {
  @Test
  fun `close before prepare admission fences late startup before starting next generation`() {
    val media = TestRealtimeMedia(blockFirstPrepareAdmission = true)
    val routing = TestAudioRouting()
    val firstQuiesced = CountDownLatch(1)
    val secondQuiesced = CountDownLatch(1)
    lateinit var second: T3VoiceRealtimeSession

    val first =
      session(
        generation = 1,
        api = TestRealtimeApi("session-a"),
        media = media,
        routing = routing,
        onQuiesced = { result ->
          assertEquals(T3VoiceRuntimeCallback.RealtimeClosed, result.callback)
          assertFalse(result.publishedBeforeQuiescence)
          assertNull(media.activeSessionId())
          second =
            session(
              generation = 2,
              api = TestRealtimeApi("session-b"),
              media = media,
              routing = routing,
              onQuiesced = { secondQuiesced.countDown() },
            )
          second.start()
          firstQuiesced.countDown()
        },
      )

    first.start()
    assertTrue(media.firstPrepareBeforeAdmission.await(1, TimeUnit.SECONDS))

    val startedAt = System.nanoTime()
    first.close()
    assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt) < 250)
    assertTrue(media.startupCancelled.await(1, TimeUnit.SECONDS))
    assertEquals(1L, firstQuiesced.count)
    assertEquals(1, media.prepareCount.get())
    assertNull(media.activeSessionId())

    media.allowFirstPrepareAdmission.countDown()

    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(media.secondPrepareCompleted.await(1, TimeUnit.SECONDS))
    assertEquals(2, media.prepareCount.get())
    assertEquals("session-b", media.activeSessionId())
    assertEquals(1, media.cancelledBeforeInstall.get())
    assertFalse(media.overlapDetected.get())

    second.close()
    assertTrue(secondQuiesced.await(1, TimeUnit.SECONDS))
    assertNull(media.activeSessionId())
  }

  @Test
  fun `bounded failure remains draining through Stop and admits retry only after late prepare`() {
    val media = TestRealtimeMedia(blockFirstPrepareAdmission = true)
    val routing = TestAudioRouting()
    val boundedFailure = CountDownLatch(1)
    val firstQuiesced = CountDownLatch(1)
    val replacementQuiesced = CountDownLatch(1)
    val emitted = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    lateinit var replacement: T3VoiceRealtimeSession

    val first =
      session(
        generation = 1,
        api = TestRealtimeApi("session-failing"),
        media = media,
        routing = routing,
        emit = { callback ->
          emitted += callback
          if (callback is T3VoiceRuntimeCallback.Failed) boundedFailure.countDown()
        },
        terminalOutcomeDeadlineMs = 40,
        onQuiesced = { result ->
          assertTrue(result.publishedBeforeQuiescence)
          replacement =
            session(
              generation = 2,
              api = TestRealtimeApi("session-retry"),
              media = media,
              routing = routing,
              onQuiesced = { replacementQuiesced.countDown() },
            )
          replacement.start()
          firstQuiesced.countDown()
        },
      )

    first.start()
    assertTrue(media.firstPrepareBeforeAdmission.await(1, TimeUnit.SECONDS))
    first.onWebRtcError("session-failing", "peer-failed", recoverable = true)

    assertTrue(boundedFailure.await(1, TimeUnit.SECONDS))
    val failed = emitted.single() as T3VoiceRuntimeCallback.Failed
    assertTrue(failed.releasePending)
    first.forceRelease() // The controller's Stop/releaseAll path is idempotent while draining.
    assertEquals(1L, firstQuiesced.count)
    assertEquals(1L, media.secondPrepareCompleted.count)
    assertNull(media.activeSessionId())

    media.allowFirstPrepareAdmission.countDown()

    assertTrue(firstQuiesced.await(1, TimeUnit.SECONDS))
    assertTrue(media.secondPrepareCompleted.await(1, TimeUnit.SECONDS))
    assertEquals("session-retry", media.activeSessionId())
    assertFalse(media.overlapDetected.get())

    replacement.close()
    assertTrue(replacementQuiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `blocking peer disposal cannot block close or bounded failure and quiesces only when done`() {
    val media = TestRealtimeMedia(blockStop = true)
    val routing = TestAudioRouting()
    val boundedFailure = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    var failure: T3VoiceRuntimeCallback.Failed? = null
    var result: T3VoiceRealtimeTerminalResult? = null
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-blocked-stop"),
        media = media,
        routing = routing,
        emit = { callback ->
          if (callback is T3VoiceRuntimeCallback.Failed) {
            failure = callback
            boundedFailure.countDown()
          }
        },
        terminalOutcomeDeadlineMs = 40,
        onQuiesced = {
          result = it
          quiesced.countDown()
        },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))

    val startedAt = System.nanoTime()
    session.close()
    assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startedAt) < 250)
    assertTrue(routing.stopCount.get() > 0)
    assertTrue(media.stopEntered.await(1, TimeUnit.SECONDS))
    assertTrue(boundedFailure.await(1, TimeUnit.SECONDS))
    assertTrue(checkNotNull(failure).releasePending)
    assertEquals(1L, quiesced.count)

    media.allowStopToReturn.countDown()

    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertTrue(checkNotNull(result).publishedBeforeQuiescence)
    assertNull(media.activeSessionId())
  }

  @Test
  fun `blocked event lane must exit before Realtime ownership quiesces`() {
    val api = TestRealtimeApi("session-blocked-events", blockEventsUntilReleased = true)
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = api,
        media = TestRealtimeMedia(),
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(api.eventEntered.await(1, TimeUnit.SECONDS))

    session.close()

    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    api.allowEventToReturn.countDown()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `blocked signaling offer must exit before Realtime ownership quiesces`() {
    val api = TestRealtimeApi("session-blocked-offer", blockOfferUntilReleased = true)
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = api,
        media = ImmediateOfferRealtimeMedia(),
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(api.offerEntered.await(1, TimeUnit.SECONDS))

    session.close()

    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    api.allowOfferToReturn.countDown()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `close after peer install fences router reacquisition before startup continues`() {
    val routing = TestAudioRouting()
    val media = InstalledBlockedRealtimeMedia(routing)
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-installed"),
        media = media,
        routing = routing,
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.peerInstalled.await(1, TimeUnit.SECONDS))

    session.close()

    assertTrue(media.startupCancelled.await(1, TimeUnit.SECONDS))
    assertFalse(routing.active.get())
    media.allowRouterAdmission.countDown()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertEquals(0, routing.startCount.get())
    assertFalse(routing.active.get())
  }

  @Test
  fun `Stop before queued startup runs accounts for startup exactly once`() {
    val startupExecutor = Executors.newSingleThreadExecutor()
    val blockerEntered = CountDownLatch(1)
    val releaseBlocker = CountDownLatch(1)
    startupExecutor.execute {
      blockerEntered.countDown()
      awaitIgnoringInterrupt(releaseBlocker)
    }
    assertTrue(blockerEntered.await(1, TimeUnit.SECONDS))
    val api = TestRealtimeApi("never-created")
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = api,
        media = TestRealtimeMedia(),
        routing = TestAudioRouting(),
        startupExecutor = startupExecutor,
        onQuiesced = { quiesced.countDown() },
      )

    session.start()
    session.close()

    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    assertEquals(0, api.createCount.get())
    releaseBlocker.countDown()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `agent close fences input and waits for playout before stopping media`() {
    val media = TestRealtimeMedia()
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-drain"),
        media = media,
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))

    session.closeAfterPlayoutDrain()

    assertTrue(media.drainEntered.await(1, TimeUnit.SECONDS))
    assertEquals(1L, media.stopEntered.count)
    assertFalse(quiesced.await(100, TimeUnit.MILLISECONDS))
    media.completeDrain()
    assertTrue(media.stopEntered.await(1, TimeUnit.SECONDS))
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `user close overrides an agent playout drain immediately`() {
    val media = TestRealtimeMedia()
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-drain-override"),
        media = media,
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))
    session.closeAfterPlayoutDrain()
    assertTrue(media.drainEntered.await(1, TimeUnit.SECONDS))

    session.close()

    assertTrue(media.stopEntered.await(1, TimeUnit.SECONDS))
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `playout completion tears down without waiting for the deadline`() {
    val media = TestRealtimeMedia()
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-ended-drain"),
        media = media,
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))
    session.closeAfterPlayoutDrain()
    assertTrue(media.drainEntered.await(1, TimeUnit.SECONDS))

    media.completeDrain()

    assertTrue(media.stopEntered.await(1, TimeUnit.SECONDS))
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `clean Realtime close fences capture and drains Ended before route teardown`() {
    val media = TestRealtimeMedia()
    val routing = TestAudioRouting()
    val arming = DeferredEndedCueArming()
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = TestRealtimeApi("session-ended-cue"),
        media = media,
        routing = routing,
        cueArming = arming,
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))
    routing.startForTest()
    session.onWebRtcStateChanged("session-ended-cue", "connected")
    assertTrue(media.inputReadyEnabled.await(1, TimeUnit.SECONDS))

    session.closeAfterPlayoutDrain()
    assertTrue(media.drainEntered.await(1, TimeUnit.SECONDS))
    media.completeDrain()

    assertTrue(arming.endedRequested.await(1, TimeUnit.SECONDS))
    assertTrue(media.inputReadyStates.contains(false))
    assertTrue(routing.active.get())
    assertEquals(1L, media.stopEntered.count)
    arming.completeEnded()

    assertTrue(media.stopEntered.await(1, TimeUnit.SECONDS))
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
    assertFalse(routing.active.get())
  }

  @Test
  fun `duplicate terminal events are admitted only once while Realtime is starting`() {
    val action =
      T3VoiceRealtimeTerminalAction.StopRealtime("terminal-a")
    val api =
      TestRealtimeApi(
        sessionId = "session-terminal-event",
        initialEvents =
          listOf(
            T3VoiceApiRealtimeEvent.TerminalAction(1, action),
            T3VoiceApiRealtimeEvent.TerminalAction(2, action),
          ),
      )
    val received = CopyOnWriteArrayList<T3VoiceRuntimeCallback>()
    val actionReceived = CountDownLatch(1)
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = api,
        media = TestRealtimeMedia(),
        routing = TestAudioRouting(),
        emit = {
          received += it
          if (it is T3VoiceRuntimeCallback.RealtimeTerminalActionReceived) {
            actionReceived.countDown()
          }
        },
        onQuiesced = { quiesced.countDown() },
      )

    session.start()

    assertTrue(actionReceived.await(1, TimeUnit.SECONDS))
    assertEquals(1, received.filterIsInstance<T3VoiceRuntimeCallback.RealtimeTerminalActionReceived>().size)
    session.close()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  @Test
  fun `context updates add and remove the terminal switch capability`() {
    val api = TestRealtimeApi("session-context")
    val media = TestRealtimeMedia()
    val quiesced = CountDownLatch(1)
    val session =
      session(
        generation = 1,
        api = api,
        media = media,
        routing = TestAudioRouting(),
        onQuiesced = { quiesced.countDown() },
      )
    session.start()
    assertTrue(media.prepareCompleted.await(1, TimeUnit.SECONDS))
    val focus = T3VoiceRealtimeFocus("project-a", "thread-a")
    val withSwitch = T3VoiceRealtimeContext(focus, THREAD_SETTINGS)

    session.admitContext(withSwitch)
    assertEquals(withSwitch, api.contextUpdates.poll(1, TimeUnit.SECONDS))

    val withoutSwitch = T3VoiceRealtimeContext(focus, null)
    session.admitContext(withoutSwitch)
    assertEquals(withoutSwitch, api.contextUpdates.poll(1, TimeUnit.SECONDS))

    session.close()
    assertTrue(quiesced.await(1, TimeUnit.SECONDS))
  }

  private fun session(
    generation: Long,
    api: T3VoiceRealtimeSessionApi,
    media: T3VoiceRealtimeMedia,
    routing: T3VoiceRealtimeAudioRouting,
    emit: (T3VoiceRuntimeCallback) -> Unit = {},
    onQuiesced: (T3VoiceRealtimeTerminalResult) -> Unit,
    startupExecutor: ExecutorService = Executors.newSingleThreadExecutor(),
    terminalOutcomeDeadlineMs: Long = 1_000,
    cueArming: T3VoiceCueArming = NoOpCueArming,
  ) =
    T3VoiceRealtimeSession(
      generation = generation,
      target = TARGET,
      sessionConfig = SESSION,
      webRtc = media,
      audioRouter = routing,
      emit = emit,
      onQuiesced = onQuiesced,
      api = api,
      cueArming = cueArming,
      startupExecutor = startupExecutor,
      terminalOutcomeDeadlineMs = terminalOutcomeDeadlineMs,
    )

  private class TestAudioRouting : T3VoiceRealtimeAudioRouting {
    val stopCount = AtomicInteger(0)
    val startCount = AtomicInteger(0)
    val active = AtomicBoolean(false)

    fun startForTest() {
      startCount.incrementAndGet()
      active.set(true)
    }

    override fun stop() {
      stopCount.incrementAndGet()
      active.set(false)
    }

  }

  private class InstalledBlockedRealtimeMedia(
    private val routing: TestAudioRouting,
  ) : T3VoiceRealtimeMedia {
    val peerInstalled = CountDownLatch(1)
    val allowRouterAdmission = CountDownLatch(1)
    val startupCancelled = CountDownLatch(1)
    private val fence = T3VoiceRealtimePrepareFence()

    override fun cancelStartup(sessionId: String) {
      fence.cancelStartup(sessionId)
      startupCancelled.countDown()
    }

    override fun prepare(
      sessionId: String,
      diagnosticGeneration: Long,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      val attempt = checkNotNull(fence.begin(sessionId))
      assertTrue(fence.claimInstall(attempt))
      peerInstalled.countDown()
      awaitIgnoringInterrupt(allowRouterAdmission)
      if (!fence.isLive(attempt)) {
        fence.abandon(attempt)
        routing.stop()
        return
      }
      routing.startForTest()
      if (!fence.isLive(attempt)) routing.stop()
      fence.complete(attempt)
    }

    override fun applyAnswer(
      sessionId: String,
      answerSdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) = Unit

    override fun stop(sessionId: String): Boolean =
      fence.retireCancelledBeforeBegin(sessionId)

    override fun fenceInputAndDrainPlayout(
      sessionId: String,
      onComplete: () -> Unit,
    ) {
      onComplete()
    }

    override fun setMuted(sessionId: String, muted: Boolean) = Unit
    override fun setInputReady(sessionId: String, ready: Boolean) = Unit

  }

  private class TestRealtimeMedia(
    private val blockFirstPrepareAdmission: Boolean = false,
    private val blockStop: Boolean = false,
  ) : T3VoiceRealtimeMedia {
    val firstPrepareBeforeAdmission = CountDownLatch(1)
    val allowFirstPrepareAdmission = CountDownLatch(1)
    val startupCancelled = CountDownLatch(1)
    val prepareCompleted = CountDownLatch(1)
    val secondPrepareCompleted = CountDownLatch(1)
    val stopEntered = CountDownLatch(1)
    val drainEntered = CountDownLatch(1)
    val allowStopToReturn = CountDownLatch(1)
    val prepareCount = AtomicInteger(0)
    val cancelledBeforeInstall = AtomicInteger(0)
    val overlapDetected = AtomicBoolean(false)
    val inputReadyEnabled = CountDownLatch(1)
    val inputReadyStates = CopyOnWriteArrayList<Boolean>()
    private val lock = Any()
    private val cancelled = mutableSetOf<String>()
    private var activeSession: String? = null
    private var drainCompletion: (() -> Unit)? = null

    override fun cancelStartup(sessionId: String) {
      synchronized(lock) { cancelled += sessionId }
      startupCancelled.countDown()
    }

    override fun prepare(
      sessionId: String,
      diagnosticGeneration: Long,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      val attempt = prepareCount.incrementAndGet()
      if (blockFirstPrepareAdmission && attempt == 1) {
        firstPrepareBeforeAdmission.countDown()
        awaitIgnoringInterrupt(allowFirstPrepareAdmission)
      }
      synchronized(lock) {
        if (sessionId in cancelled) {
          cancelledBeforeInstall.incrementAndGet()
          prepareCompleted.countDown()
          return
        }
        if (activeSession != null) overlapDetected.set(true)
        check(activeSession == null) { "Realtime media generations overlapped." }
        activeSession = sessionId
      }
      prepareCompleted.countDown()
      if (attempt == 2) secondPrepareCompleted.countDown()
    }

    override fun applyAnswer(
      sessionId: String,
      answerSdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) = Unit

    override fun stop(sessionId: String): Boolean {
      stopEntered.countDown()
      if (blockStop) awaitIgnoringInterrupt(allowStopToReturn)
      synchronized(lock) {
        if (activeSession == sessionId) activeSession = null
      }
      return true
    }

    override fun fenceInputAndDrainPlayout(
      sessionId: String,
      onComplete: () -> Unit,
    ) {
      synchronized(lock) {
        check(activeSession == sessionId)
        check(drainCompletion == null)
        drainCompletion = onComplete
      }
      drainEntered.countDown()
    }

    fun completeDrain() {
      val completion = synchronized(lock) { drainCompletion.also { drainCompletion = null } }
      checkNotNull(completion).invoke()
    }

    override fun setMuted(sessionId: String, muted: Boolean) = Unit
    override fun setInputReady(sessionId: String, ready: Boolean) {
      inputReadyStates += ready
      if (ready) inputReadyEnabled.countDown()
    }


    fun activeSessionId(): String? = synchronized(lock) { activeSession }
  }

  private class DeferredEndedCueArming : T3VoiceCueArming {
    val endedRequested = CountDownLatch(1)
    private val endedCompletion = AtomicReference<((T3VoiceCueCompletion) -> Unit)?>(null)
    private val endedGeneration = AtomicReference(0L)

    override fun isEnabled(): Boolean = true

    override fun setEnabled(enabled: Boolean): T3VoiceCueSettings = T3VoiceCueSettings(enabled)

    override fun settings(): T3VoiceCueSettings = T3VoiceCueSettings(enabled = true)

    override fun requestReady(
      generation: Long,
      completion: (T3VoiceCueCompletion) -> Unit,
    ): Boolean {
      completion(T3VoiceCueCompletion(generation, T3VoiceCue.READY, T3VoiceCueOutcome.DRAINED))
      return true
    }

    override fun requestEnded(
      generation: Long,
      completion: (T3VoiceCueCompletion) -> Unit,
    ): Boolean {
      endedGeneration.set(generation)
      endedCompletion.set(completion)
      endedRequested.countDown()
      return true
    }

    fun completeEnded() {
      checkNotNull(endedCompletion.getAndSet(null))(
        T3VoiceCueCompletion(
          endedGeneration.get(),
          T3VoiceCue.ENDED,
          T3VoiceCueOutcome.DRAINED,
        ),
      )
    }

    override fun cancel(generation: Long) = Unit

    override fun cancelAll() = Unit

    override fun release() = Unit
  }

  private class ImmediateOfferRealtimeMedia : T3VoiceRealtimeMedia {
    override fun cancelStartup(sessionId: String) = Unit

    override fun prepare(
      sessionId: String,
      diagnosticGeneration: Long,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      callback.onSuccess("offer")
    }

    override fun applyAnswer(
      sessionId: String,
      answerSdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) = Unit

    override fun stop(sessionId: String): Boolean = true

    override fun fenceInputAndDrainPlayout(
      sessionId: String,
      onComplete: () -> Unit,
    ) {
      onComplete()
    }

    override fun setMuted(sessionId: String, muted: Boolean) = Unit
    override fun setInputReady(sessionId: String, ready: Boolean) = Unit

  }

  private class TestRealtimeApi(
    private val sessionId: String,
    private val blockEventsUntilReleased: Boolean = false,
    private val blockOfferUntilReleased: Boolean = false,
    private val initialEvents: List<T3VoiceApiRealtimeEvent> = emptyList(),
  ) : T3VoiceRealtimeSessionApi {
    val createCount = AtomicInteger(0)
    val eventEntered = CountDownLatch(1)
    val allowEventToReturn = CountDownLatch(1)
    val offerEntered = CountDownLatch(1)
    val allowOfferToReturn = CountDownLatch(1)
    val contextUpdates = LinkedBlockingQueue<T3VoiceRealtimeContext>()
    private val initialEventsDelivered = AtomicBoolean(false)

    override fun createRealtimeSession(
      calls: T3VoiceHttpCallRegistry,
      target: T3VoiceRealtimeTarget,
      idempotencyKey: String,
    ): T3VoiceApiRealtimeSession {
      createCount.incrementAndGet()
      return T3VoiceApiRealtimeSession(
        state = state(),
        signalingPath = "/voice/realtime/$sessionId/offer",
        expiresAt = "2099-01-01T00:00:00Z",
        heartbeatIntervalSeconds = 60,
      )
    }

    override fun offerRealtimeSession(
      calls: T3VoiceHttpCallRegistry,
      session: T3VoiceApiRealtimeSession,
      sdp: String,
    ): String {
      if (blockOfferUntilReleased) {
        offerEntered.countDown()
        awaitIgnoringInterrupt(allowOfferToReturn)
      }
      return "answer"
    }

    override fun heartbeatRealtimeSession(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      leaseGeneration: Long,
    ): T3VoiceApiSessionState = state()

    override fun closeRealtimeSession(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      leaseGeneration: Long,
    ) = Unit

    override fun updateRealtimeContext(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      leaseGeneration: Long,
      context: T3VoiceRealtimeContext,
    ): T3VoiceApiSessionState {
      contextUpdates.offer(context)
      return state()
    }

    override fun acknowledgeRealtimeClientAction(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      leaseGeneration: Long,
      actionId: String,
      outcome: T3VoiceClientActionOutcome,
      message: String?,
    ) = Unit

    override fun decideRealtimeConfirmation(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      confirmationId: String,
      decision: T3VoiceConfirmationDecision,
    ) = Unit

    override fun realtimeEvents(
      calls: T3VoiceHttpCallRegistry,
      sessionId: String,
      leaseGeneration: Long,
      afterSequence: Long,
    ): T3VoiceApiRealtimeEvents {
      if (initialEvents.isNotEmpty() && initialEventsDelivered.compareAndSet(false, true)) {
        return T3VoiceApiRealtimeEvents(
          state(sequence = initialEvents.maxOf(T3VoiceApiRealtimeEvent::sequence)),
          events = initialEvents,
        )
      }
      if (blockEventsUntilReleased) {
        eventEntered.countDown()
        awaitIgnoringInterrupt(allowEventToReturn)
        return T3VoiceApiRealtimeEvents(state(), emptyList())
      }
      try {
        Thread.sleep(Long.MAX_VALUE)
      } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
        throw T3VoiceNativeApiException("cancelled", retryable = false)
      }
      error("Realtime event wait unexpectedly returned.")
    }

    private fun state(sequence: Long = 0) =
      T3VoiceApiSessionState(
        sessionId = sessionId,
        conversationId = "conversation-$sessionId",
        phase = "live",
        leaseGeneration = 1,
        sequence = sequence,
      )
  }

  private companion object {
    val SESSION =
      T3VoiceNativeSessionConfig(
        baseUrl = "https://environment.example.test",
        accessToken = "native-token",
        expiresAt = "2099-01-01T00:00:00Z",
      )
    val TARGET =
      T3VoiceRealtimeTarget(
        environmentId = "environment-a",
        conversation = T3VoiceConversationSelection.New(T3VoiceConversationRetention.EPHEMERAL, null),
        focus = null,
        threadSettings = null,
      )
    val THREAD_TARGET =
      T3VoiceThreadTarget(
        environmentId = "environment-a",
        projectId = "project-a",
        threadId = "thread-a",
        modelSelection = T3VoiceModelSelection("codex", "gpt-5.4", null),
        runtimeMode = T3VoiceThreadRuntimeMode.FULL_ACCESS,
        interactionMode = T3VoiceThreadInteractionMode.DEFAULT,
      )
    val THREAD_SETTINGS =
      T3VoiceThreadSettings(
        submissionPolicy = T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT,
        playResponses = true,
        autoRearm = true,
        endpointDetection = T3VoiceThreadEndpointDetection(900, 10_000, 120_000),
        rearmDelayMs = 750,
        transcriptionTimeoutMs = 600_000,
        submissionTimeoutMs = 30_000,
        responseTimeoutMs = 600_000,
      )
  }
}

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
