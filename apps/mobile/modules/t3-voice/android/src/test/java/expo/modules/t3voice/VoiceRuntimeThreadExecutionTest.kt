package expo.modules.t3voice

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeThreadExecutionTest {
  @Test fun `canonical attached authority executes without notification readiness`() {
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, 60_000, 600_000, true, 750,
    )
    val persisted = VoiceRuntimePersistedAuthority(
      "runtime-1", 4,
      T3VoiceRuntimeTargetIdentity.digest(VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)),
      target, "https://example.test", false,
    )

    assertNull(VoiceRuntimeThreadAuthorityPolicy.validateCanonical(
      persisted, 0, true, NOW))
    val attached = requireNotNull(VoiceRuntimeThreadAuthorityPolicy.validateCanonical(
      persisted, 1, true, NOW))
    assertEquals(750, attached.authority.rearmGuardMs)
    assertEquals(2_200, attached.authority.endSilenceMs)
  }

  @Test fun `auto rearm honors guard and attached or readiness ownership`() {
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, null, 600_000, true, 1_250,
    )
    assertEquals(1_250, VoiceRuntimeThreadRearmPolicy.delayMillis(target))
    assertTrue(VoiceRuntimeThreadRearmPolicy.canSchedule(target, null, false, 1))
    assertTrue(VoiceRuntimeThreadRearmPolicy.canSchedule(target, null, true, 0))
    assertFalse(VoiceRuntimeThreadRearmPolicy.canSchedule(target, null, false, 0))
    assertFalse(VoiceRuntimeThreadRearmPolicy.canSchedule(
      target, VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED, true, 1))
    assertFalse(VoiceRuntimeThreadRearmPolicy.canSchedule(
      target.copy(autoRearm = false), null, true, 1))
  }

  @Test fun `authority requires strict composite target and exact grant`() {
    val readiness = readiness()
    val available = T3VoiceRuntimeGrantLoadResult.Available(grant())
    val authorization = VoiceRuntimeThreadAuthorityPolicy.validate(readiness, available, DIGEST, NOW)
    assertEquals("project-1", authorization?.authority?.selectedProjectId)
    assertEquals("thread-1", authorization?.authority?.selectedThreadId)
    listOf("thread-1", "/thread-1", "project-1/", "a/b/c").forEach { malformed ->
      assertNull(VoiceRuntimeThreadAuthorityPolicy.validate(
        readiness.copy(targetId = malformed), available, DIGEST, NOW))
    }
  }

  @Test fun `created response accepts idempotent progressed operation but fences identity`() {
    val authority = requireNotNull(VoiceRuntimeThreadAuthorityPolicy.validate(
      readiness(), T3VoiceRuntimeGrantLoadResult.Available(grant()), DIGEST, NOW)).authority
    val progressed = createResult(snapshot(phase = "waiting", last = 9, ack = 7, dispatched = true))
    assertTrue(VoiceRuntimeThreadAuthorityPolicy.validateCreated(
      authority, "client-1", progressed, NOW))
    assertFalse(VoiceRuntimeThreadAuthorityPolicy.validateCreated(
      authority, "client-1", progressed.copy(snapshot = progressed.snapshot.copy(threadId = "other")), NOW))
    assertFalse(VoiceRuntimeThreadAuthorityPolicy.validateCreated(
      authority,
      "client-1",
      progressed.copy(snapshot = progressed.snapshot.copy(operationTokenExpiresAtEpochMillis = NOW)),
      NOW,
    ))
    assertTrue(VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
      authority, "operation-1", 7, progressed.snapshot))
    assertFalse(VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
      authority, "operation-1", 10, progressed.snapshot))
  }

  @Test fun `speech work refetches durable gap and accepts only one advertised segment prefix`() {
    val events: List<VoiceRuntimeThreadTurnEvent> = listOf(
      VoiceRuntimeThreadTurnEvent.Phase(4, "speaking"),
      VoiceRuntimeThreadTurnEvent.SpeechReady(5, 2, false),
      VoiceRuntimeThreadTurnEvent.SpeechReady(6, 3, true),
      VoiceRuntimeThreadTurnEvent.SpeechTerminal(7, "completed"),
    )
    assertEquals(
      VoiceRuntimeThreadSpeechWork(1, null),
      VoiceRuntimeThreadSpeechPolicy.next(0, 2, events),
    )
    val advertised = VoiceRuntimeThreadSpeechPolicy.next(1, 1, events)
    assertEquals(VoiceRuntimeThreadSpeechWork(2, 5), advertised)
    assertEquals(listOf(4L, 5L),
      VoiceRuntimeThreadSpeechPolicy.acceptedPrefix(events, advertised).map { it.sequence })
    assertEquals(
      VoiceRuntimeThreadSpeechWork(3, 6),
      VoiceRuntimeThreadSpeechPolicy.next(2, 2, events),
    )
  }

  @Test fun `thread retry backoff is bounded`() {
    assertEquals(500L, VoiceRuntimeThreadRetryPolicy.delayMillis(1))
    assertEquals(30_000L, VoiceRuntimeThreadRetryPolicy.delayMillis(100))
  }

  @Test fun `detached handoff continuation is admitted without weakening ordinary authority`() {
    val authority = VoiceRuntimePersistedAuthority(
      runtimeId = "runtime-1",
      generation = 5,
      targetDigest = T3VoiceRuntimeTargetIdentity.digest(
        VoiceRuntimeBridge.canonicalThreadTargetIdentity(
          VoiceRuntimeTarget.Thread(
            "environment-1", "project-1", "thread-1", "default", true,
            2_200, null, 600_000, true, 250,
          ),
        ),
      ),
      target = VoiceRuntimeTarget.Thread(
        "environment-1", "project-1", "thread-1", "default", true,
        2_200, null, 600_000, true, 250,
      ),
      environmentOrigin = "https://example.test",
      readinessEnabled = false,
    )

    assertNull(VoiceRuntimeThreadAuthorityPolicy.validateCanonical(authority, 0, true, NOW))
    assertEquals(
      "runtime-1",
      VoiceRuntimeThreadAuthorityPolicy.validateCanonical(
        authority,
        0,
        true,
        NOW,
        allowDetachedContinuation = true,
      )?.authority?.runtimeId,
    )
  }

  @Test fun `thread attempt loses ownership when readiness changes`() {
    val current = readiness()
    val authority = requireNotNull(
      VoiceRuntimeThreadAuthorityPolicy.validate(
        current,
        T3VoiceRuntimeGrantLoadResult.Available(grant()),
        DIGEST,
        NOW,
      ),
    ).authority
    val attempt = VoiceRuntimeThreadAttempt(authority, "client-1")

    assertTrue(VoiceRuntimeThreadAttemptPolicy.owns(attempt, current))
    assertFalse(
      VoiceRuntimeThreadAttemptPolicy.owns(
        attempt,
        current.copy(mode = T3VoiceReadinessMode.REALTIME),
      ),
    )
    assertFalse(
      VoiceRuntimeThreadAttemptPolicy.owns(
        attempt,
        current.copy(targetId = "project-1/thread-2"),
      ),
    )
    assertFalse(
      VoiceRuntimeThreadAttemptPolicy.owns(
        attempt,
        current.copy(generation = current.generation + 1),
      ),
    )
  }

  @Test fun `active child authority restores without retaining parent grant`() {
    val desired = readiness()
    val installed = activeAuthority()
    val active = VoiceRuntimeThreadOperationState.Active(
      claim(),
      "operation-1", NOW + 50_000,
      acknowledgedCursor = 0,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.IDLE, autoRearm = true,
      ),
    )
    assertEquals("runtime-1", VoiceRuntimeThreadAuthorityPolicy.restore(
      desired, installed, active, NOW)?.runtimeId)
    assertNull(VoiceRuntimeThreadAuthorityPolicy.restore(
      desired.copy(targetId = "project-1/other"), installed, active, NOW))
    assertNull(VoiceRuntimeThreadAuthorityPolicy.restore(
      desired, activeAuthority(targetId = "project-2/thread-1"), active, NOW))
    assertNull(VoiceRuntimeThreadAuthorityPolicy.restore(
      desired.copy(generation = 5), installed, active, NOW))
    assertNull(VoiceRuntimeThreadAuthorityPolicy.restore(
      desired, installed, active.copy(expiresAtEpochMillis = NOW), NOW))
  }

  @Test fun `background playback retry is bounded`() {
    assertTrue(VoiceRuntimeThreadPlaybackPolicy.shouldRetry(1))
    assertTrue(VoiceRuntimeThreadPlaybackPolicy.shouldRetry(3))
    assertFalse(VoiceRuntimeThreadPlaybackPolicy.shouldRetry(4))
  }

  @Test fun `acknowledged parent revocation releases exact local child fence`() {
    val state = VoiceRuntimeThreadOperationState.Prepared(
      claim(),
    )
    assertTrue(VoiceRuntimeThreadRevocationPolicy.matches(
      state, T3VoicePendingRuntimeRevocation("runtime-1", "https://example.test")))
    assertFalse(VoiceRuntimeThreadRevocationPolicy.matches(
      state, T3VoicePendingRuntimeRevocation("runtime-2", "https://example.test")))
  }

  @Test fun `failed child cancellation remains retryable until revocation acknowledgement`() {
    assertEquals(VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION,
      VoiceRuntimeThreadCancelPolicy.decide(
      VoiceRuntimeThreadTurnResult.Failure(
        VoiceRuntimeHttpFailureKind.AUTHORITY_REJECTED, 401,
      ),
    ))
    assertEquals(VoiceRuntimeThreadCancelDecision.RETRY,
      VoiceRuntimeThreadCancelPolicy.decide(
        VoiceRuntimeThreadTurnResult.Failure(
          VoiceRuntimeHttpFailureKind.RETRYABLE, 503,
        ),
      ))
    assertEquals(VoiceRuntimeThreadCancelDecision.COMPLETE,
      VoiceRuntimeThreadCancelPolicy.decide(
        VoiceRuntimeThreadTurnResult.Failure(
          VoiceRuntimeHttpFailureKind.PERMANENT, 410,
        ),
      ))
    assertEquals(VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION,
      VoiceRuntimeThreadCancelPolicy.decide(
        VoiceRuntimeThreadTurnResult.Failure(
          VoiceRuntimeHttpFailureKind.PERMANENT, 500,
        ),
      ))
    assertEquals(VoiceRuntimeThreadCancelDecision.COMPLETE,
      VoiceRuntimeThreadCancelPolicy.decide(
      VoiceRuntimeThreadTurnResult.Success(Unit),
    ))
  }

  @Test fun `event batches must be contiguous from requested cursor`() {
    val contiguous = listOf<VoiceRuntimeThreadTurnEvent>(
      VoiceRuntimeThreadTurnEvent.Phase(6, "waiting"),
      VoiceRuntimeThreadTurnEvent.Terminal(7, "completed"),
    )
    assertTrue(VoiceRuntimeThreadEventBatchPolicy.isContiguous(5, contiguous, 7))
    assertFalse(VoiceRuntimeThreadEventBatchPolicy.isContiguous(
      5, listOf(VoiceRuntimeThreadTurnEvent.Phase(7, "waiting")), 7))
    assertFalse(VoiceRuntimeThreadEventBatchPolicy.isContiguous(5, emptyList(), 7))
    assertTrue(VoiceRuntimeThreadEventBatchPolicy.isContiguous(5, emptyList(), 5))
  }

  @Test fun `event processing acknowledges once before continuing`() {
    assertEquals(
      VoiceRuntimeThreadEventCommitDecision.ACKNOWLEDGE,
      VoiceRuntimeThreadEventCommitPolicy.afterBatch(6, 5),
    )
    assertEquals(
      VoiceRuntimeThreadEventCommitDecision.CONTINUE,
      VoiceRuntimeThreadEventCommitPolicy.afterBatch(6, 6),
    )
  }

  @Test fun `terminal cleanup waits for exact ack and rearms only completed outcomes`() {
    val completedNoSpeech = terminalSnapshot(
      VoiceRuntimeTerminalSummary.COMPLETED,
      noSpeech = true,
    )
    assertFalse(VoiceRuntimeThreadTerminalPolicy.canCleanup(completedNoSpeech, 6, false))
    assertTrue(VoiceRuntimeThreadTerminalPolicy.canCleanup(completedNoSpeech, 7, false))
    assertTrue(VoiceRuntimeThreadTerminalPolicy.shouldAutoRearm(completedNoSpeech))
    listOf(
      VoiceRuntimeTerminalSummary.CANCELLED,
      VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
      VoiceRuntimeTerminalSummary.FAILED_PERMANENT,
    ).forEach { summary ->
      val terminal = terminalSnapshot(summary, noSpeech = false)
      assertTrue(VoiceRuntimeThreadTerminalPolicy.canCleanup(terminal, 7, false))
      assertFalse(VoiceRuntimeThreadTerminalPolicy.shouldAutoRearm(terminal))
      assertFalse(VoiceRuntimeThreadTerminalPolicy.shouldPollAfterAck(terminal, false))
    }
    val attention = terminalSnapshot(VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED, false)
    assertTrue(VoiceRuntimeThreadTerminalPolicy.canCleanup(attention, 7, false))
    assertFalse(VoiceRuntimeThreadTerminalPolicy.shouldPollAfterAck(attention, false))
    val completedAwaitingSpeech = completedNoSpeech.copy(
      phase = VoiceRuntimePhase.WAITING,
      speechTerminal = false,
      noSpeech = false,
    )
    assertTrue(VoiceRuntimeThreadTerminalPolicy.shouldPollAfterAck(
      completedAwaitingSpeech,
      false,
    ))
    assertFalse(VoiceRuntimeThreadTerminalPolicy.shouldPollAfterAck(
      completedAwaitingSpeech,
      true,
    ))
  }

  @Test fun `stop after acknowledge preserves durable operation cursor invariant`() {
    val active = VoiceRuntimeThreadOperationState.Active(
      claim(),
      "operation-1",
      NOW + 50_000,
      acknowledgedCursor = 5,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1",
        readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1",
        operationGeneration = 4,
        eventCursor = 5,
      ),
    )
    val stopped = VoiceRuntimeExecutionReducer.reduce(
      active.snapshot,
      VoiceRuntimeExecutionEvent.Stop,
    ).snapshot

    val durable = VoiceRuntimeThreadPersistencePolicy.snapshotAfterTransition(active, stopped)

    assertEquals(active.snapshot, durable)
    assertTrue(active.acknowledgedCursor in 0..durable.eventCursor)
  }

  @Test fun `wake lock remains held through native background work`() {
    assertTrue(VoiceRuntimeWakeLockPolicy.shouldRetain(true, false, false))
    assertTrue(VoiceRuntimeWakeLockPolicy.shouldRetain(false, true, false))
    assertTrue(VoiceRuntimeWakeLockPolicy.shouldRetain(false, false, true))
    assertFalse(VoiceRuntimeWakeLockPolicy.shouldRetain(false, false, false))
  }

  @Test fun `offline backoff does not retain wake lock for an idle durable attempt`() {
    assertFalse(VoiceRuntimeWakeLockPolicy.shouldRetain(
      hasThreadWork = false,
      hasRealtimeMedia = false,
      hasRealtimeCleanupInFlight = false,
    ))
  }

  @Test fun `event batch reduces atomically before its final cursor is persisted`() {
    val initial = VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime-1", readinessGeneration = 4,
      mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
      operationId = "operation-1", operationGeneration = 4,
      dispatchAcknowledged = true, eventCursor = 1,
    )
    val batch = VoiceRuntimeThreadBatchReducer.reduce(initial, listOf(
      serverEvent(2, VoiceRuntimeServerPhase.SPEAKING, speechTerminal = true, noSpeech = true),
      serverEvent(3, VoiceRuntimeServerPhase.COMPLETED),
    ))

    assertEquals(1L, initial.eventCursor)
    assertEquals(3L, batch.snapshot.eventCursor)
    assertTrue(batch.snapshot.responseTerminal)
  }

  @Test fun `cancel authority rejection and failed rearm require reconciliation`() {
    assertTrue(VoiceRuntimeThreadCancelReconciliationPolicy.requiresFence(
      VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION,
    ))
    assertFalse(VoiceRuntimeThreadCancelReconciliationPolicy.requiresFence(
      VoiceRuntimeThreadCancelDecision.RETRY,
    ))
    assertTrue(VoiceRuntimeThreadStartReconciliationPolicy.shouldReconcileAfterStart(false))
    assertFalse(VoiceRuntimeThreadStartReconciliationPolicy.shouldReconcileAfterStart(true))
  }

  @Test fun `missing recording cache file is rejected without throwing`() {
    assertNull(VoiceRuntimeThreadRecordingBodyPolicy.create(
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
    assertTrue(VoiceRuntimeThreadLocalStopCoordinator.complete(
      clearDurableState = { order += "state"; true },
      stopSnapshot = { order += "snapshot" },
      reconcileForeground = { order += "foreground" },
    ))
    assertEquals(listOf("state", "snapshot", "foreground"), order)

    order.clear()
    assertFalse(VoiceRuntimeThreadLocalStopCoordinator.complete(
      clearDurableState = { order += "state"; false },
      stopSnapshot = { order += "snapshot" },
      reconcileForeground = { order += "foreground" },
    ))
    assertEquals(listOf("state"), order)
  }

  @Test fun `prepared cancellation fences terminal create failures`() {
    assertTrue(VoiceRuntimeThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
      cancelRequested = true, operationId = null, retryable = false,
    ))
    assertFalse(VoiceRuntimeThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
      cancelRequested = true, operationId = null, retryable = true,
    ))
    assertFalse(VoiceRuntimeThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
      cancelRequested = false, operationId = null, retryable = false,
    ))
    assertFalse(VoiceRuntimeThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
      cancelRequested = true, operationId = "operation-1", retryable = false,
    ))
  }

  @Test fun `stop cancels upload or poll without cancelling independent server cleanup`() {
    val attempt = VoiceRuntimeThreadAttempt(
      requireNotNull(VoiceRuntimeThreadAuthorityPolicy.validate(
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

  @Test fun `prepared cancellation can recover the operation credential after execution stops`() {
    val attempt = VoiceRuntimeThreadAttempt(
      VoiceRuntimeThreadAuthority(
        "runtime-1", 4, "https://example.test", "project-1", "thread-1", true,
      ),
      "client-1",
      cancelRequested = true,
    )
    val recovery = FakeCall()

    assertTrue(attempt.beginCall(recovery, allowCancellationRecovery = true))
    assertTrue(attempt.hasActiveCall())
    assertTrue(attempt.finishCall(recovery))

    attempt.stopped = true
    val rejected = FakeCall()
    assertFalse(attempt.beginCall(rejected, allowCancellationRecovery = true))
    assertTrue(rejected.cancelled)
  }

  @Test fun `cancel completion deletes recording before clearing durable operation`() {
    val order = mutableListOf<String>()
    assertFalse(VoiceRuntimeThreadLocalCleanupCoordinator.complete(
      deleteRecording = { order += "recording"; false },
      clearDurableState = { order += "state"; true },
    ))
    assertEquals(listOf("recording"), order)
    order.clear()
    assertTrue(VoiceRuntimeThreadLocalCleanupCoordinator.complete(
      deleteRecording = { order += "recording"; true },
      clearDurableState = { order += "state"; true },
    ))
    assertEquals(listOf("recording", "state"), order)
  }

  @Test fun `process recovery registers persisted active recording before cleanup`() {
    val recording = T3VoiceRecordingResult(
      "recording-1", "file:///cache/recording-1.m4a", 1_000, 128,
    )
    val claim = claim()
    val active = VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", NOW + 10_000, 0, recording = recording,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.FINALIZED,
        operationId = "operation-1", operationGeneration = 4, recordingId = "recording-1",
      ),
    )
    var restored: T3VoiceRecordingResult? = null
    assertTrue(VoiceRuntimeThreadRecordingRecovery.restore(
      VoiceRuntimeThreadOperationLoadResult.Available(active),
    ) { restored = it; true })
    assertEquals(recording, restored)
    assertTrue(VoiceRuntimeThreadRecordingRecovery.restore(
      VoiceRuntimeThreadOperationLoadResult.Missing,
    ) { false })
  }

  @Test fun `stored operation recovery distinguishes unstarted active work`() {
    val claim = claim()
    val active = VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", NOW, 0,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1", operationGeneration = 4,
      ),
    )
    assertEquals(VoiceRuntimeThreadStoredStateDecision.REVOKE,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(active), true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.REVOKE,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Locked, true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.CANCEL_UNDISPATCHED,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(active.copy(
          expiresAtEpochMillis = NOW + 10_000,
          snapshot = active.snapshot.copy(
            phase = VoiceRuntimePhase.TRANSCRIBING,
          ),
        )), true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.RESTORE,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(active.copy(
          expiresAtEpochMillis = NOW + 10_000,
          snapshot = active.snapshot.copy(dispatchAcknowledged = true),
        )), true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.CANCEL_PREPARED,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(
          VoiceRuntimeThreadOperationState.Prepared(claim, cancelRequested = true)),
        true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.CANCEL_PREPARED,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(
          VoiceRuntimeThreadOperationState.Prepared(claim)),
        true, NOW))
    assertEquals(VoiceRuntimeThreadStoredStateDecision.REVOKE,
      VoiceRuntimeThreadStoredStatePolicy.decide(
        VoiceRuntimeThreadOperationLoadResult.Available(
          VoiceRuntimeThreadOperationState.Prepared(claim, cancelRequested = true)),
        false, NOW))
  }

  @Test fun `native control surfaces ignore cancellation-only reconciliation`() {
    assertFalse(VoiceRuntimeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, true, true))
    assertTrue(VoiceRuntimeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, true, false))
    assertTrue(VoiceRuntimeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, true, false, false))
    assertTrue(VoiceRuntimeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.RECORDING, false, false, false))
    assertFalse(VoiceRuntimeControlSurfacePolicy.isActive(
      T3VoiceRuntimePhase.IDLE, false, false, false))
  }

  @Test fun `cancellation authority survives mode change and process recovery`() {
    val targetDigest = DIGEST
    val claim = claim()
    val active = VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", NOW + 10_000, 0, cancelRequested = true,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1",
        readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.IDLE,
        autoRearm = true,
      ),
    )
    assertEquals(
      VoiceRuntimeThreadAuthority(
        "runtime-1", 4, "https://example.test", "project-1", "thread-1", true,
      ),
      VoiceRuntimeThreadAuthorityPolicy.cancellationAuthority(active),
    )
    val authorization = VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(grant(targetDigest)),
      activeAuthority(targetDigest),
      claim,
      NOW,
    )
    assertNull(VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Missing,
      activeAuthority(targetDigest),
      claim,
      NOW,
    ))
    val wrongOrigin = grant(targetDigest).copy(
      metadata = grant(targetDigest).metadata.copy(environmentOrigin = "https://other.test"),
    )
    assertNull(VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(wrongOrigin),
      activeAuthority(targetDigest),
      claim,
      NOW,
    ))
    assertNull(VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(
        grant("b".repeat(64)),
      ),
      activeAuthority(targetDigest),
      claim,
      NOW,
    ))
    assertNull(VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(grant(targetDigest)),
      activeAuthority(targetDigest, targetId = "project-2/thread-1"),
      claim,
      NOW,
    ))
    val expired = grant(targetDigest).copy(
      metadata = grant(targetDigest).metadata.copy(expiresAtEpochMillis = NOW),
    )
    assertNull(VoiceRuntimeThreadAuthorityPolicy.validatePreparedCancellation(
      T3VoiceRuntimeGrantLoadResult.Available(expired),
      activeAuthority(targetDigest),
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
  private fun activeAuthority(
    targetIdentityDigest: String = DIGEST,
    targetId: String = "project-1/thread-1",
  ) = T3VoicePreparedReadiness(
    readiness().copy(targetId = targetId), "runtime-1", "https://example.test",
    T3VoiceRuntimeGrantOperation.THREAD_TURN_START, targetIdentityDigest,
  )
  private fun claim() = VoiceRuntimeThreadClaim(
    runtimeId = "runtime-1",
    runtimeInstanceId = "instance-1",
    readinessGeneration = 4,
    modeSessionId = "mode-1",
    environmentOrigin = "https://example.test",
    projectId = "project-1",
    threadId = "thread-1",
    clientOperationId = "client-1",
    submissionPolicy = "auto-submit",
    speechPlanId = "speech-1",
    draftContext = null,
  )
  private fun snapshot(phase: String, last: Long, ack: Long, dispatched: Boolean) =
    VoiceRuntimeThreadTurnSnapshot(
      operationId = "operation-1", runtimeId = "runtime-1", generation = 4,
      runtimeInstanceId = "instance-1", modeSessionId = "mode-1",
      turnClientOperationId = "client-operation-1", submissionPolicy = "auto-submit",
      speechPlanId = "speech-1", projectId = "project-1", threadId = "thread-1",
      speechPreset = "default", autoRearm = true, phase = phase, messageId = "message-1",
      turnId = "turn-1", assistantMessageIds = emptyList(), highestAdvertisedSegment = null,
      highestStartedSegment = null, highestDrainedSegment = null, segmentDispositions = emptyList(),
      lastSequence = last, acknowledgedSequence = ack, speechTerminal = null,
      dispatchAccepted = dispatched, detachedAtEpochMillis = null,
      operationTokenExpiresAtEpochMillis = NOW + 40_000,
      retentionExpiresAtEpochMillis = NOW + 50_000,
    )
  private fun createResult(snapshot: VoiceRuntimeThreadTurnSnapshot) =
    VoiceRuntimeThreadTurnCreateResult(snapshot)
  private fun terminalSnapshot(
    summary: VoiceRuntimeTerminalSummary,
    noSpeech: Boolean,
  ) = VoiceRuntimeExecutionSnapshot(
    runtimeId = "runtime-1", readinessGeneration = 4, mode = VoiceRuntimeExecutionMode.THREAD,
    phase = when (summary) {
      VoiceRuntimeTerminalSummary.COMPLETED -> VoiceRuntimePhase.PLAYBACK_DRAINED
      VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED -> VoiceRuntimePhase.ATTENTION_REQUIRED
      else -> VoiceRuntimePhase.FAILED
    },
    operationId = "operation-1", operationGeneration = 4,
    dispatchAcknowledged = true, eventCursor = 7,
    speechTerminal = noSpeech, noSpeech = noSpeech, responseTerminal = true,
    autoRearm = true, terminalSummary = summary,
  )

  private fun serverEvent(
    sequence: Long,
    phase: VoiceRuntimeServerPhase,
    speechTerminal: Boolean = false,
    noSpeech: Boolean = false,
  ) = VoiceRuntimeExecutionEvent.ServerEvent(
    operationId = "operation-1",
    operationGeneration = 4,
    sequence = sequence,
    phase = phase,
    dispatchAcknowledged = true,
    speechTerminal = speechTerminal,
    noSpeech = noSpeech,
  )

  private class FakeCall : VoiceRuntimeThreadCall<Unit> {
    var cancelled = false
    override fun execute() = VoiceRuntimeThreadTurnResult.Success(Unit)
    override fun cancel() { cancelled = true }
  }
  companion object {
    const val NOW = 1_800_000_000_000L
    val DIGEST = "a".repeat(64)
  }
}
