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
    var startReachedAdmission = false
    var stopRan = false

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
      ) { admission ->
        startReachedAdmission = true
        startRan = admission.tryAdmit()
      },
    )
    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { admission -> stopRan = admission.tryAdmit() },
    )

    interrupts.removeFirst().run()
    ordered.removeFirst().run()

    assertTrue(stopRan)
    assertTrue(startReachedAdmission)
    assertFalse(startRan)
  }

  @Test
  fun oneStopCancelsEveryEarlierQueuedStartForTheFence() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var startsRan = 0
    var startsReachedAdmission = 0

    repeat(2) {
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.ORDERED,
          T3VoiceBinderOperationOrdering.Activation(fence),
        ) { admission ->
          startsReachedAdmission += 1
          if (admission.tryAdmit()) startsRan += 1
        },
      )
    }
    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { it.tryAdmit() },
    )

    interrupts.removeFirst().run()
    ordered.removeFirst().run()
    ordered.removeFirst().run()

    assertEquals(2, startsReachedAdmission)
    assertEquals(0, startsRan)
  }

  @Test
  fun laterStartForTheSameFenceCanRunAfterReconnect() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var firstAdmitted = true
    var reconnectedStartRan = false

    dispatcher.post(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationOrdering.Activation(fence),
    ) { firstAdmitted = it.tryAdmit() }
    dispatcher.post(
      T3VoiceBinderOperationLane.INTERRUPT,
      T3VoiceBinderOperationOrdering.Stop(fence),
    ) { it.tryAdmit() }
    dispatcher.post(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationOrdering.Activation(fence),
    ) { admission -> reconnectedStartRan = admission.tryAdmit() }

    interrupts.removeFirst().run()
    ordered.removeFirst().run()
    ordered.removeFirst().run()

    assertFalse(firstAdmitted)
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

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
      ) { admission -> startRan = admission.tryAdmit() },
    )
    assertFalse(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { it.tryAdmit() },
    )

    ordered.removeFirst().run()

    assertTrue(startRan)
  }

  @Test
  fun stopOnlyCancelsTheExactRuntimeAndModeFence() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)
    val firstFence = T3VoiceBinderOperationFence(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      "session",
    )
    val differentGeneration = firstFence.copy(
      identity = firstFence.identity.copy(generation = 2),
    )
    var firstAdmitted = false

    dispatcher.post(
      T3VoiceBinderOperationLane.ORDERED,
      T3VoiceBinderOperationOrdering.Activation(firstFence),
    ) { firstAdmitted = it.tryAdmit() }
    dispatcher.post(
      T3VoiceBinderOperationLane.INTERRUPT,
      T3VoiceBinderOperationOrdering.Stop(differentGeneration),
    ) { it.tryAdmit() }

    interrupts.removeFirst().run()
    ordered.removeFirst().run()

    assertTrue(firstAdmitted)
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
      dispatcher.post(T3VoiceBinderOperationLane.ORDERED) { admission ->
        assertTrue(admission.tryAdmit())
        results += "start"
        completed.countDown()
      }
      dispatcher.post(T3VoiceBinderOperationLane.ORDERED) { admission ->
        assertTrue(admission.tryAdmit())
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
        ) { admission ->
          assertTrue(admission.tryAdmit())
          orderedStarted.countDown()
          releaseOrdered.await()
        },
      )
      assertTrue(orderedStarted.await(1, TimeUnit.SECONDS))

      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.INTERRUPT,
          T3VoiceBinderOperationOrdering.Stop(fence),
        ) { admission ->
          assertTrue(admission.tryAdmit())
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

  @Test
  fun stopCancelsAStartPausedBetweenDispatcherAndServiceAdmission() {
    val orderedExecutor = Executors.newSingleThreadExecutor()
    val interruptExecutor = Executors.newSingleThreadExecutor()
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = {
        orderedExecutor.submit(it)
        true
      },
      interruptPost = {
        interruptExecutor.submit(it)
        true
      },
    )
    val reachedServiceBoundary = CountDownLatch(1)
    val releaseServiceAdmission = CountDownLatch(1)
    val stopCompleted = CountDownLatch(1)
    val startCompleted = CountDownLatch(1)
    val fence = T3VoiceBinderOperationFence(VoiceRuntimeIdentity("runtime", "instance", 1), "session")
    var startAdmitted = true

    try {
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.ORDERED,
          T3VoiceBinderOperationOrdering.Activation(fence),
        ) { admission ->
          reachedServiceBoundary.countDown()
          releaseServiceAdmission.await()
          startAdmitted = admission.tryAdmit()
          startCompleted.countDown()
        },
      )
      assertTrue(reachedServiceBoundary.await(1, TimeUnit.SECONDS))

      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.INTERRUPT,
          T3VoiceBinderOperationOrdering.Stop(fence),
        ) { admission ->
          assertTrue(admission.tryAdmit())
          stopCompleted.countDown()
        },
      )
      assertTrue(stopCompleted.await(1, TimeUnit.SECONDS))

      releaseServiceAdmission.countDown()
      assertTrue(startCompleted.await(1, TimeUnit.SECONDS))
      assertFalse(startAdmitted)
    } finally {
      releaseServiceAdmission.countDown()
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
