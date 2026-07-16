package expo.modules.t3voice.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeControlTest {
  private val lease =
    VoiceRuntimeControlLease(
      sessionId = "session-1",
      leaseGeneration = 2,
      heartbeatIntervalMillis = 8_000,
      failureGraceMillis = 30_000,
    )

  @Test
  fun schedulerStartsImmediatelyAtTheServerInterval() {
    assertEquals(
      T3VoiceNativeHeartbeatSchedule(initialDelayMillis = 0, intervalMillis = 8_000),
      T3VoiceNativeHeartbeatSchedulePolicy.forLease(lease),
    )
  }

  @Test
  fun responsePolicyFencesAllClientErrorsImmediately() {
    assertEquals(
      T3VoiceNativeHeartbeatResult.SUCCESS,
      T3VoiceNativeHeartbeatPolicy.classify(204),
    )
    assertEquals(
      T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE,
      T3VoiceNativeHeartbeatPolicy.classify(401),
    )
    assertEquals(
      T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE,
      T3VoiceNativeHeartbeatPolicy.classify(409),
    )
    assertEquals(
      T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE,
      T3VoiceNativeHeartbeatPolicy.classify(503),
    )
  }

  @Test
  fun successResponseMustBeExactLiveGrantIdentity() {
    val fields = T3VoiceNativeHeartbeatResponsePolicy.REQUIRED_FIELDS
    assertEquals(
      T3VoiceNativeHeartbeatResult.SUCCESS,
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "live", "listening", false, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
    )
    assertEquals(
      T3VoiceNativeHeartbeatResult.SESSION_TERMINAL,
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "terminal", "ended", false, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
    )
    assertEquals(
      T3VoiceNativeHeartbeatResult.SESSION_TERMINAL_HANDOFF,
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "terminal", "ended", true, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
    )
    listOf(
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "wrong", 2, "live", "listening", false, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 3, "live", "listening", false, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "live", "listening", false, "2026-07-12T12:00:00Z", fields - "expiresAt", "session-1", 2,
      ),
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "live", "unknown", false, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "live", "listening", false, "not-a-timestamp", fields, "session-1", 2,
      ),
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        "session-1", 2, "terminal", "ended", null, "2026-07-12T12:00:00Z", fields, "session-1", 2,
      ),
    ).forEach { assertEquals(T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE, it) }
  }

  @Test
  fun transientFailuresUseElapsedGraceRatherThanFailureCount() {
    assertFalse(
      T3VoiceNativeHeartbeatPolicy.shouldLoseControl(
        T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE,
        nowMillis = 29_999,
        lastSuccessMillis = 0,
        failureGraceMillis = 30_000,
      ),
    )
    assertTrue(
      T3VoiceNativeHeartbeatPolicy.shouldLoseControl(
        T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE,
        nowMillis = 30_000,
        lastSuccessMillis = 0,
        failureGraceMillis = 30_000,
      ),
    )
  }

  @Test
  fun originPolicyPreservesLocalHttpsHostAndRejectsCleartext() {
    assertEquals(
      "https://termstation/api/voice/sessions/session-1/native-heartbeat",
      VoiceRuntimeControlOriginPolicy.heartbeatUrl("https://termstation/some/path", "session-1"),
    )
    assertEquals(
      "https://example.test:8443/api/voice/sessions/session-1/native-heartbeat",
      VoiceRuntimeControlOriginPolicy.heartbeatUrl("https://example.test:8443", "session-1"),
    )
    runCatching {
      VoiceRuntimeControlOriginPolicy.heartbeatUrl("http://termstation", "session-1")
    }.onSuccess { throw AssertionError("Cleartext origins must be rejected.") }
  }
}
