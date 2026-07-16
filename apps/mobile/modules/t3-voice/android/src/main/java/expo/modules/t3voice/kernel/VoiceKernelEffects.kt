package expo.modules.t3voice.kernel

enum class VoiceKernelEffectFamily {
  MEDIA,
  NET,
  STORE,
  HOST,
  LOCAL,
}

sealed interface VoiceKernelEffect {
  val epoch: VoiceKernelEpoch
  val family: VoiceKernelEffectFamily

  data class StartRecording(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class StopRecording(
    override val epoch: VoiceKernelEpoch,
    val reason: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class StartPlayback(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class EnqueuePcm(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class FinishPlayback(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class CancelPlayback(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class PlayCue(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class PreparePeer(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class ApplyAnswer(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class SetMicEnabled(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class SetMuted(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class DrainPlayout(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class StopPeer(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class SetRoute(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
    // payload bound at M1/M3
  }

  data class ObserveTimeout(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
    val deadline: Long,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.MEDIA
  }

  data class ThreadTurnCall(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
    // payload bound at M1/M3
  }

  data class RealtimeCall(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
    // payload bound at M1/M3
  }

  data class StartLongPoll(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
  }

  data class StopLongPoll(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
  }

  data class Heartbeat(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
  }

  data class CancelAll(
    override val epoch: VoiceKernelEpoch,
    val scope: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.NET
  }

  data class Persist(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.STORE
    // payload bound at M1/M3
  }

  data class Load(
    override val epoch: VoiceKernelEpoch,
    val kind: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.STORE
  }

  data class Clear(
    override val epoch: VoiceKernelEpoch,
    val fence: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.STORE
  }

  data class SetForeground(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
    // payload bound at M1/M3
  }

  data class RenderNotification(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
    // payload bound at M1/M3
  }

  data class SetWakeLock(
    override val epoch: VoiceKernelEpoch,
    val enabled: Boolean,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
  }

  data class SetMediaSession(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
    // payload bound at M1/M3
  }

  data class KeepStarted(
    override val epoch: VoiceKernelEpoch,
    val action: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
  }

  data class StopSelfIfIdle(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.HOST
  }

  data class EmitEvent(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.LOCAL
    // payload bound at M1/M3
  }

  data class SettleCommand(
    override val epoch: VoiceKernelEpoch,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.LOCAL
    // payload bound at M1/M3
  }

  data class ScheduleTick(
    override val epoch: VoiceKernelEpoch,
    val timerId: String,
    val delay: Long,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.LOCAL
  }

  data class CancelTick(
    override val epoch: VoiceKernelEpoch,
    val timerId: String,
  ) : VoiceKernelEffect {
    override val family = VoiceKernelEffectFamily.LOCAL
  }
}
