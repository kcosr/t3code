package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRealtimeTerminalLatchTest {
  @Test
  fun suppressesDuplicateTerminalClaims() {
    val latch = T3VoiceRealtimeTerminalLatch()
    latch.activate("session-a")

    assertTrue(latch.claim("session-a"))
    assertFalse(latch.claim("session-a"))
  }

  @Test
  fun rejectsStaleOwnerAfterNextSessionStarts() {
    val latch = T3VoiceRealtimeTerminalLatch()
    latch.activate("session-a")
    assertTrue(latch.claim("session-a"))
    latch.activate("session-b")

    assertFalse(latch.claim("session-a"))
    assertTrue(latch.claim("session-b"))
  }
}
