package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeEngineSlotTest {
  @Test
  fun `refresh retains active engine and swaps only after terminal`() {
    val first = FakeEngine(active = true)
    val slot = slot(authority(), first)
    val refreshed = authority(token = "runtime-token-2", expiresAt = 8_000)

    val deferred = requireNotNull(slot.acceptRefresh(slot.fence(), refreshed))

    assertSame(first, slot.snapshot().current?.engine)
    assertEquals(authority(), slot.snapshot().current?.authority)
    assertEquals(refreshed, slot.snapshot().deferredAuthority)
    expectThrows<IllegalStateException> {
      slot.swapDeferredAfterTerminal(deferred, FakeEngine())
    }

    first.active = false
    val replacement = FakeEngine()
    val swapped = slot.swapDeferredAfterTerminal(deferred, replacement)

    assertSame(replacement, swapped.current?.engine)
    assertEquals(refreshed, swapped.current?.authority)
    assertNull(swapped.deferredAuthority)
  }

  @Test
  fun `latest same-fence refresh supersedes an earlier deferred rotation`() {
    val engine = FakeEngine(active = true)
    val slot = slot(authority(), engine)
    val first = authority(token = "runtime-token-2", expiresAt = 8_000)
    val staleTicket = requireNotNull(slot.acceptRefresh(slot.fence(), first))
    val second = authority(token = "runtime-token-3", expiresAt = 12_000)
    val currentTicket = requireNotNull(slot.acceptRefresh(slot.fence(), second))
    engine.active = false

    expectThrows<VoiceRuntimeFenceException> {
      slot.swapDeferredAfterTerminal(staleTicket, FakeEngine())
    }
    val swapped = slot.swapDeferredAfterTerminal(currentTicket, FakeEngine())

    assertEquals(second, swapped.current?.authority)
  }

  @Test
  fun `cross-fence or non-advancing refresh is rejected`() {
    val engine = FakeEngine(active = true)
    val slot = slot(authority(), engine)

    expectThrows<VoiceRuntimeFenceException> {
      slot.acceptRefresh(
        slot.fence(),
        authority(identity = identity.copy(generation = 2), token = "other", expiresAt = 8_000),
      )
    }
    expectThrows<VoiceRuntimeFenceException> {
      slot.acceptRefresh(slot.fence(), authority(token = "other", expiresAt = 4_000))
    }
  }

  @Test
  fun `replaying the installed refresh does not create deferred work`() {
    val slot = slot(authority(), FakeEngine())

    assertNull(slot.acceptRefresh(slot.fence(), authority()))
    assertNull(slot.snapshot().deferredAuthority)
  }

  @Test
  fun `committed idle replacement clears deferred refresh and can complete`() {
    val first = FakeEngine()
    val slot = slot(authority(), first)
    slot.acceptRefresh(
      slot.fence(),
      authority(token = "runtime-token-2", expiresAt = 8_000),
    )
    val replacement = FakeEngine()
    val replacementAuthority = authority(
      identity = identity.copy(generation = 2),
      token = "replacement-token",
      expiresAt = 10_000,
    )
    val installation = slot.stageIdleInstall(slot.fence(), replacementAuthority, replacement)

    val committed = slot.commit(installation)

    assertSame(replacement, committed.current?.engine)
    assertEquals(replacementAuthority, committed.current?.authority)
    assertNull(committed.deferredAuthority)
    assertEquals(committed, slot.complete(installation))
  }

  @Test
  fun `rollback after commit restores exact prior binding and deferred authority`() {
    val first = FakeEngine()
    val initialAuthority = authority()
    val slot = slot(initialAuthority, first)
    val refreshed = authority(token = "runtime-token-2", expiresAt = 8_000)
    slot.acceptRefresh(slot.fence(), refreshed)
    val before = slot.snapshot()
    val installation = slot.stageIdleInstall(
      slot.fence(),
      authority(identity = identity.copy(generation = 2), token = "candidate", expiresAt = 9_000),
      FakeEngine(),
    )
    slot.commit(installation)

    val rolledBack = slot.rollback(installation)

    assertSame(first, rolledBack.current?.engine)
    assertEquals(initialAuthority, rolledBack.current?.authority)
    assertEquals(refreshed, rolledBack.deferredAuthority)
    assertTrue(rolledBack.version > before.version)
  }

  @Test
  fun `rollback before commit leaves slot unchanged`() {
    val first = FakeEngine()
    val slot = slot(authority(), first)
    val before = slot.snapshot()
    val installation = slot.stageIdleInstall(
      slot.fence(),
      authority(identity = identity.copy(generation = 2), token = "candidate", expiresAt = 9_000),
      FakeEngine(),
    )

    val rolledBack = slot.rollback(installation)

    assertEquals(before, rolledBack)
    assertSame(first, rolledBack.current?.engine)
  }

  @Test
  fun `staged clear can roll back or permanently clear a deferred replacement`() {
    val first = FakeEngine()
    val slot = slot(authority(), first)
    val refreshed = authority(token = "runtime-token-2", expiresAt = 8_000)
    slot.acceptRefresh(slot.fence(), refreshed)

    val rollback = slot.stageIdleClear(slot.fence())
    assertNull(slot.commit(rollback).current)
    val restored = slot.rollback(rollback)
    assertSame(first, restored.current?.engine)
    assertEquals(refreshed, restored.deferredAuthority)

    val complete = slot.stageIdleClear(slot.fence())
    val cleared = slot.commit(complete)
    assertNull(cleared.current)
    assertNull(cleared.deferredAuthority)
    assertEquals(cleared, slot.complete(complete))
  }

  @Test
  fun `staged install rejects a skipped generation and a different runtime`() {
    val slot = slot(authority(), FakeEngine())

    expectThrows<VoiceRuntimeFenceException> {
      slot.stageIdleInstall(
        slot.fence(),
        authority(identity = identity.copy(generation = 3), token = "candidate", expiresAt = 9_000),
        FakeEngine(),
      )
    }
    expectThrows<VoiceRuntimeFenceException> {
      slot.stageIdleInstall(
        slot.fence(),
        authority(
          identity = VoiceRuntimeIdentity("runtime-2", "instance-1", 2),
          token = "candidate",
          expiresAt = 9_000,
        ),
        FakeEngine(),
      )
    }
  }

  @Test
  fun `active binding and active candidate cannot enter staged install`() {
    val active = FakeEngine(active = true)
    val activeSlot = slot(authority(), active)
    expectThrows<IllegalStateException> {
      activeSlot.stageIdleInstall(
        activeSlot.fence(),
        authority(identity = identity.copy(generation = 2), token = "candidate", expiresAt = 9_000),
        FakeEngine(),
      )
    }

    val idleSlot = slot(authority(), FakeEngine())
    expectThrows<IllegalStateException> {
      idleSlot.stageIdleInstall(
        idleSlot.fence(),
        authority(identity = identity.copy(generation = 2), token = "candidate", expiresAt = 9_000),
        FakeEngine(active = true),
      )
    }
  }

  @Test
  fun `empty slot can stage a recovered checkpoint without treating it as live work`() {
    val slot = VoiceRuntimeRealtimeEngineSlot<FakeEngine>(isActive = FakeEngine::active)
    val recovered = FakeEngine(active = true)

    val installation = slot.stageRecoveredInstall(slot.fence(), authority(), recovered)
    val committed = slot.commit(installation)

    assertSame(recovered, committed.current?.engine)
    assertEquals(committed, slot.complete(installation))
  }

  @Test
  fun `clear removes deferred authority and fences stale engine callbacks`() {
    val first = FakeEngine(active = true)
    val slot = slot(authority(), first)
    val deferred = requireNotNull(slot.acceptRefresh(
      slot.fence(),
      authority(token = "runtime-token-2", expiresAt = 8_000),
    ))
    val clearFence = slot.fence()

    assertSame(first, slot.clear(clearFence)?.engine)
    assertNull(slot.snapshot().current)
    assertNull(slot.snapshot().deferredAuthority)
    first.active = false
    expectThrows<VoiceRuntimeFenceException> {
      slot.swapDeferredAfterTerminal(deferred, FakeEngine())
    }
    expectThrows<VoiceRuntimeFenceException> { slot.clear(clearFence) }
  }

  @Test
  fun `handoff can discard deferred authority while retaining source finalization engine`() {
    val source = FakeEngine(active = true)
    val slot = slot(authority(), source)
    val deferred = requireNotNull(slot.acceptRefresh(
      slot.fence(),
      authority(token = "runtime-token-2", expiresAt = 8_000),
    ))

    val retained = slot.discardDeferred(slot.fence())

    assertSame(source, retained.current?.engine)
    assertNull(retained.deferredAuthority)
    source.active = false
    expectThrows<VoiceRuntimeFenceException> {
      slot.swapDeferredAfterTerminal(deferred, FakeEngine())
    }
  }

  @Test
  fun `candidate reference is fenced during committed rollback`() {
    val first = FakeEngine()
    val slot = slot(authority(), first)
    val candidate = FakeEngine()
    val installation = slot.stageIdleInstall(
      slot.fence(),
      authority(identity = identity.copy(generation = 2), token = "candidate", expiresAt = 9_000),
      candidate,
    )
    slot.commit(installation)
    candidate.active = true

    expectThrows<IllegalStateException> { slot.rollback(installation) }

    candidate.active = false
    assertSame(first, slot.rollback(installation).current?.engine)
  }

  private fun slot(
    authority: VoiceRuntimeRealtimeAuthority,
    engine: FakeEngine,
  ) = VoiceRuntimeRealtimeEngineSlot(
    VoiceRuntimeRealtimeEngineBinding(authority, engine),
    FakeEngine::active,
  )

  private fun authority(
    identity: VoiceRuntimeIdentity = Companion.identity,
    token: String = "runtime-token-1",
    expiresAt: Long = 5_000,
  ) = VoiceRuntimeRealtimeAuthority(
    identity,
    target,
    "https://example.test",
    token,
    expiresAt,
  )

  private inline fun <reified T : Throwable> expectThrows(block: () -> Unit): T {
    return try {
      block()
      throw AssertionError("Expected ${T::class.java.simpleName}")
    } catch (cause: Throwable) {
      if (cause !is T) throw cause
      cause
    }
  }

  private data class FakeEngine(var active: Boolean = false)

  private companion object {
    val identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 1)
    val target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1")
  }
}
