package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRealtimeAudioOwnerPolicyTest {
  @Test
  fun delayedCallbacksFromThePreviousOwnerAreRejected() {
    val policy = T3VoiceRealtimeAudioOwnerPolicy()
    val previous = policy.issue("session-a")
    policy.activate(previous)
    val replacement = policy.issue("session-b")
    policy.activate(replacement)

    assertFalse(policy.isActive(previous))
    assertTrue(policy.isActive(replacement))
  }

  @Test
  fun generationFencesReusedSessionIds() {
    val policy = T3VoiceRealtimeAudioOwnerPolicy()
    val previous = policy.issue("session-a")
    val replacement = policy.issue("session-a")

    assertNotEquals(previous, replacement)
    policy.activate(replacement)
    assertFalse(policy.isActive(previous))
  }

  @Test
  fun teardownOnlyDeactivatesTheMatchingOwnerOnce() {
    val policy = T3VoiceRealtimeAudioOwnerPolicy()
    val owner = policy.issue("session-a")
    policy.activate(owner)

    assertTrue(policy.deactivate(owner))
    assertFalse(policy.deactivate(owner))
    assertFalse(policy.isActive(owner))
  }
}
