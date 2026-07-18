package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceTerminalRuntimeFailureQueueTest {
  @Test
  fun failuresRemainOrderedAndReplayUntilTheirExactAcknowledgement() {
    val queue = T3VoiceTerminalRuntimeFailureQueue()
    val first = queue.publish(failedSnapshot(generation = 2, sequence = 8, code = "first"))
    val second = queue.publish(failedSnapshot(generation = 3, sequence = 12, code = "second"))

    assertEquals(first, queue.head.value)
    assertFalse(queue.acknowledge(second.failureId))
    assertEquals(first, queue.head.value)
    assertTrue(queue.acknowledge(first.failureId))
    assertEquals(second, queue.head.value)
    assertFalse(queue.acknowledge(first.failureId))
    assertTrue(queue.acknowledge(second.failureId))
    assertNull(queue.head.value)
  }

  @Test
  fun failureIdentityIsStoreOwnedRatherThanControllerGeneration() {
    val queue = T3VoiceTerminalRuntimeFailureQueue()

    val beforeServiceRecreation = queue.publish(failedSnapshot(1, 4, "before"))
    val afterServiceRecreation = queue.publish(failedSnapshot(1, 4, "after"))

    assertEquals(beforeServiceRecreation.failureId + 1, afterServiceRecreation.failureId)
  }

  private fun failedSnapshot(
    generation: Long,
    sequence: Long,
    code: String,
  ): T3VoiceControllerSnapshot =
    T3VoiceControllerSnapshot(
      state =
        T3VoiceControllerState.Failed(
          environmentId = "environment-a",
          operation = T3VoiceOperation.THREAD,
          failure = T3VoiceFailure(code, "$code failed.", recoverable = true),
        ),
      generation = generation,
      sequence = sequence,
    )
}
