package expo.modules.t3voice

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBackgroundThreadExecutionTest {
  @Test fun `authority requires strict composite target and exact grant`() {
    val readiness = readiness()
    val available = T3VoiceRuntimeGrantLoadResult.Available(grant())
    val authorization = T3VoiceBackgroundThreadAuthorityPolicy.validate(readiness, available, DIGEST, NOW)
    assertEquals("project-1", authorization?.authority?.selectedProjectId)
    assertEquals("thread-1", authorization?.authority?.selectedThreadId)
    listOf("thread-1", "/thread-1", "project-1/", "a/b/c").forEach { malformed ->
      assertNull(T3VoiceBackgroundThreadAuthorityPolicy.validate(
        readiness.copy(targetId = malformed), available, DIGEST, NOW))
    }
  }

  @Test fun `created response accepts idempotent progressed operation but fences identity`() {
    val authority = requireNotNull(T3VoiceBackgroundThreadAuthorityPolicy.validate(
      readiness(), T3VoiceRuntimeGrantLoadResult.Available(grant()), DIGEST, NOW)).authority
    val progressed = createResult(snapshot(phase = "waiting", last = 9, ack = 7, dispatched = true))
    assertTrue(T3VoiceBackgroundThreadAuthorityPolicy.validateCreated(
      authority, "client-1", progressed, NOW))
    assertFalse(T3VoiceBackgroundThreadAuthorityPolicy.validateCreated(
      authority, "client-1", progressed.copy(snapshot = progressed.snapshot.copy(threadId = "other")), NOW))
    assertTrue(T3VoiceBackgroundThreadAuthorityPolicy.validateSnapshot(
      authority, "operation-1", 7, progressed.snapshot))
    assertFalse(T3VoiceBackgroundThreadAuthorityPolicy.validateSnapshot(
      authority, "operation-1", 10, progressed.snapshot))
  }

  @Test fun `speech work refetches durable gap and accepts only one advertised segment prefix`() {
    val events: List<T3VoiceBackgroundThreadTurnEvent> = listOf(
      T3VoiceBackgroundThreadTurnEvent.Phase(4, "speaking"),
      T3VoiceBackgroundThreadTurnEvent.SpeechReady(5, 2, false),
      T3VoiceBackgroundThreadTurnEvent.SpeechReady(6, 3, true),
      T3VoiceBackgroundThreadTurnEvent.SpeechTerminal(7, "completed"),
    )
    assertEquals(
      T3VoiceBackgroundThreadSpeechWork(1, null),
      T3VoiceBackgroundThreadSpeechPolicy.next(0, 2, events),
    )
    val advertised = T3VoiceBackgroundThreadSpeechPolicy.next(1, 1, events)
    assertEquals(T3VoiceBackgroundThreadSpeechWork(2, 5), advertised)
    assertEquals(listOf(4L, 5L),
      T3VoiceBackgroundThreadSpeechPolicy.acceptedPrefix(events, advertised).map { it.sequence })
    assertEquals(
      T3VoiceBackgroundThreadSpeechWork(3, 6),
      T3VoiceBackgroundThreadSpeechPolicy.next(2, 2, events),
    )
  }

  @Test fun `thread retry backoff is bounded`() {
    assertEquals(500L, T3VoiceBackgroundThreadRetryPolicy.delayMillis(1))
    assertEquals(30_000L, T3VoiceBackgroundThreadRetryPolicy.delayMillis(100))
  }

  @Test fun `thread attempt loses ownership when readiness changes`() {
    val current = readiness()
    val authority = requireNotNull(
      T3VoiceBackgroundThreadAuthorityPolicy.validate(
        current,
        T3VoiceRuntimeGrantLoadResult.Available(grant()),
        DIGEST,
        NOW,
      ),
    ).authority
    val attempt = T3VoiceBackgroundThreadAttempt(authority, "client-1")

    assertTrue(T3VoiceBackgroundThreadAttemptPolicy.owns(attempt, current))
    assertFalse(
      T3VoiceBackgroundThreadAttemptPolicy.owns(
        attempt,
        current.copy(mode = T3VoiceReadinessMode.REALTIME),
      ),
    )
    assertFalse(
      T3VoiceBackgroundThreadAttemptPolicy.owns(
        attempt,
        current.copy(targetId = "project-1/thread-2"),
      ),
    )
    assertFalse(
      T3VoiceBackgroundThreadAttemptPolicy.owns(
        attempt,
        current.copy(generation = current.generation + 1),
      ),
    )
  }

  @Test fun `active child authority restores without retaining parent grant`() {
    val desired = readiness()
    val installed = T3VoicePreparedReadiness(
      desired.copy(generation = 4), "runtime-1", "https://example.test",
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      T3VoiceRuntimeTargetIdentity.digest("project-1/thread-1"),
    )
    val active = T3VoiceBackgroundThreadOperationState.Active(
      T3VoiceBackgroundThreadClaim("runtime-1", 4, "https://example.test",
        "project-1", "thread-1", "client-1"),
      "operation-1", NOW + 50_000, "child-secret",
      acknowledgedCursor = 0,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.IDLE, autoRearm = true,
      ),
    )
    assertEquals("runtime-1", T3VoiceBackgroundThreadAuthorityPolicy.restore(
      desired, installed, active, NOW)?.runtimeId)
    assertNull(T3VoiceBackgroundThreadAuthorityPolicy.restore(
      desired.copy(targetId = "project-1/other"), installed, active, NOW))
  }

  @Test fun `background playback retry is bounded`() {
    assertTrue(T3VoiceBackgroundThreadPlaybackPolicy.shouldRetry(1))
    assertTrue(T3VoiceBackgroundThreadPlaybackPolicy.shouldRetry(3))
    assertFalse(T3VoiceBackgroundThreadPlaybackPolicy.shouldRetry(4))
  }

  @Test fun `acknowledged parent revocation releases exact local child fence`() {
    val state = T3VoiceBackgroundThreadOperationState.Prepared(
      T3VoiceBackgroundThreadClaim("runtime-1", 4, "https://example.test",
        "project-1", "thread-1", "client-1"),
    )
    assertTrue(T3VoiceBackgroundThreadRevocationPolicy.matches(
      state, T3VoicePendingRuntimeRevocation("runtime-1", "https://example.test")))
    assertFalse(T3VoiceBackgroundThreadRevocationPolicy.matches(
      state, T3VoicePendingRuntimeRevocation("runtime-2", "https://example.test")))
  }

  @Test fun `failed child cancellation remains retryable until revocation acknowledgement`() {
    assertEquals(T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION,
      T3VoiceBackgroundThreadCancelPolicy.decide(
      T3VoiceBackgroundThreadTurnResult.Failure(
        T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED, 401,
      ),
    ))
    assertEquals(T3VoiceBackgroundThreadCancelDecision.RETRY,
      T3VoiceBackgroundThreadCancelPolicy.decide(
        T3VoiceBackgroundThreadTurnResult.Failure(
          T3VoiceBackgroundHttpFailureKind.RETRYABLE, 503,
        ),
      ))
    assertEquals(T3VoiceBackgroundThreadCancelDecision.COMPLETE,
      T3VoiceBackgroundThreadCancelPolicy.decide(
        T3VoiceBackgroundThreadTurnResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT, 410,
        ),
      ))
    assertEquals(T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION,
      T3VoiceBackgroundThreadCancelPolicy.decide(
        T3VoiceBackgroundThreadTurnResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT, 500,
        ),
      ))
    assertEquals(T3VoiceBackgroundThreadCancelDecision.COMPLETE,
      T3VoiceBackgroundThreadCancelPolicy.decide(
      T3VoiceBackgroundThreadTurnResult.Success(Unit),
    ))
  }

  @Test fun `event batches must be contiguous from requested cursor`() {
    val contiguous = listOf<T3VoiceBackgroundThreadTurnEvent>(
      T3VoiceBackgroundThreadTurnEvent.Phase(6, "waiting"),
      T3VoiceBackgroundThreadTurnEvent.Terminal(7, "completed"),
    )
    assertTrue(T3VoiceBackgroundThreadEventBatchPolicy.isContiguous(5, contiguous, 7))
    assertFalse(T3VoiceBackgroundThreadEventBatchPolicy.isContiguous(
      5, listOf(T3VoiceBackgroundThreadTurnEvent.Phase(7, "waiting")), 7))
    assertFalse(T3VoiceBackgroundThreadEventBatchPolicy.isContiguous(5, emptyList(), 7))
    assertTrue(T3VoiceBackgroundThreadEventBatchPolicy.isContiguous(5, emptyList(), 5))
  }

  @Test fun `event processing acknowledges once before continuing`() {
    assertEquals(
      T3VoiceBackgroundThreadEventCommitDecision.ACKNOWLEDGE,
      T3VoiceBackgroundThreadEventCommitPolicy.afterBatch(6, 5),
    )
    assertEquals(
      T3VoiceBackgroundThreadEventCommitDecision.CONTINUE,
      T3VoiceBackgroundThreadEventCommitPolicy.afterBatch(6, 6),
    )
  }

  @Test fun `terminal cleanup waits for exact ack and rearms only completed outcomes`() {
    val completedNoSpeech = terminalSnapshot(
      T3VoiceBackgroundTerminalSummary.COMPLETED,
      noSpeech = true,
    )
    assertFalse(T3VoiceBackgroundThreadTerminalPolicy.canCleanup(completedNoSpeech, 6, false))
    assertTrue(T3VoiceBackgroundThreadTerminalPolicy.canCleanup(completedNoSpeech, 7, false))
    assertTrue(T3VoiceBackgroundThreadTerminalPolicy.shouldAutoRearm(completedNoSpeech))
    listOf(
      T3VoiceBackgroundTerminalSummary.CANCELLED,
      T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
      T3VoiceBackgroundTerminalSummary.FAILED_PERMANENT,
    ).forEach { summary ->
      val terminal = terminalSnapshot(summary, noSpeech = false)
      assertTrue(T3VoiceBackgroundThreadTerminalPolicy.canCleanup(terminal, 7, false))
      assertFalse(T3VoiceBackgroundThreadTerminalPolicy.shouldAutoRearm(terminal))
      assertFalse(T3VoiceBackgroundThreadTerminalPolicy.shouldPollAfterAck(terminal, false))
    }
    val attention = terminalSnapshot(T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED, false)
    assertTrue(T3VoiceBackgroundThreadTerminalPolicy.canCleanup(attention, 7, false))
    assertFalse(T3VoiceBackgroundThreadTerminalPolicy.shouldPollAfterAck(attention, false))
    val completedAwaitingSpeech = completedNoSpeech.copy(
      phase = T3VoiceBackgroundPhase.WAITING,
      speechTerminal = false,
      noSpeech = false,
    )
    assertTrue(T3VoiceBackgroundThreadTerminalPolicy.shouldPollAfterAck(
      completedAwaitingSpeech,
      false,
    ))
    assertFalse(T3VoiceBackgroundThreadTerminalPolicy.shouldPollAfterAck(
      completedAwaitingSpeech,
      true,
    ))
  }

  @Test fun `stop after acknowledge preserves durable operation cursor invariant`() {
    val active = T3VoiceBackgroundThreadOperationState.Active(
      T3VoiceBackgroundThreadClaim(
        "runtime-1", 4, "https://example.test", "project-1", "thread-1", "client-1",
      ),
      "operation-1",
      NOW + 50_000,
      "child-secret",
      acknowledgedCursor = 5,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1",
        readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.WAITING,
        operationId = "operation-1",
        operationGeneration = 4,
        eventCursor = 5,
      ),
    )
    val stopped = T3VoiceBackgroundReducer.reduce(
      active.snapshot,
      T3VoiceBackgroundEvent.Stop,
    ).snapshot

    val durable = T3VoiceBackgroundThreadPersistencePolicy.snapshotAfterTransition(active, stopped)

    assertEquals(active.snapshot, durable)
    assertTrue(active.acknowledgedCursor in 0..durable.eventCursor)
  }

  @Test fun `wake lock remains held through native background work`() {
    assertTrue(T3VoiceBackgroundWakeLockPolicy.shouldRetain(true, false, false))
    assertTrue(T3VoiceBackgroundWakeLockPolicy.shouldRetain(false, true, false))
    assertTrue(T3VoiceBackgroundWakeLockPolicy.shouldRetain(false, false, true))
    assertFalse(T3VoiceBackgroundWakeLockPolicy.shouldRetain(false, false, false))
  }

  @Test fun `offline backoff does not retain wake lock for an idle durable attempt`() {
    assertFalse(T3VoiceBackgroundWakeLockPolicy.shouldRetain(
      hasThreadWork = false,
      hasRealtimeMedia = false,
      hasRealtimeCleanupInFlight = false,
    ))
  }

  @Test fun `event batch reduces atomically before its final cursor is persisted`() {
    val initial = T3VoiceBackgroundSnapshot(
      runtimeId = "runtime-1", readinessGeneration = 4,
      mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.WAITING,
      operationId = "operation-1", operationGeneration = 4,
      dispatchAcknowledged = true, eventCursor = 1,
    )
    val batch = T3VoiceBackgroundThreadBatchReducer.reduce(initial, listOf(
      serverEvent(2, T3VoiceBackgroundServerPhase.SPEAKING, speechTerminal = true, noSpeech = true),
      serverEvent(3, T3VoiceBackgroundServerPhase.COMPLETED),
    ))

    assertEquals(1L, initial.eventCursor)
    assertEquals(3L, batch.snapshot.eventCursor)
    assertTrue(batch.snapshot.responseTerminal)
  }

  @Test fun `cancel authority rejection and failed rearm require reconciliation`() {
    assertTrue(T3VoiceBackgroundThreadCancelReconciliationPolicy.requiresFence(
      T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION,
    ))
    assertFalse(T3VoiceBackgroundThreadCancelReconciliationPolicy.requiresFence(
      T3VoiceBackgroundThreadCancelDecision.RETRY,
    ))
    assertTrue(T3VoiceBackgroundThreadRearmPolicy.shouldReconcileAfterStart(false))
    assertFalse(T3VoiceBackgroundThreadRearmPolicy.shouldReconcileAfterStart(true))
  }

  @Test fun `missing recording cache file is rejected without throwing`() {
    assertNull(T3VoiceBackgroundThreadRecordingBodyPolicy.create(
      T3VoiceRecordingResult(
        "missing-recording",
        "file:///definitely/missing/t3-voice-recording.m4a",
        100,
        1,
      ),
    ))
  }

  @Test fun `local stop reconciles foreground only after durable state and snapshot`() {
    val order = mutableListOf<String>()
    assertTrue(T3VoiceBackgroundThreadLocalStopCoordinator.complete(
      clearDurableState = { order += "state"; true },
      stopSnapshot = { order += "snapshot" },
      reconcileForeground = { order += "foreground" },
    ))
    assertEquals(listOf("state", "snapshot", "foreground"), order)

    order.clear()
    assertFalse(T3VoiceBackgroundThreadLocalStopCoordinator.complete(
      clearDurableState = { order += "state"; false },
      stopSnapshot = { order += "snapshot" },
      reconcileForeground = { order += "foreground" },
    ))
    assertEquals(listOf("state"), order)
  }

  @Test fun `prepared cancellation reconciles missing and locked runtime grants`() {
    assertNull(T3VoiceBackgroundThreadPreparedCancellationPolicy.runtimeGrantToken(
      T3VoiceRuntimeGrantLoadResult.Missing,
    ))
    assertNull(T3VoiceBackgroundThreadPreparedCancellationPolicy.runtimeGrantToken(
      T3VoiceRuntimeGrantLoadResult.Locked,
    ))
    assertEquals(
      "secret",
      T3VoiceBackgroundThreadPreparedCancellationPolicy.runtimeGrantToken(
        T3VoiceRuntimeGrantLoadResult.Available(grant()),
      ),
    )
  }

  @Test fun `stop cancels upload or poll without cancelling independent server cleanup`() {
    val attempt = T3VoiceBackgroundThreadAttempt(
      requireNotNull(T3VoiceBackgroundThreadAuthorityPolicy.validate(
        readiness(), T3VoiceRuntimeGrantLoadResult.Available(grant()), DIGEST, NOW)).authority,
      "client-1",
    )
    val upload = FakeCall()
    assertTrue(attempt.beginCall(upload))
    attempt.cancelActiveCall()
    assertTrue(upload.cancelled)
    val poll = FakeCall()
    assertTrue(attempt.beginCall(poll))
    val cleanup = FakeCall()
    attempt.beginCancellationCall(cleanup)
    attempt.cancelActiveCall()
    assertTrue(poll.cancelled)
    assertFalse(cleanup.cancelled)

    assertFalse(attempt.finishCall(poll))
    assertTrue(attempt.finishCancellationCall(cleanup))
  }

  @Test fun `revocation fence is cleared last and survives derived cleanup crash`() {
    val order = mutableListOf<String>()
    assertFalse(T3VoiceRevocationAcknowledgementCoordinator.run(
      pendingMatches = true,
      clearDerivedState = { order += "derived"; false },
      clearPendingFence = { order += "fence"; true },
    ))
    assertEquals(listOf("derived"), order)
    order.clear()
    assertTrue(T3VoiceRevocationAcknowledgementCoordinator.run(
      pendingMatches = true,
      clearDerivedState = { order += "derived"; true },
      clearPendingFence = { order += "fence"; true },
    ))
    assertEquals(listOf("derived", "fence"), order)
  }

  @Test fun `cancel completion deletes recording before clearing durable operation`() {
    val order = mutableListOf<String>()
    assertFalse(T3VoiceBackgroundThreadLocalCleanupCoordinator.complete(
      deleteRecording = { order += "recording"; false },
      clearDurableState = { order += "state"; true },
    ))
    assertEquals(listOf("recording"), order)
    order.clear()
    assertTrue(T3VoiceBackgroundThreadLocalCleanupCoordinator.complete(
      deleteRecording = { order += "recording"; true },
      clearDurableState = { order += "state"; true },
    ))
    assertEquals(listOf("recording", "state"), order)
  }

  @Test fun `process recovery registers persisted active recording before cleanup`() {
    val recording = T3VoiceRecordingResult(
      "recording-1", "file:///cache/recording-1.m4a", 1_000, 128,
    )
    val claim = T3VoiceBackgroundThreadClaim(
      "runtime-1", 4, "https://example.test", "project-1", "thread-1", "client-1",
    )
    val active = T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", NOW + 10_000, "child", 0, recording = recording,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.FINALIZED,
        operationId = "operation-1", operationGeneration = 4, recordingId = "recording-1",
      ),
    )
    var restored: T3VoiceRecordingResult? = null
    assertTrue(T3VoiceBackgroundThreadRecordingRecovery.restore(
      T3VoiceBackgroundThreadOperationLoadResult.Available(active),
    ) { restored = it; true })
    assertEquals(recording, restored)
    assertTrue(T3VoiceBackgroundThreadRecordingRecovery.restore(
      T3VoiceBackgroundThreadOperationLoadResult.Missing,
    ) { false })
  }

  @Test fun `stored operation recovery distinguishes unstarted active work`() {
    val claim = T3VoiceBackgroundThreadClaim(
      "runtime-1", 4, "https://example.test", "project-1", "thread-1", "client-1",
    )
    val active = T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", NOW, "child", 0,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.WAITING,
        operationId = "operation-1", operationGeneration = 4,
      ),
    )
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.REVOKE,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(active), true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.REVOKE,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Locked, true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.CANCEL_UNDISPATCHED,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(active.copy(
          expiresAtEpochMillis = NOW + 10_000,
          snapshot = active.snapshot.copy(
            phase = T3VoiceBackgroundPhase.TRANSCRIBING,
          ),
        )), true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.RESTORE,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(active.copy(
          expiresAtEpochMillis = NOW + 10_000,
          snapshot = active.snapshot.copy(dispatchAcknowledged = true),
        )), true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.CANCEL_PREPARED,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(
          T3VoiceBackgroundThreadOperationState.Prepared(claim, cancelRequested = true)),
        true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.CANCEL_PREPARED,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(
          T3VoiceBackgroundThreadOperationState.Prepared(claim)),
        true, NOW))
    assertEquals(T3VoiceBackgroundThreadStoredStateDecision.REVOKE,
      T3VoiceBackgroundThreadStoredStatePolicy.decide(
        T3VoiceBackgroundThreadOperationLoadResult.Available(
          T3VoiceBackgroundThreadOperationState.Prepared(claim, cancelRequested = true)),
        false, NOW))
  }

  @Test fun `native control surfaces ignore cancellation-only reconciliation`() {
    assertFalse(T3VoiceNativeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, true, true))
    assertTrue(T3VoiceNativeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, true, false))
    assertTrue(T3VoiceNativeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, true, false, false))
    assertTrue(T3VoiceNativeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.RECORDING, false, false, false))
    assertFalse(T3VoiceNativeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, false, false))
  }

  @Test fun `cancellation authority survives mode change and process recovery`() {
    val targetDigest = T3VoiceRuntimeTargetIdentity.digest("project-1/thread-1")
    val claim = T3VoiceBackgroundThreadClaim(
      "runtime-1", 4, "https://example.test", "project-1", "thread-1", "client-1",
    )
    val active = T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", NOW + 10_000, "child", 0, cancelRequested = true,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1",
        readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.IDLE,
        autoRearm = true,
      ),
    )
    assertEquals(
      T3VoiceBackgroundThreadAuthority(
        "runtime-1", 4, "https://example.test", "project-1", "thread-1", true,
      ),
      T3VoiceBackgroundThreadAuthorityPolicy.cancellationAuthority(active),
    )
    val authorization = T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(grant(targetDigest)),
      claim,
      NOW,
    )
    assertEquals("secret", requireNotNull(authorization).runtimeGrantToken)
    assertNull(T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Missing,
      claim,
      NOW,
    ))
    val wrongOrigin = grant(targetDigest).copy(
      metadata = grant(targetDigest).metadata.copy(environmentOrigin = "https://other.test"),
    )
    assertNull(T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(wrongOrigin),
      claim,
      NOW,
    ))
  }

  private fun readiness() = T3VoiceReadinessConfig(
    enabled = true, mode = T3VoiceReadinessMode.THREAD, targetId = "project-1/thread-1",
    microphonePermissionGranted = true, notificationPermissionGranted = true,
    autoRearm = true, generation = 4,
  )
  private fun grant(targetIdentityDigest: String = DIGEST) = T3VoiceRuntimeGrant(
    T3VoiceRuntimeGrantMetadata("runtime-1", 4, "https://example.test",
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START, targetIdentityDigest, NOW + 60_000), "secret")
  private fun snapshot(phase: String, last: Long, ack: Long, dispatched: Boolean) =
    T3VoiceBackgroundThreadTurnSnapshot("operation-1", "runtime-1", 4, "project-1", "thread-1",
      "default", true, phase, "message-1", "turn-1", last, ack, null, dispatched, NOW + 50_000)
  private fun createResult(snapshot: T3VoiceBackgroundThreadTurnSnapshot) =
    T3VoiceBackgroundThreadTurnCreateResult(snapshot,
      T3VoiceBackgroundThreadTurnGrant("child", NOW + 40_000))
  private fun terminalSnapshot(
    summary: T3VoiceBackgroundTerminalSummary,
    noSpeech: Boolean,
  ) = T3VoiceBackgroundSnapshot(
    runtimeId = "runtime-1", readinessGeneration = 4, mode = T3VoiceBackgroundMode.THREAD,
    phase = when (summary) {
      T3VoiceBackgroundTerminalSummary.COMPLETED -> T3VoiceBackgroundPhase.PLAYBACK_DRAINED
      T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED -> T3VoiceBackgroundPhase.ATTENTION_REQUIRED
      else -> T3VoiceBackgroundPhase.FAILED
    },
    operationId = "operation-1", operationGeneration = 4,
    dispatchAcknowledged = true, eventCursor = 7,
    speechTerminal = noSpeech, noSpeech = noSpeech, responseTerminal = true,
    autoRearm = true, terminalSummary = summary,
  )

  private fun serverEvent(
    sequence: Long,
    phase: T3VoiceBackgroundServerPhase,
    speechTerminal: Boolean = false,
    noSpeech: Boolean = false,
  ) = T3VoiceBackgroundEvent.ServerEvent(
    operationId = "operation-1",
    operationGeneration = 4,
    sequence = sequence,
    phase = phase,
    dispatchAcknowledged = true,
    speechTerminal = speechTerminal,
    noSpeech = noSpeech,
  )

  private class FakeCall : T3VoiceBackgroundThreadCall<Unit> {
    var cancelled = false
    override fun execute() = T3VoiceBackgroundThreadTurnResult.Success(Unit)
    override fun cancel() { cancelled = true }
  }
  companion object {
    const val NOW = 1_800_000_000_000L
    val DIGEST = "a".repeat(64)
  }
}
