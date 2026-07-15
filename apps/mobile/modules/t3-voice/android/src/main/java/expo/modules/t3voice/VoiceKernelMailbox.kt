package expo.modules.t3voice

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask
import java.util.concurrent.atomic.AtomicBoolean

internal fun interface VoiceKernelCancellationToken {
  fun cancel(): Boolean
}

internal object VoiceKernelReschedulePolicy {
  fun owns(
    current: VoiceKernelCancellationToken?,
    scheduled: VoiceKernelCancellationToken,
  ): Boolean = current === scheduled
}

/**
 * Serializes runtime state ownership onto one kernel thread.
 *
 * Fire-and-forget submissions are silently dropped after shutdown begins so late media callbacks
 * remain harmless. Synchronous submissions still fail after shutdown because an awaiting caller
 * cannot receive a meaningful result from a dropped body.
 */
internal class VoiceKernelMailbox(
  private val watchdogMillis: Long = WATCHDOG_MILLIS,
  private val clock: () -> Long = SystemClock::elapsedRealtime,
  private val onWatchdog: (VoiceKernelMessage, Long) -> Unit = { _, elapsedMillis ->
    T3VoiceDiagnostics.record(
      generation = 0,
      category = T3VoiceDiagnosticCategory.KERNEL,
      code = T3VoiceDiagnosticCode.MAILBOX_BODY_SLOW,
      primaryCount = elapsedMillis.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
    )
  },
  private val onFailure: (VoiceKernelMessage, Throwable) -> Unit = { _, _ ->
    T3VoiceDiagnostics.record(
      generation = 0,
      category = T3VoiceDiagnosticCategory.KERNEL,
      code = T3VoiceDiagnosticCode.FAILED,
    )
  },
) {
  private val accepting = AtomicBoolean(true)
  private val acceptanceLock = Any()

  init {
    require(watchdogMillis >= 0) { "Mailbox watchdog duration cannot be negative." }
  }

  private val thread = HandlerThread("t3-voice-kernel").apply { start() }
  private val handler = Handler(thread.looper)

  fun submit(message: VoiceKernelMessage, body: () -> Unit): Boolean {
    return synchronized(acceptanceLock) {
      if (!accepting.get()) return false
      handler.post { runSubmitted(message, body) }
    }
  }

  fun <T> submitAndAwait(message: VoiceKernelMessage, body: () -> T): T {
    check(Looper.myLooper() !== thread.looper) {
      "The voice kernel thread cannot synchronously await its own mailbox."
    }
    val task = FutureTask { runBody(message, body) }
    synchronized(acceptanceLock) {
      check(accepting.get()) { "The voice kernel mailbox is no longer accepting messages." }
      check(handler.post(task)) { "The voice kernel mailbox rejected a message." }
    }
    return try {
      task.get()
    } catch (failure: ExecutionException) {
      throw failure.cause ?: failure
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
      throw interrupted
    }
  }

  fun submitDelayed(
    message: VoiceKernelMessage,
    delayMillis: Long,
    body: () -> Unit,
  ): VoiceKernelCancellationToken {
    require(delayMillis >= 0) { "Mailbox delay cannot be negative." }
    val pending = AtomicBoolean(true)
    val runnable = Runnable {
      if (pending.compareAndSet(true, false)) runSubmitted(message, body)
    }
    synchronized(acceptanceLock) {
      if (!accepting.get()) return NO_OP_CANCELLATION_TOKEN
      if (!handler.postDelayed(runnable, delayMillis)) return NO_OP_CANCELLATION_TOKEN
    }
    return VoiceKernelCancellationToken {
      if (!pending.compareAndSet(true, false)) {
        false
      } else {
        handler.removeCallbacks(runnable)
        true
      }
    }
  }

  fun assertKernelThread() {
    check(isKernelThread()) { "Voice kernel state requires the kernel thread." }
  }

  fun isKernelThread(): Boolean = Looper.myLooper() === thread.looper

  fun drainAndQuit() {
    synchronized(acceptanceLock) {
      if (!accepting.compareAndSet(true, false)) return
      if (isKernelThread()) {
        thread.quitSafely()
        return
      }
      check(handler.post { thread.quitSafely() }) {
        "The voice kernel mailbox could not enqueue its shutdown barrier."
      }
    }
    thread.join()
  }

  private fun runSubmitted(message: VoiceKernelMessage, body: () -> Unit) {
    runCatching { runBody(message, body) }.onFailure { onFailure(message, it) }
  }

  private fun <T> runBody(message: VoiceKernelMessage, body: () -> T): T {
    assertKernelThread()
    val startedAt = clock()
    try {
      return body()
    } finally {
      val elapsedMillis = (clock() - startedAt).coerceAtLeast(0)
      if (elapsedMillis > watchdogMillis) onWatchdog(message, elapsedMillis)
    }
  }

  private companion object {
    const val WATCHDOG_MILLIS = 250L
    val NO_OP_CANCELLATION_TOKEN = VoiceKernelCancellationToken { false }
  }
}
