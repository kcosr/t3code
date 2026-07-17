package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceRealtimePrepareFenceTest {
  @Test
  fun `cancel before begin rejects the exact later admission`() {
    val fence = T3VoiceRealtimePrepareFence()

    assertTrue(fence.cancelStartup("session-a"))

    assertNull(fence.begin("session-a"))
    val replacement = checkNotNull(fence.begin("session-b"))
    assertTrue(fence.claimInstall(replacement))
    assertTrue(fence.complete(replacement))
  }

  @Test
  fun `cancellation remains effective from resource construction through startup completion`() {
    val firstFence = T3VoiceRealtimePrepareFence()
    val first = checkNotNull(firstFence.begin("session-a"))
    assertTrue(firstFence.cancelPending("session-a"))
    assertFalse(firstFence.claimInstall(first))

    val secondFence = T3VoiceRealtimePrepareFence()
    val afterInstall = checkNotNull(secondFence.begin("session-b"))
    assertTrue(secondFence.claimInstall(afterInstall))
    assertTrue(secondFence.cancelPending("session-b"))
    assertFalse(secondFence.complete(afterInstall))
  }

  @Test
  fun `cleanup after an abandoned exact attempt cannot poison the next generation`() {
    val fence = T3VoiceRealtimePrepareFence()
    val failed = checkNotNull(fence.begin("session-failed"))
    fence.abandon(failed)

    assertFalse(fence.cancelStartup("session-failed"))
    val replacement = checkNotNull(fence.begin("session-replacement"))
    assertTrue(fence.claimInstall(replacement))
    assertTrue(fence.complete(replacement))
  }

  @Test
  fun `cleanup after a completed peer self failure cannot poison the next generation`() {
    val fence = T3VoiceRealtimePrepareFence()
    val completed = checkNotNull(fence.begin("session-completed"))
    assertTrue(fence.claimInstall(completed))
    assertTrue(fence.complete(completed))

    assertFalse(fence.cancelStartup("session-completed"))
    val replacement = checkNotNull(fence.begin("session-replacement"))
    assertTrue(fence.claimInstall(replacement))
    assertTrue(fence.complete(replacement))
  }

  @Test
  fun `terminal stop retires cancellation when startup exits before prepare begins`() {
    val fence = T3VoiceRealtimePrepareFence()
    assertTrue(fence.cancelStartup("session-never-began"))

    assertTrue(fence.retireCancelledBeforeBegin("session-never-began"))
    val replacement = checkNotNull(fence.begin("session-replacement"))
    assertTrue(fence.claimInstall(replacement))
    assertTrue(fence.complete(replacement))
  }

  @Test
  fun `Stop after install is visible before router acquisition and retires the attempt`() {
    val fence = T3VoiceRealtimePrepareFence()
    val installed = checkNotNull(fence.begin("session-installed"))
    assertTrue(fence.claimInstall(installed))

    assertTrue(fence.cancelStartup("session-installed"))
    assertFalse(fence.isLive(installed))
    fence.abandon(installed)

    val replacement = checkNotNull(fence.begin("session-replacement"))
    assertTrue(fence.claimInstall(replacement))
    assertTrue(fence.complete(replacement))
  }
}
