package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceCanonicalReadinessPolicyTest {
  @Test
  fun `transient off authority can be replaced by persistent on authority`() {
    val transient = T3VoiceCanonicalReadinessPolicy.transient(
      T3VoiceReadinessConfig(generation = 0),
      authority(
        generation = 1,
        readinessEnabled = false,
        target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
      ),
    )

    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        "runtime-1",
        1,
        transient.generation,
        listOf("runtime-1" to 1),
        nativeVoiceActive = false,
      ),
    )
    val persistent = T3VoiceReadinessReservationPolicy.reserve(
      transient,
      prepared = null,
      desired = transient.copy(enabled = true),
      proposedRuntimeId = "runtime-2",
      environmentOrigin = "https://environment.example.test",
      operation = T3VoiceRuntimeGrantOperation.REALTIME_START,
      targetIdentityDigest = "b".repeat(64),
    )
    assertEquals(2L, persistent.config.generation)
  }

  @Test
  fun `persistent on authority clears readiness without inventing a generation`() {
    val enabled = T3VoiceReadinessConfig(
      enabled = true,
      mode = T3VoiceReadinessMode.THREAD,
      targetId = "project-1/thread-1",
      generation = 9,
    )

    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(enabled, canonicalGeneration = 9)

    assertFalse(disabled.enabled)
    assertEquals(9L, disabled.generation)
    assertEquals(enabled.mode, disabled.mode)
    assertEquals(enabled.targetId, disabled.targetId)
  }

  @Test
  fun `transient restart restores canonical readiness before enabling controls`() {
    val authority = authority(
      generation = 7,
      readinessEnabled = false,
      target = threadTarget(),
    )
    val restored = T3VoiceCanonicalReadinessPolicy.transient(
      T3VoiceReadinessConfig(
        enabled = true,
        mode = T3VoiceReadinessMode.REALTIME,
        targetId = "stale-conversation",
        generation = 2,
      ),
      authority,
    )

    assertFalse(restored.enabled)
    assertEquals(T3VoiceReadinessMode.THREAD, restored.mode)
    assertEquals("project-1/thread-1", restored.targetId)
    assertEquals(7L, restored.generation)
    val ownershipFence = requireNotNull(
      T3VoiceRuntimeOwnershipPolicy.canonicalFence(
        restored,
        activeReadiness = null,
        persistedAuthority = authority,
      ),
    )
    assertEquals(
      T3VoiceRuntimeOwnershipFence(
        "runtime-1",
        7,
        "https://environment.example.test",
      ),
      ownershipFence,
    )
    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        ownershipFence.runtimeId,
        ownershipFence.generation,
        restored.generation,
        listOf("runtime-1" to 7),
        nativeVoiceActive = false,
      ),
    )
    val persistent = T3VoiceReadinessReservationPolicy.reserve(
      restored,
      prepared = null,
      desired = restored.copy(enabled = true),
      proposedRuntimeId = "runtime-2",
      environmentOrigin = "https://environment.example.test",
      operation = T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      targetIdentityDigest = "b".repeat(64),
    )
    assertEquals(8L, persistent.config.generation)
  }

  private fun authority(
    generation: Long,
    readinessEnabled: Boolean,
    target: VoiceRuntimeTarget,
  ) = VoiceRuntimePersistedAuthority(
    runtimeId = "runtime-1",
    generation = generation,
    provisioningOperationId = "provision-1",
    targetDigest = "a".repeat(64),
    target = target,
    environmentOrigin = "https://environment.example.test",
    readinessEnabled = readinessEnabled,
    token = "runtime-token",
    issuedAtEpochMillis = 1,
    expiresAtEpochMillis = 10_000,
  )

  private fun threadTarget() = VoiceRuntimeTarget.Thread(
    environmentId = "environment-1",
    projectId = "project-1",
    threadId = "thread-1",
    speechPreset = "default",
    autoRearm = false,
    endSilenceMs = 2_200,
    noSpeechTimeoutMs = null,
    maximumUtteranceMs = 600_000,
    speechEnabled = true,
    rearmGuardMs = 0,
  )
}
