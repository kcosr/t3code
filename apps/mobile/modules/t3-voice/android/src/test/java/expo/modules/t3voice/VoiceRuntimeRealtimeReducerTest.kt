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
  fun `failed late close after preparing cancellation remains durable`() {
    val admitted = admitted()
    val stopped = reducer.stop(
      admitted.state, "stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    val late = reducer.completeStart(
      stopped.state, fence, "start-1",
      VoiceRuntimeRealtimeRemoteResult.Success(startResult()), now,
    )
    val installed = requireNotNull(late.state.finalization)

    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING, installed.stage)
    assertTrue(late.effects.persistOutputs().contains(
      VoiceRuntimeRealtimeOutput.FinalizationInstalled(installed),
    ))
    val failed = reducer.completeSourceClose(
      late.state, installed, VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now + 1,
    )

    assertEquals(installed.fence, failed.state.finalization?.fence)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
      failed.state.finalization?.stage)
    assertFalse(failed.state.finalizationInFlight)
    assertTrue(failed.state.terminals.single().serverCleanupPending)
    assertEquals("session-1", failed.state.terminals.single().sessionId)
  }

  @Test
  fun `failed late close is republished after cancellation terminal acknowledgement`() {
    val admitted = admitted()
    val stopped = reducer.stop(
      admitted.state, "stop-preparing", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    val cancellation = stopped.state.terminals.single()
    val acknowledged = reducer.acknowledgeTerminal(
      stopped.state,
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(cancellation.identity, cancellation.modeSessionId),
      true,
    )
    assertTrue(acknowledged.state.terminals.isEmpty())

    val late = reducer.completeStart(
      acknowledged.state, fence, "start-1",
      VoiceRuntimeRealtimeRemoteResult.Success(startResult()), now,
    )
    val failed = reducer.completeSourceClose(
      late.state, requireNotNull(late.state.finalization),
      VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now + 1,
    )

    val republished = failed.state.terminals.single()
    assertEquals("session-1", republished.sessionId)
    assertTrue(republished.serverCleanupPending)
    assertTrue(failed.effects.persistOutputs().contains(
      VoiceRuntimeRealtimeOutput.Terminal(republished),
    ))
  }

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
  fun `failed ordinary close survives terminal acknowledgement and restart`() {
    val (closing, finalization) = closingFinalization()
    val failed = reducer.completeSourceClose(
      closing, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now,
    )
    val pending = failed.state.terminals.single()
    assertEquals("start-1.close.user-stop", failed.state.finalization?.closeOperationId)
    val acknowledged = reducer.acknowledgeTerminal(
      failed.state,
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(pending.identity, pending.modeSessionId),
      true,
    )
    assertTrue(acknowledged.state.terminals.isEmpty())
    assertEquals(finalization.fence, acknowledged.state.finalization?.fence)

    val restarted = acknowledged.state.copy(finalizationInFlight = false)
    val reconciled = reducer.recoverInterrupted(restarted, identity, now + 1)
    assertTrue(reconciled.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CloseServer })
    val completed = reducer.completeSourceClose(
      reconciled.state, requireNotNull(reconciled.state.finalization),
      VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 2,
    )

    assertNull(completed.state.finalization)
    val terminal = completed.state.terminals.single()
    assertFalse(terminal.serverCleanupPending)
  }

  @Test
  fun `failed session close survives terminal acknowledgement and restart`() {
    val terminated = reducer.onPeerTerminated(
      connected(), fence, "session-1", "peer-failed", now,
    )
    val failed = reducer.completeSourceClose(
      terminated.state, requireNotNull(terminated.state.finalization),
      VoiceRuntimeRealtimeRemoteResult.Failure("offline", true), now + 1,
    )
    val pending = failed.state.terminals.single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, pending.outcome)
    assertEquals("peer-failed", pending.reason)
    val acknowledged = reducer.acknowledgeTerminal(
      failed.state,
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(pending.identity, pending.modeSessionId),
      true,
    )
    assertTrue(acknowledged.state.terminals.isEmpty())

    val restarted = acknowledged.state.copy(finalizationInFlight = false)
    val reconciled = reducer.recoverInterrupted(restarted, identity, now + 2)
    assertTrue(reconciled.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CloseServer })
    val completed = reducer.completeSourceClose(
      reconciled.state, requireNotNull(reconciled.state.finalization),
      VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 3,
    )

    assertNull(completed.state.finalization)
    val terminal = completed.state.terminals.single()
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, terminal.outcome)
    assertEquals("peer-failed", terminal.reason)
    assertFalse(terminal.serverCleanupPending)
  }

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
  fun `retained presentation is retracted when action admission becomes unavailable`() {
    val (published, action) = presentationPublished()
    val shutdown = published.state.copy(
      checkpoint = requireNotNull(published.state.checkpoint).copy(phase = VoiceRealtimePhase.STOPPING),
    )
    val afterShutdown = reducer.completePresentationPublish(
      shutdown, fence, action, VoiceRuntimeRetentionWriteResult.INSERTED,
    )
    assertFalse(afterShutdown.result)
    assertEquals(listOf(VoiceRuntimeRealtimeEffect.RetractPresentation(fence, action)),
      afterShutdown.effects)

    val occupied = published.state.copy(
      checkpoint = requireNotNull(published.state.checkpoint).copy(
        pendingAction = action.copy(actionId = "action-already-pending"),
      ),
    )
    val afterPendingAction = reducer.completePresentationPublish(
      occupied, fence, action, VoiceRuntimeRetentionWriteResult.INSERTED,
    )
    assertFalse(afterPendingAction.result)
    assertEquals(listOf(VoiceRuntimeRealtimeEffect.RetractPresentation(fence, action)),
      afterPendingAction.effects)
  }

  @Test
  fun `late retained presentation is retracted after stop wins`() {
    val (published, action) = presentationPublished()
    val stopped = reducer.stop(
      published.state, "stop-won", fence, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, now,
    )
    val stopWon = stopped.state.copy(pendingPresentation = null)

    val late = reducer.completePresentationPublish(
      stopWon, fence, action, VoiceRuntimeRetentionWriteResult.INSERTED,
    )

    assertFalse(late.result)
    assertEquals(stopWon, late.state)
    assertEquals(listOf(VoiceRuntimeRealtimeEffect.RetractPresentation(fence, action)), late.effects)
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
  fun `handoff reserves before drain and commits after media release before activation`() {
    val (exchangedState, prepare) = handoffPrepareEffect()
    assertTrue(exchangedState.checkpoint?.phase == VoiceRealtimePhase.CONNECTED)
    val prepared = reducer.completeHandoffPrepare(exchangedState, prepare, true, now)
    assertEquals(VoiceRealtimePhase.DRAINING, prepared.state.checkpoint?.phase)
    assertEquals(prepare.exchange, prepared.state.checkpoint?.pendingHandoffExchange)
    assertTrue(prepared.effects.flattened().any {
      it == VoiceRuntimeRealtimeEffect.SetInputReady(fence, false)
    })
    assertTrue(prepared.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.Drain })
    assertFalse(prepared.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CommitHandoff })

    val drained = reducer.completeDrain(prepared.state, fence, "thread-handoff", true)
    assertEquals(VoiceRealtimePhase.STOPPING, drained.state.checkpoint?.phase)
    assertTrue(drained.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.ClosePeer })
    assertTrue(drained.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CueEnded })
    assertFalse(drained.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CommitHandoff })

    val ended = reducer.completeEndedCue(drained.state, fence, "thread-handoff", true)
    val committing = requireNotNull(ended.state.finalization)
    assertNull(ended.state.checkpoint)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING, committing.stage)
    assertTrue(ended.effects.flattened().any { it == VoiceRuntimeRealtimeEffect.CommitHandoff(committing) })

    val committed = reducer.completeHandoffCommit(
      ended.state, committing, VoiceRuntimeRealtimeRemoteResult.Success(handoffCommitResult()),
    )
    val activating = requireNotNull(committed.state.finalization)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING, activating.stage)
    assertTrue(committed.effects.flattened().any {
      it == VoiceRuntimeRealtimeEffect.ActivateHandoff(activating)
    })
    assertFalse(committed.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CloseServer })

    val activated = reducer.completeHandoffActivation(committed.state, activating, true)
    val closing = requireNotNull(activated.state.finalization)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING, closing.stage)
    assertTrue(activated.effects.flattened().any { it == VoiceRuntimeRealtimeEffect.CloseServer(closing) })
    val completed = reducer.completeSourceClose(
      activated.state, closing, VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 1,
    )
    assertNull(completed.state.finalization)
    assertFalse(completed.state.terminals.single().serverCleanupPending)
  }

  @Test
  fun `idle reconciliation is reported instead of being discarded`() {
    val result = reducer.reconcileFinalization(empty())
    assertEquals(VoiceRuntimeRealtimeFinalizationResult.Idle, result.result)
    assertTrue(result.outputs.contains(
      VoiceRuntimeRealtimeOutput.Finalization(VoiceRuntimeRealtimeFinalizationResult.Idle),
    ))
  }

  @Test
  fun `failed handoff commit retains the transition and recovery retries before closing`() {
    val (state, finalization) = handoffFinalization()
    val failed = reducer.completeHandoffCommit(
      state, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("commit-failed", true),
    )
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
      failed.state.finalization?.stage)
    assertEquals(handoffExchange(), failed.state.finalization?.handoffExchange)
    assertFalse(failed.state.finalizationInFlight)

    val recovered = reducer.recoverInterrupted(
      failed.state.copy(finalizationInFlight = false), identity, now + 1,
    )
    val retry = recovered.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.CommitHandoff>().single()
    val committed = reducer.completeHandoffCommit(
      recovered.state, retry.finalization,
      VoiceRuntimeRealtimeRemoteResult.Success(handoffCommitResult()),
    )
    val activating = requireNotNull(committed.state.finalization)
    val activated = reducer.completeHandoffActivation(committed.state, activating, true)
    val closing = requireNotNull(activated.state.finalization)
    val completed = reducer.completeSourceClose(
      activated.state, closing, VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 2,
    )
    assertNull(completed.state.finalization)
  }

  @Test
  fun `nonretryable handoff commit failure converges without activation`() {
    val (state, finalization) = handoffFinalization()
    val failed = reducer.completeHandoffCommit(
      state, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("commit-rejected", false),
    )
    val closing = requireNotNull(failed.state.finalization)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING, closing.stage)
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, closing.outcome)
    assertEquals("commit-rejected", closing.reason)
    assertFalse(failed.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.ActivateHandoff })
    assertTrue(failed.effects.flattened().any { it == VoiceRuntimeRealtimeEffect.CloseServer(closing) })

    val completed = reducer.completeSourceClose(
      failed.state, closing, VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 1,
    )
    assertNull(completed.state.finalization)
    assertEquals(VoiceRuntimeRealtimeTerminalOutcome.FAILED, completed.state.terminals.single().outcome)
  }

  @Test
  fun `failed local handoff preparation never commits server authority`() =
    assertHandoffPreparationFailure()

  @Test
  fun `prepared handoff does not drain or commit when checkpoint persistence fails`() {
    val (exchangedState, prepare) = handoffPrepareEffect()
    val checkpointAdvancedElsewhere = exchangedState.copy(
      checkpoint = requireNotNull(exchangedState.checkpoint).copy(muted = true),
    )
    val failed = reducer.completeHandoffPrepare(
      checkpointAdvancedElsewhere, prepare, true, now,
    )

    assertFalse(failed.result)
    assertEquals(checkpointAdvancedElsewhere, failed.state)
    assertEquals(listOf(VoiceRuntimeRealtimeEffect.RollbackHandoff(prepare.exchange)), failed.effects)
    assertFalse(failed.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.Drain })
    assertFalse(failed.effects.flattened().any { it is VoiceRuntimeRealtimeEffect.CommitHandoff })
  }

  @Test
  fun `prepared handoff retries commit and activation after interruption`() {
    val (state, finalization) = handoffFinalization()
    val commitFailed = reducer.completeHandoffCommit(
      state, finalization, VoiceRuntimeRealtimeRemoteResult.Failure("commit-offline", true),
    )
    val commitRestart = reducer.recoverInterrupted(
      commitFailed.state.copy(finalizationInFlight = false), identity, now + 1,
    )
    val commitRetry = commitRestart.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.CommitHandoff>().single()
    val committed = reducer.completeHandoffCommit(
      commitRestart.state, commitRetry.finalization,
      VoiceRuntimeRealtimeRemoteResult.Success(handoffCommitResult()),
    )
    val activating = requireNotNull(committed.state.finalization)
    val activationFailed = reducer.completeHandoffActivation(committed.state, activating, false)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING,
      activationFailed.state.finalization?.stage)
    assertFalse(activationFailed.state.finalizationInFlight)

    val activationRestart = reducer.recoverInterrupted(
      activationFailed.state.copy(finalizationInFlight = false), identity, now + 2,
    )
    val activationRetry = activationRestart.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.ActivateHandoff>().single()
    val activated = reducer.completeHandoffActivation(
      activationRestart.state, activationRetry.finalization, true,
    )
    val closing = requireNotNull(activated.state.finalization)
    val completed = reducer.completeSourceClose(
      activated.state, closing, VoiceRuntimeRealtimeRemoteResult.Success(closeResult()), now + 3,
    )
    assertNull(completed.state.finalization)
    assertFalse(completed.state.terminals.single().serverCleanupPending)
  }

  @Test
  fun `post-commit activation failure retains prepared handoff for restart`() {
    val (state, finalization) = handoffFinalization()
    val committed = reducer.completeHandoffCommit(
      state, finalization, VoiceRuntimeRealtimeRemoteResult.Success(handoffCommitResult()),
    )
    val activating = requireNotNull(committed.state.finalization)
    val failed = reducer.completeHandoffActivation(committed.state, activating, false)
    val retained = requireNotNull(failed.state.finalization)

    assertEquals(VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING, retained.stage)
    assertEquals(handoffExchange(), retained.handoffExchange)
    assertEquals(activating.attemptCount + 1, retained.attemptCount)
    assertEquals("handoff-activation-failed", retained.lastFailureCode)
    assertFalse(failed.state.finalizationInFlight)
    assertTrue(failed.effects.persistOutputs().contains(
      VoiceRuntimeRealtimeOutput.Finalization(
        requireNotNull(failed.result as? VoiceRuntimeRealtimeFinalizationResult.Pending),
      ),
    ))

    val restarted = reducer.recoverInterrupted(
      failed.state.copy(finalizationInFlight = false), identity, now + 1,
    )
    val retry = restarted.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.ActivateHandoff>().single()
    assertEquals(retained, retry.finalization)
    val activated = reducer.completeHandoffActivation(restarted.state, retry.finalization, true)
    assertEquals(VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
      activated.state.finalization?.stage)
  }

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

  private fun handoffPrepareEffect(): Pair<
    VoiceRuntimeRealtimeState,
    VoiceRuntimeRealtimeEffect.PrepareHandoff,
  > {
    val action = handoffAction()
    val polled = reducer.completePollActions(
      connected(),
      fence,
      "session-1",
      VoiceRuntimeRealtimeRemoteResult.Success(
        VoiceRuntimeRealtimeActionsResult(startResult().state, listOf(action)),
      ),
      handoffPlan(),
      now,
    )
    val exchange = polled.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.ExchangeHandoff>().single()
    val exchanged = reducer.completeHandoffExchange(
      polled.state,
      exchange,
      VoiceRuntimeRealtimeRemoteResult.Success(handoffExchange()),
      now,
    )
    val prepare = exchanged.effects.flattened()
      .filterIsInstance<VoiceRuntimeRealtimeEffect.PrepareHandoff>().single()
    return exchanged.state to prepare
  }

  private fun handoffFinalization(): Pair<
    VoiceRuntimeRealtimeState,
    VoiceRuntimeRealtimeFinalization,
  > {
    val (state, prepare) = handoffPrepareEffect()
    val prepared = reducer.completeHandoffPrepare(state, prepare, true, now)
    val drained = reducer.completeDrain(prepared.state, fence, "thread-handoff", true)
    val ended = reducer.completeEndedCue(drained.state, fence, "thread-handoff", true)
    return ended.state to requireNotNull(ended.state.finalization)
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

  private fun handoffPlan() = VoiceRuntimeRealtimeHandoffPlan(
    clientOperationId = "handoff-operation-1",
    threadModeSessionId = "thread-mode-1",
    environmentId = "environment-1",
    speechPreset = "default",
    endpointPolicy = VoiceRuntimeRealtimeEndpointPolicy(2_200, null, 3_600_000),
    speechEnabled = true,
    rearmGuardMs = 250,
  )

  private fun handoffCommitResult() = VoiceRuntimeRealtimeHandoffCommitResult(
    actionId = "handoff-1",
    actionSequence = 1,
    committed = true,
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

  private fun List<VoiceRuntimeRealtimeEffect>.persistOutputs(): List<VoiceRuntimeRealtimeOutput> =
    flatMap { effect ->
      val persisted = effect as? VoiceRuntimeRealtimeEffect.Persist
      persisted?.outputs.orEmpty() + persisted?.effects.orEmpty().persistOutputs()
    }
}
