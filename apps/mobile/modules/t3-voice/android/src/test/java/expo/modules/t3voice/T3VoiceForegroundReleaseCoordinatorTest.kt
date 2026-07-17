package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceForegroundReleaseCoordinatorTest {
  @Test
  fun aNewClaimCannotInterleaveBetweenIdleCheckAndForegroundRelease() {
    val idle = AtomicBoolean(true)
    val foregroundReleased = CountDownLatch(1)
    val claimAttempted = CountDownLatch(1)
    val claimCompleted = CountDownLatch(1)
    val coordinator =
      T3VoiceForegroundReleaseCoordinator(
        isIdle = idle::get,
        releaseForeground = foregroundReleased::countDown,
      )

    synchronized(coordinator.lock) {
      val claimant =
        Thread {
          claimAttempted.countDown()
          synchronized(coordinator.lock) {
            idle.set(false)
            claimCompleted.countDown()
          }
        }
      claimant.start()
      assertTrue(claimAttempted.await(2, TimeUnit.SECONDS))
      assertFalse(claimCompleted.await(50, TimeUnit.MILLISECONDS))

      coordinator.releaseWhileLocked()
      assertTrue(foregroundReleased.await(2, TimeUnit.SECONDS))
    }

    assertTrue(claimCompleted.await(2, TimeUnit.SECONDS))
    assertFalse(idle.get())
  }

  @Test(expected = IllegalStateException::class)
  fun foregroundReleaseRejectsAnActiveOwner() {
    val coordinator =
      T3VoiceForegroundReleaseCoordinator(
        isIdle = { false },
        releaseForeground = { throw AssertionError("must not release") },
      )

    synchronized(coordinator.lock) { coordinator.releaseWhileLocked() }
  }
}
