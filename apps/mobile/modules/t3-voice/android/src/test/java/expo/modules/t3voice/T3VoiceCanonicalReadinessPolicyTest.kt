package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceCanonicalReadinessPolicyTest {
  @Test
  fun `configure synthesis enables current verified readiness at payload generation`() {
    val current = readiness(enabled = false, generation = 3)

    val result = T3VoiceConfigureReadinessPolicy.synthesize(current, 7, enabled = true)

    assertTrue(result.enabled)
    assertEquals(7, result.generation)
    assertEquals(current.copy(enabled = true, generation = 7), result)
  }

  @Test
  fun `configure synthesis disables current verified readiness at payload generation`() {
    val current = readiness(enabled = true, generation = 3)

    val result = T3VoiceConfigureReadinessPolicy.synthesize(current, 8, enabled = false)

    assertFalse(result.enabled)
    assertEquals(8, result.generation)
    assertEquals(current.copy(enabled = false, generation = 8), result)
  }

  @Test
  fun `startup preparation selects matching persistent fence`() {
    val prepared = T3VoicePreparedReadiness(
      readiness(enabled = true, generation = 7),
      "runtime-1",
      "https://termstation",
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      "digest-1",
    )

    val fence = T3VoiceStartupAuthorityFencePolicy.persistentPreparation(prepared)
    assertEquals(T3VoiceStartupAuthorityFence("runtime-1", 6), fence)
    assertEquals(
      fence,
      T3VoiceStartupAuthorityFencePolicy.selectPreparation(fence, null),
    )
  }

  @Test
  fun `startup resolution discards preparation when recovered runtime conflicts`() {
    val result = T3VoiceStartupAuthorityFencePolicy.resolve(
      T3VoiceStartupAuthorityFence("runtime-1", 6),
      T3VoiceRecoveredAuthorityFence("runtime-2", 9),
    )

    assertNull(result.preparation)
    assertEquals("runtime-2", result.runtimeId)
    assertEquals(9L, result.initialGeneration)
    assertTrue(result.discardPreparation)
  }

  @Test
  fun `disabled parent remains until matching idle terminal fence`() {
    val authority = authority(readinessEnabled = false)
    assertFalse(T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      authority,
      T3VoiceDisabledAuthorityFence(authority.runtimeId, authority.generation),
      canonicalIdle = false,
    ))
    assertTrue(T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      authority,
      T3VoiceDisabledAuthorityFence(authority.runtimeId, authority.generation),
      canonicalIdle = true,
    ))
  }

  @Test
  fun `disabled cleanup preserves storage if controller clear fails`() {
    var authorityCleared = false
    var engineCleared = false
    val completed = T3VoiceDisabledTerminalCleanupCoordinator.run(
      canonicalIdle = true,
      clearController = { false },
      clearAuthority = { authorityCleared = true },
      clearEngine = { engineCleared = true },
    )

    assertFalse(completed)
    assertFalse(authorityCleared)
    assertFalse(engineCleared)
  }

  private fun readiness(enabled: Boolean, generation: Long) = T3VoiceReadinessConfig(
    enabled = enabled,
    mode = T3VoiceReadinessMode.THREAD,
    targetId = "project-1/thread-1",
    audioRouteId = "system",
    autoRearm = true,
    microphonePermissionGranted = true,
    notificationPermissionGranted = true,
    generation = generation,
  )

  private fun authority(readinessEnabled: Boolean) = VoiceRuntimePersistedAuthority(
    "runtime-1",
    7,
    T3VoiceRuntimeTargetIdentity.digest(
      VoiceRuntimeBridge.canonicalThreadTargetIdentity(threadTarget()),
    ),
    threadTarget(),
    "https://termstation",
    readinessEnabled,
  )

  private fun threadTarget() = VoiceRuntimeTarget.Thread(
    "environment-1", "project-1", "thread-1", "default", true,
    2_200, 60_000, 600_000, true, 500,
  )
}
