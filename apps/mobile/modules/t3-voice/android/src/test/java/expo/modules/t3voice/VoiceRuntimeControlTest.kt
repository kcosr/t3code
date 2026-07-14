package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeControlTest {
  private val grant =
    VoiceRuntimeControlGrant(
      token = "secret",
      sessionId = "session-1",
      leaseGeneration = 2,
      expiresAtEpochMillis = Long.MAX_VALUE,
      heartbeatIntervalMillis = 8_000,
      failureGraceMillis = 30_000,
    )

  @Test
  fun schedulerStartsImmediatelyAtTheServerInterval() {
    assertEquals(
      T3VoiceNativeHeartbeatSchedule(initialDelayMillis = 0, intervalMillis = 8_000),
      T3VoiceNativeHeartbeatSchedulePolicy.forGrant(grant),
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
        expiresAtMillis = 100_000,
      ),
    )
    assertTrue(
      T3VoiceNativeHeartbeatPolicy.shouldLoseControl(
        T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE,
        nowMillis = 30_000,
        lastSuccessMillis = 0,
        failureGraceMillis = 30_000,
        expiresAtMillis = 100_000,
      ),
    )
  }

  @Test
  fun grantExpiryAlwaysLosesControl() {
    assertTrue(
      T3VoiceNativeHeartbeatPolicy.shouldLoseControl(
        T3VoiceNativeHeartbeatResult.SUCCESS,
        nowMillis = 100,
        lastSuccessMillis = 100,
        failureGraceMillis = 30_000,
        expiresAtMillis = 100,
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

  @Test
  fun terminalHeartbeatLosesControlOnceAndErasesTheGrant() {
    val calls = AtomicInteger()
    val lost = CountDownLatch(1)
    val heartbeat =
      VoiceRuntimeControlHeartbeat(
        transport = T3VoiceNativeHeartbeatTransport { _, _, _, _ ->
          calls.incrementAndGet()
          T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
        },
        onTerminated = { _, termination ->
          assertEquals(VoiceRuntimeControlTermination.CONTROL_REJECTED, termination)
          lost.countDown()
        },
      )
    try {
      heartbeat.start("https://termstation", grant.copy(heartbeatIntervalMillis = 25))
      assertTrue("Control loss was not delivered", lost.await(1, TimeUnit.SECONDS))
      Thread.sleep(100)
      assertEquals(1, calls.get())
    } finally {
      heartbeat.destroy()
    }
  }

  @Test
  fun validTerminalSessionStopsControlWithoutReportingFailure() {
    val calls = AtomicInteger()
    val termination = AtomicReference<VoiceRuntimeControlTermination?>()
    val ended = CountDownLatch(1)
    val heartbeat =
      VoiceRuntimeControlHeartbeat(
        transport = T3VoiceNativeHeartbeatTransport { _, _, _, _ ->
          calls.incrementAndGet()
          T3VoiceNativeHeartbeatResult.SESSION_TERMINAL
        },
        onTerminated = { _, reason ->
          termination.set(reason)
          ended.countDown()
        },
      )
    try {
      heartbeat.start("https://termstation", grant.copy(heartbeatIntervalMillis = 25))
      assertTrue(ended.await(1, TimeUnit.SECONDS))
      Thread.sleep(100)
      assertEquals(VoiceRuntimeControlTermination.SESSION_ENDED, termination.get())
      assertEquals(1, calls.get())
    } finally {
      heartbeat.destroy()
    }
  }

  @Test
  fun replacementFencesAStaleInFlightTerminalResponse() {
    val oldEntered = CountDownLatch(1)
    val releaseOld = CountDownLatch(1)
    val replacementSucceeded = CountDownLatch(1)
    val lostSession = AtomicReference<String?>()
    val heartbeat =
      VoiceRuntimeControlHeartbeat(
        transport = T3VoiceNativeHeartbeatTransport { _, token, _, _ ->
          if (token == "old") {
            oldEntered.countDown()
            while (true) {
              try {
                if (releaseOld.await(1, TimeUnit.SECONDS)) break
              } catch (_: InterruptedException) {
                // Simulate a transport whose terminal response wins a cancellation race.
              }
            }
            T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
          } else {
            replacementSucceeded.countDown()
            T3VoiceNativeHeartbeatResult.SUCCESS
          }
        },
        onTerminated = { sessionId, _ -> lostSession.set(sessionId) },
      )
    try {
      heartbeat.start(
        "https://termstation",
        grant.copy(token = "old", heartbeatIntervalMillis = 1_000),
      )
      assertTrue(oldEntered.await(1, TimeUnit.SECONDS))
      heartbeat.start(
        "https://termstation",
        grant.copy(token = "new", leaseGeneration = 3, heartbeatIntervalMillis = 25),
      )
      releaseOld.countDown()
      assertTrue(replacementSucceeded.await(1, TimeUnit.SECONDS))
      assertEquals(null, lostSession.get())
    } finally {
      releaseOld.countDown()
      heartbeat.destroy()
    }
  }

  @Test
  fun transientFailuresLoseControlOnlyAfterElapsedGrace() {
    val now = AtomicLong(0)
    val firstAttempt = CountDownLatch(1)
    val lost = CountDownLatch(1)
    val heartbeat =
      VoiceRuntimeControlHeartbeat(
        transport = T3VoiceNativeHeartbeatTransport { _, _, _, _ ->
          firstAttempt.countDown()
          T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE
        },
        clockMillis = now::get,
        onTerminated = { _, termination ->
          assertEquals(VoiceRuntimeControlTermination.TRANSIENT_FAILURE, termination)
          lost.countDown()
        },
      )
    try {
      heartbeat.start(
        "https://termstation",
        grant.copy(
          expiresAtEpochMillis = 100_000,
          heartbeatIntervalMillis = 25,
          failureGraceMillis = 30_000,
        ),
      )
      assertTrue(firstAttempt.await(1, TimeUnit.SECONDS))
      assertFalse(lost.await(75, TimeUnit.MILLISECONDS))
      now.set(30_000)
      assertTrue(lost.await(1, TimeUnit.SECONDS))
    } finally {
      heartbeat.destroy()
    }
  }

  @Test
  fun stopPreventsFutureTransportUse() {
    val firstAttempt = CountDownLatch(1)
    val calls = AtomicInteger()
    val heartbeat =
      VoiceRuntimeControlHeartbeat(
        transport = T3VoiceNativeHeartbeatTransport { _, _, _, _ ->
          calls.incrementAndGet()
          firstAttempt.countDown()
          T3VoiceNativeHeartbeatResult.SUCCESS
        },
        onTerminated = { _, _ -> throw AssertionError("Stopped control must not report loss") },
      )
    try {
      heartbeat.start("https://termstation", grant.copy(heartbeatIntervalMillis = 100))
      assertTrue(firstAttempt.await(1, TimeUnit.SECONDS))
      heartbeat.stop()
      val callsAtStop = calls.get()
      Thread.sleep(200)
      assertEquals(callsAtStop, calls.get())
    } finally {
      heartbeat.destroy()
    }
  }
}
