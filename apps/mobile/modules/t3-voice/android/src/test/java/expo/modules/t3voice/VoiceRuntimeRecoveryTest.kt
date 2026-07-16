package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeRecoveryTest {
  @Test fun row1CanonicalDisabledWritesTransientReadiness() {
    val canonical = authority(enabled = false)
    val plan = plan(LoadedState(
      readinessConfig = readiness(enabled = true, generation = 1),
      canonicalAuthority = VoiceRuntimeAuthorityLoadResult.Available(canonical),
    ))
    assertTrue(plan.effects.any { it is VoiceRuntimeRecoveryEffect.WriteReadiness })
    assertEquals(canonical.generation, plan.readinessConfig.generation)
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
      VoiceRuntimeRecoveryEffect.WriteReadiness(readiness(enabled = false, generation = 9)),
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
    val write = plan.effects.indexOfFirst {
      it is VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation
    }
    assertTrue(write >= 0)
    assertEquals(VoiceRuntimeRecoveryEffect.DiscardInitialPreparation, plan.effects[write + 1])
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
    assertTrue(plan.effects.first() is VoiceRuntimeRecoveryEffect.Diagnostic)
    assertTrue(plan.realtimeInstall is VoiceRuntimeRealtimeInstallPlan.None)
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
