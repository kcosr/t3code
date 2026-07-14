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

    assertEquals(VoiceRealtimePhase.STOPPING, engine.snapshot()?.phase)
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(false),
      engine.stop("stop-2", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE),
    )

    server.releaseClose()
    finishThread.join(1_000)
    assertFalse(finishThread.isAlive)
    assertNull(engine.snapshot())
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
      listOf("handoff-commit", "server-close", "handoff-activate"),
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
    assertEquals(VoiceRealtimePhase.STOPPING, engine.snapshot()?.phase)
    assertTrue(repository.terminals(now).isEmpty())

    server.commitSucceeds = true
    val recovered = engine().recoverInterrupted(identity)

    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, recovered?.outcome)
    assertEquals(listOf("handoff-commit", "server-close", "handoff-activate"), trace.takeLast(3))
    assertTrue(handoff.activated)
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
    expectThrows<IllegalStateException> { cues.completeEnded() }
    assertEquals(VoiceRealtimePhase.STOPPING, first.snapshot()?.phase)

    handoff.throwOnActivate = false
    val replacement = engine()
    val recovered = replacement.recoverInterrupted(identity)

    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, recovered?.outcome)
    assertTrue(handoff.activated)
    assertTrue(trace.count { it == "handoff-commit" } >= 2)
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

    assertEquals(VoiceRealtimePhase.STOPPING, first.snapshot()?.phase)
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
      VoiceRuntimeRealtimePresentationSink {},
      repository,
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

  private fun engine() = VoiceRuntimeRealtimeEngine(
    authority,
    { now },
    server,
    peer,
    cues,
    handoff,
    VoiceRuntimeRealtimePresentationSink { presentation += it },
    repository,
    terminalSink = VoiceRuntimeRealtimeTerminalSink { projectedTerminals += it },
  )

  private fun connectedEngine(): VoiceRuntimeRealtimeEngine = engine().also {
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
    presentation.clear()
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
    var actionsCount = 0
    var commitSucceeds = true
    var closeSucceeds = true
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
      actionsCount = 0
      actionValues.clear()
      commitSucceeds = true
      closeSucceeds = true
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
          now + 300_000,
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
      trace += "handoff-commit"
      return if (commitSucceeds) VoiceRuntimeRealtimeRemoteResult.Success(
        VoiceRuntimeRealtimeHandoffCommitResult(
          exchange.actionId,
          exchange.actionSequence,
          true,
          false,
        ),
      ) else VoiceRuntimeRealtimeRemoteResult.Failure("handoff-commit-failed", true)
    }

    override fun close(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: VoiceRuntimeRealtimeStartResult,
      clientOperationId: String,
    ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeCloseResult> {
      closeEntered.countDown()
      check(closeRelease.await(2, TimeUnit.SECONDS)) { "Timed out waiting to release close." }
      trace += "server-close"
      return if (closeSucceeds) {
        VoiceRuntimeRealtimeRemoteResult.Success(
          VoiceRuntimeRealtimeCloseResult(session.state.copy(phase = "ended"), true, false),
        )
      } else VoiceRuntimeRealtimeRemoteResult.Failure("close-failed", true)
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
      trace += "handoff-prepare"
      return prepareSucceeds
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
