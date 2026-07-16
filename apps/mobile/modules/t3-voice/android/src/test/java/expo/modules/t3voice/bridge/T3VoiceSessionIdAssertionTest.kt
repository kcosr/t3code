package expo.modules.t3voice.bridge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceSessionIdAssertionTest {
  @Test
  fun `bridge session ids must be fresh while retained`() {
    val assertion = T3VoiceSessionIdAssertion(capacity = 2)
    assertion.assertFresh("session-1")
    assertion.assertFresh("session-2")

    assertTrue(runCatching { assertion.assertFresh("session-1") }.isFailure)
    assertEquals(2, assertion.size)
  }

  @Test
  fun `bounded assertion permits ids after eviction`() {
    val assertion = T3VoiceSessionIdAssertion(capacity = 2)
    assertion.assertFresh("session-1")
    assertion.assertFresh("session-2")
    assertion.assertFresh("session-3")
    assertion.assertFresh("session-1")

    assertEquals(2, assertion.size)
  }

  @Test
  fun `capacity must be positive`() {
    assertTrue(runCatching { T3VoiceSessionIdAssertion(capacity = 0) }.isFailure)
  }
}
