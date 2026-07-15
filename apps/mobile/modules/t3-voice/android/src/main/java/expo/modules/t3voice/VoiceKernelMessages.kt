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

internal fun T3VoiceControlCommand.toVoiceKernelHostIntentAction(): VoiceKernelHostIntentAction =
  when (this) {
    T3VoiceControlCommand.PRIMARY -> VoiceKernelHostIntentAction.ACTION_PRIMARY
    T3VoiceControlCommand.STOP -> VoiceKernelHostIntentAction.ACTION_STOP
    T3VoiceControlCommand.TOGGLE_MUTE -> VoiceKernelHostIntentAction.ACTION_TOGGLE_MUTE
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

  data class DriverResult(
    val epoch: VoiceKernelEpoch,
    val driver: VoiceKernelDriver,
    val resultKind: String,
    val payload: VoiceKernelDriverResultPayload,
  ) : VoiceKernelMessage

  data class Tick(
    val timerId: String,
    val epoch: VoiceKernelEpoch,
  ) : VoiceKernelMessage

  /** Loaded-state payload is bound at M6. */
  data object Recover : VoiceKernelMessage
}

sealed interface VoiceKernelDriverResultPayload {
  data class NetCompleted(
    val label: String,
    val continuation: () -> Unit,
  ) : VoiceKernelDriverResultPayload

  data class StorePersisted(
    val label: String,
    val result: Result<Unit>,
    val continuation: (Result<Unit>) -> Unit,
  ) : VoiceKernelDriverResultPayload

  data class MediaEvent(
    val eventKind: String,
    val continuation: () -> Unit,
  ) : VoiceKernelDriverResultPayload

  data class HostCompleted(
    val label: String,
    val result: Result<Unit>,
  ) : VoiceKernelDriverResultPayload
}
