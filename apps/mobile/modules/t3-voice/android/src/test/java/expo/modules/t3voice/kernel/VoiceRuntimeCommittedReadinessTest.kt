package expo.modules.t3voice.kernel

import expo.modules.t3voice.store.T3VoiceRuntimeGrantOperation
import expo.modules.t3voice.store.VoiceRuntimePersistedAuthority

import org.junit.Assert.assertEquals
import org.junit.Test

internal class VoiceRuntimeCommittedReadinessTest {
  @Test
  fun `matching prepared readiness is promoted after interrupted install`() {
    assertEquals(
      VoiceRuntimeCommittedReadinessDecision.Promote(readiness()),
      VoiceRuntimeCommittedReadinessPolicy.reconcile(authority(), readiness(), null),
    )
  }

  @Test
  fun `matching active readiness is already converged`() {
    assertEquals(
      VoiceRuntimeCommittedReadinessDecision.Current(readiness()),
      VoiceRuntimeCommittedReadinessPolicy.reconcile(authority(), null, readiness()),
    )
  }

  @Test
  fun `mixed generation target or origin fails closed`() {
    listOf(
      readiness().copy(config = readiness().config.copy(generation = 8)),
      readiness().copy(environmentOrigin = "https://other.example.test"),
      readiness().copy(targetIdentityDigest = "b".repeat(64)),
    ).forEach { candidate ->
      assertEquals(
        VoiceRuntimeCommittedReadinessDecision.Mismatch,
        VoiceRuntimeCommittedReadinessPolicy.reconcile(authority(), candidate, null),
      )
    }
  }

  @Test
  fun `attached only authority does not consume readiness state`() {
    assertEquals(
      VoiceRuntimeCommittedReadinessDecision.NotRequired,
      VoiceRuntimeCommittedReadinessPolicy.reconcile(
        authority().copy(readinessEnabled = false),
        null,
        null,
      ),
    )
  }

  private fun authority() = VoiceRuntimePersistedAuthority(
    runtimeId = "runtime-1",
    generation = 7,
    targetDigest = "a".repeat(64),
    target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    environmentOrigin = "https://environment.example.test",
    readinessEnabled = true,
  )

  private fun readiness() = T3VoicePreparedReadiness(
    config = T3VoiceReadinessConfig(
      enabled = true,
      mode = T3VoiceReadinessMode.REALTIME,
      targetId = "conversation-1",
      generation = 7,
    ),
    runtimeId = "runtime-1",
    environmentOrigin = "https://environment.example.test",
    operation = T3VoiceRuntimeGrantOperation.REALTIME_START,
    targetIdentityDigest = "a".repeat(64),
  )
}
