package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceKernelEpochPolicyTest {
  private val currentEpoch =
    VoiceKernelEpoch(
      runtimeInstanceId = "runtime-instance-current",
      authorityGeneration = 7L,
      rootOperationId = "operation-current",
      attemptOrdinal = 3L,
    )

  @Test
  fun exactMatchAdmits() {
    assertEquals(
      VoiceKernelEpochAdmission.Admit,
      VoiceKernelEpochPolicy.admit(currentEpoch, currentEpoch.copy()),
    )
  }

  @Test
  fun eachSingleFieldMismatchDropsWithItsDimension() {
    val cases =
      listOf(
        currentEpoch.copy(runtimeInstanceId = "runtime-instance-stale") to
          VoiceKernelEpochStalenessDimension.RUNTIME_INSTANCE,
        currentEpoch.copy(authorityGeneration = 6L) to
          VoiceKernelEpochStalenessDimension.AUTHORITY_GENERATION,
        currentEpoch.copy(rootOperationId = "operation-stale") to
          VoiceKernelEpochStalenessDimension.ROOT_OPERATION,
        currentEpoch.copy(attemptOrdinal = 2L) to
          VoiceKernelEpochStalenessDimension.ATTEMPT,
      )

    cases.forEach { (resultEpoch, expectedDimension) ->
      assertEquals(
        VoiceKernelEpochAdmission.DropStale(expectedDimension),
        VoiceKernelEpochPolicy.admit(currentEpoch, resultEpoch),
      )
    }
  }

  @Test
  fun multipleMismatchesDropAtTheFirstDimensionInPrecedenceOrder() {
    val cases =
      listOf(
        currentEpoch.copy(
          runtimeInstanceId = "runtime-instance-stale",
          authorityGeneration = 6L,
          rootOperationId = "operation-stale",
          attemptOrdinal = 2L,
        ) to VoiceKernelEpochStalenessDimension.RUNTIME_INSTANCE,
        currentEpoch.copy(
          authorityGeneration = 6L,
          rootOperationId = "operation-stale",
          attemptOrdinal = 2L,
        ) to VoiceKernelEpochStalenessDimension.AUTHORITY_GENERATION,
        currentEpoch.copy(
          rootOperationId = "operation-stale",
          attemptOrdinal = 2L,
        ) to VoiceKernelEpochStalenessDimension.ROOT_OPERATION,
      )

    cases.forEach { (resultEpoch, expectedDimension) ->
      assertEquals(
        VoiceKernelEpochAdmission.DropStale(expectedDimension),
        VoiceKernelEpochPolicy.admit(currentEpoch, resultEpoch),
      )
    }
  }

  @Test
  fun attemptOrdinalUsesEqualityRatherThanMonotonicOrdering() {
    listOf(2L, 4L).forEach { mismatchingOrdinal ->
      assertEquals(
        VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ATTEMPT),
        VoiceKernelEpochPolicy.admit(
          currentEpoch,
          currentEpoch.copy(attemptOrdinal = mismatchingOrdinal),
        ),
      )
    }
  }
}
