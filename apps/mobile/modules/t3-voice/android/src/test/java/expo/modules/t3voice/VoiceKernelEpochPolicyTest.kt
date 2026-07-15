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

  @Test
  fun `registry bumps each root independently and classifies driver families`() {
    val registry = VoiceKernelEpochRegistry()
    val fixtures = listOf(
      Triple(VoiceKernelEpochRootKind.THREAD_TURN, VoiceKernelDriver.NET, "thread-poll"),
      Triple(VoiceKernelEpochRootKind.REALTIME_MODE, VoiceKernelDriver.NET, "realtime-actions"),
      Triple(VoiceKernelEpochRootKind.REALTIME_PEER, VoiceKernelDriver.MEDIA, "RealtimeRouteChanged"),
      Triple(VoiceKernelEpochRootKind.RECORDING, VoiceKernelDriver.MEDIA, "RecorderTerminated"),
      Triple(VoiceKernelEpochRootKind.PLAYBACK, VoiceKernelDriver.MEDIA, "PcmFinished"),
      Triple(VoiceKernelEpochRootKind.CUE, VoiceKernelDriver.MEDIA, "CueCompleted"),
      Triple(VoiceKernelEpochRootKind.TIMER, VoiceKernelDriver.NET, "tick:timer-1"),
      Triple(VoiceKernelEpochRootKind.SERVICE, VoiceKernelDriver.STORE, "persisted"),
    )

    fixtures.forEachIndexed { index, (kind, driver, resultKind) ->
      val root = "root-$index"
      val stale = registry.arm(kind, "runtime-1", 7, root)
      val current = registry.arm(kind, "runtime-1", 7, root)
      val result = driverResult(stale, driver, resultKind)

      assertEquals(current, registry.currentEpochFor(result))
      assertEquals(
        VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ATTEMPT),
        VoiceKernelEpochPolicy.admit(current, result.epoch),
      )
    }
  }

  @Test
  fun `router facts use the peer epoch and stale route callbacks drop`() {
    val registry = VoiceKernelEpochRegistry()
    val stale = registry.arm(
      VoiceKernelEpochRootKind.REALTIME_PEER,
      "runtime-1",
      7,
      "peer-1",
    )
    val current = registry.arm(
      VoiceKernelEpochRootKind.REALTIME_PEER,
      "runtime-1",
      7,
      "peer-1",
    )
    val route = driverResult(stale, VoiceKernelDriver.MEDIA, "RealtimeRouteChanged")

    assertEquals(current, registry.currentEpochFor(route))
    assertEquals(
      VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ATTEMPT),
      VoiceKernelEpochPolicy.admit(current, route.epoch),
    )
  }

  @Test
  fun `cue terminal latch forgets the prior arm and admits once in constant space`() {
    val latch = VoiceKernelCueOnceGate()
    val first = currentEpoch.copy(rootOperationId = "cue:first")
    val second = currentEpoch.copy(rootOperationId = "cue:second", attemptOrdinal = 4L)

    latch.arm(first)
    assertEquals(true, latch.admit(first))
    assertEquals(false, latch.admit(first))

    latch.arm(second)
    assertEquals(false, latch.admit(first))
    assertEquals(true, latch.admit(second))
    assertEquals(false, latch.admit(second))
  }

  private fun driverResult(
    epoch: VoiceKernelEpoch,
    driver: VoiceKernelDriver,
    resultKind: String,
  ) = VoiceKernelMessage.DriverResult(
    epoch,
    driver,
    resultKind,
    when (driver) {
      VoiceKernelDriver.NET -> VoiceKernelDriverResultPayload.NetCompleted(resultKind) {}
      VoiceKernelDriver.MEDIA -> VoiceKernelDriverResultPayload.MediaEvent(resultKind) {}
      VoiceKernelDriver.STORE -> VoiceKernelDriverResultPayload.StorePersisted(resultKind, Result.success(Unit)) {}
      VoiceKernelDriver.HOST -> VoiceKernelDriverResultPayload.HostCompleted(resultKind, Result.success(Unit))
    },
  )
}
