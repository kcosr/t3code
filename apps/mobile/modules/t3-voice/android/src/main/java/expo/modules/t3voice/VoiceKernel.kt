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
 * Placeholder for the MediaArbiterState, ThreadModeState, AuthorityReadinessState,
 * and HostState component slots. RealtimeState is owned by its installed slot binding.
 */
class VoiceKernelState
