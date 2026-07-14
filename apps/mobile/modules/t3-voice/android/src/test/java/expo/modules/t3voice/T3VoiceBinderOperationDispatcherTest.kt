package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBinderOperationDispatcherTest {
  @Test
  fun realtimeStopUsesTheInterruptLane() {
    val identity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val fence = T3VoiceBinderOperationFence(identity, "session")

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
    assertEquals(
      T3VoiceBinderOperationOrdering.Activation(fence),
      T3VoiceBinderOperationLanePolicy.orderingForCommand(
        VoiceRuntimeNativeCommand.StartRealtime("start", identity, "session", "interrupt"),
      ),
    )
    assertEquals(
      T3VoiceBinderOperationOrdering.Stop(fence),
      T3VoiceBinderOperationLanePolicy.orderingForCommand(
        VoiceRuntimeNativeCommand.StopMode("stop", identity, "session", "immediate"),
      ),
    )
  }

  @Test
  fun stopCancelsAnEarlierStartThatHasNotReachedAdmission() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var startRan = false
    var startCancelled = false
    var stopRan = false

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
        onCancelled = { startCancelled = true },
      ) { startRan = true },
    )
    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { stopRan = true },
    )

    interrupts.removeFirst().run()
    ordered.removeFirst().run()

    assertTrue(stopRan)
    assertTrue(startCancelled)
    assertFalse(startRan)
  }

  @Test
  fun oneStopCancelsEveryEarlierQueuedStartForTheFence() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var startsRan = 0
    var startsCancelled = 0

    repeat(2) {
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.ORDERED,
          T3VoiceBinderOperationOrdering.Activation(fence),
          onCancelled = { startsCancelled += 1 },
        ) { startsRan += 1 },
      )
    }
    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) {},
    )

    interrupts.removeFirst().run()
    ordered.removeFirst().run()
    ordered.removeFirst().run()

    assertEquals(2, startsCancelled)
    assertEquals(0, startsRan)
  }

  @Test
  fun laterStartForTheSameFenceCanRunAfterReconnect() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var firstCancelled = false
    var reconnectedStartRan = false

    dispatcher.post(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationOrdering.Activation(fence),
      onCancelled = { firstCancelled = true },
    ) {}
    dispatcher.post(
      T3VoiceBinderOperationLane.INTERRUPT,
      T3VoiceBinderOperationOrdering.Stop(fence),
    ) {}
    dispatcher.post(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationOrdering.Activation(fence),
    ) { reconnectedStartRan = true }

    interrupts.removeFirst().run()
    ordered.removeFirst().run()
    ordered.removeFirst().run()

    assertTrue(firstCancelled)
    assertTrue(reconnectedStartRan)
  }

  @Test
  fun rejectedStopPostDoesNotCancelAQueuedStart() {
    val ordered = ArrayDeque<Runnable>()
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = {
        ordered.addLast(it)
        true
      },
      interruptPost = { false },
    )
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var startRan = false
    var startCancelled = false

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
        onCancelled = { startCancelled = true },
      ) { startRan = true },
    )
    assertFalse(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) {},
    )

    ordered.removeFirst().run()

    assertTrue(startRan)
    assertFalse(startCancelled)
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
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")

    try {
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.ORDERED,
          T3VoiceBinderOperationOrdering.Activation(fence),
        ) {
          orderedStarted.countDown()
          releaseOrdered.await()
        },
      )
      assertTrue(orderedStarted.await(1, TimeUnit.SECONDS))

      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.INTERRUPT,
          T3VoiceBinderOperationOrdering.Stop(fence),
        ) {
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

  private fun queuedDispatcher(
    ordered: ArrayDeque<Runnable>,
    interrupts: ArrayDeque<Runnable>,
  ) = T3VoiceBinderOperationDispatcher(
    orderedPost = {
      ordered.addLast(it)
      true
    },
    interruptPost = {
      interrupts.addLast(it)
      true
    },
  )
}
