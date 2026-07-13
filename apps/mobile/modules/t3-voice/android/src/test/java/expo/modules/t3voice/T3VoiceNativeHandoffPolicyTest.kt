package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceNativeHandoffPolicyTest {
  private val action =
    T3VoiceNativeHandoffAction(
      actionId = "action-1",
      sessionId = "session-1",
      leaseGeneration = 2,
      projectId = "project-1",
      threadId = "thread-1",
      autoRearm = true,
      expiresAtEpochMillis = 2_000,
    )

  @Test
  fun derivesStableRecordingOwnerFromAction() {
    assertEquals("voice-handoff-action-1", T3VoiceNativeHandoffPolicy.recordingId(action.actionId))
  }

  @Test
  fun executesOnlyUnexpiredUnseenActions() {
    assertTrue(T3VoiceNativeHandoffPolicy.shouldExecute(action, 1_999, emptySet()))
    assertFalse(T3VoiceNativeHandoffPolicy.shouldExecute(action, 2_000, emptySet()))
    assertFalse(T3VoiceNativeHandoffPolicy.shouldExecute(action, 1_000, setOf("action-1")))
  }

  @Test
  fun fencesActionsBySessionAndLeaseGeneration() {
    assertTrue(T3VoiceNativeHandoffPolicy.matchesGrant(action, "session-1", 2))
    assertFalse(T3VoiceNativeHandoffPolicy.matchesGrant(action, "session-2", 2))
    assertFalse(T3VoiceNativeHandoffPolicy.matchesGrant(action, "session-1", 3))
  }

  @Test
  fun pollerSurvivesTransportAndExecutionExceptions() {
    val polls = AtomicInteger()
    val acknowledgement = CountDownLatch(1)
    val transport =
      object : T3VoiceNativeHandoffTransport {
        override fun poll(url: String, token: String): T3VoiceNativeHandoffPollResult {
          if (polls.incrementAndGet() == 1) error("temporary transport failure")
          return T3VoiceNativeHandoffPollResult.Actions(listOf(action))
        }

        override fun acknowledge(
          url: String,
          token: String,
          outcome: T3VoiceNativeHandoffOutcome,
        ): Boolean {
          assertEquals(
            T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"),
            outcome,
          )
          acknowledgement.countDown()
          return true
        }
      }
    val poller =
      T3VoiceNativeHandoffPoller(
        transport = transport,
        clockMillis = { 1_000 },
        execute = { error("native execution failed") },
        onSettled = {},
      )
    try {
      poller.start(
        "https://termstation",
        T3VoiceNativeControlGrant(
          token = "secret",
          sessionId = action.sessionId,
          leaseGeneration = action.leaseGeneration,
          expiresAtEpochMillis = 10_000,
          heartbeatIntervalMillis = 8_000,
          failureGraceMillis = 30_000,
        ),
      )
      assertTrue("failed acknowledgement was not retried", acknowledgement.await(2, TimeUnit.SECONDS))
      assertTrue(polls.get() >= 2)
    } finally {
      poller.destroy()
    }
  }

  @Test
  fun pollerRejectsInvalidOriginBeforeScheduling() {
    val poller =
      T3VoiceNativeHandoffPoller(
        execute = { T3VoiceNativeHandoffOutcome.Listening },
        onSettled = {},
      )
    try {
      val failure =
        runCatching {
          poller.start(
            "http://termstation",
            T3VoiceNativeControlGrant(
              token = "secret",
              sessionId = action.sessionId,
              leaseGeneration = action.leaseGeneration,
              expiresAtEpochMillis = 10_000,
              heartbeatIntervalMillis = 8_000,
              failureGraceMillis = 30_000,
            ),
          )
        }.exceptionOrNull()
      assertTrue(failure is IllegalArgumentException)
    } finally {
      poller.destroy()
    }
  }
}
