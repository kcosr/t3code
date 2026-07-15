package expo.modules.t3voice

enum class VoiceKernelHostIntentAction {
  ACTION_PRIMARY,
  ACTION_STOP,
  ACTION_TOGGLE_MUTE,
  ACTION_READINESS,
  ACTION_DISABLE_READINESS,
  ACTION_START_RECORDING,
  ACTION_START_PLAYBACK,
  ACTION_START_REALTIME,
}

enum class VoiceKernelDriver {
  MEDIA,
  NET,
  STORE,
  HOST,
}

sealed interface VoiceKernelMessage {
  /** M1 binds payloadKind to the real command union. */
  data class Command(
    val callerIdentity: String,
    val payloadKind: String,
  ) : VoiceKernelMessage

  data class HostIntent(
    val action: VoiceKernelHostIntentAction,
  ) : VoiceKernelMessage

  /** Concrete driver result payloads are bound at M1/M3. */
  data class DriverResult(
    val epoch: VoiceKernelEpoch,
    val driver: VoiceKernelDriver,
    val resultKind: String,
  ) : VoiceKernelMessage

  data class Tick(
    val timerId: String,
    val epoch: VoiceKernelEpoch,
  ) : VoiceKernelMessage

  /** Loaded-state payload is bound at M6. */
  data object Recover : VoiceKernelMessage
}
