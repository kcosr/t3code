package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBinderOperationRegistryTest {
  @Test
  fun connectBeforeTimeoutDispatchesWithoutLettingTheLateTimerSettle() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    val (ticket, dispatch) = registry.register("prepare")
    assertNull(dispatch)

    val connected = registry.connected().single()

    assertEquals(ticket, connected.ticket)
    assertEquals("prepare", connected.value)
    assertNull(registry.timeout(ticket))
    assertEquals("prepare", registry.complete(ticket, connected.binderGeneration)?.value)
  }

  @Test
  fun disconnectReturnsQueuedAndInFlightOperationsForPromptFailure() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    registry.register("queued")
    registry.connected()
    registry.register("in-flight")

    assertEquals(setOf("queued", "in-flight"), registry.disconnected().map { it.value }.toSet())
    assertTrue(registry.disconnected().isEmpty())
  }

  @Test
  fun operationsRegisteredAfterBindingDeathWaitForTheReplacementGeneration() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    registry.connected()
    val (deadTicket, deadDispatch) = registry.register("dead")
    val deadGeneration = requireNotNull(deadDispatch).binderGeneration

    assertEquals("dead", registry.disconnected().single().value)
    val (replacementTicket, replacementDispatchBeforeConnect) = registry.register("replacement")
    assertNull(replacementDispatchBeforeConnect)
    val replacementDispatch = registry.connected().single()

    assertNull(registry.complete(deadTicket, deadGeneration))
    assertEquals(replacementTicket, replacementDispatch.ticket)
    assertEquals(
      "replacement",
      registry.complete(replacementTicket, replacementDispatch.binderGeneration)?.value,
    )
  }

  @Test
  fun timeoutWinsTheRaceAgainstAConnectExactlyOnce() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    val (ticket, _) = registry.register("prepare")

    assertEquals("prepare", registry.timeout(ticket)?.value)
    assertTrue(registry.connected().isEmpty())
    assertNull(registry.timeout(ticket))
  }

  @Test
  fun anOperationCanOnlySettleOnce() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    registry.connected()
    val (ticket, dispatch) = registry.register("answer")
    val generation = requireNotNull(dispatch).binderGeneration

    assertEquals("answer", registry.complete(ticket, generation)?.value)
    assertNull(registry.complete(ticket, generation))
    assertTrue(registry.disconnected().isEmpty())
  }

  @Test
  fun staleBinderGenerationCannotSettleAnOperationAfterReconnect() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    registry.connected()
    val (firstTicket, firstDispatch) = registry.register("first")
    val firstGeneration = requireNotNull(firstDispatch).binderGeneration
    registry.disconnected()
    registry.connected()
    val (secondTicket, secondDispatch) = registry.register("second")

    assertNull(registry.complete(firstTicket, firstGeneration))
    assertEquals(
      "second",
      registry.complete(secondTicket, requireNotNull(secondDispatch).binderGeneration)?.value,
    )
  }

  @Test
  fun disconnectedGenerationCannotExecuteAQueuedDispatch() {
    val registry = T3VoiceBinderOperationRegistry<String>()
    registry.connected()
    val (_, dispatch) = registry.register("queued")
    val queued = requireNotNull(dispatch)

    assertTrue(registry.isActive(queued.ticket, queued.binderGeneration))
    assertEquals("queued", registry.disconnected().single().value)
    assertFalse(registry.isActive(queued.ticket, queued.binderGeneration))
  }
}
