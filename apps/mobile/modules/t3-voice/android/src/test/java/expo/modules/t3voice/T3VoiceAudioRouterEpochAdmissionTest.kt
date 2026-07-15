package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceAudioRouterEpochAdmissionTest {
  @Test
  fun `stale focus callback retains its router arm epoch and drops`() {
    assertStaleRouterFactDrops { sessionId ->
      VoiceMediaDriverEvent.RealtimeAudioFocusChanged(sessionId, 1)
    }
  }

  @Test
  fun `stale route callback retains its router arm epoch and drops`() {
    assertStaleRouterFactDrops { sessionId ->
      VoiceMediaDriverEvent.RealtimeRouteChanged(
        sessionId,
        T3VoiceAudioRouteChange(
          routeId = "system",
          routeType = "system",
          reason = T3VoiceAudioRouteChangeReason.SELECTED_ROUTE_UNAVAILABLE,
        ),
      )
    }
  }

  private fun assertStaleRouterFactDrops(
    event: (String) -> VoiceMediaDriverEvent,
  ) {
    val registry = VoiceKernelEpochRegistry()
    val stale = registry.arm(VoiceKernelEpochRootKind.REALTIME_PEER, "runtime-1", 7, SESSION_ID)
    val current = registry.arm(VoiceKernelEpochRootKind.REALTIME_PEER, "runtime-1", 7, SESSION_ID)
    val observed = mutableListOf<Pair<VoiceKernelEpoch, VoiceMediaDriverEvent>>()
    val factory = FakeFactory()
    val driver = VoiceMediaDriver(
      VoiceMediaDriverListener { epoch, mediaEvent -> observed += epoch to mediaEvent },
      factory,
    )
    driver.armRealtime(SESSION_ID, current)
    driver.realtime

    factory.emitRouter(stale, event(SESSION_ID))

    assertEquals(listOf(stale), observed.map { it.first })
    val result = driverResult(observed.single())
    assertEquals(current, registry.currentEpochFor(result))
    assertEquals(
      VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ATTEMPT),
      VoiceKernelEpochPolicy.admit(current, result.epoch),
    )
  }

  private fun driverResult(
    observed: Pair<VoiceKernelEpoch, VoiceMediaDriverEvent>,
  ): VoiceKernelMessage.DriverResult {
    val (epoch, event) = observed
    val resultKind = event::class.java.simpleName
    return VoiceKernelMessage.DriverResult(
      epoch,
      VoiceKernelDriver.MEDIA,
      resultKind,
      VoiceKernelDriverResultPayload.MediaEvent(resultKind) {},
    )
  }

  private class FakeFactory :
    VoiceMediaDriverFactory<String, String, String, String, String, String> {
    private lateinit var routerListener: VoiceRawMediaDriverListener

    override fun createRecorder(listener: VoiceRawMediaDriverListener) = "recorder"
    override fun createPlayer(listener: VoiceRawMediaDriverListener) = "player"
    override fun createFocus(listener: VoiceRawMediaDriverListener) = "focus"
    override fun createCues() = "cues"

    override fun createRouter(listener: VoiceRawMediaDriverListener): String {
      routerListener = listener
      return "router"
    }

    override fun createRealtime(router: String, listener: VoiceRawMediaDriverListener) = "realtime"
    override fun releaseRecorder(recorder: String) = Unit
    override fun releasePlayer(player: String) = Unit
    override fun releaseCues(cues: String) = Unit
    override fun releaseFocus(focus: String) = Unit
    override fun releaseRealtime(realtime: String) = Unit

    fun emitRouter(epoch: VoiceKernelEpoch, event: VoiceMediaDriverEvent) {
      routerListener.onMediaEvent(epoch, event)
    }
  }

  private companion object {
    const val SESSION_ID = "peer-1"
  }
}
