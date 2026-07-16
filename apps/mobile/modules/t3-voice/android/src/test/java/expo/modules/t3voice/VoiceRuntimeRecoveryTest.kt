package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeRecoveryTest {
  @Test fun row1CanonicalDisabledWritesTransientReadiness() {
    val canonical = authority(enabled = false)
    val loadedReadiness = readiness(enabled = true, generation = 1).copy(
      mode = T3VoiceReadinessMode.REALTIME,
      targetId = "old-target",
      audioRouteId = "headset",
      autoRearm = true,
    )
    val plan = plan(LoadedState(
      readinessConfig = loadedReadiness,
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(canonical),
    ))
    val expected = loadedReadiness.copy(
      enabled = false,
      mode = T3VoiceReadinessMode.THREAD,
      targetId = "project/thread",
      generation = canonical.generation,
    )
    assertEquals(
      VoiceRuntimeRecoveryEffect.WriteReadiness(expected),
      plan.effects.first(),
    )
    assertEquals(expected, plan.readinessConfig)
  }

  @Test fun transientCanonicalDoesNotRequireUnreadPersistentReadiness() {
    val canonical = authority(enabled = false)
    val checkpoint = checkpoint().copy(
      fence = VoiceRuntimeRealtimeFence(
        VoiceRuntimeIdentity("checkpoint-runtime", "old", 3),
        "mode",
      ),
    )
    val plan = plan(LoadedState(
      readinessConfig = readiness(enabled = true, generation = 1),
      attachedPreparation = attached(runtimeId = "attached", generation = 7),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(canonical),
      persistentReadinessRead = false,
      realtimeCheckpoint = checkpoint,
      retiredAuthorityFence = VoiceRuntimeRetiredAuthorityFence("retired-runtime", 8),
    ))
    assertEquals(canonical.runtimeId, plan.installedRuntimeId)
    assertNull(plan.initialGeneration)
    assertNull(plan.canonicalPreparedAuthority)
    assertTrue(plan.effects.any {
      it is VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation
    })
    assertTrue(plan.effects.any {
      it is VoiceRuntimeRecoveryEffect.DiscardInitialPreparation
    })
  }

  @Test fun row2MismatchClearsAuthorityAndUsesPostWipeFenceViews() {
    val plan = plan(LoadedState(
      readinessConfig = readiness(enabled = true, generation = 9),
      preparedReadiness = prepared(runtimeId = "other", generation = 9),
      activeAuthority = prepared(runtimeId = "other", generation = 9),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
    ))
    assertEquals(listOf(
      VoiceRuntimeRecoveryEffect.ClearAuthority("startup-reconciliation-clear-authority"),
      VoiceRuntimeRecoveryEffect.WriteReadiness(
        readiness(enabled = false, generation = 9),
        bestEffort = true,
      ),
    ), plan.effects.take(2))
    assertFalse(plan.effects.any { it is VoiceRuntimeRecoveryEffect.Diagnostic })
    assertNull(plan.installedRuntimeId)
  }

  @Test fun row3PersistentPreparationSurvivesAsFenceWithoutMaterialization() {
    val prepared = prepared(generation = 4)
    val baseReadiness = readiness(enabled = false, generation = 2)
    val plan = plan(LoadedState(
      readinessConfig = baseReadiness,
      preparedReadiness = prepared,
    ))
    assertNull(plan.canonicalPreparedAuthority)
    assertEquals(3L, plan.initialGeneration)
    assertEquals(baseReadiness, plan.readinessConfig)
    assertFalse(plan.effects.any { it is VoiceRuntimeRecoveryEffect.WriteReadiness })
  }

  @Test fun row4ConflictingFenceDiscardsPreparationInOrder() {
    val prepared = prepared(runtimeId = "prepared", generation = 4)
    val plan = plan(LoadedState(
      readinessConfig = prepared.config,
      preparedReadiness = prepared,
      retiredAuthorityFence = VoiceRuntimeRetiredAuthorityFence("recovered", 8),
    ))
    val expectedPending = T3VoicePendingRuntimeRevocation(
      prepared.runtimeId,
      prepared.environmentOrigin,
    )
    val writeEffect = plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation
      >().single()
    assertEquals(expectedPending, writeEffect.pending)
    assertEquals(8L, writeEffect.config.generation)
    val write = plan.effects.indexOf(writeEffect)
    assertTrue(write >= 0)
    assertEquals(VoiceRuntimeRecoveryEffect.DiscardInitialPreparation, plan.effects[write + 1])
    assertEquals(
      VoiceRuntimeRecoveryEffect.Diagnostic(
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
        0,
      ),
      plan.effects[write + 2],
    )
  }

  @Test fun row5FallbackUsesWidenedInputsAndGatesUnrelatedReadinessGeneration() {
    val attached = attached(runtimeId = "prepared", generation = 7)
    val loaded = LoadedState(
      readinessConfig = readiness(enabled = true, generation = 7),
      attachedPreparation = attached,
      retiredAuthorityFence = VoiceRuntimeRetiredAuthorityFence("recovered", 2),
      persistentReadinessRead = false,
    )
    val plan = plan(loaded)
    val disabled = plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation
      >().single()
    assertEquals("recovered", plan.installedRuntimeId)
    assertEquals(2L, disabled.config.generation)
    assertEquals(2L, plan.initialGeneration)
  }

  @Test fun row6RestoreCarriesLoadedOperationAfterReady() {
    assertReconcileOrdering(active(recording = null))
  }

  @Test fun row7PreparedCancellationCarriesLoadedOperationAfterReady() {
    assertReconcileOrdering(VoiceRuntimeThreadOperationState.Prepared(claim()))
  }

  @Test fun row8RevokeIsDeferredAndMissingGrantPinsRevoke() {
    val loaded = VoiceRuntimeThreadOperationLoadResult.Available(
      VoiceRuntimeThreadOperationState.Prepared(claim()),
    )
    val plan = plan(LoadedState(readinessConfig = readiness(), threadOperation = loaded))
    assertFalse(VoiceRuntimeThreadStoredStatePolicy.parentGrantAvailable(null, loaded))
    assertEquals(
      VoiceRuntimeThreadStoredStateDecision.REVOKE,
      VoiceRuntimeThreadStoredStatePolicy.decide(loaded, false, 0),
    )
    assertEquals(loaded, plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.ReconcileThreadOperation
      >().single().loaded)
    assertFalse(plan.effects.any {
      it is VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation ||
        it is VoiceRuntimeRecoveryEffect.ClearLockedAfterAuthorityRevocation
    })
  }

  @Test fun row9CompletedRecordingRestoresBeforeSweep() {
    val recording = recording()
    val effects = plan(LoadedState(
      readinessConfig = readiness(),
      threadOperation = VoiceRuntimeThreadOperationLoadResult.Available(active(recording)),
    )).effects
    assertBefore<VoiceRuntimeRecoveryEffect.RestoreCompletedRecording,
      VoiceRuntimeRecoveryEffect.SweepStaleCache>(effects)
  }

  @Test fun row10FailedRecordingRestoreDetachesActiveClaim() {
    val plan = plan(LoadedState(
      readinessConfig = readiness(),
      threadOperation = VoiceRuntimeThreadOperationLoadResult.Available(active(recording())),
      threadRecordingRestored = false,
    ))
    val detached = plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.DetachActiveThread
      >().single().state
    assertNull(detached.recording)
    assertTrue(detached.detached)
    assertTrue(detached.cancelRequested)
  }

  @Test fun row11CheckpointChoosesRecoveredInstallOverCanonical() {
    val checkpoint = checkpoint()
    val plan = plan(LoadedState(
      readinessConfig = readiness(enabled = true, generation = 3),
      activeAuthority = prepared(generation = 3),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      realtimeCheckpoint = checkpoint,
    ))
    val install = plan.effects.filterIsInstance<VoiceRuntimeRecoveryEffect.InstallRealtime>().single()
    assertEquals(VoiceRuntimeRealtimeInstallPlan.Recovered(null, checkpoint), install.plan)
    assertFalse(plan.effects.any {
      (it as? VoiceRuntimeRecoveryEffect.InstallRealtime)?.plan is
        VoiceRuntimeRealtimeInstallPlan.Canonical
    })
  }

  @Test fun row12FinalizationChoosesRecoveredInstall() {
    val finalization = finalization()
    val plan = plan(LoadedState(
      readinessConfig = readiness(),
      realtimeFinalization = finalization,
    ))
    assertEquals(
      VoiceRuntimeRealtimeInstallPlan.Recovered(finalization, null),
      plan.realtimeInstall,
    )
  }

  @Test fun row13PostCutoverSnapshotIsThreadedIntoSeed() {
    val snapshot = VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime",
      readinessGeneration = 3,
      mode = VoiceRuntimeExecutionMode.THREAD,
      phase = VoiceRuntimePhase.IDLE,
    )
    assertEquals(snapshot, plan(LoadedState(
      readinessConfig = readiness(),
      runtimeSnapshot = snapshot,
    )).runtimeSnapshot)
  }

  @Test fun row14LockedAuthorityConvergesWithoutCanonicalInstall() {
    val plan = plan(LoadedState(
      readinessConfig = readiness(),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Locked,
    ))
    assertTrue(plan.realtimeInstall is VoiceRuntimeRealtimeInstallPlan.None)
    assertFalse(plan.effects.any { it is VoiceRuntimeRecoveryEffect.ConfigureCanonicalAuthority })
  }

  @Test fun row15CheckpointCorruptionEmitsDiagnosticWithoutInstall() {
    val plan = plan(LoadedState(
      readinessConfig = readiness(),
      checkpointRead = false,
    ))
    assertEquals(
      VoiceRuntimeRecoveryEffect.Diagnostic(
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
        0,
      ),
      plan.effects.first(),
    )
    assertTrue(plan.realtimeInstall is VoiceRuntimeRealtimeInstallPlan.None)
  }

  @Test fun installedCanonicalDropsStalePreparedViewBeforeDiscardMath() {
    val active = prepared(generation = 3)
    val plan = plan(LoadedState(
      readinessConfig = active.config,
      preparedReadiness = prepared(runtimeId = "stale", generation = 7),
      activeAuthority = active,
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      retiredAuthorityFence = VoiceRuntimeRetiredAuthorityFence("retired", 8),
    ))
    val disabled = plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation
      >().single()
    assertNull(disabled.pending)
    assertEquals(8L, disabled.config.generation)
    assertEquals("runtime", plan.installedRuntimeId)
  }

  @Test fun failedEnabledReadinessReadTakesReconcileFailurePath() {
    val current = prepared(generation = 3)
    val plan = plan(LoadedState(
      readinessConfig = current.config,
      activeAuthority = current,
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      persistentReadinessRead = false,
    ))
    assertEquals(listOf(
      VoiceRuntimeRecoveryEffect.ClearAuthority("startup-reconciliation-clear-authority"),
      VoiceRuntimeRecoveryEffect.WriteReadiness(
        current.config.copy(enabled = false),
        bestEffort = true,
      ),
    ), plan.effects.take(2))
    assertNull(plan.installedRuntimeId)
    assertEquals(3L, plan.initialGeneration)
    assertFalse(plan.readinessConfig.enabled)
  }

  @Test fun onlyReconcileFailureReadinessWriteIsBestEffort() {
    val transient = plan(LoadedState(
      readinessConfig = readiness(enabled = true),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority(enabled = false)),
    ))
    val attached = plan(LoadedState(
      readinessConfig = readiness(),
      attachedPreparation = attached(runtimeId = "runtime", generation = 4),
    ))
    val failure = plan(LoadedState(
      readinessConfig = readiness(enabled = true),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      persistentReadinessRead = false,
    ))
    assertFalse(transient.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteReadiness
      >().single().bestEffort)
    assertFalse(attached.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteReadiness
      >().single().bestEffort)
    assertTrue(failure.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.WriteReadiness
      >().single().bestEffort)
  }

  @Test fun attachedPreparationWritesVerifiedReadinessAndSeedsPreparedAuthority() {
    val attached = attached(runtimeId = "runtime", generation = 4)
    val plan = recover(
      LoadedState(
        readinessConfig = readiness(),
        attachedPreparation = attached,
      ),
      Permissions(microphoneGranted = false, notificationGranted = true),
      Clock { 42 },
    )
    val verified = attached.readiness.copy(microphonePermissionGranted = false)
    assertEquals(
      VoiceRuntimeRecoveryEffect.WriteReadiness(verified),
      plan.effects.first(),
    )
    assertEquals(verified, plan.readinessConfig)
    assertEquals(
      T3VoicePreparedReadiness(
        verified,
        attached.fence.runtimeId,
        attached.fence.environmentOrigin,
        attached.fence.target.grantOperation(),
        attached.fence.targetDigest,
      ),
      plan.canonicalPreparedAuthority,
    )
  }

  @Test fun playingSnapshotAndActiveOperationRemainDataOnly() {
    val snapshot = playingSnapshot()
    val operation = active(recording = null).copy(snapshot = snapshot)
    val loaded = VoiceRuntimeThreadOperationLoadResult.Available(operation)
    val plan = plan(LoadedState(
      readinessConfig = readiness(),
      runtimeSnapshot = snapshot,
      threadOperation = loaded,
    ))
    assertEquals(snapshot, plan.runtimeSnapshot)
    assertEquals(
      loaded,
      plan.effects.filterIsInstance<
        VoiceRuntimeRecoveryEffect.ReconcileThreadOperation
        >().single().loaded,
    )
    assertFalse(plan.effects.any { it::class.java.simpleName.contains("RestoreProcess") })
  }

  @Test fun recoveredRecordingAndCanonicalOrderingInvariantsArePinned() {
    val plan = plan(LoadedState(
      readinessConfig = readiness(enabled = true, generation = 3),
      activeAuthority = prepared(generation = 3),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      realtimeCheckpoint = checkpoint(),
      threadOperation = VoiceRuntimeThreadOperationLoadResult.Available(active(recording())),
    ))
    assertBefore<VoiceRuntimeRecoveryEffect.ConfigureCanonicalAuthority,
      VoiceRuntimeRecoveryEffect.InstallRealtime>(plan.effects)
    assertBefore<VoiceRuntimeRecoveryEffect.ConfigureCanonicalAuthority,
      VoiceRuntimeRecoveryEffect.ReconcileThreadOperation>(plan.effects)
    assertBefore<VoiceRuntimeRecoveryEffect.SetServiceReady,
      VoiceRuntimeRecoveryEffect.ReconcileThreadOperation>(plan.effects)
    assertBefore<VoiceRuntimeRecoveryEffect.RestoreCompletedRecording,
      VoiceRuntimeRecoveryEffect.SweepStaleCache>(plan.effects)
  }

  @Test fun lockedRevocationSelectionUsesFreshGrantOrResetsSnapshot() {
    val grant = authority()
    assertEquals(
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.Disable(
        T3VoicePendingRuntimeRevocation(grant.runtimeId, grant.environmentOrigin),
      ),
      VoiceRuntimeThreadStoredStatePolicy.selectRevocation(
        VoiceRuntimeThreadOperationLoadResult.Locked, null, null, grant,
      ),
    )
    assertEquals(
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.ClearLocked,
      VoiceRuntimeThreadStoredStatePolicy.selectRevocation(
        VoiceRuntimeThreadOperationLoadResult.Locked, null, null, null,
      ),
    )
  }

  @Test fun promotePersistsCommittedConfigButSeedsPermissionOverlay() {
    val committed = prepared(generation = 3).copy(
      config = readiness(enabled = true, generation = 3).copy(
        microphonePermissionGranted = true,
      ),
    )
    val plan = recover(
      LoadedState(
        readinessConfig = committed.config,
        preparedReadiness = committed,
        canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(authority()),
      ),
      Permissions(microphoneGranted = false, notificationGranted = true),
      Clock { 42 },
    )
    assertEquals(
      committed.config,
      plan.effects.filterIsInstance<
        VoiceRuntimeRecoveryEffect.WriteActivatedReadiness
        >().single().config,
    )
    assertFalse(plan.readinessConfig.microphonePermissionGranted)
  }

  private fun assertReconcileOrdering(state: VoiceRuntimeThreadOperationState) {
    val loaded = VoiceRuntimeThreadOperationLoadResult.Available(state)
    val plan = plan(LoadedState(readinessConfig = readiness(), threadOperation = loaded))
    assertEquals(loaded, plan.effects.filterIsInstance<
      VoiceRuntimeRecoveryEffect.ReconcileThreadOperation
      >().single().loaded)
    assertBefore<VoiceRuntimeRecoveryEffect.SetServiceReady,
      VoiceRuntimeRecoveryEffect.ReconcileThreadOperation>(plan.effects)
  }

  private inline fun <reified A : VoiceRuntimeRecoveryEffect,
    reified B : VoiceRuntimeRecoveryEffect> assertBefore(
    effects: List<VoiceRuntimeRecoveryEffect>,
  ) {
    val first = effects.indexOfFirst { it is A }
    val second = effects.indexOfFirst { it is B }
    assertTrue("${A::class.java.simpleName} must precede ${B::class.java.simpleName}",
      first >= 0 && second > first)
  }

  private fun plan(loaded: LoadedState) = recover(
    loaded,
    Permissions(microphoneGranted = true, notificationGranted = true),
    Clock { 42 },
  )

  private fun readiness(enabled: Boolean = false, generation: Long = 0) =
    T3VoiceReadinessConfig(
      enabled = enabled,
      microphonePermissionGranted = true,
      notificationPermissionGranted = true,
      generation = generation,
    )

  private fun prepared(runtimeId: String = "runtime", generation: Long = 3) =
    T3VoicePreparedReadiness(
      readiness(enabled = true, generation = generation),
      runtimeId,
      "https://example.test",
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      "digest",
    )

  private fun attached(runtimeId: String, generation: Long) =
    VoiceRuntimePreparedAttachedAuthority(
      VoiceRuntimeAuthorityFence(
        runtimeId,
        generation,
        "digest",
        threadTarget(),
        "https://example.test",
      ),
      readiness(enabled = true, generation = generation),
    )

  private fun authority(enabled: Boolean = true) = VoiceRuntimePersistedAuthority(
    runtimeId = "runtime",
    generation = 3,
    targetDigest = "digest",
    target = threadTarget(),
    environmentOrigin = "https://example.test",
    readinessEnabled = enabled,
  )

  private fun threadTarget() = VoiceRuntimeTarget.Thread(
    environmentId = "environment",
    projectId = "project",
    threadId = "thread",
    speechPreset = "default",
    autoRearm = false,
    endSilenceMs = 1,
    noSpeechTimeoutMs = null,
    maximumUtteranceMs = 1,
    speechEnabled = true,
    rearmGuardMs = 1,
  )

  private fun claim() = VoiceRuntimeThreadClaim(
    runtimeId = "runtime",
    runtimeInstanceId = "instance",
    readinessGeneration = 3,
    modeSessionId = "mode",
    environmentOrigin = "https://example.test",
    projectId = "project",
    threadId = "thread",
    clientOperationId = "client-op",
    submissionPolicy = "auto-submit",
    speechPlanId = "speech",
    draftContext = null,
  )

  private fun active(recording: T3VoiceRecordingResult?) =
    VoiceRuntimeThreadOperationState.Active(
      claim = claim(),
      operationId = "operation",
      expiresAtEpochMillis = 10_000,
      acknowledgedCursor = 0,
      recording = recording,
      snapshot = VoiceRuntimeExecutionSnapshot(),
    )

  private fun recording() = T3VoiceRecordingResult("recording", "file:///recording", 1, 1)

  private fun playingSnapshot() = VoiceRuntimeExecutionSnapshot(
    runtimeId = "runtime",
    readinessGeneration = 3,
    mode = VoiceRuntimeExecutionMode.THREAD,
    phase = VoiceRuntimePhase.PLAYING,
    operationId = "operation",
    operationGeneration = 3,
    dispatchAcknowledged = true,
    eventCursor = 1,
    highestAdvertisedSpeechSegment = 0,
    finalSpeechSegment = 0,
    speechTerminal = true,
  )

  private fun checkpoint() = VoiceRuntimeRealtimeCheckpoint(
    fence = VoiceRuntimeRealtimeFence(VoiceRuntimeIdentity("runtime", "old", 3), "mode"),
    target = VoiceRuntimeTarget.Realtime("environment", "conversation"),
    rootCommandId = "root",
    phase = VoiceRealtimePhase.CONNECTED,
    serverSessionId = "session",
    leaseGeneration = 1,
    expiresAtEpochMillis = 10_000,
    heartbeatIntervalSeconds = 5,
  )

  private fun finalization(): VoiceRuntimeRealtimeFinalization {
    val checkpoint = checkpoint()
    return VoiceRuntimeRealtimeFinalization(
      fence = checkpoint.fence,
      sourceTarget = checkpoint.target,
      sourceEnvironmentOrigin = "https://example.test",
      rootCommandId = checkpoint.rootCommandId,
      session = VoiceRuntimeRealtimeStartResult(
        VoiceRuntimeRealtimeSessionState("session", "conversation", "signaling", 1, 0),
        "/offer",
        10_000,
        5,
      ),
      closeOperationId = "close",
      outcome = VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
      reason = "process-restarted",
      lastConnectedAtEpochMillis = 1,
      handoffExchange = null,
      stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
    )
  }
}
