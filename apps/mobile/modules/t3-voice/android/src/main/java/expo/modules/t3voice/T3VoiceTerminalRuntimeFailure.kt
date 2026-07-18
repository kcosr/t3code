package expo.modules.t3voice

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal data class T3VoiceTerminalRuntimeFailure(
  val failureId: Long,
  val generation: Long,
  val sequence: Long,
  val environmentId: String,
  val operation: T3VoiceOperation,
  val failure: T3VoiceFailure,
) {
  fun toBridgeBody(): Map<String, Any?> =
    mapOf(
      "failureId" to failureId.toDouble(),
      "generation" to generation.toDouble(),
      "sequence" to sequence.toDouble(),
      "environmentId" to environmentId,
      "operation" to operation.name.lowercase().replace('_', '-'),
      "failure" to
        mapOf(
          "code" to failure.code,
          "message" to failure.message,
          "retryable" to failure.recoverable,
        ),
    )
}

internal class T3VoiceTerminalRuntimeFailureQueue {
  private val nextFailureId = AtomicLong(0)
  private val pending = ArrayDeque<T3VoiceTerminalRuntimeFailure>()
  private val mutableHead = MutableStateFlow<T3VoiceTerminalRuntimeFailure?>(null)

  val head: StateFlow<T3VoiceTerminalRuntimeFailure?> = mutableHead.asStateFlow()

  @Synchronized
  fun publish(snapshot: T3VoiceControllerSnapshot): T3VoiceTerminalRuntimeFailure {
    val failed = snapshot.state as? T3VoiceControllerState.Failed
      ?: error("Only terminal Failed snapshots can be queued.")
    val event =
      T3VoiceTerminalRuntimeFailure(
        failureId = nextFailureId.incrementAndGet(),
        generation = snapshot.generation,
        sequence = snapshot.sequence,
        environmentId = failed.environmentId,
        operation = failed.operation,
        failure = failed.failure,
      )
    pending.addLast(event)
    if (pending.size == 1) mutableHead.value = event
    return event
  }

  @Synchronized
  fun acknowledge(failureId: Long): Boolean {
    if (pending.firstOrNull()?.failureId != failureId) return false
    pending.removeFirst()
    mutableHead.value = pending.firstOrNull()
    return true
  }
}

internal object T3VoiceTerminalRuntimeFailureStore {
  private val queue = T3VoiceTerminalRuntimeFailureQueue()

  val head: StateFlow<T3VoiceTerminalRuntimeFailure?> = queue.head

  fun publish(snapshot: T3VoiceControllerSnapshot) {
    queue.publish(snapshot)
  }

  fun acknowledge(failureId: Long) {
    queue.acknowledge(failureId)
  }
}
