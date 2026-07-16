package expo.modules.t3voice

import expo.modules.t3voice.bridge.VoiceRuntimeBridge
import expo.modules.t3voice.host.AndroidVoiceHostMainDispatcher
import expo.modules.t3voice.host.T3VoiceStartCommandDecision
import expo.modules.t3voice.host.T3VoiceStartCommandPolicy
import expo.modules.t3voice.host.T3VoiceStartCommandStickinessCache
import expo.modules.t3voice.host.VoiceHostDriver
import expo.modules.t3voice.host.VoiceHostEffects
import expo.modules.t3voice.host.VoiceHostMediaSessionModel
import expo.modules.t3voice.kernel.CanonicalReadinessReconciliation
import expo.modules.t3voice.kernel.CanonicalReadinessWriteStatus
import expo.modules.t3voice.kernel.Clock
import expo.modules.t3voice.kernel.LoadedState
import expo.modules.t3voice.kernel.Permissions
import expo.modules.t3voice.kernel.T3VoiceBridgeCompletionActions
import expo.modules.t3voice.kernel.T3VoiceBridgeCompletionStore
import expo.modules.t3voice.kernel.T3VoiceCanonicalReadinessPolicy
import expo.modules.t3voice.kernel.T3VoiceConditionalDisablePolicy
import expo.modules.t3voice.kernel.T3VoiceConfigureReadinessPolicy
import expo.modules.t3voice.kernel.T3VoiceControlCommand
import expo.modules.t3voice.kernel.T3VoiceControlDecision
import expo.modules.t3voice.kernel.T3VoiceControlPolicy
import expo.modules.t3voice.kernel.T3VoiceControllerCommands
import expo.modules.t3voice.kernel.T3VoiceDiagnosticCategory
import expo.modules.t3voice.kernel.T3VoiceDiagnosticCode
import expo.modules.t3voice.kernel.T3VoiceDiagnostics
import expo.modules.t3voice.kernel.T3VoiceDisablePolicy
import expo.modules.t3voice.kernel.T3VoiceDisabledAuthorityFence
import expo.modules.t3voice.kernel.T3VoiceDisabledAuthorityRetentionPolicy
import expo.modules.t3voice.kernel.T3VoiceDisabledReadiness
import expo.modules.t3voice.kernel.T3VoiceForegroundLifecyclePolicy
import expo.modules.t3voice.kernel.T3VoiceOperationOwner
import expo.modules.t3voice.kernel.T3VoiceOperationOwnerDomain
import expo.modules.t3voice.kernel.T3VoicePendingControlDecision
import expo.modules.t3voice.kernel.T3VoicePendingRuntimeRevocation
import expo.modules.t3voice.kernel.T3VoicePlaybackCompletion
import expo.modules.t3voice.kernel.T3VoicePreparedReadiness
import expo.modules.t3voice.kernel.T3VoiceReadinessConfig
import expo.modules.t3voice.kernel.T3VoiceReadinessMode
import expo.modules.t3voice.kernel.T3VoiceReadinessStore
import expo.modules.t3voice.kernel.T3VoiceRecordingCompletion
import expo.modules.t3voice.kernel.T3VoiceRuntimeEvent
import expo.modules.t3voice.kernel.T3VoiceRuntimeOwnershipPolicy
import expo.modules.t3voice.kernel.T3VoiceRuntimePhase
import expo.modules.t3voice.kernel.T3VoiceRuntimeState
import expo.modules.t3voice.kernel.T3VoiceStateStore
import expo.modules.t3voice.kernel.VoiceKernelCancellationToken
import expo.modules.t3voice.kernel.VoiceKernelDriver
import expo.modules.t3voice.kernel.VoiceKernelDriverResultPayload
import expo.modules.t3voice.kernel.VoiceKernelEpoch
import expo.modules.t3voice.kernel.VoiceKernelEpochAdmission
import expo.modules.t3voice.kernel.VoiceKernelEpochPolicy
import expo.modules.t3voice.kernel.VoiceKernelEpochRegistry
import expo.modules.t3voice.kernel.VoiceKernelEpochRootKind
import expo.modules.t3voice.kernel.VoiceKernelEpochStalenessDimension
import expo.modules.t3voice.kernel.VoiceKernelHostIntentAction
import expo.modules.t3voice.kernel.VoiceKernelMailbox
import expo.modules.t3voice.kernel.VoiceKernelMessage
import expo.modules.t3voice.kernel.VoiceRealtimePhase
import expo.modules.t3voice.kernel.VoiceRuntimeActiveThreadController
import expo.modules.t3voice.kernel.VoiceRuntimeAuthorityReservation
import expo.modules.t3voice.kernel.VoiceRuntimeCommand
import expo.modules.t3voice.kernel.VoiceRuntimeCommandOutcome
import expo.modules.t3voice.kernel.VoiceRuntimeCommandReceipt
import expo.modules.t3voice.kernel.VoiceRuntimeControlSurfacePolicy
import expo.modules.t3voice.kernel.VoiceRuntimeCursor
import expo.modules.t3voice.kernel.VoiceRuntimeDelivery
import expo.modules.t3voice.kernel.VoiceRuntimeDeviceIdentityStore
import expo.modules.t3voice.kernel.VoiceRuntimeDraftContext
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionEvent
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionMode
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionRecovery
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionReducer
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionSnapshot
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionTransition
import expo.modules.t3voice.kernel.VoiceRuntimeExpiredException
import expo.modules.t3voice.kernel.VoiceRuntimeFenceException
import expo.modules.t3voice.kernel.VoiceRuntimeHandoffActivationPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeIdentity
import expo.modules.t3voice.kernel.VoiceRuntimeInstalledAuthority
import expo.modules.t3voice.kernel.VoiceRuntimeLegacyRealtimeCutover
import expo.modules.t3voice.kernel.VoiceRuntimeNativeCommand
import expo.modules.t3voice.kernel.VoiceRuntimeOperation
import expo.modules.t3voice.kernel.VoiceRuntimePhase
import expo.modules.t3voice.kernel.VoiceRuntimePresentation
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeAuthority
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeAuthorityPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeAuthorization
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCheckpoint
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCheckpointRepository
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCommandResult
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCues
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeEffect
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeEngineInstallation
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeEngineSlot
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeFence
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeFinalization
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeFinalizationResult
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeHandoffCoordinator
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeHandoffPlan
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeInstallPlan
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeOutput
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimePeer
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimePersistence
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimePresentationDecision
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeReducer
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeReduction
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeRemoteResult
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeState
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeStopPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeRecoveryEffect
import expo.modules.t3voice.kernel.VoiceRuntimeRecoveryPlan
import expo.modules.t3voice.kernel.VoiceRuntimeRetainedRecordKey
import expo.modules.t3voice.kernel.VoiceRuntimeServerPhase
import expo.modules.t3voice.kernel.VoiceRuntimeSnapshot
import expo.modules.t3voice.kernel.VoiceRuntimeTarget
import expo.modules.t3voice.kernel.VoiceRuntimeTerminalSummary
import expo.modules.t3voice.kernel.VoiceRuntimeThreadAttempt
import expo.modules.t3voice.kernel.VoiceRuntimeThreadAttemptPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadAuthorityPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadAuthorization
import expo.modules.t3voice.kernel.VoiceRuntimeThreadBatchReducer
import expo.modules.t3voice.kernel.VoiceRuntimeThreadCancelDecision
import expo.modules.t3voice.kernel.VoiceRuntimeThreadCancelPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadCancelReconciliationPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadCommand
import expo.modules.t3voice.kernel.VoiceRuntimeThreadEventBatchPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadEventCommitDecision
import expo.modules.t3voice.kernel.VoiceRuntimeThreadEventCommitPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadExecution
import expo.modules.t3voice.kernel.VoiceRuntimeThreadLocalCleanupCoordinator
import expo.modules.t3voice.kernel.VoiceRuntimeThreadLocalStopCoordinator
import expo.modules.t3voice.kernel.VoiceRuntimeThreadPersistencePolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadPreparedCancellationPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadRearmPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadRecordingBodyPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadRecordingRecovery
import expo.modules.t3voice.kernel.VoiceRuntimeThreadRetryPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadSpeechPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadStartReconciliationPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadStoredStateDecision
import expo.modules.t3voice.kernel.VoiceRuntimeThreadStoredStatePolicy
import expo.modules.t3voice.kernel.VoiceRuntimeThreadTerminalPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeWakeLockPolicy
import expo.modules.t3voice.kernel.canonicalReadinessReconciliation
import expo.modules.t3voice.kernel.recover
import expo.modules.t3voice.kernel.restoreBridgeRecordingCompletions
import expo.modules.t3voice.kernel.toVoiceKernelHostIntentAction
import expo.modules.t3voice.media.AndroidVoiceMediaDriverFactory
import expo.modules.t3voice.media.T3VoiceAudioRouter
import expo.modules.t3voice.media.T3VoiceCueCoordinator
import expo.modules.t3voice.media.T3VoiceCueSettings
import expo.modules.t3voice.media.T3VoiceCueSettingsStore
import expo.modules.t3voice.media.T3VoiceEndpointDetectionConfig
import expo.modules.t3voice.media.T3VoicePcmPlayer
import expo.modules.t3voice.media.T3VoicePlaybackAudioFocus
import expo.modules.t3voice.media.T3VoiceRecorder
import expo.modules.t3voice.media.T3VoiceRecordingResult
import expo.modules.t3voice.media.T3VoiceRecordingTermination
import expo.modules.t3voice.media.T3VoiceWebRtcResultCallback
import expo.modules.t3voice.media.T3VoiceWebRtcSession
import expo.modules.t3voice.media.VoiceMediaDriver
import expo.modules.t3voice.media.VoiceMediaDriverEvent
import expo.modules.t3voice.media.VoiceMediaDriverListener
import expo.modules.t3voice.net.VoiceNetDriver
import expo.modules.t3voice.net.VoiceNetLane
import expo.modules.t3voice.net.VoiceRuntimeHttpFailureKind
import expo.modules.t3voice.net.VoiceRuntimeOriginPolicy
import expo.modules.t3voice.net.VoiceRuntimeRealtimeAction
import expo.modules.t3voice.net.VoiceRuntimeRealtimeActionOutcome
import expo.modules.t3voice.net.VoiceRuntimeRealtimeEndpointPolicy
import expo.modules.t3voice.net.VoiceRuntimeRealtimeHandoffExchangeResult
import expo.modules.t3voice.net.VoiceRuntimeRealtimeHttpGateway
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnCreateInput
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnCreateResult
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnDelegate
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnEvent
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnResult
import expo.modules.t3voice.net.VoiceRuntimeThreadTurnSnapshot
import expo.modules.t3voice.store.T3VoiceRuntimeGrantOperation
import expo.modules.t3voice.store.T3VoiceRuntimeTargetIdentity
import expo.modules.t3voice.store.VoiceRuntimeAuthorityInspection
import expo.modules.t3voice.store.VoiceRuntimeAuthorityLifecyclePolicy
import expo.modules.t3voice.store.VoiceRuntimeAuthorityLoadResult
import expo.modules.t3voice.store.VoiceRuntimeAuthorityStore
import expo.modules.t3voice.store.VoiceRuntimeConsumerLease
import expo.modules.t3voice.store.VoiceRuntimeDraftHandle
import expo.modules.t3voice.store.VoiceRuntimeDurableDraftRepository
import expo.modules.t3voice.store.VoiceRuntimeDurableJournalRepository
import expo.modules.t3voice.store.VoiceRuntimeDurableRealtimeCheckpointRepository
import expo.modules.t3voice.store.VoiceRuntimeExecutionSnapshotStore
import expo.modules.t3voice.store.VoiceRuntimePersistedAuthority
import expo.modules.t3voice.store.VoiceRuntimeRealtimeCleanupStore
import expo.modules.t3voice.store.VoiceRuntimeRetentionAdmission
import expo.modules.t3voice.store.VoiceRuntimeRetentionWriteResult
import expo.modules.t3voice.store.VoiceRuntimeRetiredAuthorityFence
import expo.modules.t3voice.store.VoiceRuntimeSessionCredentialLoadResult
import expo.modules.t3voice.store.VoiceRuntimeSessionCredentialStore
import expo.modules.t3voice.store.VoiceRuntimeThreadClaim
import expo.modules.t3voice.store.VoiceRuntimeThreadOperationLoadResult
import expo.modules.t3voice.store.VoiceRuntimeThreadOperationState
import expo.modules.t3voice.store.VoiceRuntimeThreadOperationStore
import expo.modules.t3voice.store.VoiceRuntimeThreadOperationUpdateResult
import expo.modules.t3voice.store.VoiceRuntimeThreadReceipt
import expo.modules.t3voice.store.VoiceStoreDriver
import expo.modules.t3voice.store.grantOperation

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.view.KeyEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

private data class T3VoicePendingRecordingStart(
  val owner: T3VoiceOperationOwner,
  val endpointConfig: T3VoiceEndpointDetectionConfig,
  val cueGeneration: Long,
  val onStarted: MutableList<() -> Unit>,
  val onFailure: MutableList<() -> Unit>,
)

private data class T3VoicePendingRuntimeHandoffActivation(
  val actionId: String,
  val authority: VoiceRuntimePersistedAuthority,
  val turnClientOperationId: String,
  val modeSessionId: String,
  val completions: MutableList<(Boolean) -> Unit> = mutableListOf(),
)

internal data class T3VoiceNotificationSnapshot(
  val active: Boolean = false,
  val starting: Boolean = false,
  val canStart: Boolean = false,
  val controllerAttached: Boolean = false,
  val readinessEnabled: Boolean = false,
  val readinessMode: T3VoiceReadinessMode = T3VoiceReadinessMode.REALTIME,
  val realtimeActive: Boolean = false,
  val realtimeMuted: Boolean = false,
)

internal object T3VoiceRuntimeHandoffCapturePolicy {
  fun isArmed(
    expectedClientOperationId: String,
    attempt: VoiceRuntimeThreadAttempt?,
    owner: T3VoiceOperationOwner?,
    phase: T3VoiceRuntimePhase,
  ): Boolean =
    attempt?.clientOperationId == expectedClientOperationId &&
      attempt.operationId != null &&
      owner?.domain == T3VoiceOperationOwnerDomain.THREAD_MODE &&
      owner.operationId == attempt.operationId &&
      phase == T3VoiceRuntimePhase.RECORDING
}

internal object T3VoiceRecoveredRealtimeAuthorityPolicy {
  fun runtimeId(
    canonical: VoiceRuntimePersistedAuthority?,
    finalization: VoiceRuntimeRealtimeFinalization?,
    checkpoint: VoiceRuntimeRealtimeCheckpoint?,
    retired: VoiceRuntimeRetiredAuthorityFence?,
    readiness: T3VoicePreparedReadiness?,
  ): String? = canonical?.runtimeId
    ?: finalization?.fence?.identity?.runtimeId
    ?: checkpoint?.fence?.identity?.runtimeId
    ?: retired?.runtimeId
    ?: readiness?.runtimeId

  fun authority(
    finalization: VoiceRuntimeRealtimeFinalization?,
    checkpoint: VoiceRuntimeRealtimeCheckpoint?,
    checkpointEnvironmentOrigin: String?,
  ): VoiceRuntimeRealtimeAuthority? = when {
    finalization != null -> VoiceRuntimeRealtimeAuthority(
      finalization.fence.identity,
      finalization.sourceTarget,
      finalization.sourceEnvironmentOrigin,
    )
    checkpoint != null && checkpointEnvironmentOrigin != null -> {
      VoiceRuntimeRealtimeAuthority(
        checkpoint.fence.identity,
        checkpoint.target,
        checkpointEnvironmentOrigin,
      )
    }
    else -> null
  }

  fun recoveryIdentity(
    authority: VoiceRuntimeRealtimeAuthority,
    currentControllerIdentity: VoiceRuntimeIdentity,
  ): VoiceRuntimeIdentity {
    require(authority.identity.runtimeId == currentControllerIdentity.runtimeId) {
      "Recovered Realtime authority belongs to a different runtime."
    }
    return currentControllerIdentity
  }
}

internal object T3VoiceRealtimeFinalizationCallbackPolicy {
  fun shouldConvergeIdle(
    hasFinalization: Boolean,
    hasCheckpoint: Boolean,
  ): Boolean = !hasFinalization && !hasCheckpoint
}

internal class T3VoiceRecordingNotStartedException : IllegalStateException(
  "The recording stopped before microphone capture began.",
)

class T3VoiceRuntimeService : Service() {
  private val mailbox = VoiceKernelMailbox()
  private val epochRegistry = VoiceKernelEpochRegistry()

  private fun armEpoch(
    kind: VoiceKernelEpochRootKind,
    rootOperationId: String,
    authorityGeneration: Long = voiceRuntimeController.snapshot().identity.generation,
  ): VoiceKernelEpoch {
    mailbox.assertKernelThread()
    val epoch = epochRegistry.arm(
      kind,
      voiceRuntimeController.snapshot().identity.runtimeInstanceId,
      authorityGeneration,
      rootOperationId,
    )
    return epoch
  }

  private fun driverEpoch(): VoiceKernelEpoch {
    mailbox.assertKernelThread()
    val threadAttempt = runtimeThreadAttempt
    if (threadAttempt != null) {
      return epochRegistry.current(threadAttempt.clientOperationId)
        ?: armEpoch(
          VoiceKernelEpochRootKind.THREAD_TURN,
          threadAttempt.clientOperationId,
          threadAttempt.authority.readinessGeneration,
        )
    }
    val realtimeState = voiceRuntimeRealtimeEngine?.let(::realtimeState)
    // Finalization continues the mode session after the checkpoint clears; its network
    // effects (close/commit/activate) still emit "realtime-" results that admit only
    // against a REALTIME_MODE/PEER root, so they must carry the mode-session root rather
    // than falling through to SERVICE — otherwise the completion drops ROOT_OPERATION-stale
    // and finalization wedges in-flight forever (never terminating the engine).
    val realtimeFence = realtimeState?.checkpoint?.fence ?: realtimeState?.finalization?.fence
    if (realtimeFence != null) {
      val rootOperationId = realtimeFence.modeSessionId
      return epochRegistry.current(rootOperationId)
        ?: armEpoch(
          VoiceKernelEpochRootKind.REALTIME_MODE,
          rootOperationId,
          realtimeFence.identity.generation,
        )
    }
    return serviceEpoch()
  }

  private fun serviceEpoch(): VoiceKernelEpoch {
    mailbox.assertKernelThread()
    val identity = voiceRuntimeController.snapshot().identity
    val rootOperationId = "service:${identity.runtimeInstanceId}"
    return epochRegistry.current(rootOperationId)
      ?: armEpoch(VoiceKernelEpochRootKind.SERVICE, rootOperationId, identity.generation)
  }

  /**
   * Terminal thread-turn sites only. Receipt-failure paths that null the attempt and
   * schedule a restore re-arm the SAME clientOperationId and must NOT retire.
   */
  private fun retireThreadTurnEpoch(clientOperationId: String) {
    mailbox.assertKernelThread()
    epochRegistry.current(clientOperationId)?.let(epochRegistry::retire)
  }

  private fun callbackMessage(payloadKind: String) =
    VoiceKernelMessage.Command(callerIdentity = "runtime-callback", payloadKind = payloadKind)

  private fun submitCallback(body: () -> Unit): Boolean =
    mailbox.submit(callbackMessage("async-completion"), body)

  private fun submitCallback(runnable: Runnable): Boolean = submitCallback(runnable::run)

  private fun postDriverResult(result: VoiceKernelMessage.DriverResult) {
    mailbox.submit(result) { handleDriverResult(result) }
  }

  private fun handleDriverResult(result: VoiceKernelMessage.DriverResult) {
    mailbox.assertKernelThread()
    val admission = epochRegistry.currentEpochFor(result)?.let { currentEpoch ->
      VoiceKernelEpochPolicy.admit(currentEpoch, result.epoch)
    } ?: VoiceKernelEpochAdmission.DropStale(VoiceKernelEpochStalenessDimension.ROOT_OPERATION)
    if (admission is VoiceKernelEpochAdmission.DropStale) {
      T3VoiceDiagnostics.record(
        generation = 0,
        category = T3VoiceDiagnosticCategory.KERNEL,
        code = T3VoiceDiagnosticCode.STALE_DRIVER_RESULT,
        primaryCount = admission.dimension.ordinal + 1,
      )
      return
    }
    if (result.driver == VoiceKernelDriver.MEDIA && result.resultKind == "CueCompleted" &&
      !epochRegistry.admitCueTerminal(result.epoch)) {
      T3VoiceDiagnostics.record(
        generation = 0,
        category = T3VoiceDiagnosticCategory.KERNEL,
        code = T3VoiceDiagnosticCode.DUPLICATE_CUE_TERMINAL,
      )
      return
    }
    when (result.driver) {
      VoiceKernelDriver.NET -> {
        val payload = result.payload as VoiceKernelDriverResultPayload.NetCompleted
        check(payload.label == result.resultKind)
        payload.continuation()
      }
      VoiceKernelDriver.STORE -> {
        val payload = result.payload as VoiceKernelDriverResultPayload.StorePersisted
        check(result.resultKind == "persisted")
        payload.continuation(payload.result)
      }
      VoiceKernelDriver.MEDIA -> {
        val payload = result.payload as VoiceKernelDriverResultPayload.MediaEvent
        check(payload.eventKind == result.resultKind)
        payload.continuation()
      }
      VoiceKernelDriver.HOST -> {
        val payload = result.payload as VoiceKernelDriverResultPayload.HostCompleted
        check(payload.label == result.resultKind)
        payload.result.getOrThrow()
      }
    }
    if (result.driver == VoiceKernelDriver.MEDIA && result.resultKind == "CueCompleted") {
      epochRegistry.retire(result.epoch)
    }
  }

  private fun postCueCompletion(epoch: VoiceKernelEpoch, continuation: () -> Unit) {
    postDriverResult(
      VoiceKernelMessage.DriverResult(
        epoch = epoch,
        driver = VoiceKernelDriver.MEDIA,
        resultKind = "CueCompleted",
        payload = VoiceKernelDriverResultPayload.MediaEvent("CueCompleted", continuation),
      ),
    )
  }

  private fun submitCallbackDelayed(
    body: () -> Unit,
    delayMillis: Long,
    timerId: String,
  ): VoiceKernelCancellationToken = scheduleTick(timerId, delayMillis, body)

  private fun submitCallbackDelayed(
    runnable: Runnable,
    delayMillis: Long,
    timerId: String,
  ): VoiceKernelCancellationToken = submitCallbackDelayed(runnable::run, delayMillis, timerId)

  private fun scheduleTick(
    timerId: String,
    delayMillis: Long,
    continuation: () -> Unit,
  ): VoiceKernelCancellationToken {
    val epoch = armEpoch(VoiceKernelEpochRootKind.TIMER, timerId)
    val tick = VoiceKernelMessage.Tick(timerId, epoch)
    val scheduled = mailbox.submitDelayed(tick, delayMillis) {
      handleDriverResult(
        VoiceKernelMessage.DriverResult(
          epoch = tick.epoch,
          driver = VoiceKernelDriver.NET,
          resultKind = "tick:${tick.timerId}",
          payload = VoiceKernelDriverResultPayload.NetCompleted(
            "tick:${tick.timerId}",
            continuation,
          ),
        ),
      )
      epochRegistry.retire(tick.epoch)
    }
    return VoiceKernelCancellationToken {
      val cancelled = scheduled.cancel()
      // The registry is kernel-thread-only; a foreign-thread cancel keeps the entry until
      // the same timerId re-arms.
      if (cancelled && mailbox.isKernelThread()) epochRegistry.retire(tick.epoch)
      cancelled
    }
  }

  internal inner class VoiceBinder : Binder() {
    private fun binderMessage(payloadKind: String) =
      VoiceKernelMessage.Command(callerIdentity = "voice-binder", payloadKind = payloadKind)

    val state: StateFlow<T3VoiceRuntimeState>
      get() = T3VoiceStateStore.state

    val events: SharedFlow<T3VoiceRuntimeEvent>
      get() = T3VoiceStateStore.events

    fun disableRuntimeVoiceReadiness(): T3VoiceDisabledReadiness =
      mailbox.submitAndAwait(binderMessage("disable-readiness")) {
        run { disableRuntimeVoiceReadinessLocked() }
      }

    fun disableRuntimeVoiceReadinessIfIdle(
      expectedRuntimeId: String?,
      expectedGeneration: Long?,
    ): T3VoiceDisabledReadiness? = mailbox.submitAndAwait(binderMessage("disable-readiness-if-idle")) {
      run {
        val metadata = persistedAuthority()
        val identities = listOfNotNull(
          metadata?.let { it.runtimeId to it.generation },
          voiceRuntimeAuthorityStore.inspectPreparedAttachedAuthority()?.let {
            it.fence.runtimeId to (it.fence.generation - 1)
          },
          canonicalPreparedAuthority?.takeIf { !it.config.enabled }?.let {
            it.runtimeId to (it.config.generation - 1)
          },
          readinessStore.prepared()?.let { it.runtimeId to (it.config.generation - 1) },
          readinessStore.activeAuthority()?.let { it.runtimeId to it.config.generation },
        ).distinct()
        val durableThreadOwnership =
          runtimeThreadOperationStore.load() !is VoiceRuntimeThreadOperationLoadResult.Missing ||
            (runtimeSnapshot.mode == VoiceRuntimeExecutionMode.THREAD &&
              runtimeSnapshot.phase != VoiceRuntimePhase.IDLE)
        if (!T3VoiceConditionalDisablePolicy.canDisable(
            expectedRuntimeId,
            expectedGeneration,
            voiceRuntimeController.snapshot().identity.generation,
            identities,
            voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint != null || runtimeThreadAttempt != null ||
              durableThreadOwnership ||
              T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE,
          )) return@run null
        disableRuntimeVoiceReadinessLocked()
      }
    }

    private fun disableRuntimeVoiceReadinessLocked(): T3VoiceDisabledReadiness {
        val prepared = readinessStore.prepared()
        val preparedAttached = voiceRuntimeAuthorityStore.inspectPreparedAttachedAuthority()
        val activeAuthority = readinessStore.activeAuthority()
        val persistedAuthority = persistedAuthority()
        val priorPending = readinessStore.pendingRuntimeRevocation()
        val revocation =
            priorPending
            ?: persistedAuthority?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
            ?: prepared?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
            ?: preparedAttached?.let {
              T3VoicePendingRuntimeRevocation(it.fence.runtimeId, it.fence.environmentOrigin)
            }
            ?: canonicalPreparedAuthority?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
            ?: activeAuthority?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
        val canonical = voiceRuntimeController.snapshot()
        val next = T3VoiceCanonicalReadinessPolicy.disabled(
          readinessConfig,
          canonical.identity.generation,
        )
        readinessStore.writeDisabledForRuntimeRevocation(next, revocation)
        readinessConfig = next
        canonicalPreparedAuthority = null
        controllerCommands.invalidateReadiness()
        stopActiveOperationLocked()
        if (canonical.target != null) {
          runCatching {
            voiceRuntimeController.clearAuthority(
              "disable-${UUID.randomUUID()}",
              canonical.identity,
            )
          }
        }
        voiceRuntimeAuthorityStore.clear()
        storeDriver.persist("disable-clear-session-credential", driverEpoch(), body = {
          voiceRuntimeSessionCredentialStore.clear()
        })
        clearIdleRealtimeEngineLocked()
        return T3VoiceDisabledReadiness(next, revocation?.runtimeId)
    }

    fun pendingRuntimeRevocation(): T3VoicePendingRuntimeRevocation? =
      readinessStore.pendingRuntimeRevocation()

    fun runtimeVoiceOwnership(): Map<String, Any?>? = mailbox.submitAndAwait(binderMessage("ownership")) {
      run {
        val state = T3VoiceStateStore.state.value
        val authority = readinessStore.activeAuthority()
        val canonicalFence = T3VoiceRuntimeOwnershipPolicy.canonicalFence(
          readinessConfig,
          authority,
          persistedAuthority(),
          readinessStore.prepared(),
          canonicalPreparedAuthority?.takeIf { !it.config.enabled },
        )
        if (canonicalFence == null) return@run null
        mapOf(
          "sequence" to state.sequence.toDouble(),
          "active" to runtimeControlSurfaceActiveLocked(state),
          "phase" to state.phase.name.lowercase(),
          "runtimeId" to canonicalFence?.runtimeId,
          "generation" to (canonicalFence?.generation ?: readinessConfig.generation).toDouble(),
          "environmentOrigin" to canonicalFence.environmentOrigin,
          "mode" to readinessConfig.mode.name.lowercase(),
          "targetId" to readinessConfig.targetId,
          "nativeSessionId" to state.activeRealtimeSessionId,
        )
      }
    }

    private fun requireOperationMatchesMode(
      config: T3VoiceReadinessConfig,
      operation: T3VoiceRuntimeGrantOperation,
    ) {
      val expected =
        when (config.mode) {
          T3VoiceReadinessMode.REALTIME -> T3VoiceRuntimeGrantOperation.REALTIME_START
          T3VoiceReadinessMode.THREAD -> T3VoiceRuntimeGrantOperation.THREAD_TURN_START
        }
      require(operation == expected) { "Runtime voice operation does not match readiness mode." }
    }

    fun pendingReadinessDisabled(): Map<String, Any>? =
      readinessStore.pendingDisabled()?.toEventBody()

    fun acknowledgeReadinessDisabled(readinessGeneration: Long): Boolean =
      readinessStore.acknowledgePendingDisabled(readinessGeneration)

    fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      mailbox.submit(binderMessage("start-recording")) {
        run {
          val owner =
            checkNotNull(T3VoiceStateStore.claimRecording(
              recordingId,
              T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
              recordingId,
            )) {
              "The voice runtime is already in use."
            }
          recordingOwner = owner
          try {
            scheduleRecordingStartLocked(owner, endpointConfig)
          } catch (cause: Throwable) {
            releaseRecordingLocked(owner)
            throw cause
          }
        }
      }
    }

    fun stopRecording(recordingId: String): Map<String, Any> =
      mailbox.submitAndAwait(binderMessage("stop-recording")) {
        run {
          val owner = requireRecordingOwner(
            recordingId,
            T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
          )
          cancelPendingRecordingStartLocked(owner)?.let {
            releaseRecordingLocked(owner)
            throw T3VoiceRecordingNotStartedException()
          }
          try {
            recorder.stop(recordingId).toResultBody()
          } finally {
            releaseRecordingLocked(owner, stopForeground = false)
            beginRecordingEndedCueLocked(recordingId)
          }
        }
      }

    fun cancelRecording(recordingId: String) {
      mailbox.submit(binderMessage("cancel-recording")) {
        run {
          val owner = requireRecordingOwner(
            recordingId,
            T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
          )
          if (cancelPendingRecordingStartLocked(owner) != null) {
            releaseRecordingLocked(owner)
            return@run
          }
          try {
            recorder.cancel(recordingId)
          } finally {
            releaseRecordingLocked(owner, stopForeground = false)
            beginRecordingEndedCueLocked(recordingId)
          }
        }
      }
    }

    fun deleteRecording(recordingId: String, uri: String) {
      mailbox.submit(binderMessage("delete-recording")) {
        run {
          val completion = checkNotNull(T3VoiceBridgeCompletionStore.recordingById(recordingId)) {
            "Recording $recordingId is not owned by the bridge."
          }
          val recording = checkNotNull(completion.terminal.recording) {
            "Recording $recordingId is not owned by the bridge."
          }
          check(recording.uri == uri) { "Recording $recordingId URI does not match its terminal result." }
          recorder.delete(recordingId, recording.uri)
          T3VoiceBridgeCompletionStore.acknowledgeRecording(
            completion.owner.domain,
            completion.owner.operationId,
          )
        }
      }
    }

    fun acknowledgeRecordingTermination(operationId: String) {
      T3VoiceBridgeCompletionActions.acknowledgeRecording(operationId)
    }

    fun discardUnownedRecordingTermination(operationId: String): Boolean =
      mailbox.submitAndAwait(binderMessage("discard-recording-termination")) {
        run {
          T3VoiceBridgeCompletionActions.discardRecording(operationId) { recordingId, uri ->
            runCatching { recorder.delete(recordingId, uri) }
              .onFailure {
                T3VoiceDiagnostics.record(
                  0,
                  T3VoiceDiagnosticCategory.TERMINAL,
                  T3VoiceDiagnosticCode.FAILED,
                )
              }
          }
        }
      }

    fun pendingRecordingTerminations(): List<Map<String, Any?>> =
      T3VoiceBridgeCompletionStore.pendingRecordings(
        T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
      ).map(T3VoiceRecordingCompletion::toEventBody)

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      mailbox.submit(binderMessage("start-playback")) {
        run {
          startPlaybackLocked(
            playbackId,
            sampleRate,
            channelCount,
            T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK,
            playbackId,
          )
        }
      }
    }

    fun enqueuePlaybackChunk(playbackId: String, chunkIndex: Int, pcmBase64: String) {
      player.enqueue(playbackId, chunkIndex, pcmBase64)
    }

    fun finishPlayback(playbackId: String, finalChunkIndex: Int) {
      player.finish(playbackId, finalChunkIndex)
    }

    fun cancelPlayback(playbackId: String) {
      mailbox.submit(binderMessage("cancel-playback")) {
        run {
          val owner = requirePlaybackOwner(
            playbackId,
            T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK,
          )
          try {
            player.cancel(playbackId)
          } finally {
            terminatePlaybackLocked(
              owner,
              T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "cancelled"),
            )
          }
        }
      }
    }

    fun acknowledgePlaybackTermination(operationId: String) {
      T3VoiceBridgeCompletionStore.acknowledgePlayback(
        T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK,
        operationId,
      )
    }

    fun pendingPlaybackTerminations(): List<Map<String, Any>> =
      T3VoiceBridgeCompletionStore.pendingPlaybacks(
        T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK,
      ).map(T3VoicePlaybackCompletion::toEventBody)

    fun getAudioRoutes(): List<Map<String, Any>> = realtime.routes()

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()

    fun voiceRuntimeSnapshot(): VoiceRuntimeSnapshot =
      mailbox.submitAndAwait(binderMessage("snapshot")) {
        run { voiceRuntimeController.snapshot() }
      }

    fun setVoiceRuntimeSessionCredential(
      environmentOrigin: String,
      credential: String,
      onPersisted: (Result<Unit>) -> Unit,
    ) =
      mailbox.submit(binderMessage("set-session-credential")) {
        storeDriver.persist(
          "set-session-credential",
          driverEpoch(),
          body = { voiceRuntimeSessionCredentialStore.set(environmentOrigin, credential) },
          continuation = onPersisted,
        )
      }

    fun configureVoiceRuntimeAuthority(
      authority: VoiceRuntimeBridge.ParsedAuthority,
    ): VoiceRuntimeSnapshot = mailbox.submitAndAwait(binderMessage("configure-authority")) {
      run {
      cancelVoiceRuntimeThreadRearmLocked()
      val reservation = authority.reservation
      val persisted = VoiceRuntimePersistedAuthority(
        reservation.identity.runtimeId,
        reservation.identity.generation,
        reservation.targetDigest,
        authority.target,
        authority.environmentOrigin,
        authority.readinessEnabled,
      )
      val controllerCheckpoint = voiceRuntimeController.checkpointCanonicalInstall()
      val readinessCheckpoint = readinessStore.checkpoint()
      val priorReadinessConfig = readinessConfig
      val priorCanonicalPreparedAuthority = canonicalPreparedAuthority
      val realtimeAuthority = (authority.target as? VoiceRuntimeTarget.Realtime)?.let { target ->
        VoiceRuntimeRealtimeAuthority(
          reservation.identity,
          target,
          persisted.environmentOrigin,
        )
      }
      val installedBinding = voiceRuntimeRealtimeEngineSlot.snapshot().current
      val candidateEngine = realtimeAuthority
        ?.takeUnless { installedBinding?.authority == it }
        ?.let(::createRealtimeEngineLocked)
      var installation: VoiceRuntimeRealtimeEngineInstallation? = null
      var installationCompleted = false
      val snapshot = try {
        voiceRuntimeAuthorityStore.activate(persisted) {
          val configured = when (val target = authority.target) {
            is VoiceRuntimeTarget.Realtime -> voiceRuntimeController.configureRealtimeAuthority(
              reservation, target, authority.fingerprint,
            )
            is VoiceRuntimeTarget.Thread -> voiceRuntimeController.configureAuthority(
              reservation, target, authority.fingerprint,
            )
          }
          installation = when {
            candidateEngine != null ->
              voiceRuntimeRealtimeEngineSlot.stageIdleInstall(
                requireNotNull(realtimeAuthority),
                candidateEngine,
              )
            realtimeAuthority == null && installedBinding != null ->
              voiceRuntimeRealtimeEngineSlot.stageIdleClear()
            else -> null
          }
          installation?.let(voiceRuntimeRealtimeEngineSlot::commit)
          val nextReadiness = T3VoiceConfigureReadinessPolicy.synthesize(
            verifyReadiness(readinessConfig),
            persisted.generation,
            authority.readinessEnabled,
          )
          if (authority.readinessEnabled) {
            val prepared = T3VoicePreparedReadiness(
              nextReadiness,
              persisted.runtimeId,
              persisted.environmentOrigin,
              persisted.target.grantOperation(),
              persisted.targetDigest,
            )
            readinessStore.writeActivated(prepared.config, prepared)
            readinessConfig = prepared.config
            canonicalPreparedAuthority = null
          } else {
            readinessStore.write(nextReadiness)
            readinessConfig = nextReadiness
            canonicalPreparedAuthority = null
          }
          installation?.let(voiceRuntimeRealtimeEngineSlot::complete)
          installationCompleted = true
          configured
        }
      } catch (cause: Throwable) {
        installation?.takeUnless { installationCompleted }?.let { staged ->
          runCatching { voiceRuntimeRealtimeEngineSlot.rollback(staged) }
            .onFailure(cause::addSuppressed)
        }
        val controllerRestored = runCatching {
          voiceRuntimeController.restoreCanonicalInstall(
            controllerCheckpoint,
            reservation,
          )
        }.onFailure(cause::addSuppressed).getOrDefault(false)
        runCatching { readinessStore.restore(readinessCheckpoint) }
          .onFailure(cause::addSuppressed)
        readinessConfig = priorReadinessConfig
        canonicalPreparedAuthority = priorCanonicalPreparedAuthority
        if (!controllerRestored) {
          enterCanonicalRecoveryRequiredLocked("configure-controller-rollback")
        }
        throw cause
      }
      candidateEngine?.let { recoverRealtimeEngineLocked(it, reservation.identity) }
      if (persisted.readinessEnabled) keepReadinessServiceStarted()
        snapshot
      }
    }

    fun inspectVoiceRuntimeAuthority(): VoiceRuntimeAuthorityInspection? =
      mailbox.submitAndAwait(binderMessage("inspect-authority")) {
        run {
          val snapshot = voiceRuntimeController.snapshot()
          val persisted = (voiceRuntimeAuthorityStore.load()
            as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
          if (persisted != null && persisted.runtimeId == snapshot.identity.runtimeId) {
            return@run VoiceRuntimeAuthorityInspection(
              persisted.runtimeId,
              snapshot.identity.runtimeInstanceId,
              persisted.generation - 1,
              persisted.generation,
              persisted.target,
              persisted.environmentOrigin,
              persisted.readinessEnabled,
              readinessConfig,
            )
          }
          null
        }
      }

    fun clearVoiceRuntimeAuthority(commandId: String, identity: VoiceRuntimeIdentity) =
      mailbox.submitAndAwait(binderMessage("clear-authority")) {
        run {
          cancelVoiceRuntimeThreadRearmLocked()
          val snapshot = voiceRuntimeController.clearAuthority(commandId, identity)
          voiceRuntimeAuthorityStore.clear()
          clearIdleRealtimeEngineLocked()
          disableRuntimeVoiceReadinessLocked()
          snapshot
        }
      }

    fun attachVoiceRuntime(presentation: VoiceRuntimePresentation): VoiceRuntimeConsumerLease =
      mailbox.submitAndAwait(binderMessage("attach")) {
        run { voiceRuntimeController.attach(presentation) }
      }

    fun updateVoiceRuntimeAttachment(
      lease: VoiceRuntimeConsumerLease,
      presentation: VoiceRuntimePresentation,
    ): VoiceRuntimeConsumerLease = mailbox.submitAndAwait(binderMessage("update-attachment")) {
      run { voiceRuntimeController.updateAttachment(lease, presentation) }
    }

    fun detachVoiceRuntime(lease: VoiceRuntimeConsumerLease) = mailbox.submit(binderMessage("detach")) {
      run {
        voiceRuntimeController.detach(lease)
        if (!voiceRuntimeController.hasConsumers()) cancelVoiceRuntimeThreadRearmLocked()
        clearIdleAttachedOnlyAuthorityLocked()
      }
    }

    fun readVoiceRuntime(
      lease: VoiceRuntimeConsumerLease,
      after: VoiceRuntimeCursor?,
    ): VoiceRuntimeDelivery = mailbox.submitAndAwait(binderMessage("read")) {
      run { voiceRuntimeController.deliver(lease, after) }
    }

    fun acknowledgeVoiceRuntime(lease: VoiceRuntimeConsumerLease, through: VoiceRuntimeCursor) =
      mailbox.submit(binderMessage("acknowledge")) {
        run { voiceRuntimeController.acknowledge(lease, through) }
      }

    fun acknowledgeVoiceRuntimeRetainedRecord(
      identity: VoiceRuntimeIdentity,
      key: VoiceRuntimeRetainedRecordKey,
    ) = mailbox.submit(binderMessage("acknowledge-retained-record")) {
      run { voiceRuntimeController.acknowledgeRetainedRecord(identity, key) }
    }

    fun dispatchVoiceRuntime(
      command: VoiceRuntimeNativeCommand,
      admission: T3VoiceBinderOperationAdmission,
    ): VoiceRuntimeCommandReceipt = mailbox.submitAndAwait(binderMessage("dispatch")) {
      if (command !is VoiceRuntimeNativeCommand.StopMode) {
        run {
          val persisted = (voiceRuntimeAuthorityStore.load()
            as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
            ?: throw VoiceRuntimeExpiredException()
          if (!VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(
              persisted.readinessEnabled,
              voiceRuntimeController.consumerCount(),
            )) {
            throw VoiceRuntimeFenceException("Detached voice start requires persistent readiness.")
          }
        }
      }
      when (command) {
        is VoiceRuntimeNativeCommand.Thread -> run {
          when (command.command) {
            is VoiceRuntimeThreadCommand.Start,
            is VoiceRuntimeThreadCommand.Resume,
            -> voiceRuntimeController.dispatch(command.command, admission::tryAdmit)
            else -> {
              check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
              voiceRuntimeController.dispatch(command.command)
            }
          }
        }
        is VoiceRuntimeNativeCommand.StartRealtime -> {
          val engine = requireRealtimeEngineLocked(command.identity)
          run {
            ensureRuntimeForeground(
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
          }
          val admissionResult = applyRealtimeReduction(
            engine,
            engine.admitStart(
              realtimeState(engine),
              command.commandId,
              VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
              admission.tryAdmit(),
              System.currentTimeMillis(),
            ),
          )
          if (admissionResult is VoiceRuntimeRealtimeCommandResult.Rejected &&
            admissionResult.reason == "start-cancelled") {
            run { reconcileForegroundAfterVoiceStopLocked() }
          }
          realtimeCommandReceipt(command, admissionResult)
        }
        is VoiceRuntimeNativeCommand.StopMode -> {
          check(admission.tryAdmit()) { "The voice stop was cancelled before admission." }
          val operation = run { voiceRuntimeController.snapshot().operation }
          if (operation is VoiceRuntimeOperation.ThreadTurn) {
            run {
              voiceRuntimeController.dispatch(
                VoiceRuntimeThreadCommand.Stop(
                  command.commandId,
                  command.identity,
                  command.modeSessionId,
                  command.policy,
                ),
              )
            }
          } else {
            val policy = if (command.policy == "immediate") {
              VoiceRuntimeRealtimeStopPolicy.IMMEDIATE
            } else VoiceRuntimeRealtimeStopPolicy.DRAIN
            realtimeCommandReceipt(
              command,
              requireRealtimeEngineLocked(command.identity).let { engine ->
                applyRealtimeReduction(engine, engine.stop(
                  realtimeState(engine),
                command.commandId,
                VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
                policy,
                  System.currentTimeMillis(),
                ))
              },
            )
          }
        }
        is VoiceRuntimeNativeCommand.SetRealtimeMuted -> realtimeBooleanReceipt(command) {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          requireRealtimeEngineLocked(command.identity).let { engine ->
            applyRealtimeReduction(engine, engine.setMuted(
              realtimeState(engine),
              VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
              command.muted,
            ))
          }
        }
        is VoiceRuntimeNativeCommand.UpdateRealtimeFocus -> {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          val engine = requireRealtimeEngineLocked(command.identity)
          val fence = VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId)
          val focused = applyRealtimeReduction(engine, engine.updateFocus(
            realtimeState(engine), fence, command.commandId, command.focus,
          ))
          realtimeBooleanReceipt(command) { focused }
        }
        is VoiceRuntimeNativeCommand.SetAudioRoute -> {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          realtimeCommandReceipt(
            command,
            VoiceRuntimeRealtimeCommandResult.Rejected("unsupported-capability"),
          )
        }
        is VoiceRuntimeNativeCommand.DecideRealtimeConfirmation -> {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          run {
            val pending = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.pendingAction
              as? VoiceRuntimeRealtimeAction.ConfirmationRequired
              ?: throw VoiceRuntimeFenceException("Realtime confirmation is stale.")
            if (pending.actionId != command.actionId ||
              pending.confirmationId != command.confirmationId) {
              throw VoiceRuntimeFenceException("Realtime confirmation is stale.")
            }
            voiceRuntimeController.claimPresentationAction(command.lease, command.actionId)
          }
          val engine = requireRealtimeEngineLocked(command.identity)
          val admissionResult = if (applyRealtimeReduction(
              engine,
              engine.acknowledgePresentationAction(
                realtimeState(engine),
                VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
                command.commandId,
                command.actionId,
                VoiceRuntimeRealtimePresentationDecision.Confirmation(
                  command.confirmationId,
                  command.decision,
                ),
              ),
            )) {
            voiceRuntimeController.acknowledgePresentationAction(command.lease, command.actionId)
            VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
          } else VoiceRuntimeRealtimeCommandResult.Rejected("acknowledgement-failed")
          realtimeCommandReceipt(command, admissionResult)
        }
      }
    }

    fun readVoiceRuntimeDraft(lease: VoiceRuntimeConsumerLease, artifactId: String) =
      mailbox.submitAndAwait(binderMessage("read-draft")) {
        run { voiceRuntimeController.readDraft(lease, artifactId) }
      }

    fun acknowledgeVoiceRuntimeDraft(
      lease: VoiceRuntimeConsumerLease,
      artifactId: String,
      outcome: String,
    ) = mailbox.submit(binderMessage("acknowledge-draft")) {
      run { voiceRuntimeController.acknowledgeDraft(lease, artifactId, outcome) }
    }

    fun claimVoiceRuntimePresentationAction(
      lease: VoiceRuntimeConsumerLease,
      actionId: String,
    ) = mailbox.submitAndAwait(binderMessage("claim-presentation-action")) {
      run { voiceRuntimeController.claimPresentationAction(lease, actionId) }
    }

    fun acknowledgeVoiceRuntimePresentationAction(
      lease: VoiceRuntimeConsumerLease,
      actionId: String,
      outcome: String,
      message: String?,
    ) {
      mailbox.submit(binderMessage("acknowledge-presentation-action")) {
        val realtime = run {
          val pending = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.pendingAction
          val realtimeActionId = when (pending) {
            is VoiceRuntimeRealtimeAction.NavigateThread -> pending.actionId
            is VoiceRuntimeRealtimeAction.ConfirmationRequired ->
              throw VoiceRuntimeFenceException(
                "Realtime confirmations require an explicit approval decision.",
              )
            else -> null
          }
          if (realtimeActionId != actionId) {
            return@run null
          }
          val snapshot = voiceRuntimeController.snapshot()
          val operation = snapshot.operation as? VoiceRuntimeOperation.Realtime
            ?: throw VoiceRuntimeFenceException("Realtime presentation action is stale.")
          val acknowledgement = Triple(
            requireRealtimeEngineLocked(snapshot.identity),
            VoiceRuntimeRealtimeFence(snapshot.identity, operation.modeSessionId),
            VoiceRuntimeRealtimePresentationDecision.Navigate(
              if (outcome == "succeeded") VoiceRuntimeRealtimeActionOutcome.SUCCEEDED
              else VoiceRuntimeRealtimeActionOutcome.FAILED,
              message,
            )
          )
          acknowledgement
        }
        if (realtime == null) return@submit
        val engine = realtime.first
        if (applyRealtimeReduction(
            engine,
            engine.acknowledgePresentationAction(
              realtimeState(engine),
              realtime.second,
              "action-$actionId-${UUID.randomUUID()}",
              actionId,
              realtime.third,
            ),
          )) voiceRuntimeController.acknowledgePresentationAction(lease, actionId)
      }
    }
  }

  private val binder = VoiceBinder()
  private lateinit var readinessStore: T3VoiceReadinessStore
  private lateinit var cueSettingsStore: T3VoiceCueSettingsStore
  private lateinit var runtimeSnapshotStore: VoiceRuntimeExecutionSnapshotStore
  private lateinit var runtimeThreadOperationStore: VoiceRuntimeThreadOperationStore
  private lateinit var voiceRuntimeController: VoiceRuntimeActiveThreadController
  private lateinit var voiceRuntimeAuthorityStore: VoiceRuntimeAuthorityStore
  private lateinit var voiceRuntimeSessionCredentialStore: VoiceRuntimeSessionCredentialStore
  private lateinit var voiceRuntimeRealtimeRepository: VoiceRuntimeRealtimeCheckpointRepository
  private val voiceRuntimeRealtimeEngineSlot =
    VoiceRuntimeRealtimeEngineSlot<VoiceRuntimeRealtimeReducer>(
      isRealtimeStateActive = VoiceRuntimeRealtimeState::isOperational,
      assertKernelThread = mailbox::assertKernelThread,
    )
  private val voiceRuntimeRealtimeEngine: VoiceRuntimeRealtimeReducer?
    get() = voiceRuntimeRealtimeEngineSlot.snapshot().current?.engine
  private val voiceRuntimeRealtimeServer = VoiceRuntimeRealtimeHttpGateway(::sessionCredential)
  private val netDriver = VoiceNetDriver(::postDriverResult)
  private val storeDriver = VoiceStoreDriver(::postDriverResult)
  private lateinit var hostDriver: VoiceHostDriver
  private lateinit var mediaDriver: VoiceMediaDriver<
    T3VoiceRecorder,
    T3VoicePcmPlayer,
    T3VoicePlaybackAudioFocus,
    T3VoiceCueCoordinator,
    T3VoiceAudioRouter,
    T3VoiceWebRtcSession
  >
  private var voiceRuntimeRealtimeHeartbeatTask: VoiceKernelCancellationToken? = null
  private var voiceRuntimeRealtimeActionTask: VoiceKernelCancellationToken? = null
  private var voiceRuntimeRealtimeDrainTask: VoiceKernelCancellationToken? = null
  private var voiceRuntimeRealtimeFinalizationTask: VoiceKernelCancellationToken? = null
  private var voiceRuntimeThreadRearmTask: VoiceKernelCancellationToken? = null
  private var canonicalPreparedAuthority: T3VoicePreparedReadiness? = null
  private val startCommandStickiness = T3VoiceStartCommandStickinessCache()
  private var readinessConfig = T3VoiceReadinessConfig()
    set(value) {
      field = value
      startCommandStickiness.publish(value)
    }
  private var cueSettings = T3VoiceCueSettings()
  private var runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
  private val runtimeThreadServer = VoiceRuntimeThreadTurnDelegate()
  private var runtimeThreadAttempt: VoiceRuntimeThreadAttempt? = null
  private var pendingRuntimeHandoffActivation: T3VoicePendingRuntimeHandoffActivation? = null
  private var realtimeFinalizationTransitionAuthority: VoiceRuntimePersistedAuthority? = null
  private var detachedThreadContinuationAdmission = false
  private val controllerCommands = T3VoiceControllerCommands()
  private var mediaSession: MediaSession? = null
  private var mediaSessionRequested = false
  @Volatile private var foregroundServiceTypes = 0
  @Volatile private var notificationSnapshot = T3VoiceNotificationSnapshot()
  private var wakeLock: PowerManager.WakeLock? = null
  private var recordingOwner: T3VoiceOperationOwner? = null
  private var playbackOwner: T3VoiceOperationOwner? = null
  private val recorder: T3VoiceRecorder
    get() = mediaDriver.recorder
  private val player: T3VoicePcmPlayer
    get() = mediaDriver.player
  private val playbackAudioFocus: T3VoicePlaybackAudioFocus
    get() = mediaDriver.focus
  private val cueCoordinator: T3VoiceCueCoordinator
    get() = mediaDriver.cues
  private var realtimeReadyCue: Pair<String, Long>? = null
  private var realtimeEndedCue: Pair<String, Long>? = null
  private var pendingRecordingStart: T3VoicePendingRecordingStart? = null
  private var recordingEndedCue: Pair<String, Long>? = null
  private val realtime: T3VoiceWebRtcSession
    get() = mediaDriver.realtime

  private fun handleMediaDriverEventLocked(event: VoiceMediaDriverEvent) {
    when (event) {
      is VoiceMediaDriverEvent.RecorderTerminated ->
        handleRecorderTerminatedLocked(event.termination)
      is VoiceMediaDriverEvent.PcmChunkConsumed -> T3VoiceStateStore.emit(
        T3VoiceRuntimeEvent.PlaybackChunkConsumed(event.playbackId, event.chunkIndex),
      )
      is VoiceMediaDriverEvent.PcmFinished -> handlePcmFinishedLocked(event.playbackId)
      is VoiceMediaDriverEvent.PcmFailed -> handlePcmFailedLocked(event.playbackId, event.cause)
      VoiceMediaDriverEvent.PlaybackFocusSuspended ->
        playbackOwner?.let { owner -> runCatching { player.pause(owner.id) } }
      VoiceMediaDriverEvent.PlaybackFocusResumed ->
        playbackOwner?.let { owner -> runCatching { player.resume(owner.id) } }
      VoiceMediaDriverEvent.PlaybackFocusTerminated -> playbackOwner?.let { owner ->
        runCatching { player.cancel(owner.id) }
        handlePlaybackTerminationLocked(owner.id, "cancelled")
      }
      is VoiceMediaDriverEvent.RealtimeStateChanged -> handleRealtimeStateChangedLocked(event)
      is VoiceMediaDriverEvent.RealtimeRouteChanged -> Unit
      is VoiceMediaDriverEvent.RealtimeAudioFocusChanged ->
        realtime.handleAudioFocusChange(event.sessionId, event.change)
      is VoiceMediaDriverEvent.RealtimeAudioDevicesChanged ->
        realtime.handleAudioDevicesChanged(event.sessionId)
      is VoiceMediaDriverEvent.RealtimeError -> T3VoiceStateStore.emit(
        T3VoiceRuntimeEvent.RuntimeError(
          operation = "realtime:${event.sessionId}",
          code = event.code,
          message = event.message,
          recoverable = event.recoverable,
        ),
      )
      is VoiceMediaDriverEvent.RealtimeTerminated -> handleRealtimeTerminatedLocked(event)
    }
  }

  private fun handleRecorderTerminatedLocked(termination: T3VoiceRecordingTermination) {
    val owner = recordingOwner ?: return
    when (termination) {
      is T3VoiceRecordingTermination.Completed -> {
        terminateRecordingLocked(
          owner,
          T3VoiceRuntimeEvent.RecordingTerminated(
            termination.recording.recordingId,
            termination.recording,
            "completed",
            termination.reason,
          ),
          stopForeground = false,
        )
        runtimeThreadAttempt?.takeIf { it.operationId == owner.id }?.let { attempt ->
          handleRuntimeThreadRecordingLocked(attempt, termination.recording)
        }
      }
      is T3VoiceRecordingTermination.Cancelled -> {
        terminateRecordingLocked(
          owner,
          T3VoiceRuntimeEvent.RecordingTerminated(
            termination.recordingId,
            null,
            "cancelled",
            termination.reason,
          ),
          stopForeground = false,
        )
        failNativeThreadRecordingLocked(owner, "native-thread-recording-cancelled")
      }
      is T3VoiceRecordingTermination.Failed -> {
        terminateRecordingLocked(
          owner,
          T3VoiceRuntimeEvent.RecordingTerminated(
            termination.recordingId,
            null,
            "failed",
            "finalization-failed",
          ),
          stopForeground = false,
        )
        failNativeThreadRecordingLocked(owner, "native-thread-recording-failed")
      }
    }
    beginRecordingEndedCueLocked(owner.id)
  }

  private fun handlePcmFinishedLocked(playbackId: String) {
    playbackOwner?.let { owner ->
      terminatePlaybackLocked(
        owner,
        T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "completed"),
      )
      runtimeThreadAttempt?.takeIf {
        playbackId == runtimeThreadPlaybackId(it, it.playingSegment)
      }?.let { attempt ->
        val segment = requireNotNull(attempt.playingSegment)
        attempt.playingSegment = null
        attempt.playbackFailures = 0
        val persisted = applyRuntimeEventLocked(
          VoiceRuntimeExecutionEvent.PlaybackDrained(requireNotNull(attempt.operationId), segment),
        )
        if (persisted != null) {
          syncRuntimeThreadSpeechProgress(attempt, runtimeSnapshot)
          acknowledgeRuntimeThread(
            attempt,
            sessionCredential(attempt.authority.environmentOrigin),
            requireNotNull(attempt.operationId),
            runtimeSnapshot.eventCursor,
          )
        }
      }
    }
  }

  private fun handlePcmFailedLocked(playbackId: String, cause: Throwable) {
    T3VoiceStateStore.emit(
      T3VoiceRuntimeEvent.RuntimeError(
        operation = "playback:$playbackId",
        code = "pcm-playback-failed",
        message = cause.message ?: "PCM playback failed.",
        recoverable = true,
      ),
    )
    handlePlaybackTerminationLocked(playbackId, "failed")
  }

  private fun handleRealtimeStateChangedLocked(event: VoiceMediaDriverEvent.RealtimeStateChanged) {
    T3VoiceStateStore.setRealtime(
      event.sessionId,
      event.connectionState,
      event.muted,
      event.inputReady,
    )
    val canonical = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.takeIf {
      it.fence.modeSessionId == event.sessionId
    }
    if (canonical != null && event.connectionState == "connected" && !event.inputReady) {
      canonical.serverSessionId?.let { serverSessionId ->
        voiceRuntimeRealtimeEngine?.let { engine ->
          runCatching {
            applyRealtimeReduction(
              engine,
              engine.onPeerConnected(realtimeState(engine), canonical.fence, serverSessionId),
            )
          }
        }
      }
    } else if (event.connectionState == "connected" && !event.inputReady) {
      beginRealtimeReadyCueLocked(event.sessionId)
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun handleRealtimeTerminatedLocked(event: VoiceMediaDriverEvent.RealtimeTerminated) {
    val canonical = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.takeIf {
      it.fence.modeSessionId == event.sessionId
    }
    if (canonical != null) {
      T3VoiceStateStore.terminateRealtime(
        T3VoiceRuntimeEvent.RealtimeTerminated(
          event.sessionId,
          event.outcome,
          event.code,
          event.retryable,
        ),
      )
      canonical.serverSessionId?.let { serverSessionId ->
        voiceRuntimeRealtimeEngine?.let { engine ->
          runCatching {
            applyRealtimeReduction(engine, engine.onPeerTerminated(
              realtimeState(engine), canonical.fence, serverSessionId, event.code,
              System.currentTimeMillis(),
            ))
          }
        }
      }
      updateRuntimeControlSurfacesLocked()
      return
    }
    cancelRealtimeReadyCueLocked(event.sessionId)
    val terminated = T3VoiceStateStore.terminateRealtime(
      T3VoiceRuntimeEvent.RealtimeTerminated(
        event.sessionId,
        event.outcome,
        event.code,
        event.retryable,
      ),
    )
    if (terminated) {
      if (event.outcome == "ended" && cueSettings.enabled) {
        beginRealtimeEndedCueLocked(event.sessionId)
      } else {
        stopRuntimeForegroundLocked()
      }
      T3VoiceDiagnostics.record(
        event.diagnosticGeneration,
        T3VoiceDiagnosticCategory.LIFECYCLE,
        T3VoiceDiagnosticCode.FOREGROUND_RELEASED,
      )
    }
    epochRegistry.current(event.sessionId)?.let(epochRegistry::retire)
    mediaDriver.disarmRealtime(event.sessionId)
  }

  private fun beginRealtimeReadyCueLocked(sessionId: String) {
    val state = T3VoiceStateStore.state.value
    if (
      state.activeRealtimeSessionId != sessionId ||
        state.realtimeConnectionState != "connected" ||
        state.realtimeInputReady
    ) return
    if (realtimeReadyCue?.first == sessionId) return
    val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:realtime-ready:$sessionId")
    val generation = epoch.attemptOrdinal
    realtimeReadyCue = sessionId to generation
    if (!cueSettings.enabled || !cueCoordinator.requestReady(generation) { completion ->
        postCueCompletion(epoch) {
          run {
            completeRealtimeReadyCueLocked(sessionId, completion.generation)
          }
        }
      }) {
      epochRegistry.retire(epoch)
      completeRealtimeReadyCueLocked(sessionId, generation)
    }
  }

  private fun completeRealtimeReadyCueLocked(sessionId: String, generation: Long) {
    @Suppress("UNUSED_PARAMETER") val admittedGeneration = generation
    if (realtimeReadyCue?.first != sessionId) return
    realtimeReadyCue = null
    val state = T3VoiceStateStore.state.value
    if (
      state.activeRealtimeSessionId != sessionId ||
        state.realtimeConnectionState != "connected"
    ) return
    runCatching { realtime.setInputReady(sessionId, true) }
      .onFailure { realtime.failRuntimeControl(sessionId, retryable = true) }
  }

  private fun cancelRealtimeReadyCueLocked(sessionId: String) {
    val pending = realtimeReadyCue?.takeIf { it.first == sessionId } ?: return
    realtimeReadyCue = null
    cueCoordinator.stop(pending.second)
  }

  private fun beginRealtimeEndedCueLocked(sessionId: String) {
    val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:realtime-ended:$sessionId")
    val generation = epoch.attemptOrdinal
    realtimeEndedCue = sessionId to generation
    val started = cueCoordinator.requestEnded(generation) { completion ->
      postCueCompletion(epoch) {
        run {
          if (realtimeEndedCue?.first == sessionId) {
            realtimeEndedCue = null
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          }
        }
      }
    }
    if (!started) {
      epochRegistry.retire(epoch)
      realtimeEndedCue = null
      stopRuntimeForegroundLocked()
    }
  }

  private fun scheduleRecordingStartLocked(
    owner: T3VoiceOperationOwner,
    endpointConfig: T3VoiceEndpointDetectionConfig,
    onStarted: () -> Unit = {},
    onFailure: () -> Unit = {},
  ) {
    ensureRuntimeForeground(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
    )
    val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:recording-ready:${owner.id}")
    val generation = epoch.attemptOrdinal
    val pending =
      T3VoicePendingRecordingStart(
        owner,
        endpointConfig,
        generation,
        mutableListOf(onStarted),
        mutableListOf(onFailure),
      )
    pendingRecordingStart = pending
    if (!cueSettings.enabled) {
      epochRegistry.retire(epoch)
      completeRecordingStartLocked(owner, generation)
      return
    }
    val started =
      cueCoordinator.requestReady(generation) { completion ->
        postCueCompletion(epoch) {
          run {
            completeRecordingStartLocked(owner, completion.generation)
          }
        }
      }
    if (!started) {
      epochRegistry.retire(epoch)
      completeRecordingStartLocked(owner, generation)
    }
  }

  private fun completeRecordingStartLocked(owner: T3VoiceOperationOwner, cueGeneration: Long) {
    val pending = pendingRecordingStart
      ?.takeIf { it.owner == owner }
      ?: return
    @Suppress("UNUSED_PARAMETER") val admittedGeneration = cueGeneration
    pendingRecordingStart = null
    var captureStarted = false
    try {
      val epoch = armEpoch(VoiceKernelEpochRootKind.RECORDING, owner.id)
      mediaDriver.armRecording(owner.id, epoch)
      recorder.start(owner.id, pending.endpointConfig)
      captureStarted = true
      check(T3VoiceStateStore.markRecordingStarted(owner)) {
        "The recording owner changed while the microphone was arming."
      }
      keepServiceStarted(ACTION_START_RECORDING, owner.id)
      pending.onStarted.forEach { it() }
    } catch (_: Throwable) {
      if (captureStarted) runCatching { recorder.cancel(owner.id) }
      releaseRecordingLocked(owner, stopForeground = false)
      pending.onFailure.forEach { it() }
      if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        stopRuntimeForegroundLocked()
      }
    }
  }

  private fun cancelPendingRecordingStartLocked(
    owner: T3VoiceOperationOwner,
  ): T3VoicePendingRecordingStart? {
    val pending = pendingRecordingStart?.takeIf { it.owner == owner } ?: return null
    pendingRecordingStart = null
    cueCoordinator.stop(pending.cueGeneration)
    return pending
  }

  private fun beginRecordingEndedCueLocked(recordingId: String) {
    if (!cueSettings.enabled) {
      if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        stopRuntimeForegroundLocked()
      }
      return
    }
    val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:recording-ended:$recordingId")
    val generation = epoch.attemptOrdinal
    recordingEndedCue = recordingId to generation
    val started = cueCoordinator.requestEnded(generation) { completion ->
      postCueCompletion(epoch) {
        run {
          if (recordingEndedCue?.first == recordingId) {
            recordingEndedCue = null
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          }
        }
      }
    }
    if (!started) {
      epochRegistry.retire(epoch)
      recordingEndedCue = null
      if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        stopRuntimeForegroundLocked()
      }
    }
  }

  private fun verifyReadiness(config: T3VoiceReadinessConfig): T3VoiceReadinessConfig {
    val verified =
      config.copy(
        microphonePermissionGranted =
          config.microphonePermissionGranted && hasPermission(Manifest.permission.RECORD_AUDIO),
        notificationPermissionGranted =
          config.notificationPermissionGranted &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
              hasPermission(Manifest.permission.POST_NOTIFICATIONS)),
      )
    require(!verified.enabled || verified.mode != T3VoiceReadinessMode.THREAD || verified.targetId != null) {
      "Thread readiness requires a target."
    }
    return verified
  }

  private fun sessionCredential(environmentOrigin: String): String {
    val stored = (voiceRuntimeSessionCredentialStore.load()
      as? VoiceRuntimeSessionCredentialLoadResult.Available)?.value
      ?: throw VoiceRuntimeFenceException("Runtime session credential is unavailable.")
    if (stored.environmentOrigin != VoiceRuntimeOriginPolicy.normalize(environmentOrigin)) {
      throw VoiceRuntimeFenceException("Runtime session credential belongs to another environment.")
    }
    return stored.credential.value
  }

  private fun persistedAuthority(): VoiceRuntimePersistedAuthority? =
    (voiceRuntimeAuthorityStore.load() as? VoiceRuntimeAuthorityLoadResult.Available)?.authority

  private fun loadRecoveryState(): Pair<LoadedState, Permissions> {
    val retiredAuthorityFence = voiceRuntimeAuthorityStore.retireLegacyV2()
    if (retiredAuthorityFence != null) {
      storeDriver.persist("legacy-retirement-clear-session-credential", driverEpoch(), body = {
        voiceRuntimeSessionCredentialStore.clear()
      })
    }
    var snapshot = runtimeSnapshotStore.read()
    runCatching {
      VoiceRuntimeLegacyRealtimeCutover(
        runtimeSnapshotStore,
        VoiceRuntimeRealtimeCleanupStore(applicationContext),
      ).migrate(snapshot)
    }.onSuccess { cutover ->
      snapshot = cutover.snapshot
      if (cutover.migrated) {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.LEGACY_REALTIME_RETIRED,
        )
      }
    }.onFailure {
      snapshot = VoiceRuntimeExecutionSnapshot()
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
      )
    }
    val attached = runCatching { voiceRuntimeAuthorityStore.inspectPreparedAttachedAuthority() }
    val canonical = voiceRuntimeAuthorityStore.load()
    val finalization = runCatching { voiceRuntimeRealtimeRepository.loadFinalization() }
    val checkpoint = runCatching { voiceRuntimeRealtimeRepository.load() }
    val prepared = runCatching { readinessStore.prepared() }
    val active = runCatching { readinessStore.activeAuthority() }
    val threadOperation = runtimeThreadOperationStore.load()
    val permissions = Permissions(
      microphoneGranted = hasPermission(Manifest.permission.RECORD_AUDIO),
      notificationGranted = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        hasPermission(Manifest.permission.POST_NOTIFICATIONS),
    )
    var loaded = LoadedState(
      readinessConfig = readinessStore.read(),
      preparedReadiness = prepared.getOrNull(),
      activeAuthority = active.getOrNull(),
      attachedPreparation = attached.getOrNull(),
      canonicalAuthority = canonical,
      retiredAuthorityFence = retiredAuthorityFence,
      realtimeFinalization = finalization.getOrNull(),
      realtimeCheckpoint = checkpoint.getOrNull(),
      runtimeSnapshot = snapshot,
      threadOperation = threadOperation,
      cueSettings = cueSettingsStore.read(),
      attachedPreparationRead = attached.isSuccess,
      persistentReadinessRead = prepared.isSuccess,
      activeAuthorityRead = active.isSuccess,
      finalizationRead = finalization.isSuccess,
      checkpointRead = checkpoint.isSuccess,
    )
    val authority = (canonical as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
    val reconciliation = authority?.let {
      runCatching { canonicalReadinessReconciliation(loaded, permissions, it) }.getOrNull()
    }
    val writeSucceeded = when (reconciliation) {
      is CanonicalReadinessReconciliation.Transient ->
        runCatching { readinessStore.write(reconciliation.config) }.isSuccess
      is CanonicalReadinessReconciliation.Promote ->
        runCatching {
          readinessStore.writeActivated(reconciliation.authority.config, reconciliation.authority)
        }.isSuccess
      else -> null
    }
    if (writeSucceeded != null) {
      loaded = loaded.copy(
        canonicalReadinessWriteStatus = if (writeSucceeded) {
          CanonicalReadinessWriteStatus.SUCCEEDED
        } else {
          CanonicalReadinessWriteStatus.FAILED
        },
      )
    }
    return loaded to permissions
  }

  private fun executeRecoveryEffectLocked(
    effect: VoiceRuntimeRecoveryEffect,
    canonicalConfigured: Boolean,
  ): Boolean = when (effect) {
    is VoiceRuntimeRecoveryEffect.WriteReadiness -> {
      if (effect.bestEffort) {
        runCatching { readinessStore.write(effect.config) }
      } else {
        readinessStore.write(effect.config)
      }
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.WriteActivatedReadiness -> {
      readinessStore.writeActivated(effect.config, effect.authority)
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.WriteDisabledForRuntimeRevocation -> {
      readinessStore.writeDisabledForRuntimeRevocation(effect.config, effect.pending)
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.DiscardInitialPreparation -> {
      voiceRuntimeAuthorityStore.discardInitialPreparation()
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.InvalidateReadiness -> {
      controllerCommands.invalidateReadiness()
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.ClearLockedAfterAuthorityRevocation -> {
      runtimeThreadOperationStore.clearLockedAfterAuthorityRevocation()
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.ClearRuntimeSnapshot -> {
      runtimeSnapshotStore.clear()
      runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.ClearAuthority -> {
      storeDriver.persist(effect.reason, driverEpoch(), body = {
        voiceRuntimeAuthorityStore.clear()
      })
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.Diagnostic -> {
      T3VoiceDiagnostics.record(
        effect.generation,
        T3VoiceDiagnosticCategory.TERMINAL,
        effect.code,
      )
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.ConfigureCanonicalAuthority ->
      restoreCanonicalAuthorityLocked(effect.authority)
    is VoiceRuntimeRecoveryEffect.InstallRealtime -> {
      when (val install = effect.plan) {
        is VoiceRuntimeRealtimeInstallPlan.Recovered -> {
          if (!installRecoveredRealtimeStateLocked() && canonicalConfigured) {
            persistedAuthority()?.let(::installRealtimeEngineLocked)
          }
        }
        is VoiceRuntimeRealtimeInstallPlan.Canonical ->
          if (canonicalConfigured) installRealtimeEngineLocked(install.authority) else Unit
        VoiceRuntimeRealtimeInstallPlan.None -> Unit
      }
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.RestoreThreadRecording -> {
      val loaded = runtimeThreadOperationStore.load()
      if (!VoiceRuntimeThreadRecordingRecovery.restore(loaded, recorder::restoreCompleted)) {
        ((loaded as? VoiceRuntimeThreadOperationLoadResult.Available)?.state
          as? VoiceRuntimeThreadOperationState.Active)?.let { active ->
          runtimeThreadOperationStore.writeActive(
            active.copy(recording = null, detached = true, cancelRequested = true),
          )
        }
      }
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.RestoreBridgeCompletions -> {
      restoreBridgeRecordingCompletions(recorder::restoreCompleted) {}
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.SweepStaleCache -> {
      recorder.sweepStaleCache()
      canonicalConfigured
    }
    VoiceRuntimeRecoveryEffect.SetServiceReady -> {
      T3VoiceStateStore.setServiceReady()
      canonicalConfigured
    }
    is VoiceRuntimeRecoveryEffect.ReconcileThreadOperation -> {
      if (reconcileRecoveryThreadOperationLocked()) startRuntimeThreadLocked()
      canonicalConfigured
    }
  }

  private fun reconcileRecoveryThreadOperationLocked(): Boolean {
    val loaded = runtimeThreadOperationStore.load()
    val grant = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
    return when (VoiceRuntimeThreadStoredStatePolicy.decide(
      loaded,
      VoiceRuntimeThreadStoredStatePolicy.parentGrantAvailable(grant, loaded),
      System.currentTimeMillis(),
    )) {
      VoiceRuntimeThreadStoredStateDecision.NONE -> false
      VoiceRuntimeThreadStoredStateDecision.RESTORE -> true
      VoiceRuntimeThreadStoredStateDecision.CANCEL_PREPARED -> {
        val prepared = (loaded as VoiceRuntimeThreadOperationLoadResult.Available)
          .state as VoiceRuntimeThreadOperationState.Prepared
        runtimeThreadOperationStore.writePrepared(prepared.claim, cancelRequested = true)
        true
      }
      VoiceRuntimeThreadStoredStateDecision.CANCEL_UNDISPATCHED -> {
        val active = (loaded as VoiceRuntimeThreadOperationLoadResult.Available)
          .state as VoiceRuntimeThreadOperationState.Active
        runtimeThreadOperationStore.writeActive(active.copy(detached = true, cancelRequested = true))
        true
      }
      VoiceRuntimeThreadStoredStateDecision.REVOKE -> {
        executeThreadOperationRevocationLocked(loaded, grant)
        false
      }
    }
  }

  private fun executeThreadOperationRevocationLocked(
    loaded: VoiceRuntimeThreadOperationLoadResult,
    grant: VoiceRuntimePersistedAuthority?,
  ) {
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
    )
    when (val selection = VoiceRuntimeThreadStoredStatePolicy.selectRevocation(
      loaded,
      readinessStore.pendingRuntimeRevocation(),
      readinessStore.activeAuthority(),
      grant,
    )) {
      is VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.Disable -> {
        val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
          readinessConfig,
          voiceRuntimeController.snapshot().identity.generation,
        )
        readinessStore.writeDisabledForRuntimeRevocation(disabled, selection.pending)
        readinessConfig = disabled
        canonicalPreparedAuthority = null
        storeDriver.persist("revoke-thread-operation-clear-authority", driverEpoch(), body = {
          voiceRuntimeAuthorityStore.clear()
        })
        controllerCommands.invalidateReadiness()
      }
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.ClearLocked -> {
        runtimeThreadOperationStore.clearLockedAfterAuthorityRevocation()
        runtimeSnapshotStore.clear()
        runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
      }
      VoiceRuntimeThreadStoredStatePolicy.RevocationSelection.None -> Unit
    }
  }

  private fun configureRecoveryHost(plan: VoiceRuntimeRecoveryPlan) {
    readinessConfig = plan.readinessConfig
    runtimeSnapshot = plan.runtimeSnapshot
    cueSettings = plan.cueSettings
    canonicalPreparedAuthority = plan.canonicalPreparedAuthority
    hostDriver = createHostDriver()
    createNotificationChannel()
  }

  private fun executeRecoveryPlanLocked(plan: VoiceRuntimeRecoveryPlan) {
    var canonicalConfigured = false
    plan.effects.forEach { effect ->
      canonicalConfigured = executeRecoveryEffectLocked(effect, canonicalConfigured)
    }
  }

  private fun createRecoveryController(
    canonicalRuntimeId: String,
    initialGeneration: Long?,
  ) {
    voiceRuntimeController = VoiceRuntimeActiveThreadController(
        runtimeId = canonicalRuntimeId,
        runtimeInstanceId = UUID.randomUUID().toString(),
        now = System::currentTimeMillis,
        installedAuthority = ::installedCanonicalAuthorityLocked,
        execution = object : VoiceRuntimeThreadExecution {
          override fun start(
            modeSessionId: String,
            turnClientOperationId: String,
            submissionPolicy: String,
            draftContext: VoiceRuntimeDraftContext?,
          ): Boolean {
            startRuntimeThreadLocked(
              turnClientOperationId,
              modeSessionId,
              submissionPolicy,
              draftContext,
              detachedThreadContinuationAdmission,
            )
            return runtimeThreadAttempt?.clientOperationId == turnClientOperationId
          }

          override fun finish(outcome: String, draftContext: VoiceRuntimeDraftContext?): Boolean {
            val attempt = runtimeThreadAttempt ?: return false
            val owner = recordingOwner?.takeIf {
              it.domain == T3VoiceOperationOwnerDomain.THREAD_MODE &&
                attempt.operationId == it.operationId
            } ?: return false
            if (outcome == "finish-and-submit") {
              if (attempt.submissionPolicy != "auto-submit" || draftContext != null) return false
              return runCatching { recorder.stop(owner.id) }.isSuccess
            }
            if (outcome != "finish-to-draft" || attempt.submissionPolicy != "auto-submit") return false
            val context = draftContext ?: return false
            val persisted = runtimeThreadOperationStore.prepareDraftDisposition(
              attempt.clientOperationId,
              context,
            ) as? VoiceRuntimeThreadOperationUpdateResult.Updated ?: return false
            attempt.submissionPolicy = persisted.state.claim.submissionPolicy
            attempt.draftContext = persisted.state.claim.draftContext
            attempt.draftDispositionPending = true
            val stopped = runCatching { recorder.stop(owner.id) }.isSuccess
            if (!stopped) return false
            requestRuntimeThreadDraftDisposition(attempt)
            return true
          }

          override fun cancel(): Boolean {
            if (runtimeThreadAttempt == null) return false
            stopRuntimeThreadLocked(cancelServer = true)
            return true
          }

          override fun stop(policy: String): Boolean {
            if (runtimeThreadAttempt == null) return false
            when (policy) {
              "immediate" -> stopRuntimeThreadLocked(cancelServer = true)
              "drain", "pause-after-turn" -> pauseRuntimeThreadAfterTurnLocked()
              else -> return false
            }
            return true
          }

          override fun acknowledgeDraft(artifactId: String, outcome: String): Boolean {
            val attempt = runtimeThreadAttempt ?: return false
            val operationId = attempt.operationId ?: return false
            if (artifactId != "draft-$operationId") return false
            if (outcome == "discarded") {
              stopRuntimeThreadLocked(cancelServer = true)
              return true
            }
            if (outcome != "appended") return false
            val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
              it.copy(draftConsumePending = true)
            }
            if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) return false
            attempt.draftConsumePending = true
            consumeRuntimeThreadDraft(attempt)
            return true
          }
        },
        drafts = VoiceRuntimeDurableDraftRepository(applicationContext),
        retained = VoiceRuntimeDurableJournalRepository(applicationContext),
        realtimeTerminals = voiceRuntimeRealtimeRepository::terminals,
        realtimeTerminalAcknowledgement = { key ->
          val acknowledged = voiceRuntimeRealtimeRepository.acknowledgeTerminal(key)
          voiceRuntimeRealtimeEngine?.let { engine ->
            applyRealtimeReduction(
              engine,
              engine.acknowledgeTerminal(realtimeState(engine), key, acknowledged),
            )
          } ?: acknowledged
        },
        onJournalChanged = { cursor ->
          T3VoiceStateStore.emit(T3VoiceRuntimeEvent.VoiceRuntimeWake(
            cursor.runtimeId,
            cursor.runtimeInstanceId,
            cursor.generation,
            cursor.sequence,
          ))
        },
        initialGeneration = initialGeneration,
    )
  }

  override fun onCreate() {
    super.onCreate()
    readinessStore = T3VoiceReadinessStore(applicationContext)
    cueSettingsStore = T3VoiceCueSettingsStore(applicationContext)
    runtimeSnapshotStore = VoiceRuntimeExecutionSnapshotStore(applicationContext)
    runtimeThreadOperationStore = VoiceRuntimeThreadOperationStore(applicationContext)
    voiceRuntimeAuthorityStore = VoiceRuntimeAuthorityStore(applicationContext)
    voiceRuntimeSessionCredentialStore = VoiceRuntimeSessionCredentialStore(applicationContext)
    voiceRuntimeRealtimeRepository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(applicationContext)
    val (loadedState, permissions) = loadRecoveryState()
    val plan = recover(loadedState, permissions, Clock(System::currentTimeMillis))
    val canonicalRuntimeId = VoiceRuntimeDeviceIdentityStore(applicationContext)
      .getOrCreate(plan.installedRuntimeId)
    createRecoveryController(canonicalRuntimeId, plan.initialGeneration)
    configureRecoveryHost(plan)
    mailbox.submitAndAwait(callbackMessage("service-create-recovery")) {
      mediaDriver = VoiceMediaDriver(
        listener = VoiceMediaDriverListener { epoch, event ->
          postDriverResult(
            VoiceKernelMessage.DriverResult(
              epoch = epoch,
              driver = VoiceKernelDriver.MEDIA,
              resultKind = event::class.java.simpleName,
              payload = VoiceKernelDriverResultPayload.MediaEvent(
                eventKind = event::class.java.simpleName,
                continuation = { handleMediaDriverEventLocked(event) },
              ),
            ),
          )
        },
        factory = AndroidVoiceMediaDriverFactory(applicationContext),
      )
      executeRecoveryPlanLocked(plan)
    }
  }

  override fun onBind(intent: Intent?): IBinder {
    return binder
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_PRIMARY -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_PRIMARY),
      ) {
        run { executeControlCommandLocked(T3VoiceControlCommand.PRIMARY) }
      }
      ACTION_STOP -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
      ) {
        run { executeControlCommandLocked(T3VoiceControlCommand.STOP) }
      }
      ACTION_TOGGLE_MUTE -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_TOGGLE_MUTE),
      ) {
        run { executeControlCommandLocked(T3VoiceControlCommand.TOGGLE_MUTE) }
      }
      ACTION_DISABLE_READINESS -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_DISABLE_READINESS),
      ) {
        run { disableReadinessLocked() }
      }
      ACTION_READINESS -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_READINESS),
      ) {
        run { reconcileReadinessLocked() }
      }
      ACTION_START_RECORDING -> {
        val foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (T3VoiceStartCommandPolicy.shouldPromoteForegroundImmediately(
            T3VoiceStateStore.state.value.isForeground,
          )) {
          promoteForegroundOnMainThread(foregroundServiceType)
        }
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_RECORDING),
        ) {
          run {
            reconcileStartCommand(
              expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
              activeOwnerId = T3VoiceStateStore.state.value.activeRecordingId,
              foregroundServiceType = foregroundServiceType,
              startId = startId,
            )
          }
        }
      }
      ACTION_START_PLAYBACK -> {
        val foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (T3VoiceStartCommandPolicy.shouldPromoteForegroundImmediately(
            T3VoiceStateStore.state.value.isForeground,
          )) {
          promoteForegroundOnMainThread(foregroundServiceType)
        }
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_PLAYBACK),
        ) {
          run {
            reconcileStartCommand(
              expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
              activeOwnerId = T3VoiceStateStore.state.value.activePlaybackId,
              foregroundServiceType = foregroundServiceType,
              startId = startId,
            )
          }
        }
      }
      ACTION_START_REALTIME -> {
        val foregroundServiceType =
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
        if (T3VoiceStartCommandPolicy.shouldPromoteForegroundImmediately(
            T3VoiceStateStore.state.value.isForeground,
          )) {
          promoteForegroundOnMainThread(foregroundServiceType)
        }
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_REALTIME),
        ) {
          run {
            reconcileStartCommand(
              expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
              activeOwnerId = T3VoiceStateStore.state.value.activeRealtimeSessionId,
              foregroundServiceType = foregroundServiceType,
              startId = startId,
            )
          }
        }
      }
      else -> mailbox.submit(
        VoiceKernelMessage.Command(
          callerIdentity = "android-service",
          payloadKind = "start-command-other",
        ),
      ) {
        run {
          if (readinessConfig.enabled) reconcileReadinessLocked()
          else hostDriver.stopSelfIfIdle(startId)
        }
      }
    }
    // The kernel may update readiness just after this read; one intent may return stale stickiness.
    return startCommandStickiness.value
  }

  override fun onDestroy() {
    mailbox.submit(callbackMessage("service-destroy")) {
      cancelVoiceRuntimeThreadRearmLocked()
      pendingRuntimeHandoffActivation?.let {
        completeRuntimeHandoffActivationLocked(it, false)
      }
      recordingOwner?.let { owner ->
        if (cancelPendingRecordingStartLocked(owner) == null) {
          runCatching { recorder.cancel(owner.id) }
        }
        terminateRecordingLocked(
          owner,
          T3VoiceRuntimeEvent.RecordingTerminated(
            recordingId = owner.id,
            recording = null,
            outcome = "cancelled",
            reason = "service-destroyed",
          ),
          stopForeground = false,
        )
      }
      playbackOwner?.let { owner ->
        runCatching { player.cancel(owner.id) }
        terminatePlaybackLocked(
          owner,
          T3VoiceRuntimeEvent.PlaybackTerminated(owner.id, "cancelled"),
          stopForeground = false,
        )
      }
      stopRuntimeThreadLocked(cancelServer = true)
      cancelVoiceRuntimeRealtimeTasksLocked()
      cancelVoiceRuntimeRealtimeFinalizationLocked()
      runtimeThreadAttempt?.cancelAllCalls()
      T3VoiceStateStore.setInactive()
    }
    mailbox.drainAndQuit()
    setWakeLockOnMainThread(false)
    releaseMediaSessionOnMainThread()
    netDriver.release()
    storeDriver.release()
    mediaDriver.release()
    super.onDestroy()
  }

  private fun createHostDriver() = VoiceHostDriver(
    dispatcher = AndroidVoiceHostMainDispatcher(),
    effects = object : VoiceHostEffects {
      override fun setForeground(types: Int, snapshot: T3VoiceNotificationSnapshot) =
        setForegroundOnMainThread(types, snapshot)

      override fun removeForeground() = removeForegroundOnMainThread()
      override fun notify(snapshot: T3VoiceNotificationSnapshot) =
        notifyOnMainThread(snapshot)
      override fun setWakeLock(on: Boolean) = setWakeLockOnMainThread(on)
      override fun setMediaSession(model: VoiceHostMediaSessionModel) =
        setMediaSessionOnMainThread(model)
      override fun releaseMediaSession() = releaseMediaSessionOnMainThread()
      override fun keepStarted(action: String, operationId: String) =
        keepServiceStartedOnMainThread(action, operationId)
      override fun stopSelfIfIdle(startId: Int?) {
        if (startId == null) stopSelf() else stopSelf(startId)
      }
    },
    resultSink = ::postDriverResult,
    epoch = { serviceEpoch() },
  )

  private fun setForegroundOnMainThread(
    foregroundServiceType: Int,
    snapshot: T3VoiceNotificationSnapshot,
  ) {
    val notification = buildNotification(snapshot)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, foregroundServiceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundServiceTypes = foregroundServiceType
  }

  private fun removeForegroundOnMainThread() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    foregroundServiceTypes = 0
  }

  private fun notifyOnMainThread(snapshot: T3VoiceNotificationSnapshot) {
    getSystemService(NotificationManager::class.java).notify(
      NOTIFICATION_ID,
      buildNotification(snapshot),
    )
  }

  private fun startRuntimeForeground(foregroundServiceType: Int) {
    mailbox.assertKernelThread()
    T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(foregroundServiceType)
    val snapshot = captureNotificationSnapshotLocked()
    notificationSnapshot = snapshot
    hostDriver.setForeground(foregroundServiceType, snapshot)
    T3VoiceStateStore.setForeground(true)
    foregroundServiceTypes = foregroundServiceType
    updateRuntimeControlSurfacesLocked()
  }

  private fun promoteForegroundOnMainThread(foregroundServiceType: Int) {
    T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(foregroundServiceType)
    hostDriver.setForeground(foregroundServiceType, notificationSnapshot)
  }

  private fun keepServiceStarted(action: String, operationId: String) {
    hostDriver.keepStarted(action, operationId)
  }

  private fun keepServiceStartedOnMainThread(action: String, operationId: String) {
    val intent =
      Intent(this, T3VoiceRuntimeService::class.java).apply {
        this.action = action
        putExtra(EXTRA_OPERATION_ID, operationId)
      }
    startService(intent)
  }

  private fun reconcileStartCommand(
    expectedOwnerId: String?,
    activeOwnerId: String?,
    foregroundServiceType: Int,
    startId: Int,
  ) {
    when (T3VoiceStartCommandPolicy.decide(expectedOwnerId, activeOwnerId)) {
      T3VoiceStartCommandDecision.PROMOTE_ACTIVE_OWNER ->
        ensureRuntimeForeground(foregroundServiceType)
      T3VoiceStartCommandDecision.STOP_STALE_START -> hostDriver.stopSelfIfIdle(startId)
    }
  }

  private fun ensureRuntimeForeground(foregroundServiceType: Int) {
    mailbox.assertKernelThread()
    ensureMediaSessionLocked()
    val requiredTypes =
      T3VoiceForegroundLifecyclePolicy.activeServiceTypes(
        foregroundServiceType,
        readinessConfig,
        controllerCommands.isAttached(),
      )
    if (!T3VoiceStateStore.state.value.isForeground || foregroundServiceTypes != requiredTypes) {
      startRuntimeForeground(requiredTypes)
    }
    check(T3VoiceStateStore.state.value.isForeground) {
      "Android could not acquire foreground voice ownership."
    }
    acquireWakeLockLocked()
  }

  private fun nativeRealtimeAuthorityLocked(): VoiceRuntimeRealtimeAuthorization? {
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return null
    return VoiceRuntimeRealtimeAuthorityPolicy.validateCanonical(
      persisted,
      voiceRuntimeController.consumerCount(),
      hasPermission(Manifest.permission.RECORD_AUDIO),
      System.currentTimeMillis(),
    )
  }

  private fun nativeThreadAuthorityLocked(
    allowDetachedContinuation: Boolean = false,
  ): VoiceRuntimeThreadAuthorization? {
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return null
    return VoiceRuntimeThreadAuthorityPolicy.validateCanonical(
      persisted,
      voiceRuntimeController.consumerCount(),
      hasPermission(Manifest.permission.RECORD_AUDIO),
      System.currentTimeMillis(),
      allowDetachedContinuation,
    )
  }

  private fun startRuntimeThreadLocked(
    requestedClientOperationId: String? = null,
    requestedModeSessionId: String? = null,
    requestedSubmissionPolicy: String = "auto-submit",
    requestedDraftContext: VoiceRuntimeDraftContext? = null,
    allowDetachedContinuation: Boolean = false,
  ) {
    mailbox.assertKernelThread()
    if (runtimeThreadAttempt != null || T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE) return
    val persisted = runtimeThreadOperationStore.load()
    val persistedActive = (persisted as? VoiceRuntimeThreadOperationLoadResult.Available)
      ?.state as? VoiceRuntimeThreadOperationState.Active
    if (persistedActive != null) {
      val authority =
        if (persistedActive.cancelRequested) {
          VoiceRuntimeThreadAuthorityPolicy.cancellationAuthority(persistedActive)
        } else {
          val canonical = (voiceRuntimeAuthorityStore.load()
            as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
          val restored = canonical?.let {
            VoiceRuntimeThreadAuthorityPolicy.restoreCanonical(
            it,
            voiceRuntimeController.consumerCount(),
            hasPermission(Manifest.permission.RECORD_AUDIO),
            persistedActive,
            System.currentTimeMillis(),
            )
          }
          if (restored == null) {
            executeThreadOperationRevocationLocked(persisted, null)
            return
          }
          restored
        }
      val recoveredSnapshot = if (persistedActive.snapshot.phase == VoiceRuntimePhase.PLAYING) {
        VoiceRuntimeExecutionRecovery.restoreProcess(persistedActive.snapshot).snapshot
      } else {
        persistedActive.snapshot
      }
      val recoveredActive = if (recoveredSnapshot == persistedActive.snapshot) {
        persistedActive
      } else {
        persistedActive.copy(snapshot = recoveredSnapshot).also(runtimeThreadOperationStore::writeActive)
      }
      val attempt = VoiceRuntimeThreadAttempt(authority, recoveredActive.claim.clientOperationId)
      attempt.runtimeInstanceId = persistedActive.claim.runtimeInstanceId
      attempt.modeSessionId = persistedActive.claim.modeSessionId
      attempt.submissionPolicy = persistedActive.claim.submissionPolicy
      attempt.speechPlanId = persistedActive.claim.speechPlanId
      attempt.draftContext = persistedActive.claim.draftContext
      runtimeSnapshot = recoveredSnapshot
      runtimeSnapshotStore.write(recoveredSnapshot)
      attempt.operationId = recoveredActive.operationId
      attempt.acknowledgedCursor = recoveredActive.acknowledgedCursor
      attempt.recording = recoveredActive.recording
      attempt.detached = recoveredActive.detached
      attempt.cancelRequested = recoveredActive.cancelRequested
      attempt.draftDispositionPending = recoveredActive.draftDispositionPending
      attempt.draftConsumePending = recoveredActive.draftConsumePending
      syncRuntimeThreadSpeechProgress(attempt, recoveredSnapshot)
      runtimeThreadAttempt = attempt
      armEpoch(
        VoiceKernelEpochRootKind.THREAD_TURN,
        attempt.clientOperationId,
        attempt.authority.readinessGeneration,
      )
      ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      if (!materializeRuntimeThreadReceiptLocked(attempt)) {
        runtimeThreadAttempt = null
        scheduleRuntimeThreadRestoreLocked()
        return
      }
      if (attempt.cancelRequested) {
        cancelRuntimeThreadOperation(attempt)
      } else if (attempt.draftDispositionPending) {
        requestRuntimeThreadDraftDisposition(attempt)
      } else if (attempt.draftConsumePending) {
        consumeRuntimeThreadDraft(attempt)
      } else if (attempt.recording != null && !runtimeSnapshot.dispatchAcknowledged) {
        val recording = requireNotNull(attempt.recording)
        if (runtimeSnapshot.phase == VoiceRuntimePhase.IDLE) {
          if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.AuthorityValidated(
            authority.runtimeId, authority.readinessGeneration, VoiceRuntimeExecutionMode.THREAD,
            authority.autoRearm,
          )) == null) return
          if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.StartRecording(
            persistedActive.operationId, recording.recordingId,
          )) == null) return
          if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.RecordingFinalized(
            persistedActive.operationId, recording.recordingId,
          )) == null) return
          if (applyRuntimeEventLocked(
              VoiceRuntimeExecutionEvent.UploadStarted(persistedActive.operationId),
            ) == null) return
        }
        uploadRuntimeThreadRecording(attempt, recording)
      } else if (runtimeSnapshot.eventCursor > attempt.acknowledgedCursor ||
        runtimeSnapshot.highestStartedSpeechSegment >= 0) {
        acknowledgeRuntimeThread(
          attempt,
          sessionCredential(attempt.authority.environmentOrigin),
          recoveredActive.operationId,
          runtimeSnapshot.eventCursor,
        )
      } else if (runtimeSnapshot.dispatchAcknowledged || attempt.detached) {
        pollRuntimeThread(attempt)
      } else {
        if (runtimeSnapshot.phase != VoiceRuntimePhase.IDLE) {
          applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
        }
        if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.AuthorityValidated(
          authority.runtimeId, authority.readinessGeneration, VoiceRuntimeExecutionMode.THREAD,
          authority.autoRearm,
        )) == null) return
        startRuntimeThreadRecordingLocked(attempt)
      }
      return
    }
    val prepared = (persisted as? VoiceRuntimeThreadOperationLoadResult.Available)
      ?.state as? VoiceRuntimeThreadOperationState.Prepared
    val authorization =
      if (prepared?.cancelRequested == true) {
        nativeThreadAuthorityLocked()?.takeIf {
          val candidate = it.authority
          val claim = prepared.claim
          candidate.runtimeId == claim.runtimeId &&
            candidate.readinessGeneration == claim.readinessGeneration &&
            candidate.environmentOrigin == claim.environmentOrigin &&
            candidate.selectedProjectId == claim.projectId &&
            candidate.selectedThreadId == claim.threadId
        } ?: run {
          executeThreadOperationRevocationLocked(persisted, null)
          return
        }
      } else {
        nativeThreadAuthorityLocked(allowDetachedContinuation) ?: return
      }
    val authority = authorization.authority
    val runtimeInstanceId = voiceRuntimeController.snapshot().identity.runtimeInstanceId
    val clientOperationId = requestedClientOperationId ?: "thread-${UUID.randomUUID()}"
    val modeSessionId = requestedModeSessionId ?: "mode-$clientOperationId"
    val speechPlanId = "speech-$clientOperationId"
    if ((requestedSubmissionPolicy == "draft") != (requestedDraftContext != null)) return
    val claim = when (persisted) {
      VoiceRuntimeThreadOperationLoadResult.Missing ->
        VoiceRuntimeThreadClaim(
          authority.runtimeId, runtimeInstanceId, authority.readinessGeneration, modeSessionId,
          authority.environmentOrigin,
          authority.selectedProjectId, authority.selectedThreadId,
          clientOperationId, requestedSubmissionPolicy, speechPlanId, requestedDraftContext,
        ).also(runtimeThreadOperationStore::writePrepared)
      is VoiceRuntimeThreadOperationLoadResult.Available -> {
        val candidate = persisted.state.claim
        if (requestedClientOperationId != null &&
          candidate.clientOperationId != requestedClientOperationId) return
        if (candidate.runtimeId != authority.runtimeId ||
          candidate.readinessGeneration != authority.readinessGeneration ||
          candidate.environmentOrigin != authority.environmentOrigin ||
          candidate.projectId != authority.selectedProjectId ||
          candidate.threadId != authority.selectedThreadId) return
        candidate
      }
      VoiceRuntimeThreadOperationLoadResult.Locked -> return
    }
    val attempt = VoiceRuntimeThreadAttempt(authority, claim.clientOperationId)
    attempt.runtimeInstanceId = claim.runtimeInstanceId
    attempt.modeSessionId = claim.modeSessionId
    attempt.submissionPolicy = claim.submissionPolicy
    attempt.speechPlanId = claim.speechPlanId
    attempt.draftContext = claim.draftContext
    attempt.cancelRequested = prepared?.cancelRequested == true
    attempt.detached = attempt.cancelRequested
    runtimeThreadAttempt = attempt
    armEpoch(
      VoiceKernelEpochRootKind.THREAD_TURN,
      attempt.clientOperationId,
      attempt.authority.readinessGeneration,
    )
    ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    createRuntimeThreadOperation(attempt)
  }

  private fun createRuntimeThreadOperation(
    attempt: VoiceRuntimeThreadAttempt,
  ) {
    val currentAuthorization = nativeThreadAuthorityLocked(allowDetachedContinuation = true)
    if (currentAuthorization?.authority != attempt.authority) {
      completeRuntimeHandoffActivationForAttemptLocked(attempt, false)
      fenceRuntimeThreadForReconciliationLocked(attempt)
      return
    }
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    val admission = voiceRuntimeController.receiptAdmission(
      attempt.modeSessionId,
      attempt.clientOperationId,
    )
    voiceRuntimeController.publishLocalRetentionStatus(
      attempt.modeSessionId,
      attempt.clientOperationId,
      admission,
    )
    if (admission in setOf(
        VoiceRuntimeRetentionAdmission.FULL,
        VoiceRuntimeRetentionAdmission.UNAVAILABLE,
      )) {
      releaseWakeLockForRuntimeBackoffLocked()
      submitCallbackDelayed({
        run {
          if (!attempt.stopped) {
            createRuntimeThreadOperation(attempt)
          }
        }
      }, VoiceRuntimeThreadRetryPolicy.delayMillis(++attempt.retryFailures),
        "thread-create:${attempt.clientOperationId}")
      return
    }
    val target = persistedAuthority()?.target as? VoiceRuntimeTarget.Thread
      ?: throw VoiceRuntimeFenceException("Canonical Thread target is unavailable.")
    if (target.projectId != attempt.authority.selectedProjectId ||
      target.threadId != attempt.authority.selectedThreadId) {
      throw VoiceRuntimeFenceException("Canonical Thread target changed.")
    }
    acquireWakeLockLocked()
    val call = runtimeThreadServer.newCreateCall(
      attempt.authority.environmentOrigin,
      credential,
      VoiceRuntimeThreadTurnCreateInput(
        attempt.authority.runtimeId,
        attempt.runtimeInstanceId,
        attempt.authority.readinessGeneration,
        attempt.modeSessionId,
        attempt.clientOperationId,
        attempt.submissionPolicy,
        attempt.speechPlanId,
        target,
      ),
    )
    if (!attempt.beginCall(call, allowCancellationRecovery = attempt.cancelRequested)) {
      releaseWakeLockForRuntimeBackoffLocked()
      return
    }
    netDriver.execute("thread-create", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCall(call)) return@run
          handleRuntimeThreadCreatedLocked(attempt, result)
        }
      }
      continuation
    })
  }

  private fun handleRuntimeThreadCreatedLocked(
    attempt: VoiceRuntimeThreadAttempt,
    result: VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnCreateResult>,
  ) {
    if (attempt.stopped) return
    val created = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
    if (created == null || !VoiceRuntimeThreadAuthorityPolicy.validateCreated(
        attempt.authority, attempt.clientOperationId, created, System.currentTimeMillis())) {
      val failure = result as? VoiceRuntimeThreadTurnResult.Failure
      val retryable = failure?.kind in setOf(
        VoiceRuntimeHttpFailureKind.RETRYABLE,
        VoiceRuntimeHttpFailureKind.CONFLICT,
        VoiceRuntimeHttpFailureKind.CANCELLED,
      )
      if (VoiceRuntimeThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
          attempt.cancelRequested,
          attempt.operationId,
          retryable,
        )) {
        T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
          operation = "runtime-thread",
          code = "native-thread-cancel-recovery-rejected",
          message = "Runtime thread voice requires authorization reconciliation.",
          recoverable = true,
        ))
        fenceRuntimeThreadForReconciliationLocked(attempt)
      } else if (retryable) {
        attempt.retryFailures += 1
        releaseWakeLockForRuntimeBackoffLocked()
        submitCallbackDelayed({
          run {
            if (!attempt.stopped) {
              createRuntimeThreadOperation(attempt)
            }
          }
        }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
          "thread-create:${attempt.clientOperationId}")
      } else failRuntimeThreadLocked(attempt, "native-thread-create-failed")
      return
    }
    attempt.operationId = created.snapshot.operationId
    val operationSnapshot =
      if (runtimeSnapshot.mode == VoiceRuntimeExecutionMode.THREAD &&
        runtimeSnapshot.operationId == created.snapshot.operationId) runtimeSnapshot else
        VoiceRuntimeExecutionSnapshot(
          runtimeId = attempt.authority.runtimeId,
          readinessGeneration = attempt.authority.readinessGeneration,
          mode = VoiceRuntimeExecutionMode.THREAD,
          phase = VoiceRuntimePhase.IDLE,
          autoRearm = attempt.authority.autoRearm,
        )
    attempt.acknowledgedCursor = minOf(
      created.snapshot.acknowledgedSequence,
      operationSnapshot.eventCursor,
    )
    val active = VoiceRuntimeThreadOperationState.Active(
      VoiceRuntimeThreadClaim(
        attempt.authority.runtimeId, attempt.runtimeInstanceId,
        attempt.authority.readinessGeneration, attempt.modeSessionId,
        attempt.authority.environmentOrigin, attempt.authority.selectedProjectId,
        attempt.authority.selectedThreadId, attempt.clientOperationId,
        attempt.submissionPolicy, attempt.speechPlanId, attempt.draftContext,
      ),
      created.snapshot.operationId,
      created.snapshot.operationTokenExpiresAtEpochMillis,
      attempt.acknowledgedCursor,
      attempt.recording,
      attempt.detached,
      attempt.cancelRequested,
      attempt.draftDispositionPending,
      attempt.draftConsumePending,
      operationSnapshot,
      pendingReceipt = runtimeThreadReceipt(created.snapshot),
    )
    val activePersisted = runCatching {
      runtimeThreadOperationStore.writeActive(active)
    }.isSuccess
    if (!activePersisted) {
      attempt.cancelRequested = true
      attempt.detached = true
      runCatching {
        runtimeThreadOperationStore.writePrepared(active.claim, cancelRequested = true)
      }
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
      )
      cancelRuntimeThreadOperation(attempt)
      return
    }
    if (!materializeRuntimeThreadReceiptLocked(attempt)) {
      runtimeThreadAttempt = null
      scheduleRuntimeThreadRestoreLocked()
      return
    }
    attempt.retryFailures = 0
    if (attempt.cancelRequested) {
      cancelRuntimeThreadOperation(attempt)
      return
    }
    if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.AuthorityValidated(
      attempt.authority.runtimeId, attempt.authority.readinessGeneration,
      VoiceRuntimeExecutionMode.THREAD, attempt.authority.autoRearm,
    )) == null) return
    if (created.snapshot.phase == "created" && !created.snapshot.dispatchAccepted) {
      val recording = attempt.recording
      if (recording == null) {
        startRuntimeThreadRecordingLocked(attempt)
      } else {
        if (runtimeSnapshot.phase != VoiceRuntimePhase.IDLE) {
          applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
        }
        if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.StartRecording(
            created.snapshot.operationId,
            recording.recordingId,
          )) == null) return
        handleRuntimeThreadRecordingLocked(attempt, recording)
      }
    } else {
      if (runtimeSnapshot.operationId != created.snapshot.operationId ||
        runtimeSnapshot.phase == VoiceRuntimePhase.IDLE) {
        if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.StartRecording(
            created.snapshot.operationId,
            created.snapshot.operationId,
          )) == null) return
      }
      pollRuntimeThread(attempt)
    }
  }

  private fun startRuntimeThreadRecordingLocked(attempt: VoiceRuntimeThreadAttempt) {
    val operationId = attempt.operationId ?: return
    if (applyRuntimeEventLocked(
        VoiceRuntimeExecutionEvent.StartRecording(operationId, operationId),
      ) == null) return
    val owner = T3VoiceStateStore.claimRecording(
      operationId,
      T3VoiceOperationOwnerDomain.THREAD_MODE,
      operationId,
    ) ?: run {
      if (!failRuntimeHandoffCaptureLocked(attempt)) {
        failRuntimeThreadLocked(attempt, "native-thread-microphone-unavailable")
      }
      return
    }
    recordingOwner = owner
    try {
      scheduleRecordingStartLocked(
        owner,
        T3VoiceEndpointDetectionConfig(
          endSilenceMs = attempt.authority.endSilenceMs,
          noSpeechTimeoutMs = attempt.authority.noSpeechTimeoutMs,
          maximumUtteranceMs = attempt.authority.maximumUtteranceMs,
        ),
        onStarted = {
          completeRuntimeHandoffActivationForAttemptLocked(attempt, true)
        },
        onFailure = {
          if (!failRuntimeHandoffCaptureLocked(attempt)) {
            failRuntimeThreadLocked(attempt, "native-thread-microphone-unavailable")
          }
        },
      )
    } catch (_: Throwable) {
      releaseRecordingLocked(owner, stopForeground = false)
      if (!failRuntimeHandoffCaptureLocked(attempt)) {
        failRuntimeThreadLocked(attempt, "native-thread-microphone-unavailable")
      }
    }
  }

  private fun failRuntimeHandoffCaptureLocked(attempt: VoiceRuntimeThreadAttempt): Boolean {
    val activation = pendingRuntimeHandoffActivation?.takeIf {
      it.turnClientOperationId == attempt.clientOperationId
    } ?: return false
    if (runtimeSnapshot.mode == VoiceRuntimeExecutionMode.THREAD &&
      runtimeSnapshot.phase != VoiceRuntimePhase.IDLE) {
      applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
    }
    completeRuntimeHandoffActivationLocked(activation, false)
    return true
  }

  private fun handleRuntimeThreadRecordingLocked(
    attempt: VoiceRuntimeThreadAttempt,
    recording: T3VoiceRecordingResult,
  ) {
    val operationId = attempt.operationId ?: return
    val persisted = runtimeThreadOperationStore.load()
      as? VoiceRuntimeThreadOperationLoadResult.Available
    val active = persisted?.state as? VoiceRuntimeThreadOperationState.Active
    if (active?.claim?.clientOperationId != attempt.clientOperationId) {
      failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
      return
    }
    attempt.recording = recording
    val persistedRecording = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
      it.copy(recording = recording)
    }
    if (persistedRecording !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
      failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
      return
    }
    if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.RecordingFinalized(
        operationId,
        recording.recordingId,
      )) == null) return
    if (attempt.draftDispositionPending) return
    if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.UploadStarted(operationId)) == null) return
    uploadRuntimeThreadRecording(attempt, recording)
  }

  private fun requestRuntimeThreadDraftDisposition(attempt: VoiceRuntimeThreadAttempt) {
    if (!attempt.draftDispositionPending || attempt.stopped) return
    val operationId = attempt.operationId ?: return
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    val call = runtimeThreadServer.newDraftDispositionCall(
      attempt.authority.environmentOrigin,
      credential,
      operationId,
    )
    if (!attempt.beginCall(call)) return
    netDriver.execute("thread-draft-disposition", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCall(call) || attempt.stopped) {
            return@run
          }
          val transitioned = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          val valid = transitioned != null && transitioned.snapshot.submissionPolicy == "draft" &&
            VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority,
              operationId,
              runtimeSnapshot.eventCursor,
              transitioned.snapshot,
            )
          if (!valid) {
            val retryable = (result as? VoiceRuntimeThreadTurnResult.Failure)?.kind in setOf(
              VoiceRuntimeHttpFailureKind.RETRYABLE,
              VoiceRuntimeHttpFailureKind.CONFLICT,
              VoiceRuntimeHttpFailureKind.CANCELLED,
            )
            if (!retryable) {
              failRuntimeThreadLocked(attempt, "native-thread-draft-disposition-failed")
              return@run
            }
            attempt.retryFailures += 1
            submitCallbackDelayed({
              run {
                if (!attempt.stopped) {
                  requestRuntimeThreadDraftDisposition(attempt)
                }
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
              "thread-draft-disposition:${attempt.clientOperationId}")
            return@run
          }
          val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
            it.copy(draftDispositionPending = false)
          }
          if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
            failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
            return@run
          }
          attempt.retryFailures = 0
          attempt.draftDispositionPending = false
          if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, transitioned.snapshot)) {
            runtimeThreadAttempt = null
            scheduleRuntimeThreadRestoreLocked()
            return@run
          }
          val recording = attempt.recording
          if (recording == null && recordingOwner?.let {
              it.domain == T3VoiceOperationOwnerDomain.THREAD_MODE && it.id == operationId
            } != true) {
            failRuntimeThreadLocked(attempt, "native-thread-recording-unavailable")
            return@run
          }
          recording?.let {
            if (applyRuntimeEventLocked(
                VoiceRuntimeExecutionEvent.UploadStarted(operationId),
              ) != null) {
              uploadRuntimeThreadRecording(attempt, it)
            }
          }
        }
      }
      continuation
    })
  }

  private fun uploadRuntimeThreadRecording(
    attempt: VoiceRuntimeThreadAttempt,
    recording: T3VoiceRecordingResult,
  ) {
    val operationId = attempt.operationId ?: return
    val body = VoiceRuntimeThreadRecordingBodyPolicy.create(recording) ?: run {
      failRuntimeThreadLocked(attempt, "native-thread-upload-failed")
      return
    }
    acquireWakeLockLocked()
    val call = runtimeThreadServer.newUploadAudioCall(
      attempt.authority.environmentOrigin,
      sessionCredential(attempt.authority.environmentOrigin),
      operationId,
      body,
    )
    if (!attempt.beginCall(call)) {
      releaseWakeLockForRuntimeBackoffLocked()
      return
    }
    netDriver.execute("thread-upload", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCall(call)) return@run
          if (attempt.stopped) return@run
          val uploaded = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (uploaded == null || !VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, runtimeSnapshot.eventCursor, uploaded.snapshot)) {
            val retryable = (result as? VoiceRuntimeThreadTurnResult.Failure)?.kind in setOf(
              VoiceRuntimeHttpFailureKind.RETRYABLE,
              VoiceRuntimeHttpFailureKind.CONFLICT,
              VoiceRuntimeHttpFailureKind.CANCELLED,
            )
            if (retryable) {
              attempt.retryFailures += 1
              releaseWakeLockForRuntimeBackoffLocked()
              submitCallbackDelayed({
                run {
                  if (!attempt.stopped) {
                    uploadRuntimeThreadRecording(attempt, recording)
                  }
                }
              }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
                "thread-upload:${attempt.clientOperationId}")
            } else failRuntimeThreadLocked(attempt, "native-thread-upload-failed")
          } else {
            attempt.retryFailures = 0
            if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, uploaded.snapshot)) {
              runtimeThreadAttempt = null
              scheduleRuntimeThreadRestoreLocked()
              return@run
            }
            if (uploaded.disposition == "draft-ready") fetchRuntimeThreadDraft(attempt)
            else pollRuntimeThread(attempt)
          }
        }
      }
      continuation
    })
  }

  private fun pollRuntimeThread(attempt: VoiceRuntimeThreadAttempt) {
    if (attempt.polling || attempt.acknowledging || attempt.stopped) return
    val operationId = attempt.operationId ?: return
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    acquireWakeLockLocked()
    attempt.polling = true
    val after = runtimeSnapshot.eventCursor
    val playbackCursor = runtimeSnapshot.playbackCursor
    val highestAdvertisedSegment = runtimeSnapshot.highestAdvertisedSpeechSegment
    val recoveryWork = if (!attempt.detached) VoiceRuntimeThreadSpeechPolicy.next(
      playbackCursor, highestAdvertisedSegment,
      emptyList(),
    ) else null
    if (recoveryWork != null) {
      attempt.polling = false
      attempt.pendingSpeech += recoveryWork.segmentIndex
      startNextRuntimeThreadSpeechLocked(attempt)
      return
    }
    val initialCall = runtimeThreadServer.newEventsCall(
      attempt.authority.environmentOrigin, credential, operationId, after, 30_000,
    )
    if (!attempt.beginCall(initialCall)) {
      attempt.polling = false
      releaseWakeLockForRuntimeBackoffLocked()
      return
    }
    netDriver.execute("thread-poll", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = initialCall.execute()
      val events = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
      val eventWork = events?.let { VoiceRuntimeThreadSpeechPolicy.next(
        playbackCursor, highestAdvertisedSegment,
        it.events,
      ) }
      val continuation: () -> Unit = {
        run {
          attempt.polling = false
          if (!attempt.finishCall(initialCall)) return@run
          if (attempt.stopped) return@run
          val eventsResult = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (eventsResult == null || !VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, after, eventsResult.snapshot) ||
            !VoiceRuntimeThreadEventBatchPolicy.isContiguous(
              after, eventsResult.events, eventsResult.snapshot.lastSequence,
            )) {
            val retryable = (result as? VoiceRuntimeThreadTurnResult.Failure)?.kind in setOf(
              VoiceRuntimeHttpFailureKind.RETRYABLE,
              VoiceRuntimeHttpFailureKind.CONFLICT,
              VoiceRuntimeHttpFailureKind.CANCELLED,
            )
            if (retryable) scheduleRuntimeThreadPollRetryLocked(attempt)
            else failRuntimeThreadLocked(attempt, "native-thread-events-failed")
            return@run
          }
          attempt.retryFailures = 0
          if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, eventsResult.snapshot)) {
            runtimeThreadAttempt = null
            scheduleRuntimeThreadRestoreLocked()
            return@run
          }
          val acceptedEvents = VoiceRuntimeThreadSpeechPolicy.acceptedPrefix(eventsResult.events, eventWork)
          val batch = runCatching {
            VoiceRuntimeThreadBatchReducer.reduce(
              runtimeSnapshot,
              acceptedEvents.map { event ->
                runtimeThreadServerEvent(attempt, eventsResult.snapshot, event)
              },
            )
          }.getOrElse {
            failRuntimeThreadLocked(attempt, "native-thread-event-invalid")
            return@run
          }
          if (VoiceRuntimeCommand.FETCH_EVENT_GAP in batch.commands) {
            scheduleRuntimeThreadPollRetryLocked(attempt)
            return@run
          }
          if (acceptedEvents.isNotEmpty() && !persistRuntimeSnapshotLocked(batch.snapshot)) {
            failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
            return@run
          }
          if (eventsResult.snapshot.phase == "draft-ready") {
            fetchRuntimeThreadDraft(attempt)
            return@run
          }
          if (eventWork != null && !attempt.detached) attempt.pendingSpeech += eventWork.segmentIndex
          val cursor = runtimeSnapshot.eventCursor
          when (VoiceRuntimeThreadEventCommitPolicy.afterBatch(
              cursor,
              attempt.acknowledgedCursor,
            )) {
            VoiceRuntimeThreadEventCommitDecision.ACKNOWLEDGE ->
              acknowledgeRuntimeThread(attempt, credential, operationId, cursor)
            VoiceRuntimeThreadEventCommitDecision.CONTINUE ->
              startNextRuntimeThreadSpeechLocked(attempt)
          }
        }
      }
      continuation
    })
  }

  private fun runtimeThreadReceipt(
    snapshot: VoiceRuntimeThreadTurnSnapshot,
  ): VoiceRuntimeThreadReceipt {
    val target = voiceRuntimeController.snapshot().target as? VoiceRuntimeTarget.Thread
      ?: throw VoiceRuntimeFenceException("Thread receipt target is unavailable.")
    val terminalOutcome = when {
      snapshot.detachedAtEpochMillis != null -> "detached"
      snapshot.phase == "completed" -> "completed"
      snapshot.phase == "failed" -> "failed"
      snapshot.phase == "cancelled" -> "cancelled"
      else -> null
    }
    return VoiceRuntimeThreadReceipt(
      identity = VoiceRuntimeIdentity(
        snapshot.runtimeId,
        snapshot.runtimeInstanceId,
        snapshot.generation,
      ),
      modeSessionId = snapshot.modeSessionId,
      turnClientOperationId = snapshot.turnClientOperationId,
      turnOperationId = snapshot.operationId,
      environmentId = target.environmentId,
      projectId = snapshot.projectId,
      threadId = snapshot.threadId,
      userMessageId = snapshot.messageId,
      turnId = snapshot.turnId,
      assistantMessageIds = snapshot.assistantMessageIds,
      speechPlanId = snapshot.speechPlanId,
      highestAdvertisedSegment = snapshot.highestAdvertisedSegment,
      highestStartedSegment = snapshot.highestStartedSegment,
      highestDrainedSegment = snapshot.highestDrainedSegment,
      segmentDispositions = snapshot.segmentDispositions,
      speechTerminal = snapshot.speechTerminal,
      terminalOutcome = terminalOutcome,
      createdAtEpochMillis = System.currentTimeMillis(),
      expiresAtEpochMillis = snapshot.retentionExpiresAtEpochMillis,
    )
  }

  private fun stageAndMaterializeRuntimeThreadReceiptLocked(
    attempt: VoiceRuntimeThreadAttempt,
    snapshot: VoiceRuntimeThreadTurnSnapshot,
  ): Boolean {
    val receipt = runtimeThreadReceipt(snapshot)
    val updated = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
      it.copy(pendingReceipt = receipt)
    }
    if (updated !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
      voiceRuntimeController.publishLocalRetentionStatus(
        attempt.modeSessionId,
        attempt.clientOperationId,
        VoiceRuntimeRetentionAdmission.UNAVAILABLE,
      )
      return false
    }
    return materializeRuntimeThreadReceiptLocked(attempt)
  }

  private fun materializeRuntimeThreadReceiptLocked(
    attempt: VoiceRuntimeThreadAttempt,
  ): Boolean {
    val active = ((runtimeThreadOperationStore.load()
      as? VoiceRuntimeThreadOperationLoadResult.Available)?.state
      as? VoiceRuntimeThreadOperationState.Active)
      ?.takeIf { it.claim.clientOperationId == attempt.clientOperationId }
      ?: return false
    val receipt = active.pendingReceipt ?: return true
    val result = voiceRuntimeController.publishThreadReceipt(receipt)
    val admission = when (result) {
      VoiceRuntimeRetentionWriteResult.INSERTED,
      VoiceRuntimeRetentionWriteResult.UPDATED,
      -> VoiceRuntimeRetentionAdmission.AVAILABLE
      VoiceRuntimeRetentionWriteResult.FULL -> VoiceRuntimeRetentionAdmission.FULL
      VoiceRuntimeRetentionWriteResult.UNAVAILABLE -> VoiceRuntimeRetentionAdmission.UNAVAILABLE
    }
    voiceRuntimeController.publishLocalRetentionStatus(
      attempt.modeSessionId,
      attempt.clientOperationId,
      admission,
    )
    if (result !in setOf(
        VoiceRuntimeRetentionWriteResult.INSERTED,
        VoiceRuntimeRetentionWriteResult.UPDATED,
      )) return false
    return runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
      if (it.pendingReceipt == receipt) it.copy(pendingReceipt = null) else it
    } is VoiceRuntimeThreadOperationUpdateResult.Updated
  }

  private fun scheduleRuntimeThreadRestoreLocked() {
    releaseWakeLockForRuntimeBackoffLocked()
    submitCallbackDelayed({
      run {
        if (runtimeThreadAttempt == null) startRuntimeThreadLocked()
      }
    }, VoiceRuntimeThreadRetryPolicy.delayMillis(1), "thread-restore")
  }

  private fun fetchRuntimeThreadDraft(attempt: VoiceRuntimeThreadAttempt) {
    if (attempt.draftFetching || attempt.stopped) return
    val operationId = attempt.operationId ?: return
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    val context = attempt.draftContext ?: run {
      failRuntimeThreadLocked(attempt, "native-thread-draft-context-missing")
      return
    }
    attempt.draftFetching = true
    val call = runtimeThreadServer.newDraftCall(
      attempt.authority.environmentOrigin,
      credential,
      operationId,
    )
    if (!attempt.beginCall(call)) {
      attempt.draftFetching = false
      return
    }
    netDriver.execute("thread-fetch-draft", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          attempt.draftFetching = false
          if (!attempt.finishCall(call) || attempt.stopped) {
            return@run
          }
          val draft = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (draft == null || draft.operationId != operationId ||
            draft.expiresAtEpochMillis <= System.currentTimeMillis()) {
            scheduleRuntimeThreadPollRetryLocked(attempt)
            return@run
          }
          voiceRuntimeController.publishDraft(
            VoiceRuntimeDraftHandle(
              artifactId = "draft-$operationId",
              identity = voiceRuntimeController.snapshot().identity,
              modeSessionId = attempt.modeSessionId,
              turnClientOperationId = attempt.clientOperationId,
              target = context,
              expiresAtEpochMillis = draft.expiresAtEpochMillis,
            ),
            draft.transcript,
          )
          releaseWakeLockForRuntimeBackoffLocked()
        }
      }
      continuation
    })
  }

  private fun consumeRuntimeThreadDraft(attempt: VoiceRuntimeThreadAttempt) {
    val operationId = attempt.operationId ?: return
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    val call = runtimeThreadServer.newConsumeDraftCall(
      attempt.authority.environmentOrigin,
      credential,
      operationId,
    )
    if (!attempt.beginCall(call)) return
    netDriver.execute("thread-consume-draft", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCall(call) || attempt.stopped) {
            return@run
          }
          val consumed = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (consumed?.consumed == true && VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority,
              operationId,
              runtimeSnapshot.eventCursor,
              consumed.snapshot,
            )) {
            if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, consumed.snapshot)) {
              runtimeThreadAttempt = null
              scheduleRuntimeThreadRestoreLocked()
              return@run
            }
            voiceRuntimeController.completeDraftAcknowledgement("draft-$operationId")
            stopRuntimeThreadLocked(cancelServer = false)
          } else {
            attempt.retryFailures += 1
            releaseWakeLockForRuntimeBackoffLocked()
            submitCallbackDelayed({
              run {
                if (!attempt.stopped && attempt.draftConsumePending) {
                  consumeRuntimeThreadDraft(attempt)
                }
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
              "thread-consume-draft:${attempt.clientOperationId}")
          }
        }
      }
      continuation
    })
  }

  private fun acknowledgeRuntimeThread(
    attempt: VoiceRuntimeThreadAttempt,
    credential: String,
    operationId: String,
    cursor: Long,
  ) {
    acquireWakeLockLocked()
    attempt.acknowledging = true
    val call = runtimeThreadServer.newAcknowledgeCall(
      attempt.authority.environmentOrigin,
      credential,
      operationId,
      cursor,
      attempt.speechPlanId,
      runtimeSnapshot.highestStartedSpeechSegment.takeIf { it >= 0 },
      runtimeSnapshot.highestDrainedSpeechSegment.takeIf { it >= 0 },
      runtimeSnapshot.speechSegmentDispositions,
    )
    if (!attempt.beginCall(call)) {
      attempt.acknowledging = false
      releaseWakeLockForRuntimeBackoffLocked()
      return
    }
    netDriver.execute("thread-acknowledge", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val acknowledged = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCall(call)) return@run
          if (attempt.stopped) return@run
          val ack = (acknowledged as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (ack != null && VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, cursor, ack) &&
            ack.acknowledgedSequence >= cursor) {
            if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, ack)) {
              runtimeThreadAttempt = null
              scheduleRuntimeThreadRestoreLocked()
              return@run
            }
            attempt.acknowledging = false
            attempt.retryFailures = 0
            val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
              it.copy(acknowledgedCursor = cursor)
            }
            if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
              failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
              return@run
            }
            attempt.acknowledgedCursor = cursor
            startNextRuntimeThreadSpeechLocked(attempt)
            return@run
          }
          val retryable = (acknowledged as? VoiceRuntimeThreadTurnResult.Failure)?.kind in setOf(
            VoiceRuntimeHttpFailureKind.RETRYABLE,
            VoiceRuntimeHttpFailureKind.CONFLICT,
            VoiceRuntimeHttpFailureKind.CANCELLED,
          )
          if (retryable) {
            attempt.retryFailures += 1
            releaseWakeLockForRuntimeBackoffLocked()
            submitCallbackDelayed({
              run {
                if (!attempt.stopped) {
                  acknowledgeRuntimeThread(attempt, credential, operationId, cursor)
                }
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
              "thread-acknowledge:${attempt.clientOperationId}")
          } else {
            attempt.acknowledging = false
            failRuntimeThreadLocked(attempt, "native-thread-ack-failed")
          }
        }
      }
      continuation
    })
  }

  private fun scheduleRuntimeThreadPollRetryLocked(attempt: VoiceRuntimeThreadAttempt) {
    attempt.retryFailures += 1
    val delay = VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures)
    releaseWakeLockForRuntimeBackoffLocked()
    submitCallbackDelayed({
      run {
        if (!attempt.stopped) pollRuntimeThread(attempt)
      }
    }, delay, "thread-poll:${attempt.clientOperationId}")
  }

  private fun runtimeThreadServerEvent(
    attempt: VoiceRuntimeThreadAttempt,
    snapshot: VoiceRuntimeThreadTurnSnapshot,
    event: VoiceRuntimeThreadTurnEvent,
  ): VoiceRuntimeExecutionEvent.ServerEvent {
    val phase = when (event) {
      is VoiceRuntimeThreadTurnEvent.Phase -> serverPhase(event.phase)
      is VoiceRuntimeThreadTurnEvent.DispatchCorrelation -> VoiceRuntimeServerPhase.DISPATCHING
      is VoiceRuntimeThreadTurnEvent.AssistantMessageCorrelated -> VoiceRuntimeServerPhase.WAITING
      is VoiceRuntimeThreadTurnEvent.SpeechReady,
      is VoiceRuntimeThreadTurnEvent.SpeechTerminal -> VoiceRuntimeServerPhase.SPEAKING
      is VoiceRuntimeThreadTurnEvent.AttentionRequired -> VoiceRuntimeServerPhase.ATTENTION_REQUIRED
      is VoiceRuntimeThreadTurnEvent.Failure ->
        if (event.retryable) VoiceRuntimeServerPhase.FAILED_RETRYABLE else VoiceRuntimeServerPhase.FAILED_PERMANENT
      is VoiceRuntimeThreadTurnEvent.Terminal -> when (event.outcome) {
        "completed" -> VoiceRuntimeServerPhase.COMPLETED
        "cancelled" -> VoiceRuntimeServerPhase.CANCELLED
        else -> VoiceRuntimeServerPhase.FAILED_PERMANENT
      }
    }
    val speechReady = event as? VoiceRuntimeThreadTurnEvent.SpeechReady
    val speechTerminal = event as? VoiceRuntimeThreadTurnEvent.SpeechTerminal
    val correlation = event as? VoiceRuntimeThreadTurnEvent.DispatchCorrelation
    return VoiceRuntimeExecutionEvent.ServerEvent(
      requireNotNull(attempt.operationId), attempt.authority.readinessGeneration, event.sequence, phase,
      dispatchAcknowledged = snapshot.dispatchAccepted || correlation != null,
      speechSegmentIndex = speechReady?.segmentIndex,
      finalSpeechSegment = speechReady?.finalSegment == true,
      speechTerminal = speechTerminal?.outcome == "completed" || speechTerminal?.outcome == "no-speech",
      noSpeech = speechTerminal?.outcome == "no-speech",
      messageId = correlation?.messageId,
      turnId = correlation?.turnId,
    )
  }

  private fun serverPhase(value: String): VoiceRuntimeServerPhase = when (value) {
    "created" -> VoiceRuntimeServerPhase.CREATED
    "transcribing" -> VoiceRuntimeServerPhase.TRANSCRIBING
    "dispatching" -> VoiceRuntimeServerPhase.DISPATCHING
    "waiting" -> VoiceRuntimeServerPhase.WAITING
    "speaking" -> VoiceRuntimeServerPhase.SPEAKING
    "completed" -> VoiceRuntimeServerPhase.COMPLETED
    "attention-required" -> VoiceRuntimeServerPhase.ATTENTION_REQUIRED
    "cancelled" -> VoiceRuntimeServerPhase.CANCELLED
    "failed" -> VoiceRuntimeServerPhase.FAILED_PERMANENT
    else -> error("Unknown native thread phase.")
  }

  private fun startNextRuntimeThreadSpeechLocked(attempt: VoiceRuntimeThreadAttempt) {
    if (attempt.playingSegment != null || attempt.pendingSpeech.isEmpty()) {
      finishRuntimeThreadIfDrainedLocked(attempt)
      if (attempt.playingSegment == null &&
        attempt.pendingSpeech.isEmpty() && !attempt.polling &&
        VoiceRuntimeThreadTerminalPolicy.shouldPollAfterAck(
          runtimeSnapshot,
          attempt.detached,
        )) pollRuntimeThread(attempt)
      return
    }
    val segment = requireNotNull(attempt.pendingSpeech.pollFirst())
    val playbackId = runtimeThreadPlaybackId(attempt, segment)
    if (applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.PlaybackStarted(
        requireNotNull(attempt.operationId),
        segment,
      )) == null) return
    syncRuntimeThreadSpeechProgress(attempt, runtimeSnapshot)
    attempt.playingSegment = segment
    try {
      startPlaybackLocked(
        playbackId,
        24_000,
        1,
        T3VoiceOperationOwnerDomain.THREAD_MODE,
        requireNotNull(attempt.operationId),
      )
      var chunkCount = 0
      val call = runtimeThreadServer.newSpeechStreamCall(
        attempt.authority.environmentOrigin,
        sessionCredential(attempt.authority.environmentOrigin),
        requireNotNull(attempt.operationId),
        segment,
      ) { pcm ->
        player.enqueuePcmBlocking(playbackId, chunkCount, pcm)
        chunkCount += 1
      }
      if (!attempt.beginCall(call)) {
        player.cancel(playbackId)
        attempt.playingSegment = null
        return
      }
      netDriver.execute("thread-speech", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
        val result = call.execute()
        val continuation: () -> Unit = {
          run {
            if (!attempt.finishCall(call) || attempt.stopped ||
              attempt.playingSegment != segment) return@run
            if (result is VoiceRuntimeThreadTurnResult.Success && chunkCount > 0) {
              runCatching { player.finish(playbackId, chunkCount - 1) }
                .onFailure {
                  handlePlaybackTerminationLocked(
                    playbackId,
                    "failed",
                  )
                }
            } else {
              runCatching { player.cancel(playbackId) }
              handlePlaybackTerminationLocked(
                playbackId,
                "failed",
              )
            }
          }
        }
        continuation
      })
    } catch (_: Throwable) {
      runCatching { player.cancel(playbackId) }
      handlePlaybackTerminationLocked(
        playbackId,
        "failed",
      )
    }
  }

  private fun handlePlaybackTerminationLocked(
    playbackId: String,
    outcome: String,
  ) {
    mailbox.assertKernelThread()
    playbackOwner?.let { owner ->
      terminatePlaybackLocked(
        owner,
        T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, outcome),
      )
    }
    val attempt = runtimeThreadAttempt?.takeIf {
      playbackId == runtimeThreadPlaybackId(it, it.playingSegment)
    } ?: return
    val segment = requireNotNull(attempt.playingSegment)
    attempt.playingSegment = null
    attempt.playbackFailures += 1
    val persisted = applyRuntimeEventLocked(
      VoiceRuntimeExecutionEvent.PlaybackFailed(requireNotNull(attempt.operationId), segment),
    )
    if (persisted == null) {
      failRuntimeThreadLocked(attempt, "native-thread-playback-failed")
      return
    }
    syncRuntimeThreadSpeechProgress(attempt, runtimeSnapshot)
    acknowledgeRuntimeThread(
      attempt,
      sessionCredential(attempt.authority.environmentOrigin),
      requireNotNull(attempt.operationId),
      runtimeSnapshot.eventCursor,
    )
  }

  private fun syncRuntimeThreadSpeechProgress(
    attempt: VoiceRuntimeThreadAttempt,
    snapshot: VoiceRuntimeExecutionSnapshot,
  ) {
    attempt.highestStartedSegment = snapshot.highestStartedSpeechSegment.takeIf { it >= 0 }
    attempt.highestDrainedSegment = snapshot.highestDrainedSpeechSegment.takeIf { it >= 0 }
    attempt.segmentDispositions.clear()
    attempt.segmentDispositions += snapshot.speechSegmentDispositions
  }

  private fun runtimeThreadPlaybackId(attempt: VoiceRuntimeThreadAttempt, segment: Int?): String =
    "thread-playback:${attempt.operationId}:${segment ?: -1}"

  private fun finishRuntimeThreadIfDrainedLocked(attempt: VoiceRuntimeThreadAttempt) {
    if (attempt.playingSegment != null || attempt.pendingSpeech.isNotEmpty() ||
      !VoiceRuntimeThreadTerminalPolicy.canCleanup(
        runtimeSnapshot, attempt.acknowledgedCursor, attempt.detached,
      )) return
    attempt.operationId ?: return
    val completed = VoiceRuntimeThreadLocalCleanupCoordinator.complete(
      deleteRecording = {
        attempt.recording?.let {
          runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
        } ?: true
      },
      clearDurableState = {
        runCatching {
          runtimeThreadOperationStore.clear(attempt.clientOperationId)
        }.getOrDefault(false)
      },
    )
    if (!completed) {
      attempt.retryFailures += 1
      releaseWakeLockForRuntimeBackoffLocked()
      submitCallbackDelayed({
        run {
          if (!attempt.stopped) {
            finishRuntimeThreadIfDrainedLocked(attempt)
          }
        }
      }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
        "thread-finish:${attempt.clientOperationId}")
      return
    }
    runtimeThreadAttempt = null
    retireThreadTurnEpoch(attempt.clientOperationId)
    if (runtimeSnapshot.terminalSummary == VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED) {
      T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
        operation = "runtime-thread",
        code = "native-thread-attention-required",
        message = "Open the app to continue this thread.",
        recoverable = true,
      ))
    }
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
    val target = persisted?.target as? VoiceRuntimeTarget.Thread
    if (target != null &&
      VoiceRuntimeThreadTerminalPolicy.shouldAutoRearm(runtimeSnapshot) &&
      VoiceRuntimeThreadRearmPolicy.canSchedule(
        target,
        runtimeSnapshot.terminalSummary,
        persisted.readinessEnabled,
        voiceRuntimeController.consumerCount(),
      )) {
      scheduleVoiceRuntimeThreadRearmLocked(persisted, target)
    } else {
      applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
      stopRuntimeForegroundLocked()
    }
  }

  private fun scheduleVoiceRuntimeThreadRearmLocked(
    authority: VoiceRuntimePersistedAuthority,
    target: VoiceRuntimeTarget.Thread,
  ) {
    cancelVoiceRuntimeThreadRearmLocked()
    val expectedIdentity = voiceRuntimeController.snapshot().identity
    voiceRuntimeThreadRearmTask = submitCallbackDelayed({
      run {
        voiceRuntimeThreadRearmTask = null
        if (runtimeThreadAttempt != null ||
          voiceRuntimeController.snapshot().identity != expectedIdentity) return@run
        val current = (voiceRuntimeAuthorityStore.load()
          as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return@run
        val currentTarget = current.target as? VoiceRuntimeTarget.Thread ?: return@run
        if (current.runtimeId != authority.runtimeId ||
          current.generation != authority.generation ||
          current.targetDigest != authority.targetDigest ||
          currentTarget != target ||
          !VoiceRuntimeThreadRearmPolicy.canSchedule(
            currentTarget,
            runtimeSnapshot.terminalSummary,
            current.readinessEnabled,
            voiceRuntimeController.consumerCount(),
          )) return@run
        applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.RearmGuardElapsed)
        startRuntimeThreadLocked(
          requestedClientOperationId = "rearm-${UUID.randomUUID()}",
        )
        if (VoiceRuntimeThreadStartReconciliationPolicy.shouldReconcileAfterStart(
            runtimeThreadAttempt != null,
          )) {
          applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
          stopRuntimeForegroundLocked()
        }
      }
    }, VoiceRuntimeThreadRearmPolicy.delayMillis(target),
      "thread-rearm:${expectedIdentity.runtimeInstanceId}")
  }

  private fun cancelVoiceRuntimeThreadRearmLocked() {
    voiceRuntimeThreadRearmTask?.cancel()
    voiceRuntimeThreadRearmTask = null
  }

  private fun failRuntimeThreadLocked(attempt: VoiceRuntimeThreadAttempt, code: String) {
    completeRuntimeHandoffActivationForAttemptLocked(attempt, false)
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
      operation = "runtime-thread", code = code,
      message = "Runtime thread voice could not continue.", recoverable = true,
    ))
    if (runtimeSnapshot.dispatchAcknowledged) {
      fenceRuntimeThreadForReconciliationLocked(attempt)
      return
    }
    stopRuntimeThreadLocked(cancelServer = true)
  }

  private fun fenceRuntimeThreadForReconciliationLocked(
    attempt: VoiceRuntimeThreadAttempt,
  ) {
    stopRuntimeThreadAudioLocked(attempt, "reconciliation-required")
    attempt.cancelAllCalls()
    attempt.stopped = true
    attempt.detached = true
    val loaded = runtimeThreadOperationStore.load()
      as? VoiceRuntimeThreadOperationLoadResult.Available
    val active = loaded?.state as? VoiceRuntimeThreadOperationState.Active
    if (active != null) {
      runtimeThreadOperationStore.writeActive(active.copy(detached = true))
    }
    runtimeThreadAttempt = null
    retireThreadTurnEpoch(attempt.clientOperationId)
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
    )
    val pending = T3VoicePendingRuntimeRevocation(
      attempt.authority.runtimeId,
      attempt.authority.environmentOrigin,
    )
    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
      readinessConfig,
      voiceRuntimeController.snapshot().identity.generation,
    )
    readinessStore.writeDisabledForRuntimeRevocation(disabled, pending)
    readinessConfig = disabled
    storeDriver.persist("thread-reconciliation-clear-authority", driverEpoch(), body = {
      voiceRuntimeAuthorityStore.clear()
    })
    controllerCommands.invalidateReadiness()
    applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
    reconcileForegroundAfterVoiceStopLocked()
  }

  private fun stopRuntimeThreadLocked(cancelServer: Boolean) {
    cancelVoiceRuntimeThreadRearmLocked()
    val attempt = runtimeThreadAttempt ?: return
    armEpoch(
      VoiceKernelEpochRootKind.THREAD_TURN,
      attempt.clientOperationId,
      attempt.authority.readinessGeneration,
    )
    val initiallyPersisted = runtimeThreadOperationStore.load()
      as? VoiceRuntimeThreadOperationLoadResult.Available
    val prepared = initiallyPersisted?.state as? VoiceRuntimeThreadOperationState.Prepared
    if (cancelServer && prepared != null && attempt.operationId == null) {
      attempt.cancelRequested = true
      attempt.detached = true
      runtimeThreadOperationStore.writePrepared(
        prepared.claim,
        cancelRequested = true,
      )
      attempt.cancelActiveCall()
      val authorization = nativeThreadAuthorityLocked()?.takeIf {
        val authority = it.authority
        authority.runtimeId == prepared.claim.runtimeId &&
          authority.readinessGeneration == prepared.claim.readinessGeneration &&
          authority.environmentOrigin == prepared.claim.environmentOrigin &&
          authority.selectedProjectId == prepared.claim.projectId &&
          authority.selectedThreadId == prepared.claim.threadId
      }
      if (authorization == null) {
        T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
          operation = "runtime-thread",
          code = "native-thread-cancel-authorization-unavailable",
          message = "Runtime thread voice requires authorization reconciliation.",
          recoverable = true,
        ))
        fenceRuntimeThreadForReconciliationLocked(attempt)
      } else {
        applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
        createRuntimeThreadOperation(attempt)
      }
      return
    }
    attempt.cancelActiveCall()
    val dispatched = runtimeSnapshot.dispatchAcknowledged
    attempt.stopped = !dispatched
    val operationId = attempt.operationId
    val persisted = runtimeThreadOperationStore.load() as? VoiceRuntimeThreadOperationLoadResult.Available
    val active = persisted?.state as? VoiceRuntimeThreadOperationState.Active
    if (active != null && cancelServer) {
      attempt.cancelRequested = true
      attempt.detached = true
      runtimeThreadOperationStore.writeActive(active.copy(detached = true, cancelRequested = true))
      applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
      if (operationId != null) {
        cancelRuntimeThreadOperation(attempt)
      }
      return
    }
    runtimeThreadAttempt = null
    val completed = VoiceRuntimeThreadLocalStopCoordinator.complete(
      clearDurableState = {
        runCatching {
          runtimeThreadOperationStore.clear(attempt.clientOperationId)
        }.getOrDefault(false)
      },
      stopSnapshot = { applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop) },
      reconcileForeground = {},
    )
    if (!completed) {
      runtimeThreadAttempt = attempt
      T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
        operation = "runtime-thread",
        code = "native-thread-stop-reconciliation-required",
        message = "Runtime thread voice requires authorization reconciliation.",
        recoverable = true,
      ))
      fenceRuntimeThreadForReconciliationLocked(attempt)
    } else {
      retireThreadTurnEpoch(attempt.clientOperationId)
      reconcileAfterRuntimeThreadStopLocked(attempt)
    }
  }

  private fun pauseRuntimeThreadAfterTurnLocked() {
    val attempt = runtimeThreadAttempt ?: return
    if (runtimeSnapshot.autoRearm) {
      persistRuntimeSnapshotLocked(runtimeSnapshot.copy(autoRearm = false))
    }
    val owner = recordingOwner?.takeIf {
      it.domain == T3VoiceOperationOwnerDomain.THREAD_MODE &&
        it.operationId == attempt.operationId
    }
    if (owner != null) runCatching { recorder.stop(owner.id) }
  }

  private fun reconcileAfterRuntimeThreadStopLocked(
    attempt: VoiceRuntimeThreadAttempt,
  ) {
    if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    } else {
      updateRuntimeControlSurfacesLocked()
    }
  }

  private fun cancelRuntimeThreadOperation(attempt: VoiceRuntimeThreadAttempt) {
    val operationId = attempt.operationId ?: return
    val credential = sessionCredential(attempt.authority.environmentOrigin)
    acquireWakeLockLocked()
    val call = runtimeThreadServer.newCancelCall(
      attempt.authority.environmentOrigin, credential, operationId,
    )
    attempt.beginCancellationCall(call)
    netDriver.execute("thread-cancel", VoiceNetLane.THREAD_TURN, driverEpoch(), blockingBody = {
      val result = call.execute()
      val continuation: () -> Unit = {
        run {
          if (!attempt.finishCancellationCall(call)) return@run
          when (VoiceRuntimeThreadCancelPolicy.decide(result)) {
            VoiceRuntimeThreadCancelDecision.COMPLETE -> {
              val completed = VoiceRuntimeThreadLocalCleanupCoordinator.complete(
                deleteRecording = {
                  attempt.recording?.let {
                    runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
                  } ?: true
                },
                clearDurableState = {
                  runCatching {
                    runtimeThreadOperationStore.clear(attempt.clientOperationId)
                  }.getOrDefault(false)
                },
              )
              if (!completed) {
                attempt.retryFailures += 1
                releaseWakeLockForRuntimeBackoffLocked()
                submitCallbackDelayed({
                  run {
                    if (attempt.cancelRequested) {
                      cancelRuntimeThreadOperation(attempt)
                    }
                  }
                }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
                  "thread-cancel:${attempt.clientOperationId}")
                return@run
              }
              attempt.stopped = true
              runtimeThreadAttempt = null
              retireThreadTurnEpoch(attempt.clientOperationId)
              applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
              reconcileAfterRuntimeThreadStopLocked(attempt)
            }
            VoiceRuntimeThreadCancelDecision.RETRY -> {
              attempt.retryFailures += 1
              releaseWakeLockForRuntimeBackoffLocked()
              submitCallbackDelayed({
                run {
                  if (attempt.cancelRequested) {
                    cancelRuntimeThreadOperation(attempt)
                  }
                }
              }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures),
                "thread-cancel:${attempt.clientOperationId}")
            }
            VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION -> {
              T3VoiceDiagnostics.record(
                0,
                T3VoiceDiagnosticCategory.TERMINAL,
                T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
              )
              check(VoiceRuntimeThreadCancelReconciliationPolicy.requiresFence(
                VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION,
              ))
              fenceRuntimeThreadForReconciliationLocked(attempt)
            }
          }
        }
      }
      continuation
    })
  }


  private fun fenceRuntimeThreadForReadinessLocked(next: T3VoiceReadinessConfig) {
    val attempt = runtimeThreadAttempt ?: return
    if (VoiceRuntimeThreadAttemptPolicy.owns(attempt, next)) return
    stopRuntimeThreadAudioLocked(attempt, "readiness-changed")
    stopRuntimeThreadLocked(cancelServer = true)
  }


  private fun applyRuntimeEventLocked(
    event: VoiceRuntimeExecutionEvent,
  ): VoiceRuntimeExecutionTransition? {
    mailbox.assertKernelThread()
    val transition = VoiceRuntimeExecutionReducer.reduce(runtimeSnapshot, event)
    if (!persistRuntimeSnapshotLocked(transition.snapshot)) {
      runtimeThreadAttempt?.let {
        failRuntimeThreadLocked(it, "native-thread-state-unavailable")
      }
      return null
    }
    return transition
  }

  private fun persistRuntimeSnapshotLocked(
    snapshot: VoiceRuntimeExecutionSnapshot,
  ): Boolean {
    val attempt = runtimeThreadAttempt
    val dispatchedRecording = attempt?.recording?.takeIf {
      snapshot.mode == VoiceRuntimeExecutionMode.THREAD && snapshot.dispatchAcknowledged
    }
    if (attempt?.operationId != null && snapshot.mode == VoiceRuntimeExecutionMode.THREAD) {
      val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) { active ->
        active.copy(
          recording = if (dispatchedRecording == null) attempt.recording else null,
          detached = attempt.detached,
          cancelRequested = attempt.cancelRequested,
          snapshot = VoiceRuntimeThreadPersistencePolicy.snapshotAfterTransition(
            active,
            snapshot,
          ),
        )
      }
      if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) return false
    }
    runtimeSnapshot = snapshot
    if (::voiceRuntimeController.isInitialized) {
      voiceRuntimeController.observeRuntime(runtimeSnapshot)
      clearIdleAttachedOnlyAuthorityLocked()
    }
    val snapshotPersisted = runCatching {
      runtimeSnapshotStore.write(runtimeSnapshot)
    }.isSuccess
    if (attempt?.operationId == null && !snapshotPersisted) return false
    if (dispatchedRecording != null) attempt.recording = null
    dispatchedRecording?.let { recording ->
      runCatching { recorder.delete(recording.recordingId, recording.uri) }
    }
    return true
  }

  private fun realtimeAuthorityLocked(
    persisted: VoiceRuntimePersistedAuthority,
  ): VoiceRuntimeRealtimeAuthority {
    val target = persisted.target as? VoiceRuntimeTarget.Realtime
      ?: throw VoiceRuntimeFenceException("The canonical authority is not Realtime.")
    val identity = voiceRuntimeController.snapshot().identity
    if (identity.runtimeId != persisted.runtimeId || identity.generation != persisted.generation) {
      throw VoiceRuntimeFenceException("Installed Realtime authority does not match the runtime.")
    }
    return VoiceRuntimeRealtimeAuthority(
      identity,
      target,
      persisted.environmentOrigin,
    )
  }

  private fun createRealtimeEngineLocked(
    authority: VoiceRuntimeRealtimeAuthority,
  ): VoiceRuntimeRealtimeReducer = VoiceRuntimeRealtimeReducer(
      authority = authority,
      assertKernelThread = mailbox::assertKernelThread,
    )

  private fun loadRealtimeStateLocked() = VoiceRuntimeRealtimeState(
    checkpoint = voiceRuntimeRealtimeRepository.load(),
    finalization = voiceRuntimeRealtimeRepository.loadFinalization(),
    terminals = voiceRuntimeRealtimeRepository.terminals(System.currentTimeMillis()),
  )

  private fun realtimeState(
    @Suppress("UNUSED_PARAMETER") engine: VoiceRuntimeRealtimeReducer,
  ): VoiceRuntimeRealtimeState = checkNotNull(
    voiceRuntimeRealtimeEngineSlot.snapshot().current,
  ) { "The Realtime reducer slot is empty." }.state

  private fun <T> applyRealtimeReduction(
    engine: VoiceRuntimeRealtimeReducer,
    reduction: VoiceRuntimeRealtimeReduction<T>,
  ): T {
    mailbox.assertKernelThread()
    val modeSessionBefore = voiceRuntimeRealtimeEngineSlot.snapshot().current
      ?.state?.checkpoint?.fence?.modeSessionId
    if (voiceRuntimeRealtimeEngineSlot.applyReduction(reduction) == null) {
      return reduction.result
    }
    if (modeSessionBefore != null &&
      realtimeState(engine).checkpoint?.fence?.modeSessionId != modeSessionBefore
    ) {
      // The mode root shares its registry key with the canonical peer; both end here.
      epochRegistry.current(modeSessionBefore)?.let(epochRegistry::retire)
      mediaDriver.disarmRealtime(modeSessionBefore)
    }
    reduction.effects.forEach { dispatchRealtimeEffect(engine, it) }
    dispatchRealtimeOutputs(engine, reduction.outputs)
    return reduction.result
  }

  private fun dispatchRealtimeOutputs(
    engine: VoiceRuntimeRealtimeReducer,
    outputs: List<VoiceRuntimeRealtimeOutput>,
  ) {
    outputs.forEach { output ->
      when (output) {
        is VoiceRuntimeRealtimeOutput.State -> {
          voiceRuntimeController.observeRealtime(output.checkpoint)
          if (output.checkpoint == null) {
            realtimeFinalizationTransitionAuthority = realtimeState(engine).finalization
              ?.let(::realtimeHandoffAuthority)
              ?: voiceRuntimeAuthorityStore.inspectPreparedTransition()
            cancelVoiceRuntimeRealtimeTasksLocked()
            scheduleVoiceRuntimeRealtimeFinalizationLocked(engine)
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          } else scheduleVoiceRuntimeRealtimeTasksLocked(engine, output.checkpoint)
          updateRuntimeControlSurfacesLocked()
        }
        is VoiceRuntimeRealtimeOutput.FinalizationInstalled -> {
          realtimeFinalizationTransitionAuthority =
            realtimeHandoffAuthority(output.finalization)
              ?: voiceRuntimeAuthorityStore.inspectPreparedTransition()
          cancelVoiceRuntimeRealtimeTasksLocked()
          scheduleVoiceRuntimeRealtimeFinalizationLocked(engine)
          updateRuntimeControlSurfacesLocked()
        }
        is VoiceRuntimeRealtimeOutput.Terminal ->
          voiceRuntimeController.publishRealtimeTerminal(output.summary)
        is VoiceRuntimeRealtimeOutput.Finalization ->
          handleRealtimeFinalizationResultLocked(engine, output.result)
        VoiceRuntimeRealtimeOutput.ReconcileForeground -> {
          reconcileRealtimeEngineTerminalLocked(engine)
          reconcileForegroundAfterVoiceStopLocked()
        }
      }
    }
  }

  private fun dispatchRealtimeEffect(
    engine: VoiceRuntimeRealtimeReducer,
    effect: VoiceRuntimeRealtimeEffect,
  ) {
    fun apply(reduction: VoiceRuntimeRealtimeReduction<*>) {
      applyRealtimeReduction(engine, reduction)
    }
    fun <R> net(
      name: String,
      lane: VoiceNetLane,
      operation: () -> R,
      complete: (R) -> VoiceRuntimeRealtimeReduction<*>,
    ) {
      netDriver.execute(name, lane, driverEpoch(), blockingBody = {
        val result = runCatching(operation)
        val continuation: () -> Unit = {
          result.map(complete).onSuccess(::apply).onFailure {
            recordVoiceRuntimeRealtimeControlFailure()
          }
        }
        continuation
      })
    }
    when (effect) {
      is VoiceRuntimeRealtimeEffect.Persist -> storeDriver.persist(
        "realtime-state",
        driverEpoch(),
        body = {
          when (val operation = effect.operation) {
            is VoiceRuntimeRealtimePersistence.Batch -> operation.operations.forEach { nested ->
              when (nested) {
                is VoiceRuntimeRealtimePersistence.SaveCheckpoint ->
                  voiceRuntimeRealtimeRepository.save(nested.checkpoint)
                is VoiceRuntimeRealtimePersistence.ClearCheckpoint ->
                  voiceRuntimeRealtimeRepository.clear(nested.fence)
                is VoiceRuntimeRealtimePersistence.InstallFinalization ->
                  voiceRuntimeRealtimeRepository.installFinalization(
                    nested.expectedCheckpoint,
                    nested.finalization,
                  )
                is VoiceRuntimeRealtimePersistence.SaveFinalization ->
                  voiceRuntimeRealtimeRepository.saveFinalization(nested.finalization)
                is VoiceRuntimeRealtimePersistence.ClearFinalization ->
                  voiceRuntimeRealtimeRepository.clearFinalization(nested.fence, nested.sessionId)
                is VoiceRuntimeRealtimePersistence.PublishTerminal ->
                  voiceRuntimeRealtimeRepository.publishTerminal(nested.summary)
                is VoiceRuntimeRealtimePersistence.Batch ->
                  error("Nested Realtime persistence batches are unsupported.")
              }
            }
            is VoiceRuntimeRealtimePersistence.SaveCheckpoint ->
              voiceRuntimeRealtimeRepository.save(operation.checkpoint)
            is VoiceRuntimeRealtimePersistence.ClearCheckpoint ->
              voiceRuntimeRealtimeRepository.clear(operation.fence)
            is VoiceRuntimeRealtimePersistence.InstallFinalization ->
              voiceRuntimeRealtimeRepository.installFinalization(
                operation.expectedCheckpoint,
                operation.finalization,
              )
            is VoiceRuntimeRealtimePersistence.SaveFinalization ->
              voiceRuntimeRealtimeRepository.saveFinalization(operation.finalization)
            is VoiceRuntimeRealtimePersistence.ClearFinalization ->
              voiceRuntimeRealtimeRepository.clearFinalization(operation.fence, operation.sessionId)
            is VoiceRuntimeRealtimePersistence.PublishTerminal ->
              voiceRuntimeRealtimeRepository.publishTerminal(operation.summary)
          }
        },
        continuation = { persisted ->
          if (persisted.isSuccess) {
            effect.effects.forEach { dispatchRealtimeEffect(engine, it) }
            dispatchRealtimeOutputs(engine, effect.outputs)
          } else recordVoiceRuntimeRealtimeControlFailure()
        },
      )
      is VoiceRuntimeRealtimeEffect.Start -> net(
        "realtime-start",
        VoiceNetLane.REALTIME,
        { voiceRuntimeRealtimeServer.start(engine.authority, effect.fence, effect.commandId) },
      ) { result ->
        engine.completeStart(
          realtimeState(engine),
          effect.fence,
          effect.commandId,
          result,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.PreparePeer -> {
        val peerEpoch = armEpoch(
          VoiceKernelEpochRootKind.REALTIME_PEER,
          effect.fence.modeSessionId,
          effect.fence.identity.generation,
        )
        mediaDriver.armRealtime(effect.fence.modeSessionId, peerEpoch)
        netDriver.execute("realtime-peer-prepare", VoiceNetLane.REALTIME, driverEpoch(), blockingBody = {
          val accepted = realtimePeerPort(peerEpoch).prepare(
            effect.fence.modeSessionId,
            { offer -> submitCallback {
              apply(engine.onPeerOffer(realtimeState(engine), effect.fence, effect.sessionId, offer))
            } },
            { code -> submitCallback {
              apply(engine.onPeerTerminated(
                realtimeState(engine), effect.fence, effect.sessionId, code,
                System.currentTimeMillis(),
              ))
            } },
          )
          val continuation: () -> Unit = {
            apply(engine.completePeerPrepare(
              realtimeState(engine), effect.fence, effect.sessionId, accepted,
              System.currentTimeMillis(),
            ))
          }
          continuation
        })
      }
      is VoiceRuntimeRealtimeEffect.Offer -> net(
        "realtime-offer",
        VoiceNetLane.REALTIME,
        {
          voiceRuntimeRealtimeServer.offer(
            engine.authority,
            effect.fence,
            effect.session,
            effect.operationId,
            effect.sdp,
          )
        },
      ) { result ->
        engine.completeOffer(
          realtimeState(engine),
          effect.fence,
          effect.session.state.sessionId,
          result,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.ApplyAnswer -> {
        netDriver.execute("realtime-answer", VoiceNetLane.REALTIME, driverEpoch(), blockingBody = {
          val accepted = realtimePeerPort().applyAnswer(
            effect.fence.modeSessionId,
            effect.sdp,
          ) { code -> submitCallback {
            apply(engine.onPeerTerminated(
              realtimeState(engine), effect.fence, effect.sessionId, code,
              System.currentTimeMillis(),
            ))
          } }
          val continuation: () -> Unit = {
            apply(engine.completeApplyAnswer(
              realtimeState(engine), effect.fence, effect.sessionId, accepted,
              System.currentTimeMillis(),
            ))
          }
          continuation
        })
      }
      is VoiceRuntimeRealtimeEffect.SetInputReady -> net(
        "realtime-input-ready",
        VoiceNetLane.CONTROL,
        { realtimePeerPort().setInputReady(effect.fence.modeSessionId, effect.ready) },
      ) { accepted ->
        engine.completeInputReady(
          realtimeState(engine), effect.fence, effect.ready, accepted,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.SetMuted -> net(
        "realtime-muted",
        VoiceNetLane.CONTROL,
        { realtimePeerPort().setMuted(effect.fence.modeSessionId, effect.muted) },
      ) { accepted ->
        engine.completeSetMuted(
          realtimeState(engine), effect.fence, effect.muted, accepted,
        )
      }
      is VoiceRuntimeRealtimeEffect.Drain -> {
        val accepted = realtimePeerPort().drain(effect.fence.modeSessionId) {
          submitCallback {
            apply(engine.completeDrain(realtimeState(engine), effect.fence, effect.reason, true))
          }
        }
        if (!accepted) apply(engine.completeDrain(realtimeState(engine), effect.fence, effect.reason, false))
      }
      is VoiceRuntimeRealtimeEffect.ClosePeer -> netDriver.executeDetached(
        "realtime-peer-close", VoiceNetLane.CONTROL, driverEpoch(),
      ) { realtimePeerPort().close(effect.fence.modeSessionId) }
      is VoiceRuntimeRealtimeEffect.CueReady -> {
        val accepted = realtimeCuePort().ready(effect.fence.identity.generation) {
          submitCallback {
            apply(engine.completeReadyCue(
              realtimeState(engine), effect.fence, effect.sessionId, true,
            ))
          }
        }
        if (!accepted) apply(engine.completeReadyCue(
          realtimeState(engine), effect.fence, effect.sessionId, false,
        ))
      }
      is VoiceRuntimeRealtimeEffect.CueEnded -> {
        val accepted = realtimeCuePort().ended(effect.fence.identity.generation) {
          submitCallback {
            apply(engine.completeEndedCue(realtimeState(engine), effect.fence, effect.reason, true))
          }
        }
        if (!accepted) apply(engine.completeEndedCue(
          realtimeState(engine), effect.fence, effect.reason, false,
        ))
      }
      is VoiceRuntimeRealtimeEffect.Heartbeat -> net(
        "realtime-heartbeat",
        VoiceNetLane.REALTIME,
        { voiceRuntimeRealtimeServer.heartbeat(engine.authority, effect.fence, effect.session) },
      ) { result ->
        engine.completeHeartbeat(
          realtimeState(engine), effect.fence, effect.session.state.sessionId,
          result,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.PollActions -> net(
        "realtime-actions",
        VoiceNetLane.REALTIME,
        {
          voiceRuntimeRealtimeServer.actions(
          engine.authority, effect.fence, effect.session, effect.afterSequence,
          effect.waitMilliseconds,
          )
        },
      ) { result ->
        val action = (result as? VoiceRuntimeRealtimeRemoteResult.Success)
          ?.value?.actions?.firstOrNull { it.sequence > effect.afterSequence }
        val plan = (action as? VoiceRuntimeRealtimeAction.HandoffToThreadVoice)?.let {
          realtimeHandoffPort().plan(realtimeState(engine).checkpoint ?: effect.session.let {
            throw VoiceRuntimeFenceException("Realtime checkpoint is unavailable.")
          }, it)
        }
        engine.completePollActions(
          realtimeState(engine), effect.fence, effect.session.state.sessionId, result, plan,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.PublishPresentation -> apply(
        engine.completePresentationPublish(
          realtimeState(engine), effect.fence, effect.action,
          voiceRuntimeController.publishRealtimePresentationAction(effect.fence, effect.action),
        ),
      )
      is VoiceRuntimeRealtimeEffect.RetractPresentation ->
        voiceRuntimeController.retractRealtimePresentationAction(effect.fence, effect.action)
      is VoiceRuntimeRealtimeEffect.CommitHandoff -> net(
        "realtime-handoff-commit",
        VoiceNetLane.CONTROL,
        {
          voiceRuntimeRealtimeServer.commitHandoff(
            VoiceRuntimeRealtimeAuthority(
              effect.finalization.fence.identity,
              effect.finalization.sourceTarget,
              effect.finalization.sourceEnvironmentOrigin,
            ),
            effect.finalization.fence,
            effect.finalization.session,
            requireNotNull(effect.finalization.handoffExchange),
          )
        },
      ) { result ->
        engine.completeHandoffCommit(
          realtimeState(engine), effect.finalization,
          result,
        )
      }
      is VoiceRuntimeRealtimeEffect.ActivateHandoff -> {
        var activated = false
        storeDriver.persist(
          "realtime-handoff-activate", driverEpoch(),
          body = {
            activated = realtimeHandoffPort().activate(
              requireNotNull(effect.finalization.handoffExchange),
            )
          },
          continuation = { result ->
          apply(engine.completeHandoffActivation(
              realtimeState(engine), effect.finalization, result.isSuccess && activated,
          ))
          },
        )
      }
      is VoiceRuntimeRealtimeEffect.CloseServer -> net(
        "realtime-close",
        VoiceNetLane.CONTROL,
        {
        val authority = VoiceRuntimeRealtimeAuthority(
          effect.finalization.fence.identity,
          effect.finalization.sourceTarget,
          effect.finalization.sourceEnvironmentOrigin,
        )
          voiceRuntimeRealtimeServer.close(
            authority, effect.finalization.fence, effect.finalization.session,
            effect.finalization.closeOperationId,
          )
        },
      ) { result ->
        engine.completeSourceClose(
          realtimeState(engine), effect.finalization, result,
          System.currentTimeMillis(),
        )
      }
      is VoiceRuntimeRealtimeEffect.UpdateFocus -> net(
        "realtime-focus",
        VoiceNetLane.CONTROL,
        {
          voiceRuntimeRealtimeServer.updateFocus(
            engine.authority,
            effect.fence,
            effect.session,
            effect.commandId,
            effect.focus,
          )
        },
      ) { result -> engine.completeFocus(realtimeState(engine), effect, result) }
      is VoiceRuntimeRealtimeEffect.AcknowledgeAction -> net(
        "realtime-action-acknowledge",
        VoiceNetLane.CONTROL,
        {
          voiceRuntimeRealtimeServer.acknowledgeAction(
            engine.authority,
            effect.fence,
            effect.session,
            effect.action,
            effect.commandId,
            effect.decision,
          )
        },
      ) { result -> engine.completeAcknowledgement(realtimeState(engine), effect, result) }
      is VoiceRuntimeRealtimeEffect.ExchangeHandoff -> net(
        "realtime-handoff-exchange",
        VoiceNetLane.CONTROL,
        {
          voiceRuntimeRealtimeServer.exchangeHandoff(
            engine.authority,
            effect.fence,
            effect.session,
            effect.action,
            effect.plan,
          )
        },
      ) { result -> engine.completeHandoffExchange(
        realtimeState(engine), effect, result, System.currentTimeMillis(),
      ) }
      is VoiceRuntimeRealtimeEffect.PrepareHandoff -> {
        var prepared = false
        storeDriver.persist(
          "realtime-handoff-prepare",
          driverEpoch(),
          body = { prepared = realtimeHandoffPort().prepare(effect.exchange) },
          continuation = { result -> apply(engine.completeHandoffPrepare(
            realtimeState(engine), effect, result.isSuccess && prepared,
            System.currentTimeMillis(),
          )) },
        )
      }
      is VoiceRuntimeRealtimeEffect.RollbackHandoff -> storeDriver.persist(
        "realtime-handoff-rollback",
        driverEpoch(),
        body = { check(realtimeHandoffPort().rollback(effect.exchange)) },
      )
    }
  }

  private fun installRealtimeEngineLocked(persisted: VoiceRuntimePersistedAuthority) {
    mailbox.assertKernelThread()
    cancelVoiceRuntimeRealtimeTasksLocked()
    if (voiceRuntimeRealtimeRepository.load()?.pendingHandoffExchange == null &&
      voiceRuntimeRealtimeRepository.loadFinalization()?.handoffExchange == null) {
      voiceRuntimeAuthorityStore.inspectPreparedTransition()?.let {
        voiceRuntimeAuthorityStore.discardPreparedTransition(it)
      }
    }
    val installed = voiceRuntimeRealtimeEngineSlot.snapshot().current
    val target = persisted.target as? VoiceRuntimeTarget.Realtime
    if (target == null) {
      if (installed != null) {
        val installation = voiceRuntimeRealtimeEngineSlot.stageIdleClear()
        voiceRuntimeRealtimeEngineSlot.commit(installation)
        voiceRuntimeRealtimeEngineSlot.complete(installation)
      }
      return
    }
    val authority = realtimeAuthorityLocked(persisted)
    val engine = createRealtimeEngineLocked(authority)
    val state = loadRealtimeStateLocked()
    val installation = if (state.isOperational()) {
      voiceRuntimeRealtimeEngineSlot.stageRecoveredInstall(authority, engine, state)
    } else {
      voiceRuntimeRealtimeEngineSlot.stageIdleInstall(authority, engine, state)
    }
    voiceRuntimeRealtimeEngineSlot.commit(installation)
    voiceRuntimeRealtimeEngineSlot.complete(installation)
    recoverRealtimeEngineLocked(engine, authority.identity)
  }

  private fun installRecoveredRealtimeStateLocked(): Boolean {
    val finalization = voiceRuntimeRealtimeRepository.loadFinalization()
    val checkpoint = voiceRuntimeRealtimeRepository.load()
    if (finalization == null && checkpoint == null) return false
    realtimeFinalizationTransitionAuthority = finalization?.let(::realtimeHandoffAuthority)
      ?: voiceRuntimeAuthorityStore.inspectPreparedTransition()
    val checkpointOrigin = readinessStore.pendingRuntimeRevocation()?.environmentOrigin
      ?: readinessStore.activeAuthority()?.environmentOrigin
      ?: persistedAuthority()?.environmentOrigin
    val authority = T3VoiceRecoveredRealtimeAuthorityPolicy.authority(
      finalization,
      checkpoint,
      checkpointOrigin,
    ) ?: return false
    val engine = createRealtimeEngineLocked(authority)
    val state = loadRealtimeStateLocked()
    val installation = voiceRuntimeRealtimeEngineSlot.stageRecoveredInstall(
      authority,
      engine,
      state,
    )
    voiceRuntimeRealtimeEngineSlot.commit(installation)
    voiceRuntimeRealtimeEngineSlot.complete(installation)
    checkpoint?.takeIf { recovered ->
      voiceRuntimeController.snapshot().target == recovered.target
    }?.let { recovered ->
      check(voiceRuntimeController.recoverRealtimePresentationContext(recovered)) {
        "Recovered Realtime presentation context does not match canonical authority."
      }
    }
    recoverRealtimeEngineLocked(
      engine,
      T3VoiceRecoveredRealtimeAuthorityPolicy.recoveryIdentity(
        authority,
        voiceRuntimeController.snapshot().identity,
      ),
    )
    return true
  }

  private fun recoverRealtimeEngineLocked(
    engine: VoiceRuntimeRealtimeReducer,
    identity: VoiceRuntimeIdentity,
  ) {
    val recovery = runCatching {
      applyRealtimeReduction(engine, engine.recoverInterrupted(
        realtimeState(engine), identity, System.currentTimeMillis(),
      ))
    }
    if (recovery.isFailure) {
            T3VoiceDiagnostics.record(
              0,
              T3VoiceDiagnosticCategory.TERMINAL,
              T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
            )
            if (realtimeState(engine).isOperational()) {
              scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)
            } else {
              runCatching {
                voiceRuntimeRealtimeEngineSlot.clear()
              }
            }
      return
    }
    if (recovery.getOrNull() != null) {
      reconcileRealtimeEngineTerminalLocked(engine)
      return
    }
    realtimeState(engine).checkpoint?.let {
      voiceRuntimeController.observeRealtime(it)
      scheduleVoiceRuntimeRealtimeTasksLocked(engine, it)
    }
    scheduleVoiceRuntimeRealtimeFinalizationLocked(engine)
    updateRuntimeControlSurfacesLocked()
  }

  private fun realtimePeerPort(
    prepareEpoch: VoiceKernelEpoch? = null,
  ): VoiceRuntimeRealtimePeer = object : VoiceRuntimeRealtimePeer {
    override fun prepare(
      modeSessionId: String,
      onOffer: (String) -> Unit,
      onFailure: (String) -> Unit,
    ): Boolean = runCatching {
      check(T3VoiceStateStore.claimRealtime(modeSessionId)) { "The voice runtime is already in use." }
      val diagnosticGeneration = T3VoiceDiagnostics.nextGeneration()
      realtime.prepare(
        modeSessionId,
        checkNotNull(prepareEpoch) { "Realtime peer preparation requires an armed epoch." },
        diagnosticGeneration,
        readinessConfig.audioRouteId,
        object : T3VoiceWebRtcResultCallback<String> {
          override fun onSuccess(result: String) {
            dispatchVoiceRuntimeRealtimeOffer { onOffer(result) }
          }

          override fun onFailure(code: String, message: String, cause: Throwable?) {
            dispatchVoiceRuntimeRealtimeOffer { onFailure(code) }
          }
        },
      )
      mailbox.submit(callbackMessage("realtime-peer-service-start")) {
        keepServiceStarted(ACTION_START_REALTIME, modeSessionId)
      }
    }.isSuccess

    override fun applyAnswer(
      modeSessionId: String,
      sdp: String,
      onFailure: (String) -> Unit,
    ): Boolean = runCatching {
      realtime.applyAnswer(
        modeSessionId,
        sdp,
        object : T3VoiceWebRtcResultCallback<Unit> {
          override fun onSuccess(result: Unit) = Unit
          override fun onFailure(code: String, message: String, cause: Throwable?) {
            dispatchVoiceRuntimeRealtimeOffer { onFailure(code) }
          }
        },
      )
    }.isSuccess

    override fun setInputReady(modeSessionId: String, ready: Boolean): Boolean =
      runCatching { realtime.setInputReady(modeSessionId, ready) }.isSuccess

    override fun setMuted(modeSessionId: String, muted: Boolean): Boolean =
      runCatching { realtime.setMuted(modeSessionId, muted) }.isSuccess

    override fun drain(modeSessionId: String, onComplete: () -> Unit): Boolean = runCatching {
      realtime.drainPlayout(modeSessionId) { onComplete() }
    }.isSuccess

    override fun close(modeSessionId: String) {
      runCatching { realtime.stop(modeSessionId) }
      T3VoiceStateStore.releaseRealtimeClaim(modeSessionId)
    }
  }

  private fun dispatchVoiceRuntimeRealtimeOffer(block: () -> Unit) {
    runCatching {
      netDriver.executeDetached("realtime-offer", VoiceNetLane.REALTIME, driverEpoch()) {
        block()
      }
    }
  }

  private fun realtimeCuePort(): VoiceRuntimeRealtimeCues = object : VoiceRuntimeRealtimeCues {
    // The engine invokes both ports while holding its monitor. Accept optimistically and never
    // await the kernel or invoke the engine completion inline; control IO re-enters the engine only
    // after the monitor-holding call has returned.
    override fun ready(generation: Long, onComplete: () -> Unit): Boolean {
      mailbox.submit(callbackMessage("realtime-ready-cue-request")) {
        val complete = { dispatchVoiceRuntimeRealtimeControl(onComplete) }
        val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:engine-ready:$generation")
        if (!cueSettings.enabled) {
          epochRegistry.retire(epoch)
          complete()
        } else {
          val cueGeneration = epoch.attemptOrdinal
          if (!cueCoordinator.requestReady(cueGeneration) {
              postCueCompletion(epoch, complete)
            }) {
            epochRegistry.retire(epoch)
            complete()
          }
        }
      }
      return true
    }

    override fun ended(generation: Long, onComplete: () -> Unit): Boolean {
      mailbox.submit(callbackMessage("realtime-ended-cue-request")) {
        val complete = { dispatchVoiceRuntimeRealtimeControl(onComplete) }
        val epoch = armEpoch(VoiceKernelEpochRootKind.CUE, "cue:engine-ended:$generation")
        if (!cueSettings.enabled) {
          epochRegistry.retire(epoch)
          complete()
        } else {
          val cueGeneration = epoch.attemptOrdinal
          if (!cueCoordinator.requestEnded(cueGeneration) {
              postCueCompletion(epoch, complete)
            }) {
            epochRegistry.retire(epoch)
            complete()
          }
        }
      }
      return true
    }
  }

  private fun dispatchVoiceRuntimeRealtimeControl(block: () -> Unit) {
    runCatching {
      netDriver.executeDetached("realtime-control", VoiceNetLane.CONTROL, driverEpoch()) {
        block()
      }
    }
  }

  private fun realtimeHandoffPort(): VoiceRuntimeRealtimeHandoffCoordinator =
    object : VoiceRuntimeRealtimeHandoffCoordinator {
      override fun plan(
        source: VoiceRuntimeRealtimeCheckpoint,
        action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
      ) = VoiceRuntimeRealtimeHandoffPlan(
        clientOperationId = "handoff-${action.actionId}",
        threadModeSessionId = "thread-mode-${action.actionId}",
        environmentId = source.target.environmentId,
        speechPreset = "default",
        endpointPolicy = VoiceRuntimeRealtimeEndpointPolicy(2_200, null, 3_600_000),
        speechEnabled = true,
        rearmGuardMs = 250,
      )

      override fun prepare(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean =
        runCatching {
            val (persisted, reservation) = realtimeHandoffAuthorityLocked(result)
            voiceRuntimeController.validateAuthorityReplacement(
              reservation,
              persisted.target as VoiceRuntimeTarget.Thread,
            )
            voiceRuntimeAuthorityStore.prepareTransition(persisted)
          }.isSuccess

      override fun rollback(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean =
        run {
          val prepared = voiceRuntimeAuthorityStore.inspectPreparedTransition()
            ?: return@run true
          val expected = realtimeHandoffAuthority(
            result,
            prepared.runtimeId,
            prepared.environmentOrigin,
          )
          voiceRuntimeAuthorityStore.discardPreparedTransition(expected)
        }

      override fun activate(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean =
        activateRealtimeHandoff(result)
    }

  private fun realtimeHandoffAuthorityLocked(
    result: VoiceRuntimeRealtimeHandoffExchangeResult,
  ): Pair<VoiceRuntimePersistedAuthority, VoiceRuntimeAuthorityReservation> {
    val origin = persistedAuthority()?.environmentOrigin
      ?: error("Canonical handoff source authority is unavailable.")
    val current = voiceRuntimeController.snapshot().identity
    val persisted = realtimeHandoffAuthority(result, current.runtimeId, origin)
    val reservation = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity(current.runtimeId, current.runtimeInstanceId, persisted.generation),
      persisted.generation - 1,
      persisted.targetDigest,
    )
    return persisted to reservation
  }

  private fun realtimeHandoffAuthority(
    finalization: VoiceRuntimeRealtimeFinalization,
  ): VoiceRuntimePersistedAuthority? = finalization.handoffExchange?.let {
    realtimeHandoffAuthority(
      it,
      finalization.fence.identity.runtimeId,
      finalization.sourceEnvironmentOrigin,
    )
  }

  private fun realtimeHandoffAuthority(
    result: VoiceRuntimeRealtimeHandoffExchangeResult,
    runtimeId: String,
    environmentOrigin: String,
  ): VoiceRuntimePersistedAuthority {
    val reservation = result.reservation
    val target = VoiceRuntimeTarget.Thread(
      reservation.target.environmentId,
      reservation.target.projectId,
      reservation.target.threadId,
      reservation.target.speechPreset,
      reservation.target.autoRearm,
      reservation.target.endpointPolicy.endSilenceMs,
      reservation.target.endpointPolicy.noSpeechTimeoutMs,
      reservation.target.endpointPolicy.maximumUtteranceMs,
      reservation.target.speechEnabled,
      reservation.target.rearmGuardMs,
    )
    val targetDigest = T3VoiceRuntimeTargetIdentity.digest(
      VoiceRuntimeBridge.canonicalThreadTargetIdentity(target),
    )
    return VoiceRuntimePersistedAuthority(
      runtimeId = runtimeId,
      generation = reservation.generation,
      targetDigest = targetDigest,
      target = target,
      environmentOrigin = environmentOrigin,
      readinessEnabled = false,
    )
  }

  private fun activateRealtimeHandoff(
    result: VoiceRuntimeRealtimeHandoffExchangeResult,
  ): Boolean {
    val completed = CountDownLatch(1)
    var accepted = false
    val completion: (Boolean) -> Unit = {
      accepted = it
      completed.countDown()
    }
    val begin = {
      beginRealtimeHandoffActivationLocked(result, completion)
    }
    if (mailbox.isKernelThread()) {
      begin()
      return false
    }
    submitCallback(begin)
    if (!completed.await(RUNTIME_HANDOFF_ACTIVATION_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
      submitCallback {
        run {
          pendingRuntimeHandoffActivation?.takeIf { it.actionId == result.actionId }
            ?.completions?.remove(completion)
        }
      }
      return false
    }
    return accepted
  }

  private fun beginRealtimeHandoffActivationLocked(
    result: VoiceRuntimeRealtimeHandoffExchangeResult,
    completion: (Boolean) -> Unit,
  ) {
    val (persisted, reservation) = runCatching { realtimeHandoffAuthorityLocked(result) }
      .getOrElse {
        completion(false)
        return
      }
    val existing = pendingRuntimeHandoffActivation
    if (existing != null) {
      if (existing.actionId == result.actionId && existing.authority == persisted) {
        existing.completions += completion
      } else {
        completion(false)
      }
      return
    }
    val activation = T3VoicePendingRuntimeHandoffActivation(
      result.actionId,
      persisted,
      "handoff-turn-${result.actionId}",
      result.reservation.modeSessionId,
      mutableListOf(completion),
    )
    pendingRuntimeHandoffActivation = activation
    try {
      val canonical = (voiceRuntimeAuthorityStore.load()
        as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
      if (canonical == persisted) {
        val snapshot = voiceRuntimeController.snapshot()
        check(snapshot.identity.runtimeId == persisted.runtimeId &&
          snapshot.identity.generation == persisted.generation &&
          snapshot.target == persisted.target) {
          "Canonical handoff controller authority is unavailable."
        }
        ensureRuntimeHandoffThreadAttemptLocked(activation, snapshot.identity)
      } else {
        check(canonical != null && canonical.target is VoiceRuntimeTarget.Realtime &&
          canonical.runtimeId == persisted.runtimeId &&
          canonical.generation + 1 == persisted.generation &&
          canonical.environmentOrigin == persisted.environmentOrigin) {
          "Canonical handoff source authority is stale."
        }
        activatePreparedRealtimeHandoffLocked(result, activation, persisted, reservation, canonical)
      }
      reconcileRuntimeHandoffCaptureLocked(activation)
    } catch (_: Throwable) {
      completeRuntimeHandoffActivationLocked(activation, false)
    }
  }

  private fun activatePreparedRealtimeHandoffLocked(
    result: VoiceRuntimeRealtimeHandoffExchangeResult,
    activation: T3VoicePendingRuntimeHandoffActivation,
    persisted: VoiceRuntimePersistedAuthority,
    reservation: VoiceRuntimeAuthorityReservation,
    sourceAuthority: VoiceRuntimePersistedAuthority,
  ) {
    val target = persisted.target as VoiceRuntimeTarget.Thread
    val identity = reservation.identity
    val controllerCheckpoint = voiceRuntimeController.checkpointCanonicalInstall()
    val readinessCheckpoint = readinessStore.checkpoint()
    val priorReadinessConfig = readinessConfig
    detachedThreadContinuationAdmission = true
    try {
      voiceRuntimeAuthorityStore.activatePreparedTransition(persisted) {
        val receipt = voiceRuntimeController.activateHandoffAuthority(
          reservation,
          target,
          reservation.toString(),
          VoiceRuntimeThreadCommand.Start(
            "handoff-start-${result.actionId}",
            identity,
            activation.modeSessionId,
            activation.turnClientOperationId,
            "auto-submit",
            null,
            "stop-conflicting",
          ),
        )
        if (sourceAuthority.readinessEnabled) {
          val disabled = readinessConfig.copy(enabled = false)
          readinessStore.write(disabled)
          readinessConfig = disabled
        }
        receipt
      }
    } catch (cause: Throwable) {
      val controllerRestored = runCatching {
        voiceRuntimeController.restoreCanonicalInstall(
          controllerCheckpoint,
          reservation,
        )
      }.onFailure(cause::addSuppressed).getOrDefault(false)
      runCatching { readinessStore.restore(readinessCheckpoint) }
        .onFailure(cause::addSuppressed)
      readinessConfig = priorReadinessConfig
      if (!controllerRestored) {
        enterCanonicalRecoveryRequiredLocked("handoff-controller-rollback")
      }
      throw cause
    } finally {
      detachedThreadContinuationAdmission = false
    }
    cancelVoiceRuntimeRealtimeTasksLocked()
  }

  private fun ensureRuntimeHandoffThreadAttemptLocked(
    activation: T3VoicePendingRuntimeHandoffActivation,
    identity: VoiceRuntimeIdentity,
  ) {
    val current = runtimeThreadAttempt
    if (current?.clientOperationId == activation.turnClientOperationId) return
    check(current == null) { "A different Thread operation owns the native runtime." }
    detachedThreadContinuationAdmission = true
    try {
      val receipt = voiceRuntimeController.dispatch(
        VoiceRuntimeThreadCommand.Start(
          "handoff-continue-${activation.actionId}-${UUID.randomUUID()}",
          identity,
          activation.modeSessionId,
          activation.turnClientOperationId,
          "auto-submit",
          null,
          "stop-conflicting",
        ),
      )
      check(VoiceRuntimeHandoffActivationPolicy.accepted(receipt)) {
        "The recovered handoff Thread operation was not admitted."
      }
    } finally {
      detachedThreadContinuationAdmission = false
    }
  }

  private fun reconcileRuntimeHandoffCaptureLocked(
    activation: T3VoicePendingRuntimeHandoffActivation,
  ) {
    if (pendingRuntimeHandoffActivation !== activation) return
    if (T3VoiceRuntimeHandoffCapturePolicy.isArmed(
        activation.turnClientOperationId,
        runtimeThreadAttempt,
        recordingOwner,
        T3VoiceStateStore.state.value.phase,
      )) {
      completeRuntimeHandoffActivationLocked(activation, true)
      return
    }
    val attempt = runtimeThreadAttempt?.takeIf {
      it.clientOperationId == activation.turnClientOperationId
    } ?: return
    if (attempt.operationId != null && attempt.recording == null &&
      pendingRecordingStart?.owner?.operationId != attempt.operationId &&
      recordingOwner?.operationId != attempt.operationId) {
      startRuntimeThreadRecordingLocked(attempt)
    }
  }

  private fun completeRuntimeHandoffActivationLocked(
    activation: T3VoicePendingRuntimeHandoffActivation,
    succeeded: Boolean,
  ) {
    if (pendingRuntimeHandoffActivation !== activation) return
    if (succeeded && !T3VoiceRuntimeHandoffCapturePolicy.isArmed(
        activation.turnClientOperationId,
        runtimeThreadAttempt,
        recordingOwner,
        T3VoiceStateStore.state.value.phase,
      )) return
    pendingRuntimeHandoffActivation = null
    activation.completions.toList().forEach { it(succeeded) }
    activation.completions.clear()
  }

  private fun completeRuntimeHandoffActivationForAttemptLocked(
    attempt: VoiceRuntimeThreadAttempt,
    succeeded: Boolean,
  ) {
    val activation = pendingRuntimeHandoffActivation?.takeIf {
      it.turnClientOperationId == attempt.clientOperationId
    } ?: return
    completeRuntimeHandoffActivationLocked(activation, succeeded)
  }

  private fun scheduleVoiceRuntimeRealtimeFinalizationLocked(
    engine: VoiceRuntimeRealtimeReducer,
    delayMillis: Long = 0,
  ) {
    if (!realtimeState(engine).isOperational()) return
    if (voiceRuntimeRealtimeFinalizationTask != null) return
    voiceRuntimeRealtimeFinalizationTask = scheduleTick(
      "realtime-finalization:${engine.authority.identity.runtimeInstanceId}",
      delayMillis,
    ) {
      run {
        voiceRuntimeRealtimeFinalizationTask = null
      }
      runCatching {
        applyRealtimeReduction(engine, engine.reconcileFinalization(realtimeState(engine)))
      }.onFailure {
        scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)
      }
    }
  }

  private fun handleRealtimeFinalizationResultLocked(
    engine: VoiceRuntimeRealtimeReducer,
    result: VoiceRuntimeRealtimeFinalizationResult,
  ) {
    mailbox.assertKernelThread()
    when (result) {
      is VoiceRuntimeRealtimeFinalizationResult.Pending -> {
        val retryDelay = (500L * (1L shl result.attemptCount.coerceIn(0, 5)))
          .coerceAtMost(15_000L)
        scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, retryDelay)
      }
      is VoiceRuntimeRealtimeFinalizationResult.Completed -> {
        discardUnactivatedRealtimeHandoffTransitionLocked()
        reconcileRealtimeEngineTerminalLocked(engine)
      }
      VoiceRuntimeRealtimeFinalizationResult.Idle -> {
        val shouldConverge = runCatching {
          val state = realtimeState(engine)
          T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle(
            hasFinalization = state.finalization != null,
            hasCheckpoint = state.checkpoint != null,
          )
        }.getOrElse {
          scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)
          return
        }
        if (!shouldConverge) return
        discardUnactivatedRealtimeHandoffTransitionLocked()
        reconcileRealtimeEngineTerminalLocked(engine)
      }
    }
  }

  private fun discardUnactivatedRealtimeHandoffTransitionLocked() {
    val expected = realtimeFinalizationTransitionAuthority ?: return
    val canonical = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
    if (canonical != expected) {
      voiceRuntimeAuthorityStore.discardPreparedTransition(expected)
    }
    realtimeFinalizationTransitionAuthority = null
  }

  private fun reconcileRealtimeEngineTerminalLocked(engine: VoiceRuntimeRealtimeReducer) {
    if (realtimeState(engine).isOperational()) return
    cancelVoiceRuntimeRealtimeTasksLocked()
    val canonical = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
    val notificationDisabledCanonical = canonical?.takeIf {
      !it.readinessEnabled &&
        readinessStore.disabledAuthorityFence() ==
          T3VoiceDisabledAuthorityFence(it.runtimeId, it.generation)
    }
    if (notificationDisabledCanonical != null) {
      if (!T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
          notificationDisabledCanonical,
          readinessStore.disabledAuthorityFence(),
          voiceRuntimeController.isIdle(),
        )) {
        updateRuntimeControlSurfacesLocked()
        return
      }
      val controllerCleared = voiceRuntimeController.isIdle() && runCatching {
        voiceRuntimeController.clearAuthority(
          "realtime-disabled-terminal-${UUID.randomUUID()}",
          voiceRuntimeController.snapshot().identity,
        )
      }.isSuccess
      if (!controllerCleared) {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
        )
        updateRuntimeControlSurfacesLocked()
        return
      }
      storeDriver.persist(
        "disabled-terminal-clear-authority",
        driverEpoch(),
        body = {
          voiceRuntimeAuthorityStore.clear()
        },
        continuation = { persisted ->
          if (persisted.isFailure) {
            T3VoiceDiagnostics.record(
              0,
              T3VoiceDiagnosticCategory.TERMINAL,
              T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
            )
            updateRuntimeControlSurfacesLocked()
            return@persist
          }
          check(
            readinessStore.clearDisabledAuthorityFence(
              T3VoiceDisabledAuthorityFence(
                notificationDisabledCanonical.runtimeId,
                notificationDisabledCanonical.generation,
              ),
            ),
          ) { "Could not clear the disabled Realtime authority fence." }
          voiceRuntimeRealtimeEngineSlot.clear()
          updateRuntimeControlSurfacesLocked()
        },
      )
      return
    }
    if (canonical?.target is VoiceRuntimeTarget.Realtime) {
      val canonicalAuthority = runCatching { realtimeAuthorityLocked(canonical) }.getOrNull()
      if (canonicalAuthority != null) {
        val installed = voiceRuntimeRealtimeEngineSlot.snapshot().current
        if (installed?.authority != canonicalAuthority) {
          val candidate = createRealtimeEngineLocked(canonicalAuthority)
          // The recovered engine may belong to the previous process instance. It is terminal,
          // so clear its fenced slot before installing the current canonical instance.
          voiceRuntimeRealtimeEngineSlot.clear()
          val installation = voiceRuntimeRealtimeEngineSlot.stageIdleInstall(
            canonicalAuthority,
            candidate,
          )
          voiceRuntimeRealtimeEngineSlot.commit(installation)
          voiceRuntimeRealtimeEngineSlot.complete(installation)
        }
      } else {
        voiceRuntimeRealtimeEngineSlot.clear()
      }
    } else {
      voiceRuntimeRealtimeEngineSlot.clear()
      if (canonical == null && voiceRuntimeController.isIdle()) {
        val identity = voiceRuntimeController.snapshot().identity
        val cleared = runCatching {
          voiceRuntimeController.clearAuthority(
            "realtime-terminal-clear-${UUID.randomUUID()}",
            identity,
          )
        }.isSuccess
        if (!cleared) enterCanonicalRecoveryRequiredLocked("realtime-terminal-controller-clear")
      }
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun clearIdleRealtimeEngineLocked() {
    val binding = voiceRuntimeRealtimeEngineSlot.snapshot().current ?: return
    if (binding.state.isOperational()) return
    voiceRuntimeRealtimeEngineSlot.clear()
  }

  private fun enterCanonicalRecoveryRequiredLocked(reason: String) {
    pendingRuntimeHandoffActivation?.let {
      completeRuntimeHandoffActivationLocked(it, false)
    }
    cancelVoiceRuntimeThreadRearmLocked()
    runtimeThreadAttempt?.let { attempt ->
      attempt.cancelAllCalls()
      attempt.stopped = true
      retireThreadTurnEpoch(attempt.clientOperationId)
    }
    runtimeThreadAttempt = null
    val persisted = persistedAuthority()
    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
      readinessConfig,
      voiceRuntimeController.snapshot().identity.generation,
    )
    runCatching {
      readinessStore.writeDisabledForRuntimeRevocation(
        disabled,
        persisted?.let { T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin) },
      )
    }
    readinessConfig = disabled
    canonicalPreparedAuthority = null
    storeDriver.persist("recovery-clear-authority", driverEpoch(), body = {
      voiceRuntimeAuthorityStore.clear()
    })
    storeDriver.persist("recovery-clear-session-credential", driverEpoch(), body = {
      voiceRuntimeSessionCredentialStore.clear()
    })
    controllerCommands.invalidateReadiness()
    clearIdleRealtimeEngineLocked()
    if (runtimeSnapshot.phase != VoiceRuntimePhase.IDLE) {
      runCatching { applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop) }
    }
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
    )
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
      operation = "voice-runtime-authority",
      code = "voice-runtime-recovery-required",
      message = "Voice runtime authorization requires recovery ($reason).",
      recoverable = true,
    ))
    updateRuntimeControlSurfacesLocked()
  }

  private fun scheduleVoiceRuntimeRealtimeTasksLocked(
    engine: VoiceRuntimeRealtimeReducer,
    checkpoint: VoiceRuntimeRealtimeCheckpoint,
  ) {
    mailbox.assertKernelThread()
    if (checkpoint.serverSessionId == null || checkpoint.phase in setOf(
        VoiceRealtimePhase.STOPPING,
        VoiceRealtimePhase.COMPLETED,
        VoiceRealtimePhase.FAILED,
        VoiceRealtimePhase.CANCELLED,
      )) return
    if (
      checkpoint.phase in setOf(VoiceRealtimePhase.CONNECTED, VoiceRealtimePhase.RETRYING) &&
        voiceRuntimeRealtimeHeartbeatTask == null
    ) {
      val interval = requireNotNull(checkpoint.heartbeatIntervalSeconds).times(1_000L)
      lateinit var scheduleNext: () -> Unit
      scheduleNext = {
        voiceRuntimeRealtimeHeartbeatTask = scheduleTick(
          "realtime-heartbeat:${checkpoint.fence.modeSessionId}",
          interval,
        ) {
          runCatching {
            applyRealtimeReduction(engine, engine.heartbeat(realtimeState(engine), checkpoint.fence))
          }
          if (realtimeState(engine).checkpoint != null) scheduleNext()
          else voiceRuntimeRealtimeHeartbeatTask = null
        }
      }
      scheduleNext()
    }
    if (
      checkpoint.phase == VoiceRealtimePhase.CONNECTED &&
        voiceRuntimeRealtimeActionTask == null
    ) {
      lateinit var scheduleNext: (Long) -> Unit
      scheduleNext = { delayMillis ->
        voiceRuntimeRealtimeActionTask = scheduleTick(
          "realtime-actions:${checkpoint.fence.modeSessionId}",
          delayMillis,
        ) action@{
          val admission = voiceRuntimeController.presentationCapacity()
          if (admission in setOf(
              VoiceRuntimeRetentionAdmission.FULL,
              VoiceRuntimeRetentionAdmission.UNAVAILABLE,
          )) {
            scheduleNext(500L)
            return@action
          }
          runCatching {
            applyRealtimeReduction(engine, engine.pollActions(realtimeState(engine), checkpoint.fence))
          }
          if (realtimeState(engine).checkpoint != null) scheduleNext(100L)
          else voiceRuntimeRealtimeActionTask = null
        }
      }
      scheduleNext(0L)
    }
    val deadline = checkpoint.drainDeadlineAtEpochMillis
    if (deadline != null && voiceRuntimeRealtimeDrainTask == null) {
      voiceRuntimeRealtimeDrainTask = scheduleTick(
        "realtime-drain:${checkpoint.fence.modeSessionId}",
        (deadline - System.currentTimeMillis()).coerceAtLeast(0),
      ) {
        voiceRuntimeRealtimeDrainTask = null
        runCatching { applyRealtimeReduction(engine, engine.onDrainDeadline(
          realtimeState(engine), checkpoint.fence, System.currentTimeMillis(),
        )) }
      }
    }
  }

  private fun cancelVoiceRuntimeRealtimeTasksLocked() {
    voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.let { checkpoint ->
      armEpoch(
        VoiceKernelEpochRootKind.REALTIME_MODE,
        checkpoint.fence.modeSessionId,
        checkpoint.fence.identity.generation,
      )
    }
    voiceRuntimeRealtimeHeartbeatTask?.cancel()
    voiceRuntimeRealtimeActionTask?.cancel()
    voiceRuntimeRealtimeDrainTask?.cancel()
    voiceRuntimeRealtimeHeartbeatTask = null
    voiceRuntimeRealtimeActionTask = null
    voiceRuntimeRealtimeDrainTask = null
  }

  private fun cancelVoiceRuntimeRealtimeFinalizationLocked() {
    voiceRuntimeRealtimeFinalizationTask?.cancel()
    voiceRuntimeRealtimeFinalizationTask = null
  }

  private fun requireRealtimeEngineLocked(identity: VoiceRuntimeIdentity): VoiceRuntimeRealtimeReducer {
    val engine = voiceRuntimeRealtimeEngine ?: throw VoiceRuntimeFenceException(
      "Realtime authority is unavailable.",
    )
    if (voiceRuntimeController.snapshot().identity != identity) {
      throw VoiceRuntimeFenceException("Realtime authority is stale.")
    }
    return engine
  }

  private fun realtimeCommandReceipt(
    command: VoiceRuntimeNativeCommand,
    result: VoiceRuntimeRealtimeCommandResult,
  ): VoiceRuntimeCommandReceipt {
    val cursor = voiceRuntimeController.snapshot().cursor()
    val replayed = when (result) {
      is VoiceRuntimeRealtimeCommandResult.Accepted -> result.replayed
      is VoiceRuntimeRealtimeCommandResult.Rejected -> result.replayed
    }
    val outcome = when (result) {
      is VoiceRuntimeRealtimeCommandResult.Accepted -> VoiceRuntimeCommandOutcome.Accepted
      is VoiceRuntimeRealtimeCommandResult.Rejected -> VoiceRuntimeCommandOutcome.Rejected(
        when (result.reason) {
          "authority-expired", "authority-unavailable" -> "authority-unavailable"
          "owner-conflict" -> "owner-conflict"
          "unsupported-capability" -> "unsupported-capability"
          else -> "invalid-phase"
        },
      )
    }
    return VoiceRuntimeCommandReceipt(
      command.commandId,
      command.modeSessionId,
      null,
      replayed,
      outcome,
      cursor,
    )
  }

  private fun realtimeBooleanReceipt(
    command: VoiceRuntimeNativeCommand,
    operation: () -> Boolean,
  ): VoiceRuntimeCommandReceipt = realtimeCommandReceipt(
    command,
    if (operation()) VoiceRuntimeRealtimeCommandResult.Accepted(false)
    else VoiceRuntimeRealtimeCommandResult.Rejected("invalid-phase"),
  )

  private fun recordVoiceRuntimeRealtimeControlFailure() {
    T3VoiceDiagnostics.record(
      generation = 0,
      category = T3VoiceDiagnosticCategory.KERNEL,
      code = T3VoiceDiagnosticCode.FAILED,
    )
  }

  private fun installedCanonicalAuthorityLocked(): VoiceRuntimeInstalledAuthority? {
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return null
    return VoiceRuntimeInstalledAuthority(
      persisted.runtimeId,
      persisted.generation,
      persisted.targetDigest,
    )
  }

  private fun clearIdleAttachedOnlyAuthorityLocked() {
    if (!::voiceRuntimeController.isInitialized) return
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return
    val disabledAuthorityFence = readinessStore.disabledAuthorityFence()
    val clearDisabledAtTerminal = T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      persisted,
      disabledAuthorityFence,
      voiceRuntimeController.isIdle(),
    )
    if (!clearDisabledAtTerminal &&
      !VoiceRuntimeAuthorityLifecyclePolicy.shouldClear(
        persisted.readinessEnabled,
        voiceRuntimeController.consumerCount(),
        voiceRuntimeController.isIdle(),
      )) return
    val identity = voiceRuntimeController.snapshot().identity
    runCatching {
      voiceRuntimeController.clearAuthority("detach-${UUID.randomUUID()}", identity)
      readinessStore.writeDisabledForRuntimeRevocation(
        readinessConfig.copy(enabled = false),
        T3VoicePendingRuntimeRevocation(persisted.runtimeId, persisted.environmentOrigin),
      )
      voiceRuntimeAuthorityStore.clear()
      disabledAuthorityFence?.takeIf {
        it.runtimeId == persisted.runtimeId && it.generation == persisted.generation
      }?.let { check(readinessStore.clearDisabledAuthorityFence(it)) }
      clearIdleRealtimeEngineLocked()
    }
  }

  private fun restoreCanonicalAuthorityLocked(
    persisted: VoiceRuntimePersistedAuthority,
  ): Boolean {
    val snapshot = voiceRuntimeController.snapshot()
    val reservation = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity(
        persisted.runtimeId,
        snapshot.identity.runtimeInstanceId,
        persisted.generation,
      ),
      persisted.generation - 1,
      persisted.targetDigest,
    )
    try {
      when (val target = persisted.target) {
        is VoiceRuntimeTarget.Realtime -> voiceRuntimeController.configureRealtimeAuthority(
          reservation, target, reservation.toString(),
        )
        is VoiceRuntimeTarget.Thread -> voiceRuntimeController.configureAuthority(
          reservation, target, reservation.toString(),
        )
      }
      return true
    } catch (_: Throwable) {
      voiceRuntimeAuthorityStore.clear()
      return false
    }
  }

  private fun canonicalRealtimeAuthorityLocked(): VoiceRuntimePersistedAuthority? {
    val persisted = (voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return null
    if (persisted.target !is VoiceRuntimeTarget.Realtime ||
      !persisted.readinessEnabled ||
      !hasPermission(Manifest.permission.RECORD_AUDIO)) return null
    return persisted
  }

  private fun startCanonicalRealtimeLocked() {
    val persisted = canonicalRealtimeAuthorityLocked() ?: return
    if (voiceRuntimeRealtimeEngine == null) installRealtimeEngineLocked(persisted)
    val engine = voiceRuntimeRealtimeEngine ?: return
    val identity = voiceRuntimeController.snapshot().identity
    val modeSessionId = realtimeState(engine).checkpoint?.fence?.modeSessionId
      ?: "realtime-mode-${UUID.randomUUID()}"
    ensureRuntimeForeground(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
    )
    runCatching {
      applyRealtimeReduction(engine, engine.admitStart(
          realtimeState(engine),
          "notification-start-${UUID.randomUUID()}",
          VoiceRuntimeRealtimeFence(identity, modeSessionId),
          activationAdmission = true,
          nowEpochMillis = System.currentTimeMillis(),
        ))
    }
  }

  private fun executeControlCommandLocked(command: T3VoiceControlCommand) {
    mailbox.assertKernelThread()
    when (T3VoiceControlPolicy.pendingStartDecision(
        command,
        T3VoiceStateStore.state.value.phase,
        runtimeThreadAttempt != null,
      )) {
      T3VoicePendingControlDecision.IGNORE -> {
        updateRuntimeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.CANCEL -> {
        stopRuntimeThreadLocked(cancelServer = true)
        stopRuntimeForegroundLocked()
        updateRuntimeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.NOT_APPLICABLE -> Unit
    }
    val nativeRealtimeAvailable = canonicalRealtimeAuthorityLocked() != null
    val nativeThreadAvailable = nativeThreadAuthorityLocked() != null
    when (
      T3VoiceControlPolicy.decide(
        command,
        T3VoiceStateStore.state.value.phase,
        controllerCommands.isAttached(),
        nativeRealtimeAvailable = nativeRealtimeAvailable,
        nativeThreadAvailable = nativeThreadAvailable,
        readinessMode = readinessConfig.mode,
      )
    ) {
      T3VoiceControlDecision.START_NATIVE_REALTIME -> startCanonicalRealtimeLocked()
      T3VoiceControlDecision.START_NATIVE_THREAD -> startRuntimeThreadLocked()
      T3VoiceControlDecision.REQUEST_CONTROLLER_START ->
        controllerCommands.requestPrimary(
          readinessConfig.generation,
          readinessConfig.microphonePermissionGranted,
        )
      T3VoiceControlDecision.STOP_ACTIVE -> stopActiveOperationLocked()
      T3VoiceControlDecision.TOGGLE_REALTIME_MUTE -> {
        voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint?.let { checkpoint ->
          voiceRuntimeRealtimeEngine?.let { engine ->
            runCatching { applyRealtimeReduction(engine, engine.setMuted(
              realtimeState(engine), checkpoint.fence, !checkpoint.muted,
            )) }
          }
        }
      }
      T3VoiceControlDecision.IGNORE -> Unit
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun stopActiveOperationLocked() {
    mailbox.assertKernelThread()
    val state = T3VoiceStateStore.state.value
    stopRuntimeThreadLocked(cancelServer = true)
    val realtimeCheckpoint = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint
    if (realtimeCheckpoint != null) {
      voiceRuntimeRealtimeEngine?.let { engine ->
        runCatching {
          applyRealtimeReduction(engine, engine.stop(
            realtimeState(engine),
            "notification-stop-${UUID.randomUUID()}",
            realtimeCheckpoint.fence,
            VoiceRuntimeRealtimeStopPolicy.DRAIN,
            System.currentTimeMillis(),
          ))
        }
      }
    } else {
      state.activeRealtimeSessionId?.let {
        val stopped = runCatching { realtime.stop(it) }.getOrDefault(false)
        if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(it)
      }
    }
    stopTraditionalAudioLocked(state, "notification-stop")
    if (realtimeCheckpoint == null) reconcileForegroundAfterVoiceStopLocked()
  }

  private fun reconcileForegroundAfterVoiceStopLocked() {
    val cuePending = recordingEndedCue != null || realtimeEndedCue != null
    if (cuePending || T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE) {
      updateRuntimeControlSurfacesLocked()
    } else {
      stopRuntimeForeground()
    }
  }

  private fun stopTraditionalAudioLocked(
    state: T3VoiceRuntimeState,
    recordingReason: String,
    ownsRecording: (String) -> Boolean = { true },
    ownsPlayback: (String) -> Boolean = { true },
  ) {
    recordingOwner?.takeIf {
      it.id == state.activeRecordingId && ownsRecording(it.id)
    }?.let { owner ->
      val captureStarted = cancelPendingRecordingStartLocked(owner) == null
      if (captureStarted) runCatching { recorder.cancel(owner.id) }
      terminateRecordingLocked(
        owner,
        T3VoiceRuntimeEvent.RecordingTerminated(
          recordingId = owner.id,
          recording = null,
          outcome = "cancelled",
          reason = recordingReason,
        ),
        stopForeground = false,
      )
      if (captureStarted) beginRecordingEndedCueLocked(owner.id)
    }
    playbackOwner?.takeIf {
      it.id == state.activePlaybackId && ownsPlayback(it.id)
    }?.let { owner ->
      runCatching { player.cancel(owner.id) }
      terminatePlaybackLocked(
        owner,
        T3VoiceRuntimeEvent.PlaybackTerminated(owner.id, "cancelled"),
        stopForeground = false,
      )
    }
  }

  private fun stopRuntimeThreadAudioLocked(
    attempt: VoiceRuntimeThreadAttempt,
    recordingReason: String,
  ) {
    val operationId = attempt.operationId ?: return
    stopTraditionalAudioLocked(
      T3VoiceStateStore.state.value,
      recordingReason,
      ownsRecording = { it == operationId },
      ownsPlayback = { it.startsWith("thread-playback:$operationId:") },
    )
  }

  private fun requireRecordingOwner(
    recordingId: String,
    domain: T3VoiceOperationOwnerDomain,
  ): T3VoiceOperationOwner =
    checkNotNull(recordingOwner?.takeIf { it.id == recordingId && it.domain == domain }) {
      "Recording $recordingId is not owned by $domain."
    }

  private fun requirePlaybackOwner(
    playbackId: String,
    domain: T3VoiceOperationOwnerDomain,
  ): T3VoiceOperationOwner =
    checkNotNull(playbackOwner?.takeIf { it.id == playbackId && it.domain == domain }) {
      "Playback $playbackId is not owned by $domain."
    }

  private fun failNativeThreadRecordingLocked(owner: T3VoiceOperationOwner, code: String) {
    if (owner.domain != T3VoiceOperationOwnerDomain.THREAD_MODE) return
    runtimeThreadAttempt?.takeIf { it.operationId == owner.operationId }?.let { attempt ->
      failRuntimeThreadLocked(attempt, code)
    }
  }

  private fun startPlaybackLocked(
    playbackId: String,
    sampleRate: Int,
    channelCount: Int,
    domain: T3VoiceOperationOwnerDomain,
    operationId: String,
  ) {
    mailbox.assertKernelThread()
    val owner = checkNotNull(
      T3VoiceStateStore.claimPlayback(playbackId, domain, operationId),
    ) { "The voice runtime is already in use." }
    playbackOwner = owner
    try {
      ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      check(playbackAudioFocus.start()) { "Android denied playback audio focus." }
      val epoch = armEpoch(VoiceKernelEpochRootKind.PLAYBACK, playbackId)
      mediaDriver.armPlayback(playbackId, epoch)
      player.start(playbackId, sampleRate, channelCount)
      keepServiceStarted(ACTION_START_PLAYBACK, playbackId)
    } catch (cause: Throwable) {
      releasePlaybackLocked(owner)
      throw cause
    }
  }

  private fun releaseRecordingLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    mailbox.assertKernelThread()
    if (!T3VoiceStateStore.releaseRecording(owner)) return
    epochRegistry.current(owner.id)?.let(epochRegistry::retire)
    mediaDriver.disarmRecording(owner.id)
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminateRecordingLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
    stopForeground: Boolean = true,
  ) {
    mailbox.assertKernelThread()
    if (!T3VoiceStateStore.terminateRecording(owner, event)) return
    epochRegistry.current(owner.id)?.let(epochRegistry::retire)
    mediaDriver.disarmRecording(owner.id)
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun releasePlaybackLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    mailbox.assertKernelThread()
    if (!T3VoiceStateStore.releasePlayback(owner)) return
    epochRegistry.current(owner.id)?.let(epochRegistry::retire)
    mediaDriver.disarmPlayback(owner.id)
    playbackAudioFocus.stop()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminatePlaybackLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.PlaybackTerminated,
    stopForeground: Boolean = true,
  ) {
    mailbox.assertKernelThread()
    if (!T3VoiceStateStore.terminatePlayback(owner, event)) return
    epochRegistry.current(owner.id)?.let(epochRegistry::retire)
    mediaDriver.disarmPlayback(owner.id)
    playbackAudioFocus.stop()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun stopRuntimeForegroundLocked() {
    mailbox.assertKernelThread()
    check(T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      "Cannot release foreground ownership while voice is active."
    }
    stopRuntimeForeground()
  }

  private fun releaseWakeLockForRuntimeBackoffLocked() {
    if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    }
  }

  private fun stopRuntimeForeground() {
    val threadAttempt = runtimeThreadAttempt
    val hasThreadWork = threadAttempt?.let {
      it.hasActiveCall() || it.playingSegment != null ||
        T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE
    } == true
    if (!VoiceRuntimeWakeLockPolicy.shouldRetain(
        hasThreadWork = hasThreadWork,
        hasRealtimeMedia = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint != null,
        hasRealtimeCleanupInFlight = false,
      )) {
      releaseWakeLockLocked()
    }
    if (readinessConfig.isEffective()) {
      startRuntimeForeground(
        T3VoiceForegroundLifecyclePolicy.readinessServiceTypes(
          readinessConfig,
          controllerCommands.isAttached(),
        ),
      )
      return
    }
    hostDriver.removeForeground()
    T3VoiceStateStore.setForeground(false)
    foregroundServiceTypes = 0
    releaseMediaSessionLocked()
    hostDriver.stopSelfIfIdle()
  }

  private fun reconcileReadinessLocked() {
    mailbox.assertKernelThread()
    if (readinessConfig.isEffective()) {
      ensureMediaSessionLocked()
      val types =
        T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
          T3VoiceStateStore.state.value.phase,
          readinessConfig,
          controllerCommands.isAttached(),
        )
      if (!T3VoiceStateStore.state.value.isForeground || foregroundServiceTypes != types) {
        startRuntimeForeground(types)
      }
    } else if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      releaseMediaSessionLocked()
      if (T3VoiceStateStore.state.value.isForeground) stopRuntimeForeground()
      else hostDriver.stopSelfIfIdle()
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun disableReadinessLocked() {
    mailbox.assertKernelThread()
    storeDriver.persist("disable-clear-session-credential", driverEpoch(), body = {
      voiceRuntimeSessionCredentialStore.clear()
    })
    if (!T3VoiceDisablePolicy.shouldCreatePendingDisable(
        readinessConfig,
        readinessStore.pendingDisabled(),
      )) {
      val persisted = persistedAuthority()
      val disabledFence = readinessStore.disabledAuthorityFence()
      if (persisted != null && persisted.readinessEnabled &&
        disabledFence == T3VoiceDisabledAuthorityFence(
          persisted.runtimeId,
          persisted.generation,
        )) {
        runCatching {
          voiceRuntimeAuthorityStore.disableReadiness(
            persisted.runtimeId,
            persisted.generation,
          )
        }.getOrElse {
          enterCanonicalRecoveryRequiredLocked("notification-disable-authority-fence")
          return
        }
      }
      reconcileReadinessLocked()
      return
    }
    val canonical = voiceRuntimeController.snapshot()
    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
      readinessConfig,
      canonical.identity.generation,
    )
    val grantMetadata = persistedAuthority()
    val prepared = readinessStore.prepared()
    val preparedAttached = voiceRuntimeAuthorityStore.inspectPreparedAttachedAuthority()
    val activeAuthority = readinessStore.activeAuthority()
    val revocation =
      readinessStore.pendingRuntimeRevocation()
        ?: grantMetadata?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
        ?: prepared?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
        ?: preparedAttached?.let {
          T3VoicePendingRuntimeRevocation(it.fence.runtimeId, it.fence.environmentOrigin)
        }
        ?: canonicalPreparedAuthority?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
        ?: activeAuthority?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
    readinessConfig = disabled
    val disabledAuthorityFence = grantMetadata?.let {
      T3VoiceDisabledAuthorityFence(it.runtimeId, it.generation)
    }
    readinessStore.writeDisabledWithPending(disabled, revocation, disabledAuthorityFence)
    canonicalPreparedAuthority = null
    grantMetadata?.let { persisted ->
      runCatching {
        voiceRuntimeAuthorityStore.disableReadiness(
          persisted.runtimeId,
          persisted.generation,
        )
      }.getOrElse {
        enterCanonicalRecoveryRequiredLocked("notification-disable-authority-fence")
        return
      }
    }
    if (canonical.operation == VoiceRuntimeOperation.None) {
      if (canonical.target != null) {
        runCatching {
          voiceRuntimeController.clearAuthority(
            "notification-disable-${UUID.randomUUID()}",
            canonical.identity,
          )
        }.onFailure {
          enterCanonicalRecoveryRequiredLocked("notification-disable-controller-clear")
          return
        }
      }
      storeDriver.persist(
        "notification-disable-clear-authority",
        driverEpoch(),
        body = voiceRuntimeAuthorityStore::clear,
        continuation = { persisted ->
          if (persisted.isSuccess) {
            disabledAuthorityFence?.let {
              check(readinessStore.clearDisabledAuthorityFence(it)) {
                "Could not clear the idle disabled authority fence."
              }
            }
            clearIdleRealtimeEngineLocked()
          } else {
            enterCanonicalRecoveryRequiredLocked("notification-disable-authority-clear")
          }
        },
      )
    }
    controllerCommands.invalidateReadiness()
    T3VoiceStateStore.emit(
      T3VoiceRuntimeEvent.ReadinessDisabled(disabled.generation, "notification"),
    )
    reconcileReadinessLocked()
  }

  private fun keepReadinessServiceStarted() {
    hostDriver.keepStarted(ACTION_READINESS, "readiness")
  }

  private fun acquireWakeLockLocked() {
    hostDriver.setWakeLock(true)
  }

  private fun setWakeLockOnMainThread(on: Boolean) {
    if (!on) {
      wakeLock?.takeIf { it.isHeld }?.release()
      wakeLock = null
      return
    }
    if (wakeLock?.isHeld == true) return
    wakeLock =
      (getSystemService(Context.POWER_SERVICE) as PowerManager)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:t3-voice-active")
        .apply {
          setReferenceCounted(false)
          acquire()
        }
  }

  private fun releaseWakeLockLocked() {
    hostDriver.setWakeLock(false)
  }

  private fun ensureMediaSessionLocked() {
    mediaSessionRequested = true
    val state = T3VoiceStateStore.state.value
    val active = runtimeControlSurfaceActiveLocked(state)
    hostDriver.setMediaSession(
      VoiceHostMediaSessionModel(active, readinessConfig.isEffective() || active),
    )
  }

  private fun setMediaSessionOnMainThread(model: VoiceHostMediaSessionModel) {
    if (mediaSession == null) mediaSession = MediaSession(this, "T3VoiceRuntime").apply {
      setCallback(
        object : MediaSession.Callback() {
          override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
            val event =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
              } else {
                @Suppress("DEPRECATION")
                mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
              } ?: return false
            val command =
              T3VoiceControlPolicy.mediaButtonCommand(
                event.action,
                event.repeatCount,
                event.keyCode,
            )
            if (!T3VoiceControlPolicy.consumesMediaButton(event.keyCode)) return false
            if (command == null) return true
            mailbox.submit(VoiceKernelMessage.HostIntent(command.toVoiceKernelHostIntentAction())) {
              run {
                executeControlCommandLocked(command)
              }
            }
            return true
          }

          override fun onPlay() {
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_PRIMARY),
            ) {
              run {
                executeControlCommandLocked(T3VoiceControlCommand.PRIMARY)
              }
            }
          }

          override fun onPause() {
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
            ) {
              run {
                executeControlCommandLocked(T3VoiceControlCommand.STOP)
              }
            }
          }

          override fun onStop() {
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
            ) {
              run {
                executeControlCommandLocked(T3VoiceControlCommand.STOP)
              }
            }
          }
        },
      )
    }
    updateMediaSessionOnMainThread(model)
  }

  private fun updateMediaSessionOnMainThread(model: VoiceHostMediaSessionModel) {
    val session = mediaSession ?: return
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_STOP,
        )
        .setState(
          if (model.active) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          PlaybackState.PLAYBACK_POSITION_UNKNOWN,
          1f,
        )
        .build(),
    )
    session.isActive = model.enabled
  }

  private fun releaseMediaSessionLocked() {
    mediaSessionRequested = false
    hostDriver.releaseMediaSession()
  }

  private fun releaseMediaSessionOnMainThread() {
    mediaSession?.release()
    mediaSession = null
  }

  private fun updateRuntimeControlSurfacesLocked() {
    mailbox.assertKernelThread()
    val state = T3VoiceStateStore.state.value
    val active = runtimeControlSurfaceActiveLocked(state)
    if (!mediaSessionRequested) return
    hostDriver.setMediaSession(
      VoiceHostMediaSessionModel(active, readinessConfig.isEffective() || active),
    )
    val snapshot = captureNotificationSnapshotLocked(state, active)
    notificationSnapshot = snapshot
    if (state.isForeground) {
      hostDriver.notify(snapshot)
    }
  }

  private fun hasPermission(permission: String): Boolean =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    val channel =
      NotificationChannel(
        NOTIFICATION_CHANNEL_ID,
        "T3 voice",
        NotificationManager.IMPORTANCE_LOW,
      ).apply {
        description = "Active T3 voice sessions"
        setSound(null, null)
      }
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun captureNotificationSnapshotLocked(
    state: T3VoiceRuntimeState = T3VoiceStateStore.state.value,
    active: Boolean = runtimeControlSurfaceActiveLocked(state),
  ): T3VoiceNotificationSnapshot {
    val realtimeCheckpoint = voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint
    val starting =
      state.phase == T3VoiceRuntimePhase.ARMING ||
        (state.phase == T3VoiceRuntimePhase.REALTIME && !state.realtimeInputReady) ||
        realtimeCheckpoint?.phase in setOf(
          VoiceRealtimePhase.PREPARING,
          VoiceRealtimePhase.NEGOTIATING,
          VoiceRealtimePhase.CUEING,
        )
    val controllerAttached = controllerCommands.isAttached()
    val canStart =
      realtimeCheckpoint == null &&
        runtimeThreadAttempt == null &&
        (canonicalRealtimeAuthorityLocked() != null || nativeThreadAuthorityLocked() != null)
    return T3VoiceNotificationSnapshot(
      active = active,
      starting = starting,
      canStart = canStart,
      controllerAttached = controllerAttached,
      readinessEnabled = readinessConfig.enabled,
      readinessMode = readinessConfig.mode,
      realtimeActive = state.phase == T3VoiceRuntimePhase.REALTIME,
      realtimeMuted = state.realtimeMuted,
    )
  }

  @Suppress("DEPRECATION")
  private fun buildNotification(snapshot: T3VoiceNotificationSnapshot): Notification {
    val primaryIntent =
      PendingIntent.getService(
        this,
        PRIMARY_REQUEST_CODE,
        Intent(this, T3VoiceRuntimeService::class.java).apply { action = ACTION_PRIMARY },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val muteIntent =
      PendingIntent.getService(
        this,
        MUTE_REQUEST_CODE,
        Intent(this, T3VoiceRuntimeService::class.java).apply { action = ACTION_TOGGLE_MUTE },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val disableReadinessIntent =
      PendingIntent.getService(
        this,
        DISABLE_READINESS_REQUEST_CODE,
        Intent(this, T3VoiceRuntimeService::class.java).apply { action = ACTION_DISABLE_READINESS },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val stopIntent =
      Intent(this, T3VoiceRuntimeService::class.java).apply {
        action = ACTION_STOP
      }
    val stopPendingIntent =
      PendingIntent.getService(
        this,
        STOP_REQUEST_CODE,
        stopIntent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent =
      launchIntent?.let {
        PendingIntent.getActivity(
          this,
          CONTENT_REQUEST_CODE,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
      } else {
        Notification.Builder(this)
      }
    builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(
        when {
          snapshot.starting -> "T3 voice starting"
          snapshot.active -> "T3 voice active"
          else -> "T3 voice ready"
        },
      )
      .setContentText(
        when {
          snapshot.starting -> "Preparing audio. Use Stop to cancel."
          snapshot.active -> "Use the voice control to stop the active operation."
          snapshot.canStart -> "Voice controls are ready."
          snapshot.controllerAttached -> "Microphone permission is required."
          snapshot.readinessMode == T3VoiceReadinessMode.REALTIME ->
            "Open T3 to renew voice authorization."
          else -> "Open T3 to unlock voice controls."
        },
      )
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    if (snapshot.active) {
      builder.addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
      if (snapshot.realtimeActive) {
        builder.addAction(
          android.R.drawable.ic_btn_speak_now,
          if (snapshot.realtimeMuted) "Unmute" else "Mute",
          muteIntent,
        )
      }
    } else if (snapshot.canStart) {
      builder.addAction(android.R.drawable.ic_media_play, "Start", primaryIntent)
    }
    if (snapshot.readinessEnabled) {
      builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disable", disableReadinessIntent)
    }
    return builder.build()
  }

  private fun runtimeControlSurfaceActiveLocked(state: T3VoiceRuntimeState): Boolean {
    val threadAttempt = runtimeThreadAttempt
    return voiceRuntimeRealtimeEngine?.let(::realtimeState)?.checkpoint != null || VoiceRuntimeControlSurfacePolicy.isActive(
      phase = state.phase,
      realtimeAttemptActive = false,
      threadAttemptActive = threadAttempt != null,
      threadCancellationOnly = threadAttempt?.cancelRequested == true,
    )
  }

  companion object {
    private const val NOTIFICATION_CHANNEL_ID = "t3_voice_runtime"
    private const val NOTIFICATION_ID = 3107
    private const val STOP_REQUEST_CODE = 3108
    private const val CONTENT_REQUEST_CODE = 3109
    private const val PRIMARY_REQUEST_CODE = 3110
    private const val MUTE_REQUEST_CODE = 3111
    private const val DISABLE_READINESS_REQUEST_CODE = 3112
    private const val ACTION_PRIMARY = "expo.modules.t3voice.action.PRIMARY"
    private const val ACTION_STOP = "expo.modules.t3voice.action.STOP"
    private const val ACTION_TOGGLE_MUTE = "expo.modules.t3voice.action.TOGGLE_MUTE"
    private const val ACTION_READINESS = "expo.modules.t3voice.action.READINESS"
    private const val ACTION_DISABLE_READINESS = "expo.modules.t3voice.action.DISABLE_READINESS"
    private const val ACTION_START_RECORDING = "expo.modules.t3voice.action.START_RECORDING"
    private const val ACTION_START_PLAYBACK = "expo.modules.t3voice.action.START_PLAYBACK"
    private const val ACTION_START_REALTIME = "expo.modules.t3voice.action.START_REALTIME"
    private const val EXTRA_OPERATION_ID = "operationId"
    private const val RUNTIME_HANDOFF_ACTIVATION_TIMEOUT_MILLIS = 60_000L
    fun requestStop(context: Context) {
      start(context, ACTION_STOP, null)
    }

    private fun start(context: Context, action: String, operationId: String?) {
      val intent =
        Intent(context, T3VoiceRuntimeService::class.java).apply {
          this.action = action
          if (operationId != null) putExtra(EXTRA_OPERATION_ID, operationId)
        }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}
