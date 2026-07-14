package expo.modules.t3voice

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
  private val presentation = mutableListOf<T3VoiceBackgroundRealtimeAction>()
  private var repository = VoiceRuntimeMemoryRealtimeCheckpointRepository()

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
    server.actionValues += T3VoiceBackgroundRealtimeAction.NavigateThread(
      7,
      now,
      "action-1",
      "project-1",
      "thread-1",
      now + 60_000,
    )
    server.actionValues += T3VoiceBackgroundRealtimeAction.ConfirmationRequired(
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
          T3VoiceBackgroundRealtimeActionOutcome.SUCCEEDED,
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
  fun `handoff exchanges authority before bounded drain and activates after close`() {
    val engine = connectedEngine()
    server.actionValues += T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice(
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
    assertEquals(listOf("handoff-exchange", "input:false", "peer-drain"), trace.takeLast(3))
    assertEquals(12L, engine.snapshot()?.lastActionSequence)
    assertFalse(handoff.activated)

    peer.completeDrain()
    assertEquals(VoiceRealtimePhase.STOPPING, engine.snapshot()?.phase)
    assertEquals(listOf("peer-close", "server-close", "cue-ended"), trace.takeLast(3))
    assertFalse(handoff.activated)

    cues.completeEnded()
    assertTrue(handoff.activated)
    assertNull(engine.snapshot())
    val terminal = repository.terminals(now).single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.COMPLETED, terminal.outcome)
    assertEquals("thread-handoff", terminal.reason)
    assertFalse(terminal.serverCleanupPending)
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
    server.actionValues += T3VoiceBackgroundRealtimeAction.StopRealtimeVoice(3, now)
    assertTrue(draining.pollActions(fence))
    assertEquals(VoiceRealtimePhase.DRAINING, draining.snapshot()?.phase)
    assertTrue(trace.contains("peer-drain"))
    assertFalse(trace.contains("peer-close"))
  }

  @Test
  fun `drain deadline forces shutdown when the peer never completes`() {
    val engine = connectedEngine()
    server.actionValues += T3VoiceBackgroundRealtimeAction.StopRealtimeVoice(3, now)
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

  private fun startResult() = T3VoiceBackgroundRealtimeStartResult(
    T3VoiceBackgroundRealtimeSessionState(
      "session-1",
      "conversation-1",
      "signaling",
      2,
      0,
    ),
    "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
    now + 600_000,
    T3VoiceBackgroundRealtimeControlGrant("control-token", now + 300_000, 15, 45),
  )

  private fun heartbeat(disposition: String) = T3VoiceBackgroundRealtimeHeartbeatResult(
    startResult().state.copy(phase = if (disposition == "live") "listening" else "ended"),
    disposition,
    false,
    now + 300_000,
  )

  private inner class FakeServer : VoiceRuntimeRealtimeServer {
    var startCount = 0
    var actionsCount = 0
    val actionValues = mutableListOf<T3VoiceBackgroundRealtimeAction>()
    var heartbeatResult: VoiceRuntimeRealtimeRemoteResult<T3VoiceBackgroundRealtimeHeartbeatResult> =
      VoiceRuntimeRealtimeRemoteResult.Success(heartbeat("live"))

    fun reset() {
      startCount = 0
      actionsCount = 0
      actionValues.clear()
      heartbeatResult = VoiceRuntimeRealtimeRemoteResult.Success(heartbeat("live"))
    }

    override fun start(authority: VoiceRuntimeRealtimeAuthority, fence: VoiceRuntimeRealtimeFence, clientOperationId: String) =
      VoiceRuntimeRealtimeRemoteResult.Success(startResult()).also {
        startCount++
        trace += "server-start"
      }

    override fun offer(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      clientOperationId: String,
      sdp: String,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeAnswer("session-1", 2, "answer-sdp", false),
    ).also { trace += "server-offer" }

    override fun heartbeat(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
    ) = heartbeatResult

    override fun actions(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      afterSequence: Long,
      waitMilliseconds: Long,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeActionsResult(
        session.state,
        actionValues.filter { it.sequence > afterSequence },
      ),
    ).also { actionsCount++ }

    override fun acknowledgeAction(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      action: T3VoiceBackgroundRealtimeAction,
      clientOperationId: String,
      decision: VoiceRuntimeRealtimePresentationDecision,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeActionAckResult(
        actionId(action),
        action.sequence,
        when (decision) {
          is VoiceRuntimeRealtimePresentationDecision.Navigate -> decision.outcome
          is VoiceRuntimeRealtimePresentationDecision.Confirmation ->
            if (decision.decision == "approve") T3VoiceBackgroundRealtimeActionOutcome.SUCCEEDED
            else T3VoiceBackgroundRealtimeActionOutcome.FAILED
        },
        false,
      ),
    ).also { trace += "ack:${action.sequence}" }

    override fun updateFocus(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      clientOperationId: String,
      focus: T3VoiceBackgroundRealtimeFocus?,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeFocusResult(session.state, focus, false),
    ).also { trace += "focus:${focus?.projectId}:${focus?.threadId}" }

    override fun exchangeHandoff(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      action: T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice,
      plan: VoiceRuntimeRealtimeHandoffPlan,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeHandoffExchangeResult(
        action.actionId,
        action.sequence,
        action.projectId,
        action.threadId,
        action.autoRearm,
        T3VoiceBackgroundRealtimeTransitionGrant(
          "thread-token",
          now + 300_000,
          identity.generation + 1,
          plan.threadModeSessionId,
          T3VoiceBackgroundRealtimeThreadTarget(
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

    override fun close(
      authority: VoiceRuntimeRealtimeAuthority,
      fence: VoiceRuntimeRealtimeFence,
      session: T3VoiceBackgroundRealtimeStartResult,
      clientOperationId: String,
    ) = VoiceRuntimeRealtimeRemoteResult.Success(
      T3VoiceBackgroundRealtimeCloseResult(session.state.copy(phase = "ended"), true, false),
    ).also { trace += "server-close" }
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

    override fun plan(
      source: VoiceRuntimeRealtimeCheckpoint,
      action: T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice,
    ) = VoiceRuntimeRealtimeHandoffPlan(
      "handoff-operation-${action.sequence}",
      "thread-mode-${action.sequence}",
      source.target.environmentId,
      "default",
      T3VoiceBackgroundRealtimeEndpointPolicy(2_200, null, 600_000),
      true,
      250,
    )

    override fun activate(result: T3VoiceBackgroundRealtimeHandoffExchangeResult): Boolean {
      activated = true
      trace += "handoff-activate"
      return true
    }
  }

  private fun actionId(action: T3VoiceBackgroundRealtimeAction) = when (action) {
    is T3VoiceBackgroundRealtimeAction.NavigateThread -> action.actionId
    is T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice -> action.actionId
    is T3VoiceBackgroundRealtimeAction.ConfirmationRequired -> action.actionId
    is T3VoiceBackgroundRealtimeAction.StopRealtimeVoice -> "stop"
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
