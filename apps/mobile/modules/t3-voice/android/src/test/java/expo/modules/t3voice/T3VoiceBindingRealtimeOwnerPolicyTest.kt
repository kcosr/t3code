package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class T3VoiceBindingRealtimeOwnerPolicyTest {
  @Test
  fun disconnectClaimsOnlyTheCurrentBindingOwnerOnce() {
    val policy = T3VoiceBindingRealtimeOwnerPolicy()
    val first = policy.connected()
    policy.observe(first, "old")
    val second = policy.connected()
    policy.observe(first, "stale")
    policy.observe(second, "current")

    assertEquals(
      T3VoiceBindingRealtimeOwnerPolicy.Owner("current", second),
      policy.disconnected(),
    )
    assertNull(policy.disconnected())
  }

  @Test
  fun clearingObservedSessionPreventsFalseTerminalEvent() {
    val policy = T3VoiceBindingRealtimeOwnerPolicy()
    val generation = policy.connected()
    policy.observe(generation, "active")
    policy.observe(generation, null)

    assertNull(policy.disconnected())
  }
}
