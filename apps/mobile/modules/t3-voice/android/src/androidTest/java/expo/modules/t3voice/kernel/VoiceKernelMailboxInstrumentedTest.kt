package expo.modules.t3voice.kernel

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class VoiceKernelMailboxInstrumentedTest {
  @Test
  fun submissionsRemainFifoAndSubmitAndAwaitReturnsTheBodyValue() {
    val mailbox = VoiceKernelMailbox()
    val observed = mutableListOf<Int>()
    try {
      mailbox.submit(command("first")) { observed += 1 }
      mailbox.submit(command("second")) { observed += 2 }

      val result = mailbox.submitAndAwait(command("third")) {
        observed += 3
        42
      }

      assertEquals(42, result)
      assertEquals(listOf(1, 2, 3), observed)
    } finally {
      mailbox.drainAndQuit()
    }
  }

  @Test
  fun cancelledDelayedSubmissionDoesNotRun() {
    val mailbox = VoiceKernelMailbox()
    val ran = AtomicBoolean(false)
    try {
      val token = mailbox.submitDelayed(command("delayed"), 100) { ran.set(true) }

      assertTrue(token.cancel())
      assertFalse(token.cancel())
      assertFalse(CountDownLatch(1).await(200, TimeUnit.MILLISECONDS))
      mailbox.submitAndAwait(command("barrier")) { Unit }
      assertFalse(ran.get())
    } finally {
      mailbox.drainAndQuit()
    }
  }

  @Test
  fun watchdogReceivesSlowMessageMetadata() {
    val now = AtomicLong(1_000)
    var watched: Pair<VoiceKernelMessage, Long>? = null
    val mailbox = VoiceKernelMailbox(
      clock = now::get,
      onWatchdog = { message, elapsedMillis -> watched = message to elapsedMillis },
    )
    val message = command("slow")
    try {
      mailbox.submitAndAwait(message) { now.addAndGet(251) }

      assertEquals(message to 251L, watched)
    } finally {
      mailbox.drainAndQuit()
    }
  }

  @Test
  fun fireAndForgetSubmissionsDropSilentlyAfterDrainWhileAwaitStillFails() {
    val mailbox = VoiceKernelMailbox()
    mailbox.drainAndQuit()

    assertFalse(mailbox.submit(command("late")) { error("must not run") })
    assertFalse(
      mailbox.submitDelayed(command("late-delayed"), 0) { error("must not run") }.cancel(),
    )
    assertThrows(IllegalStateException::class.java) {
      mailbox.submitAndAwait(command("late-await")) { Unit }
    }
  }

  @Test
  fun kernelThreadDiscriminatorSupportsInlineAndForeignDispatch() {
    val mailbox = VoiceKernelMailbox()
    try {
      assertFalse(mailbox.isKernelThread())
      mailbox.submitAndAwait(command("kernel-discriminator")) {
        assertTrue(mailbox.isKernelThread())
        var ranInline = false
        if (mailbox.isKernelThread()) ranInline = true
        assertTrue(ranInline)
      }
    } finally {
      mailbox.drainAndQuit()
    }
  }

  private fun command(payloadKind: String) =
    VoiceKernelMessage.Command(callerIdentity = "test", payloadKind = payloadKind)
}
