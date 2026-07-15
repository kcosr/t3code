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
