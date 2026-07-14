package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBinderOperationDispatcherTest {
  @Test
  fun realtimeStopUsesTheInterruptLane() {
    val identity = VoiceRuntimeIdentity("runtime", "instance", 1)

    assertEquals(
      T3VoiceBinderOperationLane.INTERRUPT,
      T3VoiceBinderOperationLanePolicy.forCommand(
        VoiceRuntimeNativeCommand.StopMode("stop", identity, "session", "immediate"),
      ),
    )
    assertEquals(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationLanePolicy.forCommand(
        VoiceRuntimeNativeCommand.StartRealtime("start", identity, "session", "interrupt"),
      ),
    )
  }

  @Test
  fun ordinaryOperationsRemainOrdered() {
    val orderedExecutor = Executors.newSingleThreadExecutor()
    val interruptExecutor = Executors.newSingleThreadExecutor()
    val dispatcher =
      T3VoiceBinderOperationDispatcher(
        orderedPost = {
          orderedExecutor.submit(it)
          true
        },
        interruptPost = {
          interruptExecutor.submit(it)
          true
        },
      )
    val completed = CountDownLatch(2)
    val results = mutableListOf<String>()

    try {
      dispatcher.post(T3VoiceBinderOperationLane.ORDERED) {
        results += "start"
        completed.countDown()
      }
      dispatcher.post(T3VoiceBinderOperationLane.ORDERED) {
        results += "answer"
        completed.countDown()
      }

      assertTrue(completed.await(1, TimeUnit.SECONDS))
      assertEquals(listOf("start", "answer"), results)
    } finally {
      orderedExecutor.shutdownNow()
      interruptExecutor.shutdownNow()
    }
  }

  @Test
  fun interruptCompletesWhileAnOrderedOperationIsBlocked() {
    val orderedExecutor = Executors.newSingleThreadExecutor()
    val interruptExecutor = Executors.newSingleThreadExecutor()
    val dispatcher =
      T3VoiceBinderOperationDispatcher(
        orderedPost = {
          orderedExecutor.submit(it)
          true
        },
        interruptPost = {
          interruptExecutor.submit(it)
          true
        },
      )
    val orderedStarted = CountDownLatch(1)
    val releaseOrdered = CountDownLatch(1)
    val interruptCompleted = CountDownLatch(1)

    try {
      assertTrue(
        dispatcher.post(T3VoiceBinderOperationLane.ORDERED) {
          orderedStarted.countDown()
          releaseOrdered.await()
        },
      )
      assertTrue(orderedStarted.await(1, TimeUnit.SECONDS))

      assertTrue(
        dispatcher.post(T3VoiceBinderOperationLane.INTERRUPT) {
          interruptCompleted.countDown()
        },
      )

      assertTrue(interruptCompleted.await(1, TimeUnit.SECONDS))
    } finally {
      releaseOrdered.countDown()
      orderedExecutor.shutdownNow()
      interruptExecutor.shutdownNow()
    }
  }
}
