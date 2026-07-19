package expo.modules.t3voice

internal enum class T3VoiceAudioFocusState {
  ACTIVE,
  SUSPENDED,
  TERMINATED,
}

internal enum class T3VoiceAudioFocusEvent {
  GAINED,
  LOST_TRANSIENTLY,
  DUCK_REQUESTED,
  LOST_PERMANENTLY,
  REQUEST_DENIED,
}

internal enum class T3VoiceAudioFocusAction {
  MUTE_CAPTURE,
  PAUSE_PLAYBACK,
  UNMUTE_CAPTURE,
  RESUME_PLAYBACK,
  TERMINATE_SESSION,
}

internal data class T3VoiceAudioFocusTransition(
  val state: T3VoiceAudioFocusState,
  val actions: List<T3VoiceAudioFocusAction>,
)

internal object T3VoiceAudioFocusPolicy {
  fun reduce(
    state: T3VoiceAudioFocusState,
    event: T3VoiceAudioFocusEvent,
  ): T3VoiceAudioFocusTransition =
    when (state) {
      T3VoiceAudioFocusState.ACTIVE -> reduceActive(event)
      T3VoiceAudioFocusState.SUSPENDED -> reduceSuspended(event)
      T3VoiceAudioFocusState.TERMINATED -> transition(T3VoiceAudioFocusState.TERMINATED)
    }

  private fun reduceActive(event: T3VoiceAudioFocusEvent): T3VoiceAudioFocusTransition =
    when (event) {
      T3VoiceAudioFocusEvent.GAINED -> transition(T3VoiceAudioFocusState.ACTIVE)
      T3VoiceAudioFocusEvent.LOST_TRANSIENTLY,
      T3VoiceAudioFocusEvent.DUCK_REQUESTED,
      ->
        transition(
          T3VoiceAudioFocusState.SUSPENDED,
          T3VoiceAudioFocusAction.MUTE_CAPTURE,
          T3VoiceAudioFocusAction.PAUSE_PLAYBACK,
        )
      T3VoiceAudioFocusEvent.LOST_PERMANENTLY,
      T3VoiceAudioFocusEvent.REQUEST_DENIED,
      ->
        transition(
          T3VoiceAudioFocusState.TERMINATED,
          T3VoiceAudioFocusAction.TERMINATE_SESSION,
        )
    }

  private fun reduceSuspended(event: T3VoiceAudioFocusEvent): T3VoiceAudioFocusTransition =
    when (event) {
      T3VoiceAudioFocusEvent.GAINED ->
        transition(
          T3VoiceAudioFocusState.ACTIVE,
          T3VoiceAudioFocusAction.UNMUTE_CAPTURE,
          T3VoiceAudioFocusAction.RESUME_PLAYBACK,
        )
      T3VoiceAudioFocusEvent.LOST_TRANSIENTLY,
      T3VoiceAudioFocusEvent.DUCK_REQUESTED,
      -> transition(T3VoiceAudioFocusState.SUSPENDED)
      T3VoiceAudioFocusEvent.LOST_PERMANENTLY,
      T3VoiceAudioFocusEvent.REQUEST_DENIED,
      ->
        transition(
          T3VoiceAudioFocusState.TERMINATED,
          T3VoiceAudioFocusAction.TERMINATE_SESSION,
        )
    }

  private fun transition(
    state: T3VoiceAudioFocusState,
    vararg actions: T3VoiceAudioFocusAction,
  ) = T3VoiceAudioFocusTransition(state = state, actions = actions.toList())
}

/** Keeps process-wide Android audio mutations behind a successful focus admission. */
internal object T3VoiceAudioRoleAdmissionPolicy {
  fun admit(
    requestFocus: () -> Boolean,
    establishAudioRole: () -> Unit,
  ): Boolean {
    if (!requestFocus()) return false
    establishAudioRole()
    return true
  }
}
