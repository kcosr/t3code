package expo.modules.t3voice

internal data class T3VoiceCaptureState(
  val userMuted: Boolean = false,
  val focusSuspended: Boolean = false,
  val terminalFenced: Boolean = false,
) {
  val effectiveMuted: Boolean
    get() = userMuted || focusSuspended || terminalFenced

  val recordingEnabled: Boolean
    get() = !focusSuspended && !terminalFenced
}

internal object T3VoiceCapturePolicy {
  fun setUserMuted(state: T3VoiceCaptureState, muted: Boolean): T3VoiceCaptureState =
    state.copy(userMuted = muted)

  fun setFocusSuspended(state: T3VoiceCaptureState, suspended: Boolean): T3VoiceCaptureState =
    state.copy(focusSuspended = suspended)

  fun fenceTerminalInput(state: T3VoiceCaptureState): T3VoiceCaptureState =
    state.copy(terminalFenced = true)
}
