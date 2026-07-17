package expo.modules.t3voice

/** Tracks the module's single current service-binding attempt. Callers provide synchronization. */
internal class T3VoiceServiceBindingState {
  enum class BindingRequestKind {
    DESTROYED,
    ACTIVE,
    START_BIND,
  }

  data class BindingRequest(
    val kind: BindingRequestKind,
    val attemptId: Long?,
  )

  data class BindingCompletion(
    val available: Boolean,
    val releaseAttempt: Boolean,
  )

  data class InvalidatedBinding(
    val invalidatedAttemptId: Long,
    val replacementAttemptId: Long?,
  )

  private enum class State {
    UNBOUND,
    BINDING,
    REGISTERED,
    CONNECTED,
    INVALIDATED,
    DESTROYED,
  }

  private var state = State.UNBOUND
  private var currentAttemptId: Long? = null
  private var nextAttemptId = 0L

  fun reset() {
    state = State.UNBOUND
    currentAttemptId = null
  }

  fun requestBinding(): BindingRequest =
    when (state) {
      State.DESTROYED -> BindingRequest(BindingRequestKind.DESTROYED, null)
      State.UNBOUND ->
        BindingRequest(BindingRequestKind.START_BIND, startBindingAttempt())
      State.BINDING,
      State.REGISTERED,
      State.CONNECTED,
      State.INVALIDATED,
      -> BindingRequest(BindingRequestKind.ACTIVE, currentAttemptId)
    }

  fun completeBinding(attemptId: Long, succeeded: Boolean): BindingCompletion {
    if (attemptId != currentAttemptId) {
      return BindingCompletion(available = isAvailable(), releaseAttempt = succeeded)
    }
    return when (state) {
      State.BINDING -> {
        state = if (succeeded) State.REGISTERED else State.UNBOUND
        if (!succeeded) currentAttemptId = null
        BindingCompletion(available = succeeded, releaseAttempt = false)
      }
      State.CONNECTED -> {
        if (!succeeded) {
          state = State.UNBOUND
          currentAttemptId = null
        }
        BindingCompletion(available = succeeded, releaseAttempt = false)
      }
      State.REGISTERED -> BindingCompletion(available = true, releaseAttempt = false)
      State.INVALIDATED -> BindingCompletion(available = true, releaseAttempt = false)
      State.DESTROYED -> BindingCompletion(available = false, releaseAttempt = succeeded)
      State.UNBOUND -> BindingCompletion(available = false, releaseAttempt = succeeded)
    }
  }

  fun connected(attemptId: Long): Boolean {
    if (attemptId != currentAttemptId) return false
    if (state != State.BINDING && state != State.REGISTERED) return false
    state = State.CONNECTED
    return true
  }

  fun disconnected(attemptId: Long): Boolean {
    if (attemptId != currentAttemptId || state != State.CONNECTED) return false
    state = State.REGISTERED
    return true
  }

  fun invalidate(attemptId: Long): Boolean {
    if (attemptId != currentAttemptId) return false
    return invalidateCurrent() != null
  }

  fun invalidateCurrent(): Long? =
    when (state) {
      State.BINDING,
      State.REGISTERED,
      State.CONNECTED,
      -> requireNotNull(currentAttemptId).also { state = State.INVALIDATED }
      State.UNBOUND,
      State.INVALIDATED,
      State.DESTROYED,
      -> null
    }

  fun takeInvalidatedBinding(rebind: Boolean): InvalidatedBinding? {
    if (state != State.INVALIDATED) return null
    val invalidatedAttemptId = requireNotNull(currentAttemptId)
    val replacementAttemptId = if (rebind) startBindingAttempt() else null
    if (!rebind) {
      state = State.UNBOUND
      currentAttemptId = null
    }
    return InvalidatedBinding(invalidatedAttemptId, replacementAttemptId)
  }

  fun isAvailable(): Boolean =
    when (state) {
      State.BINDING,
      State.REGISTERED,
      State.CONNECTED,
      State.INVALIDATED,
      -> true
      State.UNBOUND,
      State.DESTROYED,
      -> false
    }

  fun isDestroyed(): Boolean = state == State.DESTROYED

  fun hasInvalidatedBinding(): Boolean = state == State.INVALIDATED

  fun destroy(): Long? {
    val attemptId = currentAttemptId
    state = State.DESTROYED
    currentAttemptId = null
    return attemptId
  }

  private fun startBindingAttempt(): Long {
    nextAttemptId += 1
    state = State.BINDING
    currentAttemptId = nextAttemptId
    return nextAttemptId
  }
}
