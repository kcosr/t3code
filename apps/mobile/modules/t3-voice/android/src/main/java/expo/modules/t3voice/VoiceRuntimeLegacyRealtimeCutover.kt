package expo.modules.t3voice

internal data class VoiceRuntimeLegacyRealtimeCutoverResult(
  val snapshot: VoiceRuntimeExecutionSnapshot,
  val migrated: Boolean,
)

/**
 * Removes the retired pre-canonical Realtime owner using local state only.
 * Its server grant is revoked by the protocol cutover, so network recovery is neither possible nor safe.
 */
internal class VoiceRuntimeLegacyRealtimeCutover(
  private val snapshotStore: VoiceRuntimeExecutionSnapshotStore,
  private val cleanupStore: VoiceRuntimeRealtimeCleanupStore,
) {
  @Synchronized
  fun migrate(snapshot: VoiceRuntimeExecutionSnapshot): VoiceRuntimeLegacyRealtimeCutoverResult {
    val legacySnapshot = snapshot.mode == VoiceRuntimeExecutionMode.REALTIME &&
      snapshot.phase in LEGACY_ACTIVE_PHASES
    val cleanup = cleanupStore.load()
    if (!legacySnapshot && cleanup == VoiceRuntimeRealtimeCleanupLoadResult.Missing) {
      return VoiceRuntimeLegacyRealtimeCutoverResult(snapshot, migrated = false)
    }

    // Both clears are idempotent. A crash or storage fault resumes this local migration on next start.
    cleanupStore.clear()
    if (legacySnapshot) snapshotStore.clear()
    return VoiceRuntimeLegacyRealtimeCutoverResult(
      if (legacySnapshot) VoiceRuntimeExecutionSnapshot() else snapshot,
      migrated = true,
    )
  }

  private companion object {
    val LEGACY_ACTIVE_PHASES = setOf(
      VoiceRuntimePhase.REALTIME_STARTING,
      VoiceRuntimePhase.REALTIME_ACTIVE,
    )
  }
}
