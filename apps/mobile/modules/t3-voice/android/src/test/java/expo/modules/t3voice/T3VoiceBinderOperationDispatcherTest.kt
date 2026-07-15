package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
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
    val stopLaneDrained = CountDownLatch(1)
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
      assertTrue(
        dispatcher.post(T3VoiceBinderOperationLane.INTERRUPT) { admission ->
          assertTrue(admission.tryAdmit())
          stopLaneDrained.countDown()
        },
      )
      assertTrue(stopLaneDrained.await(1, TimeUnit.SECONDS))

      releaseServiceAdmission.countDown()
      assertTrue(startCompleted.await(1, TimeUnit.SECONDS))
      assertFalse(startAdmitted)
      assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
    } finally {
      releaseServiceAdmission.countDown()
      orderedExecutor.shutdownNow()
      interruptExecutor.shutdownNow()
    }
  }

  @Test
  fun completedStartStopSessionsDoNotRetainOrderingState() {
    val ordered = ArrayDeque<Runnable>()
    val interrupts = ArrayDeque<Runnable>()
    val dispatcher = queuedDispatcher(ordered, interrupts)

    repeat(10_000) { index ->
      val fence = T3VoiceBinderOperationFence(
        VoiceRuntimeIdentity("runtime-$index", "instance-$index", index.toLong()),
        "session-$index",
      )
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.ORDERED,
          T3VoiceBinderOperationOrdering.Activation(fence),
        ) { assertTrue(it.tryAdmit()) },
      )
      ordered.removeFirst().run()
      assertTrue(
        dispatcher.post(
          T3VoiceBinderOperationLane.INTERRUPT,
          T3VoiceBinderOperationOrdering.Stop(fence),
        ) { assertTrue(it.tryAdmit()) },
      )
      interrupts.removeFirst().run()
    }

    assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
  }

  @Test
  fun rejectedOverlappingStopDoesNotResurrectACompletedTombstone() {
    var firstStop: Runnable? = null
    var interruptPosts = 0
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = { true },
      interruptPost = { runnable ->
        interruptPosts += 1
        if (interruptPosts == 1) {
          firstStop = runnable
          true
        } else {
          firstStop?.run()
          false
        }
      },
    )
    val fence = T3VoiceBinderOperationFence(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      "session",
    )

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) },
    )
    assertFalse(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) },
    )

    assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
  }

  @Test
  fun rejectedActivationRetiresAStopThatFinishedWhileItsPostWasBlocked() {
    val orderedPostEntered = CountDownLatch(1)
    val releaseOrderedPost = CountDownLatch(1)
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = {
        orderedPostEntered.countDown()
        releaseOrderedPost.await()
        false
      },
      interruptPost = {
        it.run()
        true
      },
    )
    val fence = T3VoiceBinderOperationFence(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      "session",
    )
    var activationAccepted = true
    val activationPost = Thread {
      activationAccepted = dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
      ) { assertTrue(it.tryAdmit()) }
    }

    activationPost.start()
    assertTrue(orderedPostEntered.await(1, TimeUnit.SECONDS))
    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) },
    )
    assertEquals(T3VoiceBinderOrderingRetention(1, 1), dispatcher.retainedOrderingCounts())

    releaseOrderedPost.countDown()
    activationPost.join(1_000)
    assertFalse(activationPost.isAlive)
    assertFalse(activationAccepted)
    assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
  }

  @Test
  fun concurrentRejectedStopsCannotRestoreEachOthersTombstones() {
    val ordered = ArrayDeque<Runnable>()
    val stopPostIndex = AtomicInteger()
    val stopPostEntered = listOf(CountDownLatch(1), CountDownLatch(1))
    val releaseStopPost = listOf(CountDownLatch(1), CountDownLatch(1))
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = {
        ordered.addLast(it)
        true
      },
      interruptPost = {
        val index = stopPostIndex.getAndIncrement()
        stopPostEntered[index].countDown()
        releaseStopPost[index].await()
        false
      },
    )
    val fence = T3VoiceBinderOperationFence(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      "session",
    )
    var activationAdmitted = false
    var firstStopAccepted = true
    var secondStopAccepted = true

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
      ) { activationAdmitted = it.tryAdmit() },
    )
    val firstStopPost = Thread {
      firstStopAccepted = dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) }
    }
    val secondStopPost = Thread {
      secondStopAccepted = dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) }
    }

    firstStopPost.start()
    assertTrue(stopPostEntered[0].await(1, TimeUnit.SECONDS))
    secondStopPost.start()
    assertTrue(stopPostEntered[1].await(1, TimeUnit.SECONDS))

    releaseStopPost[0].countDown()
    firstStopPost.join(1_000)
    assertFalse(firstStopPost.isAlive)
    assertFalse(firstStopAccepted)

    releaseStopPost[1].countDown()
    secondStopPost.join(1_000)
    assertFalse(secondStopPost.isAlive)
    assertFalse(secondStopAccepted)

    ordered.removeFirst().run()
    assertTrue(activationAdmitted)
    assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
  }

  @Test
  fun registeringStopDoesNotCancelActivationWhenItsPostIsRejected() {
    val ordered = ArrayDeque<Runnable>()
    val stopPostEntered = CountDownLatch(1)
    val releaseStopPost = CountDownLatch(1)
    val dispatcher = T3VoiceBinderOperationDispatcher(
      orderedPost = {
        ordered.addLast(it)
        true
      },
      interruptPost = {
        stopPostEntered.countDown()
        releaseStopPost.await()
        false
      },
    )
    val fence = T3VoiceBinderOperationFence(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      "session",
    )
    var activationAdmitted = false
    var stopAccepted = true

    assertTrue(
      dispatcher.post(
        T3VoiceBinderOperationLane.ORDERED,
        T3VoiceBinderOperationOrdering.Activation(fence),
      ) { activationAdmitted = it.tryAdmit() },
    )
    val stopPost = Thread {
      stopAccepted = dispatcher.post(
        T3VoiceBinderOperationLane.INTERRUPT,
        T3VoiceBinderOperationOrdering.Stop(fence),
      ) { assertTrue(it.tryAdmit()) }
    }
    stopPost.start()
    assertTrue(stopPostEntered.await(1, TimeUnit.SECONDS))

    ordered.removeFirst().run()
    assertTrue(activationAdmitted)

    releaseStopPost.countDown()
    stopPost.join(1_000)
    assertFalse(stopPost.isAlive)
    assertFalse(stopAccepted)
    assertEquals(T3VoiceBinderOrderingRetention(0, 0), dispatcher.retainedOrderingCounts())
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
