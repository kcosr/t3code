package expo.modules.t3voice

internal data class T3VoiceCaptureState(
  val userMuted: Boolean = false,
  val focusSuspended: Boolean = false,
  val terminalFenced: Boolean = false,
  /** False until Ready cue completes (or cues are disabled / fail-open). */
  val inputReady: Boolean = false,
) {
  val effectiveMuted: Boolean
    get() = userMuted || focusSuspended || terminalFenced || !inputReady

  val recordingEnabled: Boolean
    get() = inputReady && !focusSuspended && !terminalFenced
}

internal object T3VoiceCapturePolicy {
  fun setUserMuted(state: T3VoiceCaptureState, muted: Boolean): T3VoiceCaptureState =
    state.copy(userMuted = muted)

  fun setFocusSuspended(state: T3VoiceCaptureState, suspended: Boolean): T3VoiceCaptureState =
    state.copy(focusSuspended = suspended)

  fun fenceTerminalInput(state: T3VoiceCaptureState): T3VoiceCaptureState =
    state.copy(terminalFenced = true)

  fun setInputReady(state: T3VoiceCaptureState, ready: Boolean): T3VoiceCaptureState =
    state.copy(inputReady = ready)
}
