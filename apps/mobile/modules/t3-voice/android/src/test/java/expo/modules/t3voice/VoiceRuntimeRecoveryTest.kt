package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeRecoveryTest {
  @Test
  fun missingGrantRevokesPreparedClaim() {
    val loaded = VoiceRuntimeThreadOperationLoadResult.Available(
      VoiceRuntimeThreadOperationState.Prepared(claim()),
    )
    assertFalse(VoiceRuntimeThreadStoredStatePolicy.parentGrantAvailable(null, loaded))
    assertEquals(
      VoiceRuntimeThreadStoredStateDecision.REVOKE,
      VoiceRuntimeThreadStoredStatePolicy.decide(loaded, false, 0),
    )
  }

  @Test
  fun lockedRevocationUsesFreshGrantWhenOtherViewsAreMissing() {
    val grant = authority()
    assertEquals(
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.Disable(
        T3VoicePendingRuntimeRevocation(grant.runtimeId, grant.environmentOrigin),
      ),
      VoiceRuntimeThreadStoredStatePolicy.selectRevocation(
        VoiceRuntimeThreadOperationLoadResult.Locked,
        null,
        null,
        grant,
      ),
    )
    assertEquals(
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.ClearLocked,
      VoiceRuntimeThreadStoredStatePolicy.selectRevocation(
        VoiceRuntimeThreadOperationLoadResult.Locked,
        null,
        null,
        null,
      ),
    )
  }

  @Test
  fun basePlanPinsKernelOrdering() {
    val plan = recover(
      LoadedState(readinessConfig = T3VoiceReadinessConfig()),
      Permissions(microphoneGranted = true, notificationGranted = true),
      Clock { 42 },
    )
    val effects = plan.effects
    assertTrue(effects.indexOfFirst { it is VoiceRuntimeRecoveryEffect.SweepStaleCache } >
      effects.indexOfFirst { it is VoiceRuntimeRecoveryEffect.RestoreBridgeCompletions })
    assertTrue(effects.indexOfFirst { it is VoiceRuntimeRecoveryEffect.ReconcileThreadOperation } >
      effects.indexOfFirst { it is VoiceRuntimeRecoveryEffect.SetServiceReady })
  }

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

  private fun authority() = VoiceRuntimePersistedAuthority(
    runtimeId = "runtime",
    generation = 3,
    targetDigest = "digest",
    target = VoiceRuntimeTarget.Thread(
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
    ),
    environmentOrigin = "https://example.test",
    readinessEnabled = true,
  )
}
