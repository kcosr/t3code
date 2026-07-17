package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRealtimeConnectionTimeoutPolicyTest {
  @Test
  fun connectedDisarmsBothDeadlines() {
    val policy = T3VoiceRealtimeConnectionTimeoutPolicy()
    val owner = policy.activate("session-a")
    val connecting =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING))
    val disconnected =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED))

    assertTrue(policy.disarmAll(owner))
    assertFalse(policy.consume(connecting))
    assertFalse(policy.consume(disconnected))
  }

  @Test
  fun consumesEachArmedDeadlineAtMostOnce() {
    val policy = T3VoiceRealtimeConnectionTimeoutPolicy()
    val owner = policy.activate("session-a")
    val token =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING))

    assertTrue(policy.consume(token))
    assertFalse(policy.consume(token))
  }

  @Test
  fun rearmingRejectsTheCancelledTimersLateCallback() {
    val policy = T3VoiceRealtimeConnectionTimeoutPolicy()
    val owner = policy.activate("session-a")
    val stale =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED))
    val current =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED))

    assertFalse(policy.consume(stale))
    assertTrue(policy.consume(current))
  }

  @Test
  fun replacementRejectsLateTimersEvenWhenSessionIdIsReused() {
    val policy = T3VoiceRealtimeConnectionTimeoutPolicy()
    val firstOwner = policy.activate("session-a")
    val stale =
      requireNotNull(policy.arm(firstOwner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED))
    val replacementOwner = policy.activate("session-a")
    val current =
      requireNotNull(
        policy.arm(replacementOwner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED),
      )

    assertNotEquals(firstOwner.generation, replacementOwner.generation)
    assertFalse(policy.consume(stale))
    assertTrue(policy.consume(current))
  }

  @Test
  fun stopOrFailureInvalidatesEveryTimerForTheOwner() {
    val policy = T3VoiceRealtimeConnectionTimeoutPolicy()
    val owner = policy.activate("session-a")
    val connecting =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING))
    val disconnected =
      requireNotNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.DISCONNECTED))

    assertTrue(policy.deactivate(owner))
    assertFalse(policy.consume(connecting))
    assertFalse(policy.consume(disconnected))
    assertNull(policy.arm(owner, T3VoiceRealtimeConnectionTimeoutPolicy.Kind.CONNECTING))
  }
}
