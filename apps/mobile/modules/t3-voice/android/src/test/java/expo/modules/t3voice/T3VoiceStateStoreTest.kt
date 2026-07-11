package expo.modules.t3voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class T3VoiceStateStoreTest {
  @Before
  fun resetStore() {
    T3VoiceStateStore.setInactive()
    T3VoiceStateStore.setServiceReady()
  }

  @After
  fun tearDown() {
    T3VoiceStateStore.setInactive()
  }

  @Test
  fun realtimeOwnershipIsClaimedAtomically() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertFalse(T3VoiceStateStore.claimRealtime("session-b"))
    assertEquals("session-a", T3VoiceStateStore.state.value.activeRealtimeSessionId)
  }

  @Test
  fun terminalStateIsDurableAndRejectsStaleUpdates() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    val terminal =
      T3VoiceRuntimeEvent.RealtimeTerminated(
        nativeSessionId = "session-a",
        outcome = "failed",
        code = "realtime-connection-failed",
        retryable = true,
      )

    T3VoiceStateStore.terminateRealtime(terminal)
    T3VoiceStateStore.setRealtime("session-a", "connected", false)

    assertNull(T3VoiceStateStore.state.value.activeRealtimeSessionId)
    assertEquals("failed", T3VoiceStateStore.state.value.realtimeConnectionState)
    assertEquals(terminal, T3VoiceStateStore.realtimeTermination.value)
  }
}
