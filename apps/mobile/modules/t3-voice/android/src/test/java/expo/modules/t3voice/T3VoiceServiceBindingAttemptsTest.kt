package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceServiceBindingAttemptsTest {
  @Test
  fun initialBindFailureDoesNotUnbindAndAllowsANewAttempt() {
    val lock = Any()
    val state = T3VoiceServiceBindingState()
    val host = FakeBindingHost(bindResults = ArrayDeque(listOf(false, true)))
    val attempts = host.createAttempts(lock)

    val failedAttempt = state.startBindingRequest()
    val failed =
      attempts.bind(failedAttempt, host, FakeConnection(failedAttempt)) { succeeded ->
        state.completeBinding(failedAttempt, succeeded)
      }

    assertFalse(failed.available)
    assertEquals(listOf(failedAttempt), host.bindCalls)
    assertTrue(host.unbindCalls.isEmpty())
    attempts.release(failedAttempt)
    assertTrue(host.unbindCalls.isEmpty())

    val retryAttempt = state.startBindingRequest()
    val recovered =
      attempts.bind(retryAttempt, host, FakeConnection(retryAttempt)) { succeeded ->
        state.completeBinding(retryAttempt, succeeded)
      }

    assertTrue(recovered.available)
    assertEquals(listOf(failedAttempt, retryAttempt), host.bindCalls)
    assertTrue(state.connected(retryAttempt))
    attempts.release(requireNotNull(state.destroy()))
    assertEquals(listOf(retryAttempt), host.unbindCalls)
  }

  @Test
  fun releaseDuringAcceptedBindDefersOneUnbindAndStaleCompletionPreservesReplacement() {
    val lock = Any()
    val state = T3VoiceServiceBindingState()
    val host = FakeBindingHost(bindResults = ArrayDeque(listOf(true, true)))
    lateinit var attempts: T3VoiceServiceBindingAttempts<FakeBindingHost, FakeConnection>
    var replacementAttempt: Long? = null
    attempts = host.createAttempts(lock)
    val oldAttempt = state.startBindingRequest()
    host.beforeBindReturns = { connection ->
      if (connection.attemptId == oldAttempt) {
        assertTrue(state.invalidate(oldAttempt))
        val invalidated = requireNotNull(state.takeInvalidatedBinding(rebind = true))
        replacementAttempt = requireNotNull(invalidated.replacementAttemptId)
        attempts.release(invalidated.invalidatedAttemptId)
      }
    }

    val staleCompletion =
      attempts.bind(oldAttempt, host, FakeConnection(oldAttempt)) { succeeded ->
        state.completeBinding(oldAttempt, succeeded)
      }

    assertTrue(staleCompletion.available)
    assertTrue(staleCompletion.releaseAttempt)
    assertEquals(listOf(oldAttempt), host.unbindCalls)
    attempts.release(oldAttempt)
    assertEquals(listOf(oldAttempt), host.unbindCalls)

    host.beforeBindReturns = null
    val replacement = requireNotNull(replacementAttempt)
    attempts.bind(replacement, host, FakeConnection(replacement)) { succeeded ->
      state.completeBinding(replacement, succeeded)
    }
    assertFalse(state.connected(oldAttempt))
    assertTrue(state.connected(replacement))

    attempts.release(requireNotNull(state.destroy()))
    assertEquals(listOf(oldAttempt, replacement), host.unbindCalls)
  }

  @Test
  fun timeoutRetryAndDestroySettleEveryQueuedOperationAndReleaseEachAcceptedBindOnce() {
    val lock = Any()
    val state = T3VoiceServiceBindingState()
    val operations = T3VoiceBinderOperationRegistry<String>()
    val host = FakeBindingHost(bindResults = ArrayDeque(listOf(true, true)))
    val attempts = host.createAttempts(lock)

    val timedOutAttempt = state.startBindingRequest()
    attempts.bind(timedOutAttempt, host, FakeConnection(timedOutAttempt)) { succeeded ->
      state.completeBinding(timedOutAttempt, succeeded)
    }
    val (timedOutTicket, _) = operations.register("timed-out")
    operations.register("disconnected")

    assertEquals("timed-out", operations.timeout(timedOutTicket)?.value)
    assertEquals(timedOutAttempt, state.invalidateCurrent())
    assertEquals(listOf("disconnected"), operations.disconnected().map { it.value })
    assertNull(operations.timeout(timedOutTicket))

    val retry = requireNotNull(state.takeInvalidatedBinding(rebind = true))
    attempts.release(retry.invalidatedAttemptId)
    val retryAttempt = requireNotNull(retry.replacementAttemptId)
    attempts.bind(retryAttempt, host, FakeConnection(retryAttempt)) { succeeded ->
      state.completeBinding(retryAttempt, succeeded)
    }
    assertEquals(listOf(timedOutAttempt, retryAttempt), host.bindCalls)
    assertEquals(listOf(timedOutAttempt), host.unbindCalls)
    assertFalse(state.connected(timedOutAttempt))

    val (recoveredTicket, recoveredBeforeConnect) = operations.register("recovered")
    assertNull(recoveredBeforeConnect)
    val recoveredDispatch = operations.connected().single()
    assertTrue(state.connected(retryAttempt))
    assertEquals(recoveredTicket, recoveredDispatch.ticket)
    assertEquals(
      "recovered",
      operations.complete(recoveredTicket, recoveredDispatch.binderGeneration)?.value,
    )

    val (destroyedTicket, destroyedDispatch) = operations.register("destroyed")
    val destroyedGeneration = requireNotNull(destroyedDispatch).binderGeneration
    val bindingToRelease = requireNotNull(state.destroy())
    assertEquals(listOf("destroyed"), operations.destroy().map { it.value })
    attempts.release(bindingToRelease)

    assertNull(operations.complete(destroyedTicket, destroyedGeneration))
    attempts.release(bindingToRelease)
    assertEquals(listOf(timedOutAttempt, retryAttempt), host.unbindCalls)
    assertEquals(
      T3VoiceServiceBindingState.BindingRequestKind.DESTROYED,
      state.requestBinding().kind,
    )
  }

  private data class FakeConnection(val attemptId: Long)

  private class FakeBindingHost(
    private val bindResults: ArrayDeque<Boolean>,
  ) {
    val bindCalls = mutableListOf<Long>()
    val unbindCalls = mutableListOf<Long>()
    var beforeBindReturns: ((FakeConnection) -> Unit)? = null

    fun createAttempts(
      lock: Any,
    ): T3VoiceServiceBindingAttempts<FakeBindingHost, FakeConnection> =
      T3VoiceServiceBindingAttempts(
        lock = lock,
        bind = { host, connection -> host.bind(connection) },
        unbind = { host, connection -> host.unbind(connection) },
      )

    private fun bind(connection: FakeConnection): Boolean {
      bindCalls += connection.attemptId
      beforeBindReturns?.invoke(connection)
      return bindResults.removeFirst()
    }

    private fun unbind(connection: FakeConnection) {
      unbindCalls += connection.attemptId
    }
  }

  private fun T3VoiceServiceBindingState.startBindingRequest(): Long {
    val request = requestBinding()
    assertEquals(T3VoiceServiceBindingState.BindingRequestKind.START_BIND, request.kind)
    return requireNotNull(request.attemptId)
  }
}
