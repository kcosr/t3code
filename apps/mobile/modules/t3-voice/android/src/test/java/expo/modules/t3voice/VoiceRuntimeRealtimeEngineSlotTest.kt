package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeEngineSlotTest {
  private data class Engine(var active: Boolean = false)

  @Test
  fun `idle installation commits and completes`() {
    val slot = VoiceRuntimeRealtimeEngineSlot<Engine>(isActive = { it.active })
    val engine = Engine()
    val installation = slot.stageIdleInstall(authority(), engine)

    assertSame(engine, slot.commit(installation).current?.engine)
    assertSame(engine, slot.complete(installation).current?.engine)
  }

  @Test
  fun `committed idle installation rolls back to previous engine`() {
    val previous = Engine()
    val slot = VoiceRuntimeRealtimeEngineSlot(
      VoiceRuntimeRealtimeEngineBinding(authority(), previous),
      Engine::active,
    )
    val candidate = Engine()
    val installation = slot.stageIdleInstall(authority(generation = 8), candidate)
    slot.commit(installation)

    assertSame(previous, slot.rollback(installation).current?.engine)
  }

  @Test
  fun `active engine cannot be replaced`() {
    val slot = VoiceRuntimeRealtimeEngineSlot(
      VoiceRuntimeRealtimeEngineBinding(authority(), Engine(active = true)),
      Engine::active,
    )

    assertTrue(runCatching {
      slot.stageIdleInstall(authority(generation = 8), Engine())
    }.isFailure)
  }

  @Test
  fun `idle clear removes binding`() {
    val slot = VoiceRuntimeRealtimeEngineSlot(
      VoiceRuntimeRealtimeEngineBinding(authority(), Engine()),
      Engine::active,
    )
    val clear = slot.stageIdleClear()
    slot.commit(clear)
    assertNull(slot.complete(clear).current)
  }

  @Test
  fun `empty slot installs a recovered active engine`() {
    val slot = VoiceRuntimeRealtimeEngineSlot<Engine>(isActive = Engine::active)
    val recovered = Engine(active = true)
    val installation = slot.stageRecoveredInstall(authority(), recovered)

    assertSame(recovered, slot.commit(installation).current?.engine)
    assertSame(recovered, slot.complete(installation).current?.engine)
  }

  @Test
  fun `active committed candidate cannot be rolled back`() {
    val previous = Engine()
    val candidate = Engine()
    val slot = VoiceRuntimeRealtimeEngineSlot(
      VoiceRuntimeRealtimeEngineBinding(authority(), previous),
      Engine::active,
    )
    val installation = slot.stageIdleInstall(authority(generation = 8), candidate)
    slot.commit(installation)
    candidate.active = true

    assertTrue(runCatching { slot.rollback(installation) }.isFailure)
    candidate.active = false
    assertSame(previous, slot.rollback(installation).current?.engine)
  }

  @Test
  fun `reduction installation uses stable binding identity and live state`() {
    val slot = VoiceRuntimeRealtimeEngineSlot<Engine>(isActive = Engine::active)
    val installation = slot.stageIdleInstall(authority(), Engine())
    val binding = requireNotNull(slot.commit(installation).current)
    slot.complete(installation)
    val checkpoint = VoiceRuntimeRealtimeCheckpoint(
      VoiceRuntimeRealtimeFence(authority().identity, "mode-1"),
      authority().target,
      "start-1",
      VoiceRealtimePhase.PREPARING,
    )
    slot.applyReduction(
      VoiceRuntimeRealtimeReduction(binding.state.copy(checkpoint = checkpoint), result = Unit),
    )

    assertEquals(checkpoint, slot.snapshot().current?.state?.checkpoint)
    assertTrue(runCatching { slot.stageIdleClear() }.isFailure)
  }

  private fun authority(generation: Long = 7) = VoiceRuntimeRealtimeAuthority(
    VoiceRuntimeIdentity("runtime-1", "process-1", generation),
    VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    "https://termstation",
  )
}
