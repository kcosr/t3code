package expo.modules.t3voice

data class VoiceKernelReduction(
  val state: VoiceKernelState,
  val effects: List<VoiceKernelEffect>,
)

interface VoiceKernelReducer {
  fun reduce(
    state: VoiceKernelState,
    message: VoiceKernelMessage,
  ): VoiceKernelReduction
}

/**
 * Placeholder for the MediaArbiterState, ThreadModeState, RealtimeState,
 * AuthorityReadinessState, and HostState component slots.
 */
class VoiceKernelState
