package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRealtimeSessionLeaseTest {
  @Test
  fun claimTerminalIsOnceOnly() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    assertTrue(lease.claimTerminal())
    assertFalse(lease.claimTerminal())
  }

  @Test
  fun claimTerminalSucceedsAfterRelease() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    assertTrue(lease.release())
    assertTrue(lease.claimTerminal())
    assertFalse(lease.claimTerminal())
  }

  @Test
  fun claimTerminalIsPerLeaseIndependent() {
    val first = T3VoiceRealtimeSessionLease("session-a")
    val second = T3VoiceRealtimeSessionLease("session-a")
    first.install()
    assertTrue(first.claimTerminal())
    second.install()
    assertTrue(second.claimTerminal())
    assertFalse(first.claimTerminal())
  }

  @Test
  fun audioInactiveUntilInstallAndAfterRelease() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    assertFalse(lease.isAudioActive())
    lease.install()
    assertTrue(lease.isAudioActive())
    assertTrue(lease.release())
    assertFalse(lease.isAudioActive())
    assertFalse(lease.release())
  }

  @Test
  fun delayedCallbacksFromAReleasedLeaseAreRejected() {
    val first = T3VoiceRealtimeSessionLease("session-a")
    val second = T3VoiceRealtimeSessionLease("session-b")
    first.install()
    second.install()
    first.release()
    assertFalse(first.isAudioActive())
    assertTrue(second.isAudioActive())
  }

  @Test
  fun referentialIdentityFencesSameSessionIdString() {
    val first = T3VoiceRealtimeSessionLease("session-a")
    val second = T3VoiceRealtimeSessionLease("session-a")
    second.install()
    assertFalse(first.isAudioActive())
    assertTrue(second.isAudioActive())
  }

  @Test
  fun disarmAllTimeoutsInvalidatesBothKinds() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    val connecting = requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
    val disconnected =
      requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    assertTrue(lease.disarmAllTimeouts())
    assertFalse(lease.consumeTimeout(connecting))
    assertFalse(lease.consumeTimeout(disconnected))
  }

  @Test
  fun consumeTimeoutIsOnceOnly() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    val token = requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
    assertTrue(lease.consumeTimeout(token))
    assertFalse(lease.consumeTimeout(token))
  }

  @Test
  fun rearmingRejectsStaleOrdinals() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    val stale = requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    val current =
      requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    assertFalse(lease.consumeTimeout(stale))
    assertTrue(lease.consumeTimeout(current))
  }

  @Test
  fun separateLeasesDoNotShareArmedState() {
    val first = T3VoiceRealtimeSessionLease("session-a")
    val second = T3VoiceRealtimeSessionLease("session-a")
    first.install()
    val stale = requireNotNull(first.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    // Production releases the prior lease before installing a replacement.
    first.release()
    second.install()
    val current =
      requireNotNull(second.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    assertFalse(first.consumeTimeout(stale))
    assertTrue(second.consumeTimeout(current))
  }

  @Test
  fun releaseDisarmsAndBlocksRearm() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    lease.install()
    val connecting = requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
    val disconnected =
      requireNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.DISCONNECTED))
    assertTrue(lease.release())
    assertFalse(lease.consumeTimeout(connecting))
    assertFalse(lease.consumeTimeout(disconnected))
    assertNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
  }

  @Test
  fun armTimeoutNullBeforeInstall() {
    val lease = T3VoiceRealtimeSessionLease("session-a")
    assertNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
    lease.install()
    assertNotNull(lease.armTimeout(T3VoiceRealtimeSessionLease.TimeoutKind.CONNECTING))
  }
}
