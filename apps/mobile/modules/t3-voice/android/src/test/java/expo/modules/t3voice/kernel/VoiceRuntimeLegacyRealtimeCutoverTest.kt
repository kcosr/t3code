package expo.modules.t3voice.kernel

import expo.modules.t3voice.store.MemoryRuntimeStorage
import expo.modules.t3voice.store.VoiceRuntimeExecutionSnapshotStore
import expo.modules.t3voice.store.VoiceRuntimeRealtimeCleanupLoadResult
import expo.modules.t3voice.store.VoiceRuntimeRealtimeCleanupStore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeLegacyRealtimeCutoverTest {
  @Test
  fun `starting snapshot and cleanup marker are cleared without remote recovery`() {
    val storage = MemoryRuntimeStorage()
    val snapshots = VoiceRuntimeExecutionSnapshotStore(storage)
    val cleanup = VoiceRuntimeRealtimeCleanupStore(storage)
    val legacy = legacySnapshot(VoiceRuntimePhase.REALTIME_STARTING)
    snapshots.write(legacy)
    cleanup.write(marker())

    val result = VoiceRuntimeLegacyRealtimeCutover(snapshots, cleanup).migrate(snapshots.read())

    assertTrue(result.migrated)
    assertEquals(VoiceRuntimeExecutionSnapshot(), result.snapshot)
    assertEquals(VoiceRuntimeExecutionSnapshot(), snapshots.read())
    assertEquals(VoiceRuntimeRealtimeCleanupLoadResult.Missing, cleanup.load())
  }

  @Test
  fun `active snapshot without cleanup is still retired exactly once`() {
    val storage = MemoryRuntimeStorage()
    val snapshots = VoiceRuntimeExecutionSnapshotStore(storage)
    val cleanup = VoiceRuntimeRealtimeCleanupStore(storage)
    snapshots.write(legacySnapshot(VoiceRuntimePhase.REALTIME_ACTIVE))
    val migration = VoiceRuntimeLegacyRealtimeCutover(snapshots, cleanup)

    assertTrue(migration.migrate(snapshots.read()).migrated)
    assertFalse(migration.migrate(snapshots.read()).migrated)
  }

  @Test
  fun `orphan cleanup marker is removed without disturbing active thread state`() {
    val storage = MemoryRuntimeStorage()
    val snapshots = VoiceRuntimeExecutionSnapshotStore(storage)
    val cleanup = VoiceRuntimeRealtimeCleanupStore(storage)
    val thread = VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime-1",
      readinessGeneration = 7,
      mode = VoiceRuntimeExecutionMode.THREAD,
      phase = VoiceRuntimePhase.RECORDING,
      operationId = "thread-operation",
      operationGeneration = 7,
      recordingId = "recording-1",
    )
    snapshots.write(thread)
    cleanup.write(marker())

    val result = VoiceRuntimeLegacyRealtimeCutover(snapshots, cleanup).migrate(snapshots.read())

    assertTrue(result.migrated)
    assertEquals(thread, result.snapshot)
    assertEquals(thread, snapshots.read())
    assertEquals(VoiceRuntimeRealtimeCleanupLoadResult.Missing, cleanup.load())
  }

  private fun legacySnapshot(phase: VoiceRuntimePhase) = VoiceRuntimeExecutionSnapshot(
    runtimeId = "runtime-1",
    readinessGeneration = 7,
    mode = VoiceRuntimeExecutionMode.REALTIME,
    phase = phase,
    operationId = "legacy-realtime",
    operationGeneration = 7,
  )

  private fun marker() = VoiceRuntimeRealtimeCleanupMarker(
    runtimeId = "runtime-1",
    readinessGeneration = 7,
    environmentOrigin = "https://environment.example.test",
    operationId = "legacy-realtime",
    conversationId = "conversation-1",
  )
}
