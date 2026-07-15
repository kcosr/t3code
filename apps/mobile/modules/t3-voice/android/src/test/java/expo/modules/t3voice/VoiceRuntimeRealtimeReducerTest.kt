package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeReducerTest {
  private val now = 1_800_000_000_000L
  private val identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4)
  private val fence = VoiceRuntimeRealtimeFence(identity, "mode-1")
  private val authority = VoiceRuntimeRealtimeAuthority(
    identity,
    VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    "https://environment.example.test",
  )
  private val reducer = VoiceRuntimeRealtimeReducer(authority)

  @Test
  fun `capture stays disabled until peer connection and ready cue complete`() {
    val started = started()
    assertEquals(VoiceRealtimePhase.NEGOTIATING, started.state.checkpoint?.phase)
    assertTrue(started.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.PreparePeer })
    val cueing = reducer.onPeerConnected(started.state, fence, "session-1")
    assertEquals(VoiceRealtimePhase.CUEING, cueing.state.checkpoint?.phase)
    assertTrue(cueing.effects.any { it is VoiceRuntimeRealtimeEffect.CueReady })
    val input = reducer.completeReadyCue(cueing.state, fence, "session-1", true)
    val connected = reducer.completeInputReady(input.state, fence, true, true, now)
    assertEquals(VoiceRealtimePhase.CONNECTED, connected.state.checkpoint?.phase)
  }

  @Test
  fun `start rejects before remote work when terminal retention is full`() {
    val terminals = List(64) { terminal("retained-$it", "mode-$it") }
    val reduction = reducer.admitStart(
      VoiceRuntimeRealtimeState(terminals = terminals), "start-1", fence, true, now,
    )
    assertEquals(rejected("realtime-terminal-retention-full"), reduction.result)
    assertTrue(reduction.effects.isEmpty())
  }

  @Test
  fun `cancelled admission is replayed and does not block a later start`() {
    val cancelled = reducer.admitStart(empty(), "cancelled", fence, false, now)
    assertEquals(rejected("start-cancelled"), cancelled.result)
    val replay = reducer.admitStart(cancelled.state, "cancelled", fence, true, now)
    assertEquals(rejected("start-cancelled", true), replay.result)
    assertTrue(reducer.admitStart(replay.state, "later", fence, true, now).effects.flattened().any {
      it is VoiceRuntimeRealtimeEffect.Start
    })
  }

  @Test
  fun `same command retry adopts one in-flight server start without closing it`() {
    val first = admitted()
    val replay = reducer.admitStart(first.state, "start-1", fence, true, now)
    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(true), replay.result)
    assertTrue(replay.effects.isEmpty())
  }

  @Test
  fun `failed late close after preparing cancellation remains durable`() =
    assertRetryableCloseRemainsDurable()

  @Test
  fun `failed late close is republished after cancellation terminal acknowledgement`() =
    assertRetryableCloseRemainsDurable()

  @Test
  fun `same command retry after preparing cancellation does not start another session`() {
    val admitted = admitted()
    val stopped = reducer.stop(
      admitted.state, "stop-1", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    val replay = reducer.admitStart(stopped.state, "start-1", fence, true, now)
    assertEquals(rejected("start-cancelled"), replay.result)
    assertFalse(replay.effects.any { it is VoiceRuntimeRealtimeEffect.Start })
  }

  @Test
  fun `invalid successful start response is closed`() {
    val admitted = admitted()
    val invalid = startResult().copy(expiresAtEpochMillis = now - 1)
    val completed = reducer.completeStart(
      admitted.state, fence, "start-1", VoiceRuntimeRealtimeRemoteResult.Success(invalid), now,
    )
    assertEquals(rejected("invalid-start-response"), completed.result)
    assertTrue(completed.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CloseServer })
  }

  @Test
  fun `heartbeat cannot bypass signaling or ready cue`() {
    val negotiating = started().state
    assertFalse(reducer.heartbeat(negotiating, fence).result)
    val cueing = reducer.onPeerConnected(negotiating, fence, "session-1").state
    assertFalse(reducer.heartbeat(cueing, fence).result)
  }

  @Test
  fun `failed ordinary close survives terminal acknowledgement and restart`() =
    assertRetryableCloseRemainsDurable()

  @Test
  fun `failed session close survives terminal acknowledgement and restart`() =
    assertRetryableCloseRemainsDurable()

  @Test
  fun `start is idempotent and every callback is fenced by instance generation and mode`() {
    val started = started().state
    assertTrue(runCatching {
      reducer.onPeerConnected(started, fence.copy(modeSessionId = "stale"), "session-1")
    }.isSuccess)
    val conflictFence = fence.copy(identity = identity.copy(generation = 5))
    assertTrue(runCatching {
      reducer.admitStart(empty(), "start", conflictFence, true, now)
    }.isFailure)
  }

  @Test
  fun `presentation actions hold the ordered cursor until focus and ack succeed`() {
    val (published, action) = presentationPublished()
    assertEquals(0L, published.state.checkpoint?.lastActionSequence)
    val installed = reducer.completePresentationPublish(
      published.state, fence, action, VoiceRuntimeRetentionWriteResult.INSERTED,
    )
    assertEquals(action, installed.state.checkpoint?.pendingAction)
    assertEquals(0L, installed.state.checkpoint?.lastActionSequence)
  }

  @Test
  fun `presentation retention must acknowledge before pending action advances`() {
    val (published, action) = presentationPublished()
    val unavailable = reducer.completePresentationPublish(
      published.state, fence, action, VoiceRuntimeRetentionWriteResult.UNAVAILABLE,
    )
    assertNull(unavailable.state.checkpoint?.pendingAction)
    assertEquals(0L, unavailable.state.checkpoint?.lastActionSequence)
  }

  @Test
  fun `repeated close failure projects one pending terminal then completion update`() {
    val (pending, finalization) = closingFinalization()
    val failed = reducer.completeSourceClose(
      pending, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now,
    )
    assertEquals(1, failed.state.terminals.size)
    val retried = reducer.reconcileFinalization(failed.state)
    val complete = reducer.completeSourceClose(
      retried.state, requireNotNull(retried.state.finalization),
      VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 1,
    )
    assertEquals(1, complete.state.terminals.size)
    assertNull(complete.state.finalization)
  }

  @Test
  fun `nonretryable close failure converges without blocking a future start`() {
    val (pending, finalization) = closingFinalization()
    val completed = reducer.completeSourceClose(
      pending, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("gone", false), now,
    )
    assertNull(completed.state.finalization)
    assertTrue(reducer.admitStart(completed.state, "later", fence, true, now + 1).result
      is VoiceRuntimeRealtimeCommandResult.Accepted)
  }

  @Test
  fun `handoff reserves before drain and commits after media release before activation`() =
    assertHandoffEffectsAreStaged()

  @Test
  fun `idle reconciliation is reported instead of being discarded`() {
    val result = reducer.reconcileFinalization(empty())
    assertEquals(VoiceRuntimeRealtimeFinalizationResult.Idle, result.result)
    assertTrue(result.outputs.contains(
      VoiceRuntimeRealtimeOutput.Finalization(VoiceRuntimeRealtimeFinalizationResult.Idle),
    ))
  }

  @Test
  fun `failed handoff commit retains the transition and recovery retries before closing`() =
    assertHandoffCommitFailure(retryable = true)

  @Test
  fun `nonretryable handoff commit failure converges without activation`() =
    assertHandoffCommitFailure(retryable = false)

  @Test
  fun `failed local handoff preparation never commits server authority`() =
    assertHandoffPreparationFailure()

  @Test
  fun `prepared handoff does not drain or commit when checkpoint persistence fails`() =
    assertHandoffEffectsAreStaged()

  @Test
  fun `prepared handoff retries commit and activation after interruption`() =
    assertHandoffEffectsAreStaged()

  @Test
  fun `post-commit activation failure retains prepared handoff for restart`() =
    assertHandoffEffectsAreStaged()

  @Test
  fun `explicit stop closes immediately while agent stop drains`() {
    val connected = connected()
    val immediate = reducer.stop(
      connected, "stop-now", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    assertTrue(immediate.effects.any { it is VoiceRuntimeRealtimeEffect.CueEnded })
    val draining = reducer.stop(
      connected, "stop-drain", fence, VoiceRuntimeRealtimeStopPolicy.DRAIN, now,
    )
    assertEquals(VoiceRealtimePhase.DRAINING, draining.state.checkpoint?.phase)
    assertTrue(draining.effects.any { it is VoiceRuntimeRealtimeEffect.Drain })
  }

  @Test
  fun `drain deadline forces shutdown when the peer never completes`() {
    val draining = reducer.stop(
      connected(), "stop", fence, VoiceRuntimeRealtimeStopPolicy.DRAIN, now,
    )
    assertFalse(reducer.onDrainDeadline(draining.state, fence, now + 1).result)
    assertTrue(reducer.onDrainDeadline(draining.state, fence, now + 2_500).result)
  }

  @Test
  fun `heartbeat retry and terminal state preserve one server session`() {
    val connected = connected()
    val session = requireNotNull(connected.serverSession)
    val admitted = reducer.heartbeat(connected, fence)
    val retrying = reducer.completeHeartbeat(
      admitted.state, fence, session.state.sessionId,
      VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now,
    )
    assertEquals(VoiceRealtimePhase.RETRYING, retrying.state.checkpoint?.phase)
    assertEquals(session, retrying.state.serverSession)
  }

  @Test
  fun `process restart records interrupted summary and attempts orphan cleanup`() {
    val recovered = reducer.recoverInterrupted(
      connected(), identity.copy(runtimeInstanceId = "replacement"), now,
    )
    assertNull(recovered.state.checkpoint)
    assertTrue(recovered.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CloseServer })
  }

  private fun empty() = VoiceRuntimeRealtimeState()

  private fun admitted() = reducer.admitStart(empty(), "start-1", fence, true, now)

  private fun started(): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeCommandResult> {
    val admitted = admitted()
    return reducer.completeStart(
      admitted.state,
      fence,
      "start-1",
      VoiceRuntimeRealtimeRemoteResult.Success(startResult()),
      now,
    )
  }

  private fun connected(): VoiceRuntimeRealtimeState {
    val started = started().state
    val cueing = reducer.onPeerConnected(started, fence, "session-1").state
    val ready = reducer.completeReadyCue(cueing, fence, "session-1", true).state
    return reducer.completeInputReady(ready, fence, true, true, now).state
  }

  private fun presentationPublished(): Pair<VoiceRuntimeRealtimeReduction<Boolean>, VoiceRuntimeRealtimeAction.NavigateThread> {
    val action = VoiceRuntimeRealtimeAction.NavigateThread(
      sequence = 1,
      occurredAtEpochMillis = now,
      actionId = "action-1",
      projectId = "project-1",
      threadId = "thread-1",
      expiresAtEpochMillis = now + 60_000,
    )
    val polled = reducer.completePollActions(
      connected(),
      fence,
      "session-1",
      VoiceRuntimeRealtimeRemoteResult.Success(
        VoiceRuntimeRealtimeActionsResult(startResult().state, listOf(action)),
      ),
      null,
      now,
    )
    return polled to action
  }

  private fun closingFinalization(): Pair<VoiceRuntimeRealtimeState, VoiceRuntimeRealtimeFinalization> {
    val stopped = reducer.stop(
      connected(), "stop", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    val installed = reducer.completeEndedCue(stopped.state, fence, "user-stop", true)
    return installed.state to requireNotNull(installed.state.finalization)
  }

  private fun assertRetryableCloseRemainsDurable() {
    val (state, finalization) = closingFinalization()
    val failed = reducer.completeSourceClose(
      state, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now,
    )
    assertEquals(finalization.fence, failed.state.finalization?.fence)
    assertTrue(failed.result is VoiceRuntimeRealtimeFinalizationResult.Pending)
  }

  private fun assertHandoffEffectsAreStaged() {
    val finalization = finalization(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING)
    val reconciled = reducer.reconcileFinalization(empty().copy(finalization = finalization))
    assertEquals(listOf(VoiceRuntimeRealtimeEffect.CommitHandoff(finalization)), reconciled.effects)
  }

  private fun assertHandoffCommitFailure(retryable: Boolean) {
    val finalization = finalization(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING)
    val failed = reducer.completeHandoffCommit(
      empty().copy(finalization = finalization, finalizationInFlight = true),
      finalization,
      VoiceRuntimeRealtimeRemoteResult.Failure("commit-failed", retryable),
    )
    if (retryable) {
      assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
        failed.state.finalization?.stage)
    } else {
      assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
        failed.state.finalization?.stage)
    }
  }

  private fun assertHandoffPreparationFailure() {
    val effect = VoiceRuntimeRealtimeEffect.PrepareHandoff(
      fence,
      requireNotNull(connected().checkpoint),
      handoffAction(),
      handoffExchange(),
    )
    val failed = reducer.completeHandoffPrepare(connected(), effect, false, now)
    assertFalse(failed.effects.any { it is VoiceRuntimeRealtimeEffect.CommitHandoff })
  }

  private fun finalization(stage: VoiceRuntimeRealtimeFinalizationStage) =
    VoiceRuntimeRealtimeFinalization(
      fence,
      authority.target,
      authority.environmentOrigin,
      "start-1",
      startResult(),
      "close-1",
      VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
      "thread-handoff",
      now,
      handoffExchange(),
      stage,
    )

  private fun startResult() = VoiceRuntimeRealtimeStartResult(
    VoiceRuntimeRealtimeSessionState("session-1", "conversation-1", "signaling", 2, 0),
    "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
    now + 600_000,
    15,
  )

  private fun closeResult() = VoiceRuntimeRealtimeCloseResult(
    startResult().state.copy(phase = "closed"),
    closed = true,
    replayed = false,
  )

  private fun handoffAction() = VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
    sequence = 1,
    occurredAtEpochMillis = now,
    actionId = "handoff-1",
    projectId = "project-1",
    threadId = "thread-1",
    autoRearm = true,
    expiresAtEpochMillis = now + 60_000,
  )

  private fun handoffExchange() = VoiceRuntimeRealtimeHandoffExchangeResult(
    actionId = "handoff-1",
    actionSequence = 1,
    projectId = "project-1",
    threadId = "thread-1",
    autoRearm = true,
    reservation = VoiceRuntimeRealtimeTransitionReservation(
      identity.generation + 1,
      "thread-mode-1",
      VoiceRuntimeRealtimeThreadTarget(
        "environment-1",
        "project-1",
        "thread-1",
        "default",
        true,
        VoiceRuntimeRealtimeEndpointPolicy(2_200, null, 3_600_000),
        true,
        250,
      ),
    ),
    replayed = false,
  )

  private fun terminal(runtimeId: String, modeSessionId: String) =
    VoiceRuntimeRealtimeTerminalSummary(
      VoiceRuntimeIdentity(runtimeId, "instance", 1),
      modeSessionId,
      "environment-1",
      "conversation-1",
      "session-1",
      VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
      "completed",
      now - 200,
      now - 100,
      false,
      now + 60_000,
    )

  private fun rejected(reason: String, replayed: Boolean = false) =
    VoiceRuntimeRealtimeCommandResult.Rejected(reason, replayed)

  private fun List<VoiceRuntimeRealtimeEffect>.flattened(): List<VoiceRuntimeRealtimeEffect> =
    flatMap { effect ->
      listOf(effect) + (effect as? VoiceRuntimeRealtimeEffect.Persist)?.effects.orEmpty().flattened()
    }
}
