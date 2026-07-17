package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceSessionIdTombstonesTest {
  @Test
  fun rejectsAnIdWhileItRemainsInTheRecentWindow() {
    val tombstones = T3VoiceSessionIdTombstones(capacity = 2)

    assertTrue(tombstones.add("session-a"))
    assertFalse(tombstones.add("session-a"))
    assertEquals(1, tombstones.size)
  }

  @Test
  fun evictsTheOldestIdWhenCapacityIsExceeded() {
    val tombstones = T3VoiceSessionIdTombstones(capacity = 2)

    assertTrue(tombstones.add("session-a"))
    assertTrue(tombstones.add("session-b"))
    assertTrue(tombstones.add("session-c"))

    assertEquals(2, tombstones.size)
    assertTrue(tombstones.add("session-a"))
    assertFalse(tombstones.add("session-c"))
    assertEquals(2, tombstones.size)
  }

  @Test
  fun neverRetainsMoreThanItsConfiguredCapacity() {
    val tombstones = T3VoiceSessionIdTombstones(capacity = 8)

    repeat(10_000) { index -> assertTrue(tombstones.add("session-$index")) }

    assertEquals(8, tombstones.size)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsAnUnboundedZeroCapacityConfiguration() {
    T3VoiceSessionIdTombstones(capacity = 0)
  }
}
