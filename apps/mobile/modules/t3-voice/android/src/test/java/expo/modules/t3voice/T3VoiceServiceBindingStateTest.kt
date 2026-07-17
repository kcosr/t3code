package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceServiceBindingStateTest {
  @Test
  fun failedInitialBindAllowsTheNextBridgeRequestToStartANewAttempt() {
    val state = T3VoiceServiceBindingState()
    val first = state.startBindingRequest()

    assertFalse(state.completeBinding(first, succeeded = false).available)

    val retry = state.startBindingRequest()
    assertTrue(retry > first)
  }

  @Test
  fun concurrentBridgeRequestsJoinOneInFlightAttempt() {
    val state = T3VoiceServiceBindingState()
    val attemptId = state.startBindingRequest()

    val second = state.requestBinding()
    val third = state.requestBinding()

    assertEquals(T3VoiceServiceBindingState.BindingRequestKind.ACTIVE, second.kind)
    assertEquals(attemptId, second.attemptId)
    assertEquals(T3VoiceServiceBindingState.BindingRequestKind.ACTIVE, third.kind)
    assertEquals(attemptId, third.attemptId)
  }

  @Test
  fun connectionTimeoutReleasesAcceptedAttemptAndMakesLaterRetryRecoverable() {
    val state = T3VoiceServiceBindingState()
    val timedOutAttempt = state.startBindingRequest()
    assertTrue(state.completeBinding(timedOutAttempt, succeeded = true).available)

    assertEquals(timedOutAttempt, state.invalidateCurrent())
    val cleanup = requireNotNull(state.takeInvalidatedBinding(rebind = false))
    assertEquals(timedOutAttempt, cleanup.invalidatedAttemptId)
    assertNull(cleanup.replacementAttemptId)

    val retryAttempt = state.startBindingRequest()
    assertTrue(retryAttempt > timedOutAttempt)
  }

  @Test
  fun connectionTimeoutCanReserveExactlyOneImmediateReplacement() {
    val state = T3VoiceServiceBindingState()
    val timedOutAttempt = state.startBindingRequest()
    assertTrue(state.completeBinding(timedOutAttempt, succeeded = true).available)
    assertEquals(timedOutAttempt, state.invalidateCurrent())

    val replacement = requireNotNull(state.takeInvalidatedBinding(rebind = true))
    val replacementId = requireNotNull(replacement.replacementAttemptId)

    assertTrue(replacementId > timedOutAttempt)
    assertEquals(T3VoiceServiceBindingState.BindingRequestKind.ACTIVE, state.requestBinding().kind)
    assertNull(state.takeInvalidatedBinding(rebind = true))
  }

  @Test
  fun lateOldBindCompletionCannotCorruptReplacementAttempt() {
    val state = T3VoiceServiceBindingState()
    val oldAttempt = state.startBindingRequest()
    assertTrue(state.invalidate(oldAttempt))
    val replacement =
      requireNotNull(state.takeInvalidatedBinding(rebind = true)).replacementAttemptId!!

    val staleCompletion = state.completeBinding(oldAttempt, succeeded = true)

    assertTrue(staleCompletion.available)
    assertTrue(staleCompletion.releaseAttempt)
    assertEquals(replacement, state.requestBinding().attemptId)
    assertTrue(state.completeBinding(replacement, succeeded = true).available)
    assertTrue(state.connected(replacement))
  }

  @Test
  fun staleConnectedCallbackCannotResurrectInvalidatedAttempt() {
    val state = T3VoiceServiceBindingState()
    val attemptId = state.startBindingRequest()
    assertTrue(state.completeBinding(attemptId, succeeded = true).available)
    assertTrue(state.invalidate(attemptId))

    assertFalse(state.connected(attemptId))
    assertTrue(state.hasInvalidatedBinding())
  }

  @Test
  fun staleConnectedCallbackCannotResurrectUnboundAttempt() {
    val state = T3VoiceServiceBindingState()
    val attemptId = state.startBindingRequest()
    assertFalse(state.completeBinding(attemptId, succeeded = false).available)

    assertFalse(state.connected(attemptId))
    assertFalse(state.isAvailable())
  }

  @Test
  fun callbackFromOldAttemptIsRejectedAfterReplacementStarts() {
    val state = T3VoiceServiceBindingState()
    val oldAttempt = state.startBindingRequest()
    assertTrue(state.completeBinding(oldAttempt, succeeded = true).available)
    assertTrue(state.invalidate(oldAttempt))
    val replacement =
      requireNotNull(state.takeInvalidatedBinding(rebind = true)).replacementAttemptId!!

    assertFalse(state.connected(oldAttempt))
    assertTrue(state.completeBinding(replacement, succeeded = true).available)
    assertTrue(state.connected(replacement))
  }

  @Test
  fun bindCompletionAfterDestroyOnlyReleasesItsOwnAttempt() {
    val state = T3VoiceServiceBindingState()
    val attemptId = state.startBindingRequest()

    assertEquals(attemptId, state.destroy())
    val completion = state.completeBinding(attemptId, succeeded = true)

    assertFalse(completion.available)
    assertTrue(completion.releaseAttempt)
    assertEquals(
      T3VoiceServiceBindingState.BindingRequestKind.DESTROYED,
      state.requestBinding().kind,
    )
  }

  private fun T3VoiceServiceBindingState.startBindingRequest(): Long {
    val request = requestBinding()
    assertEquals(T3VoiceServiceBindingState.BindingRequestKind.START_BIND, request.kind)
    return requireNotNull(request.attemptId)
  }
}
