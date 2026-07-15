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
  fun `cue terminal gate admits once per independently armed root`() {
    val registry = VoiceKernelEpochRegistry()
    val recordingEnded = registry.arm(
      VoiceKernelEpochRootKind.CUE,
      "runtime-1",
      7,
      "cue:recording-ended:r1",
    )
    val recordingReady = registry.arm(
      VoiceKernelEpochRootKind.CUE,
      "runtime-1",
      7,
      "cue:recording-ready:r2",
    )

    assertEquals(true, registry.admitCueTerminal(recordingEnded))
    assertEquals(false, registry.admitCueTerminal(recordingEnded))
    assertEquals(true, registry.admitCueTerminal(recordingReady))
    assertEquals(false, registry.admitCueTerminal(recordingReady))
  }

  @Test
  fun `cue terminal gate replaces only the rearmed root epoch`() {
    val registry = VoiceKernelEpochRegistry()
    val first = registry.arm(
      VoiceKernelEpochRootKind.CUE,
      "runtime-1",
      7,
      "cue:recording-ended:r1",
    )
    val independent = registry.arm(
      VoiceKernelEpochRootKind.CUE,
      "runtime-1",
      7,
      "cue:realtime-ended:s1",
    )
    val rearmed = registry.arm(
      VoiceKernelEpochRootKind.CUE,
      "runtime-1",
      7,
      first.rootOperationId,
    )

    assertEquals(false, registry.admitCueTerminal(first))
    assertEquals(true, registry.admitCueTerminal(rearmed))
    assertEquals(true, registry.admitCueTerminal(independent))
  }

  @Test
  fun `retire removes a root only when the epoch matches`() {
    val registry = VoiceKernelEpochRegistry()
    val first = registry.arm(VoiceKernelEpochRootKind.RECORDING, "runtime-1", 7, "rec-1")
    val rearmed = registry.arm(VoiceKernelEpochRootKind.RECORDING, "runtime-1", 7, "rec-1")

    registry.retire(first)
    assertEquals(rearmed, registry.current("rec-1"))
    assertEquals(1, registry.size())

    registry.retire(rearmed)
    assertEquals(null, registry.current("rec-1"))
    assertEquals(0, registry.size())
    assertEquals(
      null,
      registry.currentEpochFor(
        driverResult(rearmed, VoiceKernelDriver.MEDIA, "RecorderTerminated"),
      ),
    )
  }

  @Test
  fun `re-armed roots never reuse a retired life's ordinal`() {
    val registry = VoiceKernelEpochRegistry()
    val retired = registry.arm(VoiceKernelEpochRootKind.PLAYBACK, "runtime-1", 7, "play-1")
    registry.retire(retired)
    val rearmed = registry.arm(VoiceKernelEpochRootKind.PLAYBACK, "runtime-1", 7, "play-1")

    assertEquals(
      VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ATTEMPT),
      VoiceKernelEpochPolicy.admit(rearmed, retired),
    )
  }

  @Test
  fun `retire of an unknown root is a no-op`() {
    val registry = VoiceKernelEpochRegistry()
    registry.retire(currentEpoch)
    assertEquals(0, registry.size())
  }

  @Test
  fun `registry does not grow once terminal roots retire`() {
    val registry = VoiceKernelEpochRegistry()
    val kinds = listOf(
      VoiceKernelEpochRootKind.THREAD_TURN,
      VoiceKernelEpochRootKind.REALTIME_MODE,
      VoiceKernelEpochRootKind.REALTIME_PEER,
      VoiceKernelEpochRootKind.RECORDING,
      VoiceKernelEpochRootKind.PLAYBACK,
      VoiceKernelEpochRootKind.CUE,
      VoiceKernelEpochRootKind.TIMER,
      VoiceKernelEpochRootKind.SERVICE,
    )

    repeat(3) { round ->
      val epochs = kinds.mapIndexed { index, kind ->
        registry.arm(kind, "runtime-1", 7, "root-$round-$index")
      }
      assertEquals(kinds.size, registry.size())
      epochs.forEach(registry::retire)
      assertEquals(0, registry.size())
    }
  }

  @Test
  fun `cue terminal gate never admits after retirement`() {
    val registry = VoiceKernelEpochRegistry()
    val cue = registry.arm(VoiceKernelEpochRootKind.CUE, "runtime-1", 7, "cue:recording-ended:r1")

    assertEquals(true, registry.admitCueTerminal(cue))
    registry.retire(cue)
    assertEquals(false, registry.admitCueTerminal(cue))
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
