package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceStartCommandPolicyTest {
  @Test
  fun onlyTheExactActiveOwnerCanPromoteToForeground() {
    assertEquals(
      T3VoiceStartCommandDecision.PROMOTE_ACTIVE_OWNER,
      T3VoiceStartCommandPolicy.decide("owner-a", "owner-a"),
    )
  }

  @Test
  fun delayedStartCannotPromoteAnIdleRuntime() {
    assertEquals(
      T3VoiceStartCommandDecision.STOP_STALE_START,
      T3VoiceStartCommandPolicy.decide("owner-a", null),
    )
  }

  @Test
  fun delayedStartCannotPromoteAReplacementOwner() {
    assertEquals(
      T3VoiceStartCommandDecision.STOP_STALE_START,
      T3VoiceStartCommandPolicy.decide("owner-a", "owner-b"),
    )
  }

  @Test
  fun missingExpectedOwnerNeverPromotesAnyState() {
    assertEquals(
      T3VoiceStartCommandDecision.STOP_STALE_START,
      T3VoiceStartCommandPolicy.decide(null, null),
    )
    assertEquals(
      T3VoiceStartCommandDecision.STOP_STALE_START,
      T3VoiceStartCommandPolicy.decide(null, "owner-b"),
    )
  }
}
