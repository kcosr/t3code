package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicReference

/** Accounts for startup exactly once, including cancellation while its runnable is still queued. */
internal class T3VoiceStartupQuiescence(
  private val task: () -> Unit,
) {
  private enum class State {
    NEW,
    QUEUED,
    RUNNING,
    FINISHED,
  }

  private val state = AtomicReference(State.NEW)
  private val finished = CountDownLatch(1)
  private val runnable =
    Runnable {
      if (!state.compareAndSet(State.QUEUED, State.RUNNING)) return@Runnable
      try {
        task()
      } finally {
        check(state.compareAndSet(State.RUNNING, State.FINISHED)) {
          "Realtime startup quiescence ownership changed."
        }
        finished.countDown()
      }
    }

  /** Returns false when terminal cleanup already cancelled startup before submission. */
  fun submit(executor: Executor): Boolean {
    if (!state.compareAndSet(State.NEW, State.QUEUED)) return false
    try {
      executor.execute(runnable)
    } catch (cause: Throwable) {
      if (state.compareAndSet(State.QUEUED, State.FINISHED)) finished.countDown()
      throw cause
    }
    return true
  }

  /** Opens quiescence immediately only if the startup body cannot have begun. */
  fun cancelBeforeRun(): Boolean {
    while (true) {
      when (val current = state.get()) {
        State.NEW,
        State.QUEUED,
        -> if (state.compareAndSet(current, State.FINISHED)) {
          finished.countDown()
          return true
        }
        State.RUNNING -> return false
        State.FINISHED -> return true
      }
    }
  }

  fun awaitUninterruptibly() {
    var interrupted = false
    while (finished.count > 0) {
      try {
        finished.await()
      } catch (_: InterruptedException) {
        interrupted = true
      }
    }
    if (interrupted) Thread.currentThread().interrupt()
  }

  internal fun isFinishedForTest(): Boolean = finished.count == 0L
}
