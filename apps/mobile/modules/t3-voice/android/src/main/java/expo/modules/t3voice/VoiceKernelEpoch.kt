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
  )

  private val entries = mutableMapOf<String, Entry>()

  fun arm(
    kind: VoiceKernelEpochRootKind,
    runtimeInstanceId: String,
    authorityGeneration: Long,
    rootOperationId: String,
  ): VoiceKernelEpoch {
    require(runtimeInstanceId.isNotBlank()) { "Epoch runtime instance must be non-empty." }
    require(rootOperationId.isNotBlank()) { "Epoch root operation must be non-empty." }
    require(authorityGeneration >= 0) { "Epoch authority generation cannot be negative." }
    val previous = entries[rootOperationId]
    val ordinal = previous?.epoch?.attemptOrdinal?.let(::nextOrdinal) ?: 1L
    return VoiceKernelEpoch(
      runtimeInstanceId,
      authorityGeneration,
      rootOperationId,
      ordinal,
    ).also { entries[rootOperationId] = Entry(kind, it) }
  }

  fun current(rootOperationId: String): VoiceKernelEpoch? = entries[rootOperationId]?.epoch

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
      "RealtimeStateChanged", "RealtimeRouteChanged", "RealtimeError", "RealtimeTerminated" ->
        kind == VoiceKernelEpochRootKind.REALTIME_PEER
      "RealtimeDrainCompleted" -> kind == VoiceKernelEpochRootKind.REALTIME_PEER
      else -> false
    }
    VoiceKernelDriver.STORE -> kind != VoiceKernelEpochRootKind.TIMER
    VoiceKernelDriver.HOST -> kind == VoiceKernelEpochRootKind.SERVICE
  }

  private fun nextOrdinal(current: Long): Long =
    if (current == Long.MAX_VALUE) 1L else current + 1L
}
