package expo.modules.t3voice

internal data class Permissions(
  val microphoneGranted: Boolean,
  val notificationGranted: Boolean,
)

internal fun interface Clock {
  fun nowMillis(): Long
}

internal enum class CanonicalReadinessWriteStatus {
  NOT_ATTEMPTED,
  SUCCEEDED,
  FAILED,
}

internal data class LoadedState(
  val readinessConfig: T3VoiceReadinessConfig,
  val preparedReadiness: T3VoicePreparedReadiness? = null,
  val activeAuthority: T3VoicePreparedReadiness? = null,
  val attachedPreparation: VoiceRuntimePreparedAttachedAuthority? = null,
  val canonicalAuthority: VoiceRuntimeAuthorityLoadResult = VoiceRuntimeAuthorityLoadResult.Missing,
  val retiredAuthorityFence: VoiceRuntimeRetiredAuthorityFence? = null,
  val realtimeFinalization: VoiceRuntimeRealtimeFinalization? = null,
  val realtimeCheckpoint: VoiceRuntimeRealtimeCheckpoint? = null,
  val runtimeSnapshot: VoiceRuntimeExecutionSnapshot = VoiceRuntimeExecutionSnapshot(),
  val threadOperation: VoiceRuntimeThreadOperationLoadResult = VoiceRuntimeThreadOperationLoadResult.Missing,
  val cueSettings: T3VoiceCueSettings = T3VoiceCueSettings(),
  val attachedPreparationRead: Boolean = true,
  val persistentReadinessRead: Boolean = true,
  val activeAuthorityRead: Boolean = true,
  val finalizationRead: Boolean = true,
  val checkpointRead: Boolean = true,
  val threadRecordingRestored: Boolean = true,
  val canonicalReadinessWriteStatus: CanonicalReadinessWriteStatus =
    CanonicalReadinessWriteStatus.NOT_ATTEMPTED,
)

internal sealed interface CanonicalReadinessReconciliation {
  data class Transient(val config: T3VoiceReadinessConfig) : CanonicalReadinessReconciliation
  data class Current(val config: T3VoiceReadinessConfig) : CanonicalReadinessReconciliation
  data class Promote(
    val config: T3VoiceReadinessConfig,
    val authority: T3VoicePreparedReadiness,
  ) : CanonicalReadinessReconciliation
}

internal fun canonicalReadinessReconciliation(
  loaded: LoadedState,
  permissions: Permissions,
  authority: VoiceRuntimePersistedAuthority,
): CanonicalReadinessReconciliation {
  fun verify(config: T3VoiceReadinessConfig): T3VoiceReadinessConfig {
    val verified = config.copy(
      microphonePermissionGranted = config.microphonePermissionGranted && permissions.microphoneGranted,
      notificationPermissionGranted = config.notificationPermissionGranted && permissions.notificationGranted,
    )
    require(!verified.enabled || verified.mode != T3VoiceReadinessMode.THREAD || verified.targetId != null) {
      "Thread readiness requires a target."
    }
    return verified
  }
  if (!authority.readinessEnabled) {
    val readiness = loaded.readinessConfig.copy(
      microphonePermissionGranted = permissions.microphoneGranted,
      notificationPermissionGranted = permissions.notificationGranted,
    )
    return CanonicalReadinessReconciliation.Transient(
      verify(T3VoiceCanonicalReadinessPolicy.transient(readiness, authority)),
    )
  }
  check(loaded.persistentReadinessRead)
  check(loaded.activeAuthorityRead)
  return when (val decision = VoiceRuntimeCommittedReadinessPolicy.reconcile(
    authority,
    loaded.preparedReadiness,
    loaded.activeAuthority,
  )) {
    is VoiceRuntimeCommittedReadinessDecision.Current ->
      CanonicalReadinessReconciliation.Current(verify(decision.authority.config))
    is VoiceRuntimeCommittedReadinessDecision.Promote ->
      CanonicalReadinessReconciliation.Promote(
        verify(decision.authority.config),
        decision.authority,
      )
    else -> error("Canonical authority and readiness state do not match.")
  }
}

internal sealed interface VoiceRuntimeRealtimeInstallPlan {
  data object None : VoiceRuntimeRealtimeInstallPlan
  data class Recovered(
    val finalization: VoiceRuntimeRealtimeFinalization?,
    val checkpoint: VoiceRuntimeRealtimeCheckpoint?,
  ) : VoiceRuntimeRealtimeInstallPlan
  data class Canonical(val authority: VoiceRuntimePersistedAuthority) : VoiceRuntimeRealtimeInstallPlan
}

internal data class VoiceRuntimeRecoveryPlan(
  val installedRuntimeId: String?,
  val initialGeneration: Long?,
  val canonicalPreparedAuthority: T3VoicePreparedReadiness?,
  val readinessConfig: T3VoiceReadinessConfig,
  val runtimeSnapshot: VoiceRuntimeExecutionSnapshot,
  val cueSettings: T3VoiceCueSettings,
  val realtimeInstall: VoiceRuntimeRealtimeInstallPlan,
  val effects: List<VoiceRuntimeRecoveryEffect>,
)

internal sealed interface VoiceRuntimeRecoveryEffect {
  data class WriteReadiness(
    val config: T3VoiceReadinessConfig,
    val bestEffort: Boolean = false,
  ) : VoiceRuntimeRecoveryEffect
  data class WriteActivatedReadiness(
    val config: T3VoiceReadinessConfig,
    val authority: T3VoicePreparedReadiness,
  ) : VoiceRuntimeRecoveryEffect
  data class WriteDisabledForRuntimeRevocation(
    val config: T3VoiceReadinessConfig,
    val pending: T3VoicePendingRuntimeRevocation?,
  ) : VoiceRuntimeRecoveryEffect
  data object DiscardInitialPreparation : VoiceRuntimeRecoveryEffect
  data object InvalidateReadiness : VoiceRuntimeRecoveryEffect
  data object ClearLockedAfterAuthorityRevocation : VoiceRuntimeRecoveryEffect
  data object ClearRuntimeSnapshot : VoiceRuntimeRecoveryEffect
  data class ClearAuthority(val reason: String) : VoiceRuntimeRecoveryEffect
  data class Diagnostic(val code: T3VoiceDiagnosticCode, val generation: Long = 0) : VoiceRuntimeRecoveryEffect
  data class ConfigureCanonicalAuthority(val authority: VoiceRuntimePersistedAuthority) : VoiceRuntimeRecoveryEffect
  data class InstallRealtime(val plan: VoiceRuntimeRealtimeInstallPlan) : VoiceRuntimeRecoveryEffect
  data class RestoreCompletedRecording(val recording: T3VoiceRecordingResult) : VoiceRuntimeRecoveryEffect
  data class DetachActiveThread(val state: VoiceRuntimeThreadOperationState.Active) : VoiceRuntimeRecoveryEffect
  data object RestoreBridgeCompletions : VoiceRuntimeRecoveryEffect
  data object SweepStaleCache : VoiceRuntimeRecoveryEffect
  data object SetServiceReady : VoiceRuntimeRecoveryEffect
  data class ReconcileThreadOperation(val loaded: VoiceRuntimeThreadOperationLoadResult) : VoiceRuntimeRecoveryEffect
}

/**
 * Pure recovery decision. The run-2 host calls `deviceIdentity.getOrCreate(plan.installedRuntimeId)`,
 * constructs the controller, applies the seed, then executes [VoiceRuntimeRecoveryPlan.effects] in
 * order. Legacy-retirement credential clearing remains a loader responsibility. Thread
 * reconciliation deliberately carries only the loader snapshot: its executor reloads both the
 * operation and canonical grant and uses execution-time time before calling
 * [VoiceRuntimeThreadStoredStatePolicy.decide].
 */
internal fun recover(loaded: LoadedState, permissions: Permissions, clock: Clock): VoiceRuntimeRecoveryPlan {
  clock.nowMillis() // makes the recovery instant explicit without freezing thread reconciliation
  val effects = mutableListOf<VoiceRuntimeRecoveryEffect>()
  fun verify(config: T3VoiceReadinessConfig): T3VoiceReadinessConfig {
    val verified = config.copy(
      microphonePermissionGranted = config.microphonePermissionGranted && permissions.microphoneGranted,
      notificationPermissionGranted = config.notificationPermissionGranted && permissions.notificationGranted,
    )
    require(!verified.enabled || verified.mode != T3VoiceReadinessMode.THREAD || verified.targetId != null) {
      "Thread readiness requires a target."
    }
    return verified
  }

  var readiness = loaded.readinessConfig.copy(
    microphonePermissionGranted = permissions.microphoneGranted,
    notificationPermissionGranted = permissions.notificationGranted,
  )
  var canonical = (loaded.canonicalAuthority as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
  var prepared = loaded.preparedReadiness
  var active = loaded.activeAuthority
  if (!loaded.finalizationRead) effects += VoiceRuntimeRecoveryEffect.Diagnostic(T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED)
  if (!loaded.checkpointRead) effects += VoiceRuntimeRecoveryEffect.Diagnostic(T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED)

  canonical?.let { authority ->
    val reconciled = runCatching {
      when (val reconciliation = canonicalReadinessReconciliation(loaded, permissions, authority)) {
        is CanonicalReadinessReconciliation.Transient -> {
          check(loaded.canonicalReadinessWriteStatus != CanonicalReadinessWriteStatus.FAILED)
          readiness = reconciliation.config
          if (loaded.canonicalReadinessWriteStatus == CanonicalReadinessWriteStatus.NOT_ATTEMPTED) {
            effects += VoiceRuntimeRecoveryEffect.WriteReadiness(readiness)
          }
          prepared = null
          active = null
        }
        is CanonicalReadinessReconciliation.Current ->
          readiness = reconciliation.config
        is CanonicalReadinessReconciliation.Promote -> {
          check(loaded.canonicalReadinessWriteStatus != CanonicalReadinessWriteStatus.FAILED)
          readiness = reconciliation.config
          if (loaded.canonicalReadinessWriteStatus == CanonicalReadinessWriteStatus.NOT_ATTEMPTED) {
            effects += VoiceRuntimeRecoveryEffect.WriteActivatedReadiness(
              reconciliation.authority.config,
              reconciliation.authority,
            )
          }
          active = reconciliation.authority
          prepared = null
        }
      }
    }.isSuccess
    if (!reconciled) {
      effects += VoiceRuntimeRecoveryEffect.ClearAuthority("startup-reconciliation-clear-authority")
      readiness = readiness.copy(enabled = false)
      effects += VoiceRuntimeRecoveryEffect.WriteReadiness(readiness, bestEffort = true)
      canonical = null
      prepared = null
      active = null
    }
  }
  if (canonical != null) prepared = null

  val persistentFence = if (canonical == null) runCatching {
    T3VoiceStartupAuthorityFencePolicy.persistentPreparation(prepared)
  } else Result.success(null)
  val selection = persistentFence.mapCatching {
    check(
      (canonical != null || loaded.persistentReadinessRead) &&
        loaded.attachedPreparationRead && loaded.activeAuthorityRead,
    )
    T3VoiceStartupAuthorityFencePolicy.selectPreparation(it, loaded.attachedPreparation?.takeIf { canonical == null })
  }
  val fences = listOf(
    loaded.realtimeFinalization?.fence?.identity?.let { T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation) },
    loaded.realtimeCheckpoint?.fence?.identity?.let { T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation) },
    loaded.retiredAuthorityFence?.let { T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation) },
    active?.let { T3VoiceRecoveredAuthorityFence(it.runtimeId, it.config.generation) },
  )
  var resolution = T3VoiceStartupAuthorityFencePolicy.resolveWithFallback(
    selection, fences, prepared, loaded.attachedPreparation, canonical != null,
    loaded.persistentReadinessRead, loaded.attachedPreparationRead, loaded.activeAuthorityRead,
  )
  var attached = loaded.attachedPreparation
  if (resolution.discardPreparation) {
    val readinessRuntimeIds = listOfNotNull(
      active?.runtimeId,
      prepared?.runtimeId,
      attached?.fence?.runtimeId,
    )
    val readinessGeneration = readiness.generation.takeIf {
      resolution.runtimeId == null || readinessRuntimeIds.any { runtimeId ->
        runtimeId == resolution.runtimeId
      }
    }
    val generation = maxOf(
      resolution.initialGeneration ?: 0,
      readinessGeneration ?: 0,
    )
    readiness = readiness.copy(enabled = false, generation = generation)
    val pending = prepared?.let { T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin) }
      ?: attached?.let { T3VoicePendingRuntimeRevocation(it.fence.runtimeId, it.fence.environmentOrigin) }
    effects += VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation(readiness, pending)
    effects += VoiceRuntimeRecoveryEffect.DiscardInitialPreparation
    effects += VoiceRuntimeRecoveryEffect.Diagnostic(T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED)
    resolution = resolution.copy(preparation = null, initialGeneration = generation)
    attached = null
    prepared = null
  }
  var canonicalPrepared: T3VoicePreparedReadiness? = null
  attached?.takeIf { canonical == null }?.let {
    readiness = verify(it.readiness)
    effects += VoiceRuntimeRecoveryEffect.WriteReadiness(readiness)
    canonicalPrepared = T3VoicePreparedReadiness(readiness, it.fence.runtimeId, it.fence.environmentOrigin, it.fence.target.grantOperation(), it.fence.targetDigest)
  }
  val installedRuntimeId = T3VoiceRecoveredRealtimeAuthorityPolicy.runtimeId(
    canonical, loaded.realtimeFinalization, loaded.realtimeCheckpoint, loaded.retiredAuthorityFence, active,
  ) ?: resolution.runtimeId
  canonical?.let { effects += VoiceRuntimeRecoveryEffect.ConfigureCanonicalAuthority(it) }
  val realtimeInstall = when {
    loaded.realtimeFinalization != null || loaded.realtimeCheckpoint != null ->
      VoiceRuntimeRealtimeInstallPlan.Recovered(loaded.realtimeFinalization, loaded.realtimeCheckpoint)
    canonical != null -> VoiceRuntimeRealtimeInstallPlan.Canonical(canonical!!)
    else -> VoiceRuntimeRealtimeInstallPlan.None
  }
  if (realtimeInstall !is VoiceRuntimeRealtimeInstallPlan.None) effects += VoiceRuntimeRecoveryEffect.InstallRealtime(realtimeInstall)
  val recording = ((loaded.threadOperation as? VoiceRuntimeThreadOperationLoadResult.Available)?.state as? VoiceRuntimeThreadOperationState.Active)?.recording
  if (recording != null && loaded.threadRecordingRestored) {
    effects += VoiceRuntimeRecoveryEffect.RestoreCompletedRecording(recording)
  } else if (recording != null) {
    val active = (loaded.threadOperation as VoiceRuntimeThreadOperationLoadResult.Available)
      .state as VoiceRuntimeThreadOperationState.Active
    effects += VoiceRuntimeRecoveryEffect.DetachActiveThread(
      active.copy(recording = null, detached = true, cancelRequested = true),
    )
  }
  effects += VoiceRuntimeRecoveryEffect.RestoreBridgeCompletions
  effects += VoiceRuntimeRecoveryEffect.SweepStaleCache
  effects += VoiceRuntimeRecoveryEffect.SetServiceReady
  effects += VoiceRuntimeRecoveryEffect.ReconcileThreadOperation(loaded.threadOperation)
  return VoiceRuntimeRecoveryPlan(installedRuntimeId, if (canonical == null) resolution.initialGeneration else null, canonicalPrepared, readiness, loaded.runtimeSnapshot, loaded.cueSettings, realtimeInstall, effects)
}
