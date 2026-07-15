package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeRealtimeBinderOffloadTest {
  private val identity = VoiceRuntimeIdentity("runtime", "instance", 1)
  private val fence = VoiceRuntimeRealtimeFence(identity, "mode")

  @Test
  fun startReceiptPrecedesRemoteCompletion() {
    val starts = ArrayDeque<Runnable>()
    val controls = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload(starts::addLast, controls::addLast)
    val engine = FakeEngine(
      startAdmission = pendingStart(),
      startCompletionFailure = VoiceRuntimeFenceException("network failed"),
    )

    val result = offload.submitStart(engine::admitStart, engine::completeStart)

    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false), result)
    assertEquals(0, engine.startCompletionCount)
    assertTrue(runCatching { starts.removeFirst().run() }.isFailure)
    assertEquals(1, engine.startCompletionCount)
  }

  @Test
  fun noMatchPresentationStillAcknowledgesTheControllerWithoutCallingTheEngine() {
    val controls = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload({}, controls::addLast)
    val engine = FakeEngine(acknowledgementFailure = AssertionError("engine must not run"))
    var controllerAcknowledgements = 0
    var failures = 0

    offload.submitPresentationAcknowledgement(
      hasRealtimeMatch = false,
      operation = engine::acknowledgePresentation,
      onAcknowledged = { controllerAcknowledgements += 1 },
      onFailure = { failures += 1 },
      failure = { VoiceRuntimeFenceException("rejected") },
    )

    assertEquals(1, controllerAcknowledgements)
    assertEquals(0, engine.acknowledgementCount)
    assertEquals(0, failures)
    assertTrue(controls.isEmpty())
  }

  @Test
  fun focusAdmissionIsSynchronousAndRemoteCompletionIsOffloaded() {
    val controls = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload({}, controls::addLast)
    val rejected = FakeEngine(focusAdmission = false)
    val remoteRejected = FakeEngine(focusResult = false)
    val throwing = FakeEngine(focusFailure = VoiceRuntimeFenceException("network failed"))
    val failures = mutableListOf<Throwable>()

    assertFalse(
      offload.submitFocus(
        rejected::admitFocus,
        rejected::updateFocus,
        failures::add,
      ) { VoiceRuntimeFenceException("rejected focus") },
    )
    assertTrue(controls.isEmpty())
    assertEquals(0, rejected.focusCompletionCount)

    assertTrue(
      offload.submitFocus(
        remoteRejected::admitFocus,
        remoteRejected::updateFocus,
        failures::add,
      ) { VoiceRuntimeFenceException("rejected focus") },
    )
    assertTrue(
      offload.submitFocus(
        throwing::admitFocus,
        throwing::updateFocus,
        failures::add,
      ) { VoiceRuntimeFenceException("rejected focus") },
    )
    assertEquals(0, throwing.focusCompletionCount)
    assertTrue(failures.isEmpty())

    controls.removeFirst().run()
    controls.removeFirst().run()

    assertEquals(2, failures.size)
    assertTrue(failures.all { it is VoiceRuntimeFenceException })
    assertEquals(1, remoteRejected.focusCompletionCount)
    assertEquals(1, throwing.focusCompletionCount)
  }

  @Test
  fun matchedPresentationGatesControllerAcknowledgementOnEngineSuccess() {
    val controls = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload({}, controls::addLast)
    val rejected = FakeEngine(acknowledgementResult = false)
    val throwing = FakeEngine(
      acknowledgementFailure = VoiceRuntimeFenceException("stale action"),
    )
    val accepted = FakeEngine(acknowledgementResult = true)
    var controllerAcknowledgements = 0
    val failures = mutableListOf<Throwable>()

    listOf(rejected, throwing, accepted).forEach { engine ->
      offload.submitPresentationAcknowledgement(
        hasRealtimeMatch = true,
        operation = engine::acknowledgePresentation,
        onAcknowledged = { controllerAcknowledgements += 1 },
        onFailure = failures::add,
        failure = { VoiceRuntimeFenceException("rejected action") },
      )
    }
    assertEquals(0, controllerAcknowledgements)

    controls.removeFirst().run()
    controls.removeFirst().run()
    controls.removeFirst().run()

    assertEquals(1, controllerAcknowledgements)
    assertEquals(2, failures.size)
    assertTrue(failures.all { it is VoiceRuntimeFenceException })
  }

  @Test
  fun startAdmissionPropagatesEngineExceptionsAndPreservesReplay() {
    val starts = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload(starts::addLast, {})
    val idempotencyFailure = FakeEngine(
      startAdmissionFailure = VoiceRuntimeIdempotencyConflictException(),
    )
    val fenceFailure = FakeEngine(
      startAdmissionFailure = VoiceRuntimeFenceException("stale start"),
    )
    val replay = FakeEngine(
      startAdmission = VoiceRuntimeRealtimeStartAdmission.Settled(
        VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false, replayed = true),
      ),
    )

    assertTrue(
      runCatching { offload.submitStart(idempotencyFailure::admitStart, idempotencyFailure::completeStart) }
        .exceptionOrNull() is VoiceRuntimeIdempotencyConflictException,
    )
    assertTrue(
      runCatching { offload.submitStart(fenceFailure::admitStart, fenceFailure::completeStart) }
        .exceptionOrNull() is VoiceRuntimeFenceException,
    )
    assertEquals(
      VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false, replayed = true),
      offload.submitStart(replay::admitStart, replay::completeStart),
    )
    assertTrue(starts.isEmpty())
  }

  private fun pendingStart() = VoiceRuntimeRealtimeStartAdmission.Pending(
    commandId = "start",
    fingerprint = "start:$fence",
    fence = fence,
    result = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false),
  )

  private class FakeEngine(
    private val startAdmission: VoiceRuntimeRealtimeStartAdmission =
      VoiceRuntimeRealtimeStartAdmission.Settled(
        VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false),
      ),
    private val startAdmissionFailure: Throwable? = null,
    private val startCompletionFailure: Throwable? = null,
    private val focusAdmission: Boolean = true,
    private val focusResult: Boolean = true,
    private val focusFailure: Throwable? = null,
    private val acknowledgementResult: Boolean = true,
    private val acknowledgementFailure: Throwable? = null,
  ) {
    var startCompletionCount = 0
      private set
    var acknowledgementCount = 0
      private set
    var focusCompletionCount = 0
      private set

    fun admitStart(): VoiceRuntimeRealtimeStartAdmission {
      startAdmissionFailure?.let { throw it }
      return startAdmission
    }

    fun completeStart(@Suppress("UNUSED_PARAMETER") admission: VoiceRuntimeRealtimeStartAdmission.Pending) {
      startCompletionCount += 1
      startCompletionFailure?.let { throw it }
    }

    fun admitFocus() = focusAdmission

    fun updateFocus(): Boolean {
      focusCompletionCount += 1
      focusFailure?.let { throw it }
      return focusResult
    }

    fun acknowledgePresentation(): Boolean {
      acknowledgementCount += 1
      acknowledgementFailure?.let { throw it }
      return acknowledgementResult
    }
  }
}
