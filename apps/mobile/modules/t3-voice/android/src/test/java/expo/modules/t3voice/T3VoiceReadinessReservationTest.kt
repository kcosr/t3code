package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceReadinessReservationTest {
  @Test
  fun `same desired readiness reuses generation and persisted runtime identity`() {
    val desired = desiredReadiness(targetId = "conversation-1")
    val first =
      T3VoiceReadinessReservationPolicy.reserve(
        current = T3VoiceReadinessConfig(generation = 4),
        prepared = null,
        desired = desired,
        proposedRuntimeId = "runtime-first",
      )
    val retried =
      T3VoiceReadinessReservationPolicy.reserve(
        current = first.config,
        prepared =
          first.copy(
            config =
              first.config.copy(
                enabled = true,
                microphonePermissionGranted = false,
                notificationPermissionGranted = false,
              ),
          ),
        desired = desired,
        proposedRuntimeId = "runtime-ignored",
      )

    assertEquals(5, retried.config.generation)
    assertEquals("runtime-first", retried.runtimeId)
    assertFalse(retried.config.enabled)
    assertTrue(retried.config.microphonePermissionGranted)
    assertTrue(retried.config.notificationPermissionGranted)
  }

  @Test
  fun `changed target reserves a new generation`() {
    val first =
      T3VoicePreparedReadiness(
        desiredReadiness("conversation-1").copy(generation = 5),
        "runtime-stable",
      )
    val replacement =
      T3VoiceReadinessReservationPolicy.reserve(
        current = first.config.copy(enabled = false),
        prepared = first,
        desired = desiredReadiness("conversation-2"),
        proposedRuntimeId = "runtime-stable",
      )

    assertEquals(6, replacement.config.generation)
    assertEquals("runtime-stable", replacement.runtimeId)
  }

  @Test
  fun `activation requires exact desired payload and generation`() {
    val desired = desiredReadiness("conversation-1")
    val prepared = T3VoicePreparedReadiness(desired.copy(generation = 5), "runtime-1")
    val activated =
      T3VoiceReadinessReservationPolicy.requireActivation(
        locked = prepared.config.copy(enabled = false),
        prepared = prepared,
        desired = desired,
        expectedGeneration = 5,
      )

    assertTrue(activated.enabled)
    assertEquals(5, activated.generation)
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceReadinessReservationPolicy.requireActivation(
        locked = prepared.config.copy(enabled = false),
        prepared = prepared,
        desired = desiredReadiness("conversation-2"),
        expectedGeneration = 5,
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceReadinessReservationPolicy.requireActivation(
        locked = prepared.config.copy(enabled = false),
        prepared = prepared,
        desired = desired,
        expectedGeneration = 6,
      )
    }
  }

  private fun desiredReadiness(targetId: String) =
    T3VoiceReadinessConfig(
      enabled = true,
      mode = T3VoiceReadinessMode.REALTIME,
      targetId = targetId,
      notificationPermissionGranted = true,
      microphonePermissionGranted = true,
    )
}
