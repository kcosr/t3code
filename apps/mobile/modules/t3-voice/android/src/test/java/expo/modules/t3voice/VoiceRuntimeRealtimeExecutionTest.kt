package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeExecutionTest {
  @Test
  fun `authority requires exact effective realtime readiness`() {
    val readiness = readiness()
    val grant = grant(readiness)
    val authority =
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.Available(grant),
        EXPECTED_DIGEST,
        NOW,
      )

    assertEquals("runtime-1", authority?.runtimeId)
    assertEquals("conversation-1", authority?.conversationId)
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.Available(grant),
        T3VoiceRuntimeTargetIdentity.digest("realtime:environment:conversation-2"),
        NOW,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness.copy(generation = 8),
        T3VoiceRuntimeGrantLoadResult.Available(grant),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness.copy(mode = T3VoiceReadinessMode.THREAD),
        T3VoiceRuntimeGrantLoadResult.Available(grant),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.TargetReplaced(grant),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
  }

  @Test
  fun `authority rejects expired wrong operation and missing microphone permission`() {
    val readiness = readiness()
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.Available(
          grant(readiness, expiresAt = NOW),
        ),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.Available(
          grant(readiness, operation = T3VoiceRuntimeGrantOperation.THREAD_TURN_START),
        ),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness.copy(microphonePermissionGranted = false),
        T3VoiceRuntimeGrantLoadResult.Available(grant(readiness)),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
  }

  @Test
  fun `started session must retain exact conversation and live bounded leases`() {
    val authority = requireNotNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness(),
        T3VoiceRuntimeGrantLoadResult.Available(grant(readiness())),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    val valid = startResult()
    assertTrue(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(authority, valid, NOW),
    )
    assertFalse(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(
        authority,
        valid.copy(state = valid.state.copy(conversationId = "conversation-2")),
        NOW,
      ),
    )
    assertFalse(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(
        authority,
        valid.copy(controlGrant = valid.controlGrant.copy(expiresAtEpochMillis = NOW)),
        NOW,
      ),
    )
    assertFalse(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(
        authority,
        valid.copy(state = valid.state.copy(phase = "closed")),
        NOW,
      ),
    )
    assertFalse(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(
        authority,
        valid.copy(controlGrant = valid.controlGrant.copy(failureGraceSeconds = 20)),
        NOW,
      ),
    )
    assertFalse(
      VoiceRuntimeRealtimeAuthorityPolicy.validateStartedSession(
        authority,
        valid.copy(controlGrant = valid.controlGrant.copy(heartbeatIntervalSeconds = 3_600)),
        NOW,
      ),
    )
    val native = VoiceRuntimeRealtimeAuthorityPolicy.runtimeControlGrant(valid)
    assertEquals(15_000, native.heartbeatIntervalMillis)
    assertEquals(45_000, native.failureGraceMillis)
  }

  @Test
  fun `attempt ownership fences generation target and operation`() {
    val readiness = readiness()
    val authority = requireNotNull(
      VoiceRuntimeRealtimeAuthorityPolicy.validate(
        readiness,
        T3VoiceRuntimeGrantLoadResult.Available(grant(readiness)),
        EXPECTED_DIGEST,
        NOW,
      ),
    )
    val attempt = VoiceRuntimeRealtimeAttempt("operation-1", authority, 9)

    assertTrue(VoiceRuntimeRealtimeAttemptPolicy.owns(attempt, "operation-1", readiness))
    assertFalse(VoiceRuntimeRealtimeAttemptPolicy.owns(attempt, "operation-2", readiness))
    assertFalse(
      VoiceRuntimeRealtimeAttemptPolicy.owns(
        attempt,
        "operation-1",
        readiness.copy(generation = 8),
      ),
    )
    assertFalse(
      VoiceRuntimeRealtimeAttemptPolicy.owns(
        attempt,
        "operation-1",
        readiness.copy(targetId = "conversation-2"),
      ),
    )
  }

  private fun readiness() =
    T3VoiceReadinessConfig(
      enabled = true,
      mode = T3VoiceReadinessMode.REALTIME,
      targetId = "conversation-1",
      microphonePermissionGranted = true,
      notificationPermissionGranted = true,
      generation = 7,
    )

  private fun grant(
    readiness: T3VoiceReadinessConfig,
    expiresAt: Long = NOW + 60_000,
    operation: T3VoiceRuntimeGrantOperation = T3VoiceRuntimeGrantOperation.REALTIME_START,
  ) =
    T3VoiceRuntimeGrant(
      metadata =
        T3VoiceRuntimeGrantMetadata(
          runtimeId = "runtime-1",
          readinessGeneration = readiness.generation,
          environmentOrigin = "https://environment.example.test",
          operation = operation,
          targetIdentityDigest = EXPECTED_DIGEST,
          expiresAtEpochMillis = expiresAt,
        ),
      token = "runtime-secret",
    )

  private fun startResult() =
    VoiceRuntimeRealtimeStartResult(
      state =
        VoiceRuntimeRealtimeSessionState(
          sessionId = "session-1",
          conversationId = "conversation-1",
          phase = "signaling",
          leaseGeneration = 4,
          sequence = 0,
        ),
      signalingPath = "/api/voice/native/realtime-sessions/session-1/webrtc-offer",
      expiresAtEpochMillis = NOW + 60_000,
      controlGrant =
        VoiceRuntimeRealtimeControlGrant(
          token = "control-secret",
          expiresAtEpochMillis = NOW + 60_000,
          heartbeatIntervalSeconds = 15,
          failureGraceSeconds = 45,
        ),
    )

  private companion object {
    const val NOW = 1_800_000_000_000L
    val EXPECTED_DIGEST = T3VoiceRuntimeTargetIdentity.digest("realtime:environment:conversation-1")
  }
}
