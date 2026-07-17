package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceRetainedNativeSessionTest {
  private val session =
    T3VoiceNativeSessionConfig(
      baseUrl = "https://environment.example.test/",
      accessToken = "ephemeral-native-token",
      expiresAt = "2030-01-01T00:00:00.000Z",
    )

  @Test
  fun `normal close and failure cleanup leave no retained credential`() {
    val retained = T3VoiceRetainedNativeSession()

    retained.retain(session)
    retained.clear()
    assertFalse(retained.hasValueForTest())

    retained.retain(session)
    retained.clear()
    assertFalse(retained.hasValueForTest())
  }

  @Test
  fun `Realtime to Thread transfer is single use`() {
    val retained = T3VoiceRetainedNativeSession()
    retained.retain(session)

    assertTrue(retained.hasValueForTest())
    assertSame(session, retained.consume())
    assertFalse(retained.hasValueForTest())
    assertSame(null, retained.consume())
  }

  @Test
  fun `switch cancellation clears credential before or after close completion`() {
    val beforeCompletion = T3VoiceRealtimeThreadTransfer()
    beforeCompletion.begin(ownerGeneration = 7, preserveForThread = true)
    beforeCompletion.cancel(ownerGeneration = 7)
    beforeCompletion.complete(ownerGeneration = 7, session = session)
    assertFalse(beforeCompletion.hasValueForTest())

    val afterCompletion = T3VoiceRealtimeThreadTransfer()
    afterCompletion.begin(ownerGeneration = 7, preserveForThread = true)
    afterCompletion.complete(ownerGeneration = 7, session = session)
    assertTrue(afterCompletion.hasValueForTest())
    afterCompletion.cancel(ownerGeneration = 7)
    assertFalse(afterCompletion.hasValueForTest())
    assertSame(null, afterCompletion.consume())
  }

  @Test
  fun `stale generation cannot cancel a newer transfer`() {
    val transfer = T3VoiceRealtimeThreadTransfer()
    transfer.begin(ownerGeneration = 9, preserveForThread = true)
    transfer.complete(ownerGeneration = 9, session = session)

    transfer.cancel(ownerGeneration = 8)

    assertTrue(transfer.hasValueForTest())
    assertSame(session, transfer.consume())
  }
}
