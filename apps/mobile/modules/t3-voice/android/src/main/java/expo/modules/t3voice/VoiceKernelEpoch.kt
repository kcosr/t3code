package expo.modules.t3voice

data class VoiceKernelEpoch(
  val runtimeInstanceId: String,
  val authorityGeneration: Long,
  val rootOperationId: String,
  val attemptOrdinal: Long,
)

enum class VoiceKernelEpochStalenessDimension {
  RUNTIME_INSTANCE,
  AUTHORITY_GENERATION,
  ROOT_OPERATION,
  ATTEMPT,
}

sealed interface VoiceKernelEpochAdmission {
  data object Admit : VoiceKernelEpochAdmission

  data class DropStale(
    val dimension: VoiceKernelEpochStalenessDimension,
  ) : VoiceKernelEpochAdmission
}

object VoiceKernelEpochPolicy {
  fun admit(
    currentEpoch: VoiceKernelEpoch,
    resultEpoch: VoiceKernelEpoch,
  ): VoiceKernelEpochAdmission {
    if (currentEpoch.runtimeInstanceId != resultEpoch.runtimeInstanceId) {
      return VoiceKernelEpochAdmission.DropStale(
        VoiceKernelEpochStalenessDimension.RUNTIME_INSTANCE,
      )
    }
    if (currentEpoch.authorityGeneration != resultEpoch.authorityGeneration) {
      return VoiceKernelEpochAdmission.DropStale(
        VoiceKernelEpochStalenessDimension.AUTHORITY_GENERATION,
      )
    }
    if (currentEpoch.rootOperationId != resultEpoch.rootOperationId) {
      return VoiceKernelEpochAdmission.DropStale(
        VoiceKernelEpochStalenessDimension.ROOT_OPERATION,
      )
    }
    if (currentEpoch.attemptOrdinal != resultEpoch.attemptOrdinal) {
      return VoiceKernelEpochAdmission.DropStale(
        VoiceKernelEpochStalenessDimension.ATTEMPT,
      )
    }
    return VoiceKernelEpochAdmission.Admit
  }
}

internal enum class VoiceKernelEpochRootKind {
  THREAD_TURN,
  REALTIME_MODE,
  REALTIME_PEER,
  RECORDING,
  PLAYBACK,
  CUE,
  TIMER,
  SERVICE,
}

/** Kernel-owned attempt ordinals and the current epoch for every independently fenced root. */
internal class VoiceKernelEpochRegistry {
  private data class Entry(
    val kind: VoiceKernelEpochRootKind,
    val epoch: VoiceKernelEpoch,
    var cueTerminalConsumed: Boolean = false,
  )

  private val entries = mutableMapOf<String, Entry>()

  /**
   * Registry-global ordinal: every armed life is globally unique, so a root re-armed after
   * [retire] can never collide with a late result stamped by a retired life.
   */
  private var nextAttemptOrdinal = 1L

  fun arm(
    kind: VoiceKernelEpochRootKind,
    runtimeInstanceId: String,
    authorityGeneration: Long,
    rootOperationId: String,
  ): VoiceKernelEpoch {
    require(runtimeInstanceId.isNotBlank()) { "Epoch runtime instance must be non-empty." }
    require(rootOperationId.isNotBlank()) { "Epoch root operation must be non-empty." }
    require(authorityGeneration >= 0) { "Epoch authority generation cannot be negative." }
    return VoiceKernelEpoch(
      runtimeInstanceId,
      authorityGeneration,
      rootOperationId,
      nextAttemptOrdinal++,
    ).also { entries[rootOperationId] = Entry(kind, it) }
  }

  fun current(rootOperationId: String): VoiceKernelEpoch? = entries[rootOperationId]?.epoch

  /** Removes the root's entry only if it still holds exactly this epoch. */
  fun retire(epoch: VoiceKernelEpoch) {
    val entry = entries[epoch.rootOperationId] ?: return
    if (entry.epoch == epoch) entries.remove(epoch.rootOperationId)
  }

  fun size(): Int = entries.size

  /** Admits the first terminal for each current cue root without a second historical epoch set. */
  fun admitCueTerminal(epoch: VoiceKernelEpoch): Boolean {
    val entry = entries[epoch.rootOperationId] ?: return false
    if (entry.kind != VoiceKernelEpochRootKind.CUE || entry.epoch != epoch ||
      entry.cueTerminalConsumed) {
      return false
    }
    entry.cueTerminalConsumed = true
    return true
  }

  fun currentEpochFor(result: VoiceKernelMessage.DriverResult): VoiceKernelEpoch? {
    val entry = entries[result.epoch.rootOperationId] ?: return null
    return entry.epoch.takeIf { accepts(entry.kind, result.driver, result.resultKind) }
  }

  private fun accepts(
    kind: VoiceKernelEpochRootKind,
    driver: VoiceKernelDriver,
    resultKind: String,
  ): Boolean = when (driver) {
    VoiceKernelDriver.NET -> when {
      resultKind.startsWith("thread-") -> kind == VoiceKernelEpochRootKind.THREAD_TURN
      resultKind.startsWith("realtime-") ->
        kind == VoiceKernelEpochRootKind.REALTIME_MODE ||
          kind == VoiceKernelEpochRootKind.REALTIME_PEER
      resultKind.startsWith("tick:") -> kind == VoiceKernelEpochRootKind.TIMER
      else -> kind == VoiceKernelEpochRootKind.SERVICE
    }
    VoiceKernelDriver.MEDIA -> when (resultKind) {
      "RecorderTerminated" -> kind == VoiceKernelEpochRootKind.RECORDING
      "PcmChunkConsumed", "PcmFinished", "PcmFailed",
      "PlaybackFocusSuspended", "PlaybackFocusResumed", "PlaybackFocusTerminated",
      -> kind == VoiceKernelEpochRootKind.PLAYBACK
      "CueCompleted" -> kind == VoiceKernelEpochRootKind.CUE
      "RealtimeStateChanged", "RealtimeRouteChanged", "RealtimeAudioFocusChanged",
      "RealtimeAudioDevicesChanged", "RealtimeError", "RealtimeTerminated",
      ->
        kind == VoiceKernelEpochRootKind.REALTIME_PEER
      "RealtimeDrainCompleted" -> kind == VoiceKernelEpochRootKind.REALTIME_PEER
      else -> false
    }
    VoiceKernelDriver.STORE -> kind != VoiceKernelEpochRootKind.TIMER
    VoiceKernelDriver.HOST -> kind == VoiceKernelEpochRootKind.SERVICE
  }
}
