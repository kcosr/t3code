package expo.modules.t3voice

import java.util.concurrent.ExecutionException
import java.util.concurrent.FutureTask

internal class VoiceRuntimeRealtimeBinderOffload(
  private val startPost: (Runnable) -> Unit,
  private val controlPost: (Runnable) -> Unit,
) {
  fun submitStart(
    admit: () -> VoiceRuntimeRealtimeStartAdmission,
    complete: (VoiceRuntimeRealtimeStartAdmission.Pending) -> Unit,
  ): VoiceRuntimeRealtimeCommandResult {
    val admission = admit()
    if (admission is VoiceRuntimeRealtimeStartAdmission.Pending) {
      startPost { complete(admission) }
    }
    return admission.result
  }

  private fun submitControl(body: () -> Unit): VoiceRuntimeRealtimeCommandResult.Accepted {
    controlPost(Runnable(body))
    return admittedResult()
  }

  fun submitFocus(
    operation: () -> Boolean,
    onFailure: (Throwable) -> Unit,
  ): Boolean = submitControlAndAwait {
    runCatching(operation).onFailure(onFailure).getOrDefault(false)
  }

  fun submitAcknowledgement(
    operation: () -> Boolean,
    onAcknowledged: () -> Unit,
    onFailure: (Throwable) -> Unit,
    failure: () -> Throwable,
  ): VoiceRuntimeRealtimeCommandResult.Accepted = submitControl {
    runCatching {
      if (!operation()) throw failure()
      onAcknowledged()
    }.onFailure(onFailure)
  }

  fun submitPresentationAcknowledgement(
    hasRealtimeMatch: Boolean,
    operation: () -> Boolean,
    onAcknowledged: () -> Unit,
    onFailure: (Throwable) -> Unit,
    failure: () -> Throwable,
  ) {
    if (!hasRealtimeMatch) {
      onAcknowledged()
      return
    }
    submitAcknowledgement(operation, onAcknowledged, onFailure, failure)
  }

  private fun submitControlAndAwait(body: () -> Boolean): Boolean {
    val task = FutureTask(body)
    controlPost(task)
    return try {
      task.get()
    } catch (failure: ExecutionException) {
      throw failure.cause ?: failure
    } catch (interrupted: InterruptedException) {
      Thread.currentThread().interrupt()
      throw interrupted
    }
  }

  private fun admittedResult() = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
}
