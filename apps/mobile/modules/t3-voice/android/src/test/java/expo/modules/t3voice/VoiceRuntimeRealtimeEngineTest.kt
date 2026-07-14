package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

internal class VoiceRuntimeRealtimeEngineTest {
  private var now = 1_800_000_000_000L
  private val identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4)
  private val fence = VoiceRuntimeRealtimeFence(identity, "mode-1")
  private val authority = VoiceRuntimeRealtimeAuthority(
    identity,
    VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    "https://environment.example.test",
    "runtime-token",
    now + 600_000,
  )
  private val server = FakeServer()
  private val peer = FakePeer()
  private val cues = FakeCues()
  private val handoff = FakeHandoff()
  private val presentation = mutableListOf<VoiceRuntimeRealtimeAction>()
  private val retractedPresentation = mutableListOf<Pair<VoiceRuntimeRealtimeFence, String>>()
  private var presentationWriteResult = VoiceRuntimeRetentionWriteResult.INSERTED
  private var presentationEntered = CountDownLatch(0)
  private var presentationRelease = CountDownLatch(0)
  private val finalizationResults = mutableListOf<VoiceRuntimeRealtimeFinalizationResult>()
  private var repository: VoiceRuntimeRealtimeCheckpointRepository =
    VoiceRuntimeMemoryRealtimeCheckpointRepository()

  @Test
  fun `capture stays disabled until peer connection and ready cue complete`() {
    val engine = engine()

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      engine.start("start-1", fence),
    )
    assertEquals(VoiceRealtimePhase.NEGOTIATING, engine.snapshot()?.phase)
    assertFalse(peer.inputReady)
    assertEquals(listOf("server-start", "peer-prepare"), trace)

    peer.deliverOffer("offer-sdp")
    assertEquals(listOf("server-offer", "peer-answer"), trace.takeLast(2))
    assertFalse(peer.inputReady)

    engine.onPeerConnected(fence, "session-1")
    assertEquals(VoiceRealtimePhase.CUEING, engine.snapshot()?.phase)
    assertEquals("cue-ready", trace.last())
    assertFalse(peer.inputReady)

    cues.completeReady()
    assertTrue(peer.inputReady)
    assertEquals(VoiceRealtimePhase.CONNECTED, engine.snapshot()?.phase)
    assertEquals(now, engine.snapshot()?.lastConnectedAtEpochMillis)
  }

  @Test
  fun `start rejects before remote work when terminal retention is full`() {
    val retained = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    repeat(64) { index ->
      retained.publishTerminal(
        VoiceRuntimeRealtimeTerminalSummary(
          identity = VoiceRuntimeIdentity("retained-$index", "instance-$index", 1),
          modeSessionId = "retained-mode-$index",
          environmentId = "environment-1",
          conversationId = "conversation-$index",
          sessionId = "session-$index",
          outcome = VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
          reason = "completed",
          lastConnectedAtEpochMillis = now - 200,
          terminalAtEpochMillis = now - 100,
          serverCleanupPending = false,
          expiresAtEpochMillis = now + 60_000,
        ),
      )
    }
    repository = retained
    val engine = engine()

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Rejected("realtime-terminal-retention-full"),
      engine.start("start-1", fence),
    )
    assertEquals(0, server.startCount)
    assertNull(repository.load())
  }

  @Test
  fun `blocked action poll does not delay offer or snapshot`() {
    val engine = engine()
    assertTrue(engine.start("start-1", fence) is VoiceRuntimeRealtimeCommandResult.Accepted)
    server.blockActions()
    val pollResult = AtomicReference<Boolean>()
    val pollThread = Thread { pollResult.set(engine.pollActions(fence)) }
    pollThread.start()
    assertTrue(server.awaitActions())

    val offerThread = Thread { peer.deliverOffer("offer") }
    offerThread.start()
    offerThread.join(1_000)

    assertFalse("Offer processing waited for the action long poll.", offerThread.isAlive)
    assertEquals(VoiceRealtimePhase.NEGOTIATING, engine.snapshot()?.phase)
    assertTrue(trace.contains("server-offer"))
    server.releaseActions()
    pollThread.join(1_000)
    assertFalse(pollThread.isAlive)
    assertTrue(pollResult.get())
  }

  @Test
  fun `stop cancels preparing session while server start is blocked`() {
    val engine = engine()
    server.blockStart()
    val startResult = AtomicReference<VoiceRuntimeRealtimeCommandResult>()
    val startThread = Thread { startResult.set(engine.start("start-1", fence)) }
    startThread.start()
    assertTrue(server.awaitStart())
    assertEquals(VoiceRealtimePhase.PREPARING, engine.snapshot()?.phase)

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      engine.stop("stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )
    assertNull(engine.snapshot())

    server.releaseStart()
    startThread.join(1_000)
    assertFalse(startThread.isAlive)
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Rejected("start-cancelled"),
      startResult.get(),
    )
    assertTrue(trace.contains("server-close"))
  }

  @Test
  fun `same command retry adopts one in-flight server start without closing it`() {
    val engine = engine()
    server.blockStart()
    val firstResult = AtomicReference<VoiceRuntimeRealtimeCommandResult>()
    val firstThread = Thread { firstResult.set(engine.start("start-1", fence)) }
    firstThread.start()
    assertTrue(server.awaitStart())

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true),
      engine.start("start-1", fence),
    )
    server.releaseStart()
    firstThread.join(1_000)

    assertFalse(firstThread.isAlive)
    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(false), firstResult.get())
    assertEquals(1, server.startCount)
    assertFalse(trace.contains("server-close"))
  }

  @Test
  fun `failed late close after preparing cancellation remains durable`() {
    val engine = engine()
    server.closeSucceeds = false
    server.blockStart()
    val startThread = Thread { engine.start("start-1", fence) }
    startThread.start()
    assertTrue(server.awaitStart())
    engine.stop("stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)

    server.releaseStart()
    startThread.join(1_000)
    assertFalse(startThread.isAlive)
    val terminal = repository.terminals(now).single()
    assertTrue(terminal.serverCleanupPending)
    assertEquals("session-1", terminal.sessionId)
    assertTrue(engine.isOperational())
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
      repository.loadFinalization()?.stage,
    )
  }

  @Test
  fun `failed late close is republished after cancellation terminal acknowledgement`() {
    val engine = engine()
    server.closeSucceeds = false
    server.blockStart()
    val startThread = Thread { engine.start("start-1", fence) }
    startThread.start()
    assertTrue(server.awaitStart())
    engine.stop("stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    assertTrue(repository.acknowledgeTerminal(
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(identity, fence.modeSessionId),
    ))

    server.releaseStart()
    startThread.join(1_000)

    assertFalse(startThread.isAlive)
    val terminal = repository.terminals(now).single()
    assertTrue(terminal.serverCleanupPending)
    assertEquals("session-1", terminal.sessionId)
    assertEquals(2, projectedTerminals.size)
  }

  @Test
  fun `same command retry after preparing cancellation does not start another session`() {
    val engine = engine()
    server.blockStart()
    val startThread = Thread { engine.start("start-1", fence) }
    startThread.start()
    assertTrue(server.awaitStart())
    engine.stop("stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Rejected("start-cancelled"),
      engine.start("start-1", fence),
    )
    server.releaseStart()
    startThread.join(1_000)

    assertFalse(startThread.isAlive)
    assertEquals(1, server.startCount)
  }

  @Test
  fun `invalid successful start response is closed`() {
    val engine = engine()
    server.startResponse = startResult().copy(
      state = startResult().state.copy(conversationId = "wrong-conversation"),
    )

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Rejected("invalid-start-response"),
      engine.start("start-1", fence),
    )

    assertTrue(trace.contains("server-close"))
    assertNull(engine.snapshot())
  }

  @Test
  fun `heartbeat cannot bypass signaling or ready cue`() {
    val engine = engine()
    assertTrue(engine.start("start-1", fence) is VoiceRuntimeRealtimeCommandResult.Accepted)
    server.heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Failure("network", true)
    assertFalse(engine.heartbeat(fence))
    assertEquals(VoiceRealtimePhase.NEGOTIATING, engine.snapshot()?.phase)

    peer.deliverOffer("offer")
    engine.onPeerConnected(fence, "session-1")
    assertFalse(engine.heartbeat(fence))
    assertEquals(VoiceRealtimePhase.CUEING, engine.snapshot()?.phase)
    cues.completeReady()
    assertEquals(VoiceRealtimePhase.CONNECTED, engine.snapshot()?.phase)
  }

  @Test
  fun `stop completes while action poll is blocked and discards its late response`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.NavigateThread(
      7,
      now,
      "late-action",
      "project-1",
      "thread-1",
      now + 60_000,
    )
    server.blockActions()
    val pollResult = AtomicReference<Boolean>()
    val pollThread = Thread { pollResult.set(engine.pollActions(fence)) }
    pollThread.start()
    assertTrue(server.awaitActions())

    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      engine.stop("stop-while-polling", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )
    cues.completeEnded()
    assertNull(engine.snapshot())

    server.releaseActions()
    pollThread.join(1_000)
    assertFalse(pollThread.isAlive)
    assertFalse(pollResult.get())
    assertTrue(presentation.isEmpty())
  }

  @Test
  fun `shutdown cleanup does not hold engine monitor while server close is blocked`() {
    val engine = connectedEngine()
    server.blockClose()
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      engine.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )
    val finishThread = Thread { cues.completeEnded() }
    finishThread.start()
    assertTrue(server.awaitClose())

    assertNull(engine.snapshot())
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
      repository.loadFinalization()?.stage,
    )
    val terminationThread = Thread {
      engine.onPeerTerminated(fence, "session-1", "peer-closed")
    }
    terminationThread.start()
    terminationThread.join(1_000)
    assertFalse("Intentional peer termination launched another close.", terminationThread.isAlive)
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true),
      engine.stop("stop-2", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )

    server.releaseClose()
    finishThread.join(1_000)
    assertFalse(finishThread.isAlive)
    assertNull(engine.snapshot())
    assertEquals(1, server.closeCount)
  }

  @Test
  fun `failed ordinary close survives terminal acknowledgement and restart`() {
    val first = connectedEngine()
    server.closeSucceeds = false
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      first.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )
    cues.completeEnded()

    assertNull(first.snapshot())
    assertTrue(first.isOperational())
    val pending = requireNotNull(repository.loadFinalization())
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING, pending.stage)
    assertEquals("start-1.close.user-stop", pending.closeOperationId)
    assertEquals("control-token", pending.session.controlGrant.token)
    assertEquals(2L, pending.session.state.leaseGeneration)
    val reported = repository.terminals(now).single()
    assertTrue(reported.serverCleanupPending)
    assertTrue(repository.acknowledgeTerminal(VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
      reported.identity,
      reported.modeSessionId,
    )))
    assertTrue(repository.terminals(now).isEmpty())
    assertEquals(pending, repository.loadFinalization())

    server.closeSucceeds = true
    val replacement = engine()
    val completed = replacement.reconcileFinalization()
      as VoiceRuntimeRealtimeFinalizationResult.Completed
    assertFalse(completed.summary.serverCleanupPending)
    assertNull(repository.loadFinalization())
    assertFalse(replacement.isOperational())
    assertEquals("start-1.close.user-stop", server.lastCloseOperationId)
    assertEquals("control-token", server.lastCloseControlToken)
  }

  @Test
  fun `failed session close survives terminal acknowledgement and restart`() {
    val first = connectedEngine()
    server.closeSucceeds = false

    first.onPeerTerminated(fence, "session-1", "peer-failed")

    val pending = requireNotNull(repository.loadFinalization())
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, pending.outcome)
    assertEquals("peer-failed", pending.reason)
    val terminal = repository.terminals(now).single()
    assertTrue(terminal.serverCleanupPending)
    assertTrue(repository.acknowledgeTerminal(
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(terminal.identity, terminal.modeSessionId),
    ))
    assertEquals(pending, repository.loadFinalization())

    server.closeSucceeds = true
    val replacement = engine()
    assertTrue(
      replacement.reconcileFinalization() is VoiceRuntimeRealtimeFinalizationResult.Completed,
    )
    assertNull(repository.loadFinalization())
  }

  @Test
  fun `start is idempotent and every callback is fenced by instance generation and mode`() {
    val engine = engine()
    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(false), engine.start("start-1", fence))
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false, replayed = true),
      engine.start("start-1", fence),
    )
    assertEquals(1, server.startCount)
    expectThrows<VoiceRuntimeIdempotencyConflictException> {
      engine.start("start-1", fence.copy(modeSessionId = "other"))
    }
    expectThrows<VoiceRuntimeFenceException> {
      engine.onPeerConnected(
        fence.copy(identity = identity.copy(runtimeInstanceId = "stale")),
        "session-1",
      )
    }
    expectThrows<VoiceRuntimeFenceException> {
      engine.onPeerConnected(fence, "other-session")
    }
  }

  @Test
  fun `presentation actions hold the ordered cursor until focus and ack succeed`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.NavigateThread(
      7,
      now,
      "action-1",
      "project-1",
      "thread-1",
      now + 60_000,
    )
    server.actionValues += VoiceRuntimeRealtimeAction.ConfirmationRequired(
      9,
      now,
      "action-2",
      "confirmation-1",
      "tool-call-1",
      "send_message",
      "Send a message",
      now + 60_000,
    )

    assertTrue(engine.pollActions(fence))
    assertEquals(listOf("action-1"), presentation.map { actionId(it) })
    assertEquals(0L, engine.snapshot()?.lastActionSequence)
    assertEquals(1, server.actionsCount)
    assertTrue(engine.pollActions(fence))
    assertEquals(1, server.actionsCount)

    assertTrue(
      engine.acknowledgePresentationAction(
        fence,
        "ack-1",
        "action-1",
        VoiceRuntimeRealtimePresentationDecision.Navigate(
          VoiceRuntimeRealtimeActionOutcome.SUCCEEDED,
          null,
        ),
      ),
    )
    assertEquals(listOf("focus:project-1:thread-1", "ack:7"), trace.takeLast(2))
    assertEquals(7L, engine.snapshot()?.lastActionSequence)

    assertTrue(engine.pollActions(fence))
    assertEquals(listOf("action-1", "action-2"), presentation.map { actionId(it) })
    assertEquals(7L, engine.snapshot()?.lastActionSequence)
    assertTrue(
      engine.acknowledgePresentationAction(
        fence,
        "ack-2",
        "action-2",
        VoiceRuntimeRealtimePresentationDecision.Confirmation(
          "confirmation-1",
          "reject",
        ),
      ),
    )
    assertEquals(9L, engine.snapshot()?.lastActionSequence)
  }

  @Test
  fun `presentation retention must acknowledge before pending action advances`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.NavigateThread(
      7,
      now,
      "action-1",
      "project-1",
      "thread-1",
      now + 60_000,
    )
    presentationWriteResult = VoiceRuntimeRetentionWriteResult.FULL

    assertFalse(engine.pollActions(fence))
    assertNull(engine.snapshot()?.pendingAction)
    assertEquals(0L, engine.snapshot()?.lastActionSequence)
    assertTrue(presentation.isEmpty())

    presentationWriteResult = VoiceRuntimeRetentionWriteResult.INSERTED
    assertTrue(engine.pollActions(fence))
    assertEquals("action-1", actionId(requireNotNull(engine.snapshot()?.pendingAction)))
    assertEquals(listOf("action-1"), presentation.map(::actionId))
    assertEquals(2, server.actionsCount)
  }

  @Test
  fun `late presentation publication is retracted with its exact fence after stop wins`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.NavigateThread(
      7, now, "action-1", "project-1", "thread-1", now + 60_000,
    )
    blockPresentation()
    val pollResult = AtomicReference<Boolean>()
    val pollThread = Thread { pollResult.set(engine.pollActions(fence)) }
    pollThread.start()
    assertTrue(awaitPresentation())

    val stopThread = Thread {
      engine.stop("stop-during-presentation", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    }
    stopThread.start()
    stopThread.join(1_000)
    assertFalse("Stop waited for presentation retention.", stopThread.isAlive)

    releasePresentation()
    pollThread.join(1_000)

    assertFalse(pollThread.isAlive)
    assertFalse(pollResult.get())
    assertTrue(presentation.isEmpty())
    assertEquals(listOf(fence to "action-1"), retractedPresentation)
  }

  @Test
  fun `presentation publication is retracted when checkpoint admission cannot persist`() {
    val durable = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    val failing = FailingSaveRepository(durable)
    repository = failing
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.NavigateThread(
      7, now, "action-1", "project-1", "thread-1", now + 60_000,
    )
    failing.failNextSave = true

    expectThrows<IllegalStateException> { engine.pollActions(fence) }

    assertTrue(presentation.isEmpty())
    assertEquals(listOf(fence to "action-1"), retractedPresentation)
    assertNull(durable.load()?.pendingAction)
  }

  @Test
  fun `repeated close failure projects one pending terminal then completion update`() {
    val engine = connectedEngine()
    server.closeSucceeds = false
    engine.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    cues.completeEnded()

    assertEquals(1, projectedTerminals.size)
    val firstPending = requireNotNull(repository.loadFinalization())
    assertEquals(1, firstPending.attemptCount)
    val retry = engine.reconcileFinalization() as VoiceRuntimeRealtimeFinalizationResult.Pending
    assertEquals(2, retry.attemptCount)
    assertEquals(1, projectedTerminals.size)

    server.closeSucceeds = true
    assertTrue(engine.reconcileFinalization() is VoiceRuntimeRealtimeFinalizationResult.Completed)
    assertEquals(listOf(true, false), projectedTerminals.map { it.serverCleanupPending })
    assertNull(repository.loadFinalization())
  }

  @Test
  fun `nonretryable close failure converges without blocking a future start`() {
    val engine = connectedEngine()
    server.closeSucceeds = false
    server.closeFailureRetryable = false
    engine.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    cues.completeEnded()

    assertFalse(engine.isOperational())
    assertNull(repository.loadFinalization())
    assertTrue(repository.terminals(now).single().serverCleanupPending)
    assertTrue(engine.start("start-2", fence) is VoiceRuntimeRealtimeCommandResult.Accepted)
  }

  @Test
  fun `expired parent authority does not prevent child-grant source cleanup`() {
    val shortAuthority = authority.copy(expiresAtEpochMillis = now + 100)
    val engine = connectedEngine(shortAuthority)
    server.closeSucceeds = false
    engine.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    cues.completeEnded()
    val closeCount = server.closeCount

    now = shortAuthority.expiresAtEpochMillis
    server.closeSucceeds = true
    val result = engine.reconcileFinalization()

    assertTrue(result is VoiceRuntimeRealtimeFinalizationResult.Completed)
    assertEquals(closeCount + 1, server.closeCount)
    assertEquals("control-token", server.lastCloseAuthorityToken)
    assertNull(repository.loadFinalization())
    assertFalse(engine.isOperational())
  }

  @Test
  fun `source close ignores expired handoff grant after activation`() {
    server.transitionGrantExpiresAtEpochMillis = now + 100
    val engine = connectedEngine()
    server.closeSucceeds = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    assertTrue(engine.pollActions(fence))
    peer.completeDrain()
    cues.completeEnded()
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
      repository.loadFinalization()?.stage,
    )

    now += 100
    server.closeSucceeds = true
    val result = engine.reconcileFinalization()

    assertTrue(result is VoiceRuntimeRealtimeFinalizationResult.Completed)
    assertTrue(handoff.activated)
    assertEquals(2, server.closeCount)
    assertNull(repository.loadFinalization())
  }

  @Test
  fun `handoff commit can recover after source control grant expires`() {
    server.transitionGrantExpiresAtEpochMillis = now + 600_000
    val engine = connectedEngine()
    server.commitSucceeds = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    assertTrue(engine.pollActions(fence))
    peer.completeDrain()
    cues.completeEnded()
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
      repository.loadFinalization()?.stage,
    )

    now = startResult().controlGrant.expiresAtEpochMillis
    server.commitSucceeds = true
    val result = engine.reconcileFinalization()

    assertTrue(result is VoiceRuntimeRealtimeFinalizationResult.Completed)
    assertTrue(handoff.activated)
    assertEquals(0, server.closeCount)
    assertEquals("thread-token", server.lastCommitAuthorityToken)
    val terminal = repository.terminals(now).single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, terminal.outcome)
    assertTrue(terminal.serverCleanupPending)
  }

  @Test
  fun `expired transition grant converges before handoff commit while control grant remains live`() {
    server.transitionGrantExpiresAtEpochMillis = now + 100
    val engine = connectedEngine()
    server.commitSucceeds = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    assertTrue(engine.pollActions(fence))
    peer.completeDrain()
    cues.completeEnded()
    val commitCount = server.commitCount

    now += 100
    server.commitSucceeds = true
    val result = engine.reconcileFinalization()

    assertTrue(result is VoiceRuntimeRealtimeFinalizationResult.Completed)
    assertEquals(commitCount, server.commitCount)
    assertEquals(1, server.closeCount)
    assertFalse(handoff.activated)
    assertNull(repository.loadFinalization())
    val terminal = repository.terminals(now).single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, terminal.outcome)
    assertEquals("handoff-transition-credential-expired", terminal.reason)
    assertFalse(terminal.serverCleanupPending)
  }

  @Test
  fun `handoff reserves before drain and commits after media release before activation`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12,
      now,
      "handoff-1",
      "project-1",
      "thread-1",
      true,
      now + 60_000,
    )

    assertTrue(engine.pollActions(fence))
    assertEquals(VoiceRealtimePhase.DRAINING, engine.snapshot()?.phase)
    assertFalse(peer.inputReady)
    assertEquals(
      listOf("handoff-exchange", "handoff-prepare", "input:false", "peer-drain"),
      trace.takeLast(4),
    )
    assertEquals(12L, engine.snapshot()?.lastActionSequence)
    assertFalse(handoff.activated)

    peer.completeDrain()
    assertEquals(VoiceRealtimePhase.STOPPING, engine.snapshot()?.phase)
    assertEquals(listOf("peer-close", "cue-ended"), trace.takeLast(2))
    assertFalse(handoff.activated)

    cues.completeEnded()
    assertEquals(
      listOf("handoff-commit", "handoff-activate", "server-close"),
      trace.takeLast(3),
    )
    assertTrue(handoff.activated)
    assertNull(engine.snapshot())
    val terminal = repository.terminals(now).single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, terminal.outcome)
    assertEquals("thread-handoff", terminal.reason)
    assertFalse(terminal.serverCleanupPending)
  }

  @Test
  fun `handoff preparation does not hold engine monitor and stale preparation cannot drain`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    handoff.blockPrepare()
    val pollResult = AtomicReference<Boolean>()
    val pollThread = Thread { pollResult.set(engine.pollActions(fence)) }
    pollThread.start()
    assertTrue(handoff.awaitPrepare())

    val stopThread = Thread {
      engine.stop("stop-during-prepare", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)
    }
    stopThread.start()
    stopThread.join(1_000)
    assertFalse("Stop waited for handoff preparation.", stopThread.isAlive)

    handoff.releasePrepare()
    pollThread.join(1_000)

    assertFalse(pollThread.isAlive)
    assertFalse(pollResult.get())
    assertFalse(trace.contains("peer-drain"))
    assertNull(engine.snapshot()?.pendingHandoffExchange)
    assertTrue(trace.contains("handoff-rollback"))
  }

  @Test
  fun `synchronous finalization completion is reported after the engine monitor is released`() {
    val callbackBlocked = AtomicReference(false)
    lateinit var engine: VoiceRuntimeRealtimeEngine
    engine = engine(
      finalizationSink = VoiceRuntimeRealtimeFinalizationSink { result ->
        val probe = Thread { engine.isOperational() }
        probe.start()
        probe.join(1_000)
        callbackBlocked.set(probe.isAlive)
        finalizationResults += result
      },
    )
    assertTrue(engine.start("start-1", fence) is VoiceRuntimeRealtimeCommandResult.Accepted)
    peer.deliverOffer("offer")
    engine.onPeerConnected(fence, "session-1")
    cues.completeReady()
    engine.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE)

    cues.completeEnded()

    assertFalse(callbackBlocked.get())
    assertTrue(finalizationResults.single() is VoiceRuntimeRealtimeFinalizationResult.Completed)
  }

  @Test
  fun `idle reconciliation is reported instead of being discarded`() {
    val engine = engine()

    val result = engine.reconcileFinalization()

    assertEquals(VoiceRuntimeRealtimeFinalizationResult.Idle, result)
    assertEquals(listOf(VoiceRuntimeRealtimeFinalizationResult.Idle), finalizationResults)
  }

  @Test
  fun `failed handoff commit retains the transition and recovery retries before closing`() {
    val engine = connectedEngine()
    server.commitSucceeds = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )

    assertTrue(engine.pollActions(fence))
    peer.completeDrain()
    cues.completeEnded()

    assertEquals("handoff-commit", trace.last())
    assertFalse(trace.contains("server-close"))
    assertFalse(handoff.activated)
    assertNull(engine.snapshot())
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
      repository.loadFinalization()?.stage,
    )
    assertTrue(engine.isOperational())
    assertTrue(repository.terminals(now).isEmpty())

    server.commitSucceeds = true
    val recovered = engine().recoverInterrupted(identity)

    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, recovered?.outcome)
    assertEquals(listOf("handoff-commit", "handoff-activate", "server-close"), trace.takeLast(3))
    assertTrue(handoff.activated)
  }

  @Test
  fun `nonretryable handoff commit failure converges without activation`() {
    val engine = connectedEngine()
    server.commitSucceeds = false
    server.commitFailureRetryable = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )

    assertTrue(engine.pollActions(fence))
    peer.completeDrain()
    cues.completeEnded()

    assertFalse(engine.isOperational())
    assertNull(repository.loadFinalization())
    assertFalse(handoff.activated)
    assertEquals(1, server.closeCount)
    val terminal = repository.terminals(now).single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, terminal.outcome)
    assertEquals("handoff-commit-failed", terminal.reason)
    assertFalse(terminal.serverCleanupPending)
  }

  @Test
  fun `failed local handoff preparation never commits server authority`() {
    val engine = connectedEngine()
    handoff.prepareSucceeds = false
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )

    assertFalse(engine.pollActions(fence))

    assertTrue(trace.contains("handoff-prepare"))
    assertFalse(trace.contains("handoff-commit"))
    assertFalse(handoff.activated)
    assertEquals("handoff-admission-failed", repository.terminals(now).single().reason)
  }

  @Test
  fun `prepared handoff does not drain or commit when checkpoint persistence fails`() {
    val durable = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    val failing = FailingSaveRepository(durable)
    repository = failing
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    failing.failNextSave = true

    expectThrows<IllegalStateException> { engine.pollActions(fence) }

    assertTrue(trace.contains("handoff-prepare"))
    assertTrue(trace.contains("handoff-rollback"))
    assertFalse(trace.contains("peer-drain"))
    assertFalse(trace.contains("handoff-commit"))
    assertNull(durable.load()?.pendingHandoffExchange)
  }

  @Test
  fun `prepared handoff retries commit and activation after interruption`() {
    val first = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    assertTrue(first.pollActions(fence))
    peer.completeDrain()
    handoff.throwOnActivate = true
    cues.completeEnded()
    assertNull(first.snapshot())
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING,
      repository.loadFinalization()?.stage,
    )

    handoff.throwOnActivate = false
    val replacement = engine()
    val recovered = replacement.recoverInterrupted(identity)

    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, recovered?.outcome)
    assertTrue(handoff.activated)
    assertEquals(1, trace.count { it == "handoff-commit" })
  }

  @Test
  fun `post-commit activation failure retains prepared handoff for restart`() {
    val first = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
      12, now, "handoff-1", "project-1", "thread-1", true, now + 60_000,
    )
    assertTrue(first.pollActions(fence))
    peer.completeDrain()
    handoff.activateSucceeds = false
    cues.completeEnded()

    assertNull(first.snapshot())
    assertEquals(
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING,
      repository.loadFinalization()?.stage,
    )
    assertTrue(repository.terminals(now).isEmpty())

    handoff.activateSucceeds = true
    val replacement = engine()
    val recovered = replacement.recoverInterrupted(identity)
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, recovered?.outcome)
    assertTrue(handoff.activated)
  }

  @Test
  fun `explicit stop closes immediately while agent stop drains`() {
    val immediate = connectedEngine()
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      immediate.stop("stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )
    assertFalse(trace.contains("peer-drain"))
    assertTrue(trace.contains("peer-close"))
    cues.completeEnded()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.STOPPED, repository.terminals(now).single().outcome)
    assertEquals(repository.terminals(now).single(), projectedTerminals.single())

    resetFakes()
    val draining = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.StopRealtimeVoice(3, now)
    assertTrue(draining.pollActions(fence))
    assertEquals(VoiceRealtimePhase.DRAINING, draining.snapshot()?.phase)
    assertTrue(trace.contains("peer-drain"))
    assertFalse(trace.contains("peer-close"))
  }

  @Test
  fun `drain deadline forces shutdown when the peer never completes`() {
    val engine = connectedEngine()
    server.actionValues += VoiceRuntimeRealtimeAction.StopRealtimeVoice(3, now)
    assertTrue(engine.pollActions(fence))
    assertFalse(engine.onDrainDeadline(fence, now + 2_499))
    assertFalse(trace.contains("peer-close"))
    assertTrue(engine.onDrainDeadline(fence, now + 2_500))
    assertTrue(trace.contains("peer-close"))
  }

  @Test
  fun `heartbeat retry and terminal state preserve one server session`() {
    val engine = connectedEngine()
    server.heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Failure("network", true)
    assertFalse(engine.heartbeat(fence))
    assertEquals(VoiceRealtimePhase.RETRYING, engine.snapshot()?.phase)

    server.heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Success(
      heartbeat(disposition = "live"),
    )
    assertTrue(engine.heartbeat(fence))
    assertEquals(VoiceRealtimePhase.CONNECTED, engine.snapshot()?.phase)
    assertEquals(1, server.startCount)

    server.heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Success(
      heartbeat(disposition = "terminal"),
    )
    assertTrue(engine.heartbeat(fence))
    assertEquals(VoiceRealtimePhase.STOPPING, engine.snapshot()?.phase)
  }

  @Test
  fun `process restart records interrupted summary and attempts orphan cleanup`() {
    val first = connectedEngine()
    assertEquals(VoiceRealtimePhase.CONNECTED, first.snapshot()?.phase)
    val replacement = VoiceRuntimeRealtimeEngine(
      authority.copy(identity = identity.copy(runtimeInstanceId = "instance-2")),
      { now },
      server,
      peer,
      cues,
      handoff,
      presentationSink(),
      repository,
      VoiceRuntimeRealtimeFinalizationSink {},
    )

    val terminal = replacement.recoverInterrupted(identity.copy(runtimeInstanceId = "instance-2"))
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED, terminal?.outcome)
    assertEquals("process-restarted", terminal?.reason)
    assertFalse(requireNotNull(terminal).serverCleanupPending)
    assertNull(replacement.snapshot())
    assertTrue(trace.contains("server-close"))
  }

  private val trace = mutableListOf<String>()
  private val projectedTerminals = mutableListOf<VoiceRuntimeRealtimeTerminalSummary>()

  private fun engine(
    engineAuthority: VoiceRuntimeRealtimeAuthority = authority,
    finalizationSink: VoiceRuntimeRealtimeFinalizationSink =
      VoiceRuntimeRealtimeFinalizationSink { finalizationResults += it },
  ) = VoiceRuntimeRealtimeEngine(
    engineAuthority,
    { now },
    server,
    peer,
    cues,
    handoff,
    presentationSink(),
    repository,
    finalizationSink,
    terminalSink = VoiceRuntimeRealtimeTerminalSink { projectedTerminals += it },
  )

  private fun connectedEngine(
    engineAuthority: VoiceRuntimeRealtimeAuthority = authority,
  ): VoiceRuntimeRealtimeEngine = engine(engineAuthority).also {
    assertTrue(it.start("start-1", fence) is VoiceRuntimeRealtimeCommandResult.Accepted)
    peer.deliverOffer("offer")
    it.onPeerConnected(fence, "session-1")
    cues.completeReady()
    trace.clear()
  }

  private fun resetFakes() {
    trace.clear()
    server.reset()
    peer.reset()
    cues.reset()
    handoff.activated = false
    handoff.reset()
    presentation.clear()
    retractedPresentation.clear()
    presentationWriteResult = VoiceRuntimeRetentionWriteResult.INSERTED
    presentationEntered = CountDownLatch(0)
    presentationRelease = CountDownLatch(0)
    finalizationResults.clear()
    projectedTerminals.clear()
    repository = VoiceRuntimeMemoryRealtimeCheckpointRepository()
  }

  private fun startResult() = VoiceRuntimeRealtimeStartResult(
    VoiceRuntimeRealtimeSessionState(
      "session-1",
      "conversation-1",
      "signaling",
      2,
      0,
    ),
    "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
    now + 600_000,
    VoiceRuntimeRealtimeControlGrant("control-token", now + 300_000, 15, 45),
  )

  private fun heartbeat(disposition: String) = VoiceRuntimeRealtimeHeartbeatResult(
    startResult().state.copy(phase = if (disposition == "live") "listening" else "ended"),
    disposition,
    false,
    now + 300_000,
  )

  private inner class FakeServer : VoiceRuntimeRealtimeServer {
    var startCount = 0
    var commitCount = 0
    var closeCount = 0
    var lastCommitAuthorityToken: String? = null
    var lastCloseAuthorityToken: String? = null
    var lastCloseOperationId: String? = null
    var lastCloseControlToken: String? = null
    var actionsCount = 0
    var commitSucceeds = true
    var commitFailureRetryable = true
    var closeSucceeds = true
    var closeFailureRetryable = true
    var transitionGrantExpiresAtEpochMillis = now + 300_000
    var startResponse = startResult()
    val actionValues = mutableListOf<VoiceRuntimeRealtimeAction>()
    var heartbeatResult: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHeartbeatResult> =
      VoiceRuntimeRealtimeRemoteResult.Success(heartbeat("live"))
    private var actionsEntered = CountDownLatch(0)
    private var actionsRelease = CountDownLatch(0)
    private var startEntered = CountDownLatch(0)
    private var startRelease = CountDownLatch(0)
    private var closeEntered = CountDownLatch(0)
    private var closeRelease = CountDownLatch(0)

    fun blockStart() {
      startEntered = CountDownLatch(1)
      startRelease = CountDownLatch(1)
    }

    fun awaitStart(): Boolean = startEntered.await(1, TimeUnit.SECONDS)

    fun releaseStart() = startRelease.countDown()

    fun blockClose() {
      closeEntered = CountDownLatch(1)
      closeRelease = CountDownLatch(1)
    }

    fun awaitClose(): Boolean = closeEntered.await(1, TimeUnit.SECONDS)

    fun releaseClose() = closeRelease.countDown()

    fun blockActions() {
      actionsEntered = CountDownLatch(1)
      actionsRelease = CountDownLatch(1)
    }

    fun awaitActions(): Boolean = actionsEntered.await(1, TimeUnit.SECONDS)

    fun releaseActions() = actionsRelease.countDown()

    fun reset() {
      startCount = 0
      commitCount = 0
      closeCount = 0
      lastCommitAuthorityToken = null
      lastCloseAuthorityToken = null
      lastCloseOperationId = null
      lastCloseControlToken = null
      actionsCount = 0
      actionValues.clear()
      commitSucceeds = true
      commitFailureRetryable = true
      closeSucceeds = true
      closeFailureRetryable = true
      transitionGrantExpiresAtEpochMillis = now + 300_000
      startResponse = startResult()
      heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Success(heartbeat("live"))
      actionsEntered = CountDownLatch(0)
      actionsRelease = CountDownLatch(0)
      startEntered = CountDownLatch(0)
      startRelease = CountDownLatch(0)
      closeEntered = CountDownLatch(0)
      closeRelease = CountDownLatch(0)
    }

    override fun start(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      clientOperationId: String,
    ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeStartResult> {
      startEntered.countDown()
      check(startRelease.await(2, TimeUnit.SECONDS)) { "Timed out waiting to release start." }
      startCount++
      trace += "server-start"
      return VoiceRuntimeRealtimeRemoteResult.Success(startResponse)
    }

    override fun offer(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      clientOperationId: String,
      sdp: String,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      VoiceRuntimeRealtimeAnswer("session-1", 2, "answer-sdp", false),
    ).also { trace += "server-offer" }

    override fun heartbeat(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
    ) = heartbeatResult

    override fun actions(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      afterSequence: Long,
      waitMilliseconds: Long,
    ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionsResult> {
      actionsEntered.countDown()
      check(actionsRelease.await(2, TimeUnit.SECONDS)) { "Timed out waiting to release actions." }
      actionsCount++
      return VoiceRuntimeRealtimeRemoteResult.Success(
        VoiceRuntimeRealtimeActionsResult(
          session.state,
          actionValues.filter { it.sequence > afterSequence },
        ),
      )
    }

    override fun acknowledgeAction(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      action: VoiceRuntimeRealtimeAction,
      clientOperationId: String,
      decision: VoiceRuntimeRealtimePresentationDecision,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      VoiceRuntimeRealtimeActionAckResult(
        actionId(action),
        action.sequence,
        when (decision) {
          is VoiceRuntimeRealtimePresentationDecision.Navigate -> decision.outcome
          is VoiceRuntimeRealtimePresentationDecision.Confirmation ->
            if (decision.decision == "approve") VoiceRuntimeRealtimeActionOutcome.SUCCEEDED
            else VoiceRuntimeRealtimeActionOutcome.FAILED
        },
        false,
      ),
    ).also { trace += "ack:${action.sequence}" }

    override fun updateFocus(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      clientOperationId: String,
      focus: VoiceRuntimeRealtimeFocus?,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      VoiceRuntimeRealtimeFocusResult(session.state, focus, false),
    ).also { trace += "focus:${focus?.projectId}:${focus?.threadId}" }

    override fun exchangeHandoff(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
      plan: VoiceRuntimeRealtimeHandoffPlan,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      VoiceRuntimeRealtimeHandoffExchangeResult(
        action.actionId,
        action.sequence,
        action.projectId,
        action.threadId,
        action.autoRearm,
        VoiceRuntimeRealtimeTransitionGrant(
          "thread-token",
          transitionGrantExpiresAtEpochMillis,
          identity.generation + 1,
          plan.threadModeSessionId,
          VoiceRuntimeRealtimeThreadTarget(
            plan.environmentId,
            action.projectId,
            action.threadId,
            plan.speechPreset,
            action.autoRearm,
            plan.endpointPolicy,
            plan.speechEnabled,
            plan.rearmGuardMs,
          ),
        ),
        false,
      ),
    ).also { trace += "handoff-exchange" }

    override fun commitHandoff(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      exchange: VoiceRuntimeRealtimeHandoffExchangeResult,
    ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHandoffCommitResult> {
      commitCount++
      lastCommitAuthorityToken = authority.runtimeToken
      trace += "handoff-commit"
      return if (commitSucceeds) VoiceRuntimeRealtimeRemoteResult.Success(
        VoiceRuntimeRealtimeHandoffCommitResult(
          exchange.actionId,
          exchange.actionSequence,
          true,
          false,
        ),
      ) else VoiceRuntimeRealtimeRemoteResult.Failure(
        "handoff-commit-failed",
        commitFailureRetryable,
      )
    }

    override fun close(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      clientOperationId: String,
    ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeCloseResult> {
      closeCount++
      lastCloseAuthorityToken = authority.runtimeToken
      lastCloseOperationId = clientOperationId
      lastCloseControlToken = session.controlGrant.token
      closeEntered.countDown()
      check(closeRelease.await(2, TimeUnit.SECONDS)) { "Timed out waiting to release close." }
      trace += "server-close"
      return if (closeSucceeds) {
        VoiceRuntimeRealtimeRemoteResult.Success(
          VoiceRuntimeRealtimeCloseResult(session.state.copy(phase = "ended"), true, false),
        )
      } else VoiceRuntimeRealtimeRemoteResult.Failure("close-failed", closeFailureRetryable)
    }
  }

  private inner class FakePeer : VoiceRuntimeRealtimePeer {
    private var offer: ((String) -> Unit)? = null
    private var drain: (() -> Unit)? = null
    var inputReady = false

    fun reset() {
      offer = null
      drain = null
      inputReady = false
    }

    override fun prepare(modeSessionId: String, onOffer: (String) -> Unit, onFailure: (String) -> Unit): Boolean {
      offer = onOffer
      trace += "peer-prepare"
      return true
    }

    fun deliverOffer(value: String) = requireNotNull(offer)(value)

    override fun applyAnswer(modeSessionId: String, sdp: String, onFailure: (String) -> Unit): Boolean {
      trace += "peer-answer"
      return true
    }

    override fun setInputReady(modeSessionId: String, ready: Boolean): Boolean {
      inputReady = ready
      trace += "input:$ready"
      return true
    }

    override fun setMuted(modeSessionId: String, muted: Boolean): Boolean = true

    override fun drain(modeSessionId: String, onComplete: () -> Unit): Boolean {
      drain = onComplete
      trace += "peer-drain"
      return true
    }

    fun completeDrain() = requireNotNull(drain)()

    override fun close(modeSessionId: String) {
      inputReady = false
      trace += "peer-close"
    }
  }

  private inner class FakeCues : VoiceRuntimeRealtimeCues {
    private var ready: (() -> Unit)? = null
    private var ended: (() -> Unit)? = null

    fun reset() {
      ready = null
      ended = null
    }

    override fun ready(generation: Long, onComplete: () -> Unit): Boolean {
      ready = onComplete
      trace += "cue-ready"
      return true
    }

    override fun ended(generation: Long, onComplete: () -> Unit): Boolean {
      ended = onComplete
      trace += "cue-ended"
      return true
    }

    fun completeReady() = requireNotNull(ready).also { ready = null }.invoke()
    fun completeEnded() = requireNotNull(ended).also { ended = null }.invoke()
  }

  private inner class FakeHandoff : VoiceRuntimeRealtimeHandoffCoordinator {
    var activated = false
    var prepareSucceeds = true
    var activateSucceeds = true
    var throwOnActivate = false
    private var prepareEntered = CountDownLatch(0)
    private var prepareRelease = CountDownLatch(0)

    fun blockPrepare() {
      prepareEntered = CountDownLatch(1)
      prepareRelease = CountDownLatch(1)
    }

    fun awaitPrepare(): Boolean = prepareEntered.await(1, TimeUnit.SECONDS)

    fun releasePrepare() = prepareRelease.countDown()

    fun reset() {
      prepareSucceeds = true
      activateSucceeds = true
      throwOnActivate = false
      prepareEntered = CountDownLatch(0)
      prepareRelease = CountDownLatch(0)
    }

    override fun plan(
      source: VoiceRuntimeRealtimeCheckpoint,
      action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
    ) = VoiceRuntimeRealtimeHandoffPlan(
      "handoff-operation-${action.sequence}",
      "thread-mode-${action.sequence}",
      source.target.environmentId,
      "default",
      VoiceRuntimeRealtimeEndpointPolicy(2_200, null, 600_000),
      true,
      250,
    )

    override fun prepare(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean {
      prepareEntered.countDown()
      check(prepareRelease.await(2, TimeUnit.SECONDS)) { "Timed out waiting to release prepare." }
      trace += "handoff-prepare"
      return prepareSucceeds
    }

    override fun rollback(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean {
      trace += "handoff-rollback"
      return true
    }

    override fun activate(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean {
      if (throwOnActivate) throw IllegalStateException("simulated process interruption")
      if (!activateSucceeds) {
        trace += "handoff-activate-failed"
        return false
      }
      activated = true
      trace += "handoff-activate"
      return true
    }
  }

  private fun presentationSink() = object : VoiceRuntimeRealtimePresentationSink {
    override fun publish(
      fence: VoiceRuntimeRealtimeFence,
      action: VoiceRuntimeRealtimeAction,
    ): VoiceRuntimeRetentionWriteResult {
      presentationEntered.countDown()
      check(presentationRelease.await(2, TimeUnit.SECONDS)) {
        "Timed out waiting to release presentation retention."
      }
      return presentationWriteResult.also { result ->
        if (result == VoiceRuntimeRetentionWriteResult.INSERTED ||
          result == VoiceRuntimeRetentionWriteResult.UPDATED) presentation += action
      }
    }

    override fun retract(
      fence: VoiceRuntimeRealtimeFence,
      action: VoiceRuntimeRealtimeAction,
    ): VoiceRuntimeRetentionRemovalResult {
      val removed = presentation.remove(action)
      retractedPresentation += fence to actionId(action)
      return if (removed) VoiceRuntimeRetentionRemovalResult.REMOVED
      else VoiceRuntimeRetentionRemovalResult.MISSING
    }
  }

  private fun blockPresentation() {
    presentationEntered = CountDownLatch(1)
    presentationRelease = CountDownLatch(1)
  }

  private fun awaitPresentation(): Boolean = presentationEntered.await(1, TimeUnit.SECONDS)

  private fun releasePresentation() = presentationRelease.countDown()

  private class FailingSaveRepository(
    private val delegate: VoiceRuntimeRealtimeCheckpointRepository,
  ) : VoiceRuntimeRealtimeCheckpointRepository by delegate {
    var failNextSave = false

    override fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint) {
      if (failNextSave) {
        failNextSave = false
        throw IllegalStateException("simulated checkpoint failure")
      }
      delegate.save(checkpoint)
    }
  }

  private fun actionId(action: VoiceRuntimeRealtimeAction) = when (action) {
    is VoiceRuntimeRealtimeAction.NavigateThread -> action.actionId
    is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> action.actionId
    is VoiceRuntimeRealtimeAction.ConfirmationRequired -> action.actionId
    is VoiceRuntimeRealtimeAction.StopRealtimeVoice -> "stop"
  }

  private inline fun <reified T : Throwable> expectThrows(block: () -> Unit) {
    try {
      block()
      fail("Expected ${T::class.java.simpleName}")
    } catch (error: Throwable) {
      if (error !is T) throw error
    }
  }
}
