package expo.modules.t3voice

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
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.view.KeyEvent
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.UUID
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

internal class T3VoiceForegroundReleaseCoordinator(
  private val isIdle: () -> Boolean,
  private val releaseForeground: () -> Unit,
) {
  val lock = Any()

  fun releaseWhileLocked() {
    check(Thread.holdsLock(lock)) { "Foreground release must hold the operation lock." }
    check(isIdle()) { "Cannot release foreground ownership while voice is active." }
    releaseForeground()
  }
}

internal object T3VoiceRealtimeControlStartPolicy {
  fun startIfOwned(
    expectedSessionId: String,
    activeSessionId: String?,
    startControl: () -> Unit,
    keepServiceStarted: () -> Unit,
  ) {
    check(activeSessionId == expectedSessionId) {
      "The Realtime peer terminated during preparation."
    }
    startControl()
    keepServiceStarted()
  }
}

private data class T3VoicePendingRecordingStart(
  val owner: T3VoiceOperationOwner,
  val endpointConfig: T3VoiceEndpointDetectionConfig,
  val cueGeneration: Long,
  val onStarted: MutableList<() -> Unit>,
  val onFailure: MutableList<() -> Unit>,
)

internal class T3VoiceRecordingNotStartedException : IllegalStateException(
  "The recording stopped before microphone capture began.",
)

class T3VoiceRuntimeService : Service() {
  internal inner class VoiceBinder : Binder() {
    val state: StateFlow<T3VoiceRuntimeState>
      get() = T3VoiceStateStore.state

    val events: SharedFlow<T3VoiceRuntimeEvent>
      get() = T3VoiceStateStore.events

    val realtimeTermination: StateFlow<T3VoiceRuntimeEvent.RealtimeTerminated?>
      get() = T3VoiceStateStore.realtimeTermination

    val recordingTermination: StateFlow<T3VoiceRuntimeEvent.RecordingTerminated?>
      get() = T3VoiceStateStore.recordingTermination

    val playbackTermination: StateFlow<T3VoiceRuntimeEvent.PlaybackTerminated?>
      get() = T3VoiceStateStore.playbackTermination

    val threadVoiceHandoff: StateFlow<T3VoiceRuntimeEvent.ThreadVoiceHandoff?>
      get() = T3VoiceStateStore.threadVoiceHandoff

    val voiceCommands: StateFlow<T3VoicePendingCommand?>
      get() = controllerCommands.pending

    fun setReadinessSnapshot(config: T3VoiceReadinessConfig): T3VoiceReadinessConfig =
      synchronized(operationLock) {
        check(T3VoiceReadinessReconciliationPolicy.canApply(config, readinessStore.pendingDisabled())) {
          "A notification disable must be acknowledged before readiness can be enabled."
        }
        val verified = verifyReadiness(config)
        if (readinessConfig.samePayload(verified)) return@synchronized readinessConfig
        val next = verified.copy(generation = readinessConfig.generation + 1)
        fenceBackgroundThreadForReadinessLocked(next)
        fenceBackgroundRealtimeForReadinessLocked(next)
        readinessConfig = next
        readinessStore.write(next)
        controllerCommands.invalidateReadiness()
        reconcileReadinessLocked()
        if (next.isEffective()) keepReadinessServiceStarted()
        next
      }

    fun prepareBackgroundVoiceReadiness(
      desired: T3VoiceReadinessConfig,
      proposedRuntimeId: String,
      environmentOrigin: String,
      operation: T3VoiceRuntimeGrantOperation,
      targetIdentityDigest: String,
    ): T3VoicePreparedReadiness =
      synchronized(operationLock) {
        val verified = verifyReadiness(desired)
        requireOperationMatchesMode(verified, operation)
        check(T3VoiceBackgroundPreparationPolicy.canPrepare(
          T3VoiceStateStore.state.value.phase,
          backgroundRealtimeAttempt != null,
          backgroundThreadAttempt != null ||
            backgroundThreadOperationStore.load() !is T3VoiceBackgroundThreadOperationLoadResult.Missing ||
            (backgroundSnapshot.mode == T3VoiceBackgroundMode.THREAD &&
              backgroundSnapshot.phase != T3VoiceBackgroundPhase.IDLE),
          backgroundRealtimeCleanup != null || backgroundRealtimeCleanupLocked,
        )) { "Background voice readiness cannot be prepared while native voice is active." }
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        check(readinessStore.pendingRuntimeRevocation() === null) {
          "A runtime revocation must be acknowledged before readiness can be prepared."
        }
        check(readinessStore.activeAuthority() === null) {
          "The active background voice authority must be disabled before replacement."
        }
        check(grantStore.load() is T3VoiceRuntimeGrantLoadResult.Missing) {
          "The installed background voice grant must be revoked before replacement."
        }
        check(
          T3VoiceReadinessReconciliationPolicy.canApply(
            verified,
            readinessStore.pendingDisabled(),
          ),
        ) { "A notification disable must be acknowledged before readiness can be prepared." }
        val prepared =
          T3VoiceReadinessReservationPolicy.reserve(
            readinessConfig,
            readinessStore.prepared(),
            verified,
            proposedRuntimeId,
            environmentOrigin,
            operation,
            targetIdentityDigest,
          )
        if (
          readinessConfig.generation == prepared.config.generation &&
            readinessStore.prepared()?.let {
              it.runtimeId == prepared.runtimeId && it.config.sameReservationPayload(verified)
                && it.environmentOrigin == prepared.environmentOrigin
                && it.operation == prepared.operation
                && it.targetIdentityDigest == prepared.targetIdentityDigest
            } == true
        ) {
          return@synchronized prepared
        }
        readinessStore.writePrepared(prepared.copy(config = prepared.config.copy(enabled = true)))
        fenceBackgroundThreadForReadinessLocked(prepared.config)
        fenceBackgroundRealtimeForReadinessLocked(prepared.config)
        readinessConfig = prepared.config
        controllerCommands.invalidateReadiness()
        reconcileReadinessLocked()
        prepared
      }

    fun inspectBackgroundVoiceAuthority(
      desired: T3VoiceReadinessConfig,
      environmentOrigin: String,
      operation: T3VoiceRuntimeGrantOperation,
      targetIdentityDigest: String,
    ): T3VoiceBackgroundAuthoritySnapshot? =
      synchronized(operationLock) {
        val verified = verifyReadiness(desired)
        requireOperationMatchesMode(verified, operation)
        val normalizedOrigin = T3VoiceBackgroundOriginPolicy.normalize(environmentOrigin)
        readinessStore.prepared()?.let { prepared ->
          if (
            prepared.config.sameReservationPayload(verified) &&
              prepared.environmentOrigin == normalizedOrigin &&
              prepared.operation == operation &&
              prepared.targetIdentityDigest == targetIdentityDigest
          ) {
            return@synchronized T3VoiceBackgroundAuthoritySnapshot(
              T3VoiceBackgroundAuthorityState.PREPARED,
              prepared.runtimeId,
              prepared.config,
              prepared.environmentOrigin,
              prepared.operation,
              null,
              false,
            )
          }
        }
        if (!readinessConfig.enabled || !readinessConfig.sameReservationPayload(verified)) {
          return@synchronized null
        }
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        val metadata = grantStore.metadataIgnoringExpiry() ?: return@synchronized null
        val activeAuthority = readinessStore.activeAuthority() ?: return@synchronized null
        if (
          metadata.readinessGeneration != readinessConfig.generation ||
            activeAuthority.runtimeId != metadata.runtimeId ||
            activeAuthority.config.generation != metadata.readinessGeneration ||
            activeAuthority.environmentOrigin != normalizedOrigin ||
            activeAuthority.operation != operation ||
            activeAuthority.targetIdentityDigest != targetIdentityDigest ||
            metadata.environmentOrigin != normalizedOrigin ||
            metadata.operation != operation ||
            metadata.targetIdentityDigest != targetIdentityDigest
        ) {
          return@synchronized null
        }
        T3VoiceBackgroundAuthoritySnapshot(
          T3VoiceBackgroundAuthorityState.ACTIVE,
          metadata.runtimeId,
          readinessConfig,
          metadata.environmentOrigin,
          metadata.operation,
          metadata.expiresAtEpochMillis,
          grantStore.isRefreshPending(metadata),
        )
      }

    fun activateBackgroundVoiceReadiness(
      desired: T3VoiceReadinessConfig,
      expectedGeneration: Long,
      grant: T3VoiceRuntimeGrant,
    ): T3VoiceReadinessConfig =
      synchronized(operationLock) {
        check(
          T3VoiceReadinessReconciliationPolicy.canApply(
            desired,
            readinessStore.pendingDisabled(),
          ),
        ) { "A notification disable must be acknowledged before readiness can be activated." }
        check(readinessStore.pendingRuntimeRevocation() === null) {
          "A runtime revocation must be acknowledged before readiness can be activated."
        }
        val activated =
          T3VoiceReadinessReservationPolicy.requireActivation(
            readinessConfig,
            readinessStore.prepared(),
            verifyReadiness(desired),
            expectedGeneration,
          )
        require(grant.metadata.readinessGeneration == expectedGeneration) {
          "Runtime grant generation does not match voice readiness."
        }
        require(readinessStore.prepared()?.runtimeId == grant.metadata.runtimeId) {
          "Runtime grant identity does not match voice readiness."
        }
        val prepared = requireNotNull(readinessStore.prepared())
        require(
          prepared.environmentOrigin ==
            T3VoiceBackgroundOriginPolicy.normalize(grant.metadata.environmentOrigin) &&
            prepared.operation == grant.metadata.operation &&
            prepared.targetIdentityDigest == grant.metadata.targetIdentityDigest
        ) { "Runtime grant authority does not match voice readiness." }
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        grantStore.provision(grant)
        try {
          readinessStore.writeActivated(activated, prepared)
        } catch (cause: Throwable) {
          runCatching { grantStore.clear(deleteKey = true) }
          throw cause
        }
        readinessConfig = activated
        controllerCommands.invalidateReadiness()
        reconcileReadinessLocked()
        if (activated.isEffective()) keepReadinessServiceStarted()
        activated
      }

    fun disableBackgroundVoiceReadiness(): T3VoiceDisabledReadiness =
      synchronized(operationLock) {
        disableBackgroundVoiceReadinessLocked()
      }

    fun disableBackgroundVoiceReadinessIfIdle(
      expectedRuntimeId: String?,
      expectedGeneration: Long?,
    ): T3VoiceDisabledReadiness? = synchronized(operationLock) {
      val metadata = T3VoiceRuntimeGrantStore(applicationContext).storedMetadata()
      val identities = listOfNotNull(
        metadata?.let { it.runtimeId to it.readinessGeneration },
        readinessStore.prepared()?.let { it.runtimeId to it.config.generation },
        readinessStore.activeAuthority()?.let { it.runtimeId to it.config.generation },
      ).distinct()
      val durableThreadOwnership =
        backgroundThreadOperationStore.load() !is T3VoiceBackgroundThreadOperationLoadResult.Missing ||
          (backgroundSnapshot.mode == T3VoiceBackgroundMode.THREAD &&
            backgroundSnapshot.phase != T3VoiceBackgroundPhase.IDLE)
      if (!T3VoiceConditionalDisablePolicy.canDisable(
          expectedRuntimeId,
          expectedGeneration,
          readinessConfig.generation,
          identities,
          backgroundRealtimeAttempt != null || backgroundThreadAttempt != null ||
            durableThreadOwnership ||
            backgroundRealtimeCleanup != null || backgroundRealtimeCleanupLocked ||
            T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE,
        )) return@synchronized null
      disableBackgroundVoiceReadinessLocked()
    }

    private fun disableBackgroundVoiceReadinessLocked(): T3VoiceDisabledReadiness {
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        val prepared = readinessStore.prepared()
        val activeAuthority = readinessStore.activeAuthority()
        val metadata = grantStore.storedMetadata()
        val priorPending = readinessStore.pendingRuntimeRevocation()
        val revocation =
          priorPending
            ?: metadata?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
            ?: prepared?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
            ?: activeAuthority?.let {
              T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
            }
        val next =
          if (!readinessConfig.enabled && readinessStore.prepared() === null) {
            readinessConfig
          } else {
            readinessConfig.copy(enabled = false, generation = readinessConfig.generation + 1)
          }
        readinessStore.writeDisabledForRuntimeRevocation(next, revocation)
        readinessConfig = next
        controllerCommands.invalidateReadiness()
        stopActiveOperationLocked()
        grantStore.clear(deleteKey = true)
        return T3VoiceDisabledReadiness(next, revocation?.runtimeId)
    }

    fun pendingRuntimeRevocation(): T3VoicePendingRuntimeRevocation? =
      readinessStore.pendingRuntimeRevocation()

    fun backgroundVoiceOwnership(): Map<String, Any?>? = synchronized(operationLock) {
      val state = T3VoiceStateStore.state.value
      val authority = readinessStore.activeAuthority()
      val activeRealtimeOrigin = handoffEnvironmentOrigin?.takeIf {
        state.activeRealtimeSessionId != null
      }
      if (activeRealtimeOrigin == null &&
        (authority == null || !readinessConfig.enabled ||
          authority.config.generation != readinessConfig.generation)) return@synchronized null
      mapOf(
        "sequence" to state.sequence.toDouble(),
        "active" to nativeControlSurfaceActiveLocked(state),
        "phase" to state.phase.name.lowercase(),
        "runtimeId" to authority?.runtimeId,
        "readinessGeneration" to readinessConfig.generation.toDouble(),
        "environmentOrigin" to (activeRealtimeOrigin ?: authority?.environmentOrigin),
        "mode" to if (activeRealtimeOrigin != null) "realtime" else readinessConfig.mode.name.lowercase(),
        "targetId" to readinessConfig.targetId,
        "nativeSessionId" to state.activeRealtimeSessionId,
      )
    }

    fun acknowledgeRuntimeRevocation(expected: T3VoicePendingRuntimeRevocation): Boolean =
      synchronized(operationLock) {
        val pendingMatches = readinessStore.pendingRuntimeRevocation() == expected
        val acknowledged = T3VoiceRevocationAcknowledgementCoordinator.run(
          pendingMatches = pendingMatches,
          clearDerivedState = clearDerived@{
            if (backgroundRealtimeCleanupLocked) {
              if (!runCatching { backgroundRealtimeCleanupStore.clear() }.isSuccess) {
                return@clearDerived false
              }
              backgroundRealtimeCleanupLocked = false
              backgroundRealtimeCleanupInFlight = false
              backgroundRealtimeCleanupFailures = 0
              backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
            }
            backgroundRealtimeCleanup?.let { marker ->
              val markerMatches = marker.runtimeId == expected.runtimeId &&
                T3VoiceBackgroundOriginPolicy.normalize(marker.environmentOrigin) ==
                T3VoiceBackgroundOriginPolicy.normalize(expected.environmentOrigin)
              if (!markerMatches || !backgroundRealtimeCleanupStore.clear(marker)) {
                return@clearDerived false
              }
              backgroundRealtimeCleanup = null
              backgroundRealtimeCleanupInFlight = false
              backgroundRealtimeCleanupFailures = 0
              backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
              if (backgroundSnapshot.operationId == marker.operationId) {
                applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
              }
            }
            when (val loaded = backgroundThreadOperationStore.load()) {
              is T3VoiceBackgroundThreadOperationLoadResult.Available -> {
                val threadOperation = loaded.state
                if (!T3VoiceBackgroundThreadRevocationPolicy.matches(threadOperation, expected)) {
                  return@clearDerived false
                }
                val activeAttempt = backgroundThreadAttempt?.takeIf {
                  it.clientOperationId == threadOperation.claim.clientOperationId
                }
                activeAttempt?.let {
                  it.cancelAllCalls()
                  it.stopped = true
                }
                val cleared = T3VoiceBackgroundThreadLocalCleanupCoordinator.complete(
                  deleteRecording = {
                    (threadOperation as? T3VoiceBackgroundThreadOperationState.Active)?.recording?.let {
                      runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
                    } ?: true
                  },
                  clearDurableState = {
                    runCatching {
                      backgroundThreadOperationStore.clear(threadOperation.claim.clientOperationId)
                    }.getOrDefault(false)
                  },
                )
                if (!cleared) {
                  return@clearDerived false
                }
                if (activeAttempt != null) backgroundThreadAttempt = null
                if (backgroundSnapshot.mode == T3VoiceBackgroundMode.THREAD) {
                  applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
                }
              }
              T3VoiceBackgroundThreadOperationLoadResult.Locked ->
                if (!backgroundThreadOperationStore.clearLockedAfterAuthorityRevocation()) {
                  return@clearDerived false
                }
              T3VoiceBackgroundThreadOperationLoadResult.Missing -> Unit
            }
            true
          },
          clearPendingFence = { readinessStore.acknowledgeRuntimeRevocation(expected) },
        )
        if (!acknowledged) return@synchronized false
        if (
          !readinessConfig.isEffective() &&
            T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE
        ) {
          stopRuntimeForegroundLocked()
        }
        true
      }

    fun beginBackgroundVoiceGrantRefresh(
      expected: T3VoiceRuntimeGrantMetadata,
    ): T3VoiceBackgroundAuthoritySnapshot =
      synchronized(operationLock) {
        check(readinessConfig.enabled) { "Background voice readiness is not active." }
        requireOperationMatchesMode(readinessConfig, expected.operation)
        require(expected.readinessGeneration == readinessConfig.generation) {
          "Background voice grant refresh generation is stale."
        }
        requireActiveAuthority(expected)
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        val metadata = grantStore.beginRefresh(expected)
        activeAuthoritySnapshot(metadata, refreshPending = true)
      }

    fun installBackgroundVoiceRuntimeGrant(
      grant: T3VoiceRuntimeGrant,
    ): T3VoiceBackgroundAuthoritySnapshot =
      synchronized(operationLock) {
        check(readinessConfig.enabled) { "Background voice readiness is not active." }
        requireOperationMatchesMode(readinessConfig, grant.metadata.operation)
        require(grant.metadata.readinessGeneration == readinessConfig.generation) {
          "Background voice grant rotation generation is stale."
        }
        requireActiveAuthority(grant.metadata)
        val grantStore = T3VoiceRuntimeGrantStore(applicationContext)
        check(grantStore.isRefreshPending(grant.metadata)) {
          "Background voice grant refresh has not been started for this authority."
        }
        grantStore.provision(grant)
        activeAuthoritySnapshot(grant.metadata, refreshPending = false)
      }

    private fun activeAuthoritySnapshot(
      metadata: T3VoiceRuntimeGrantMetadata,
      refreshPending: Boolean,
    ): T3VoiceBackgroundAuthoritySnapshot =
      T3VoiceBackgroundAuthoritySnapshot(
        T3VoiceBackgroundAuthorityState.ACTIVE,
        metadata.runtimeId,
        readinessConfig,
        T3VoiceBackgroundOriginPolicy.normalize(metadata.environmentOrigin),
        metadata.operation,
        metadata.expiresAtEpochMillis,
        refreshPending,
      )

    private fun requireOperationMatchesMode(
      config: T3VoiceReadinessConfig,
      operation: T3VoiceRuntimeGrantOperation,
    ) {
      val expected =
        when (config.mode) {
          T3VoiceReadinessMode.REALTIME -> T3VoiceRuntimeGrantOperation.REALTIME_START
          T3VoiceReadinessMode.THREAD -> T3VoiceRuntimeGrantOperation.THREAD_TURN_START
        }
      require(operation == expected) { "Background voice operation does not match readiness mode." }
    }

    private fun requireActiveAuthority(metadata: T3VoiceRuntimeGrantMetadata) {
      val active = requireNotNull(readinessStore.activeAuthority()) {
        "Background voice authority metadata is unavailable."
      }
      require(
        active.runtimeId == metadata.runtimeId &&
          active.config.generation == metadata.readinessGeneration &&
          active.environmentOrigin ==
          T3VoiceBackgroundOriginPolicy.normalize(metadata.environmentOrigin) &&
          active.operation == metadata.operation &&
          active.targetIdentityDigest == metadata.targetIdentityDigest
      ) { "Background voice authority is stale." }
    }

    fun registerVoiceController(generation: Long) {
      synchronized(operationLock) {
        controllerCommands.register(generation)
        if (readinessConfig.isEffective() && T3VoiceStateStore.state.value.isForeground) {
          startRuntimeForeground(
            T3VoiceForegroundLifecyclePolicy.reconciledServiceTypes(
              T3VoiceStateStore.state.value.phase,
              readinessConfig,
              controllerAttached = true,
            ),
          )
        }
        updateNativeControlSurfacesLocked()
      }
    }

    fun unregisterVoiceController(generation: Long) {
      synchronized(operationLock) {
        controllerCommands.unregister(generation)
        reconcileReadinessLocked()
      }
    }

    fun pendingVoiceCommand(): Map<String, Any>? =
      controllerCommands.pending.value?.toEventBody()

    fun completeVoiceCommand(
      commandId: String,
      controllerGeneration: Long,
      outcome: String,
    ): Boolean = controllerCommands.complete(commandId, controllerGeneration, outcome)

    fun pendingReadinessDisabled(): Map<String, Any>? =
      readinessStore.pendingDisabled()?.toEventBody()

    fun acknowledgeReadinessDisabled(readinessGeneration: Long): Boolean =
      readinessStore.acknowledgePendingDisabled(readinessGeneration)

    fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      synchronized(operationLock) {
        val owner =
          checkNotNull(T3VoiceStateStore.claimRecording(recordingId)) {
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

    fun stopRecording(recordingId: String): Map<String, Any> =
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
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

    fun cancelRecording(recordingId: String) {
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
        if (cancelPendingRecordingStartLocked(owner) != null) {
          releaseRecordingLocked(owner)
          return@synchronized
        }
        try {
          recorder.cancel(recordingId)
        } finally {
          releaseRecordingLocked(owner, stopForeground = false)
          beginRecordingEndedCueLocked(recordingId)
        }
      }
    }

    fun deleteRecording(recordingId: String, uri: String) {
      recorder.delete(recordingId, uri)
      T3VoiceStateStore.clearRecordingTermination(recordingId)
    }

    fun acknowledgeRecordingTermination(recordingId: String) {
      T3VoiceStateStore.clearRecordingTermination(recordingId)
    }

    fun pendingRecordingTermination(): Map<String, Any?>? =
      T3VoiceStateStore.recordingTermination.value?.toEventBody()

    fun pendingThreadVoiceHandoff(): Map<String, Any>? =
      T3VoiceStateStore.pendingThreadVoiceHandoff()?.toEventBody()

    fun acknowledgeThreadVoiceHandoff(actionId: String) {
      T3VoiceStateStore.clearThreadVoiceHandoff(actionId)
    }

    fun armThreadVoiceHandoff(nativeSessionId: String) {
      synchronized(operationLock) {
        if (handoffEligibleSessionId != nativeSessionId) return
        awaitingHandoffAction = true
        nativeHandoffPoller.beginTerminalWindow()
      }
    }

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      synchronized(operationLock) {
        val owner =
          checkNotNull(T3VoiceStateStore.claimPlayback(playbackId)) {
            "The voice runtime is already in use."
          }
        playbackOwner = owner
        try {
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
          check(playbackAudioFocus.start()) { "Android denied playback audio focus." }
          player.start(playbackId, sampleRate, channelCount)
          keepServiceStarted(ACTION_START_PLAYBACK, playbackId)
        } catch (cause: Throwable) {
          releasePlaybackLocked(owner)
          throw cause
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
      synchronized(operationLock) {
        val owner = requirePlaybackOwner(playbackId)
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

    fun acknowledgePlaybackTermination(playbackId: String) {
      T3VoiceStateStore.clearPlaybackTermination(playbackId)
    }

    fun pendingPlaybackTermination(): Map<String, Any>? =
      T3VoiceStateStore.playbackTermination.value?.toEventBody()

    fun prepareRealtimeSession(
      nativeSessionId: String,
      environmentOrigin: String,
      audioRouteId: String,
      nativeControlGrant: T3VoiceNativeControlGrant,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      synchronized(operationLock) {
        check(T3VoiceStateStore.claimRealtime(nativeSessionId)) {
          "The voice runtime is already in use."
        }
        val diagnosticGeneration = T3VoiceDiagnostics.nextGeneration()
        T3VoiceDiagnostics.record(
          diagnosticGeneration,
          T3VoiceDiagnosticCategory.LIFECYCLE,
          T3VoiceDiagnosticCode.PREPARE_STARTED,
        )
        try {
          ensureRuntimeForeground(
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
          )
          realtime.prepare(nativeSessionId, diagnosticGeneration, audioRouteId, callback)
          T3VoiceRealtimeControlStartPolicy.startIfOwned(
            expectedSessionId = nativeSessionId,
            activeSessionId = T3VoiceStateStore.state.value.activeRealtimeSessionId,
            startControl = {
              awaitingHandoffAction = false
              nativeControlHeartbeat.start(environmentOrigin, nativeControlGrant)
              handoffEligibleSessionId = nativeSessionId
              handoffEligibleLeaseGeneration = nativeControlGrant.leaseGeneration
              handoffEnvironmentOrigin = environmentOrigin
              nativeHandoffPoller.start(environmentOrigin, nativeControlGrant)
            },
            keepServiceStarted = {
              keepServiceStarted(ACTION_START_REALTIME, nativeSessionId)
            },
          )
        } catch (cause: Throwable) {
          nativeControlHeartbeat.stop()
          nativeHandoffPoller.stop()
          handoffEligibleSessionId = null
          handoffEligibleLeaseGeneration = null
          handoffEnvironmentOrigin = null
          awaitingHandoffAction = false
          runCatching { realtime.stop(nativeSessionId) }
          T3VoiceStateStore.releaseRealtimeClaim(nativeSessionId)
          stopRuntimeForegroundLocked()
          T3VoiceDiagnostics.record(
            diagnosticGeneration,
            T3VoiceDiagnosticCategory.TERMINAL,
            T3VoiceDiagnosticCode.FAILED,
          )
          T3VoiceDiagnostics.record(
            diagnosticGeneration,
            T3VoiceDiagnosticCategory.LIFECYCLE,
            T3VoiceDiagnosticCode.FOREGROUND_RELEASED,
          )
          throw cause
        }
      }
    }

    fun applyRealtimeAnswer(
      nativeSessionId: String,
      sdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) {
      realtime.applyAnswer(nativeSessionId, sdp, callback)
    }

    fun stopRealtimeSession(nativeSessionId: String): Boolean =
      synchronized(operationLock) {
        cancelRealtimeReadyCueLocked(nativeSessionId)
        realtime.stop(nativeSessionId)
      }

    fun setRealtimeMuted(nativeSessionId: String, muted: Boolean) {
      realtime.setMuted(nativeSessionId, muted)
    }

    fun getAudioRoutes(): List<Map<String, Any>> = realtime.routes()

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()

    fun setVoiceCuesEnabled(enabled: Boolean): T3VoiceCueSettings =
      synchronized(operationLock) {
        val wasEnabled = cueSettings.enabled
        cueSettings = cueSettingsStore.write(enabled)
        if (wasEnabled && !enabled) disablePendingCuesLocked()
        cueSettings
      }

    fun setAudioRoute(nativeSessionId: String, routeId: String): List<Map<String, Any>> =
      realtime.selectRoute(nativeSessionId, routeId)
  }

  private val binder = VoiceBinder()
  private lateinit var readinessStore: T3VoiceReadinessStore
  private lateinit var cueSettingsStore: T3VoiceCueSettingsStore
  private lateinit var backgroundSnapshotStore: T3VoiceBackgroundSnapshotStore
  private lateinit var backgroundRealtimeCleanupStore: T3VoiceBackgroundRealtimeCleanupStore
  private lateinit var backgroundThreadOperationStore: T3VoiceBackgroundThreadOperationStore
  private var readinessConfig = T3VoiceReadinessConfig()
  private var cueSettings = T3VoiceCueSettings()
  private var backgroundSnapshot = T3VoiceBackgroundSnapshot()
  private var backgroundRestoreRequested = false
  private var backgroundRealtimeAttempt: T3VoiceBackgroundRealtimeAttempt? = null
  private var backgroundRealtimeCleanup: T3VoiceBackgroundRealtimeCleanupMarker? = null
  private var backgroundRealtimeCleanupLocked = false
  private var backgroundRealtimeCleanupInFlight = false
  private var backgroundRealtimeCleanupFailures = 0
  private var backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
  @Volatile private var serviceDestroyed = false
  private val backgroundRealtimeIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val backgroundThreadCancellationIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val backgroundRealtimeServer = T3VoiceBackgroundRealtimeDelegate()
  private val backgroundThreadServer = T3VoiceBackgroundThreadTurnDelegate()
  private var backgroundThreadAttempt: T3VoiceBackgroundThreadAttempt? = null
  private val controllerCommands = T3VoiceControllerCommands()
  private var mediaSession: MediaSession? = null
  private var foregroundServiceTypes = 0
  private var wakeLock: PowerManager.WakeLock? = null
  private val foregroundReleaseCoordinator =
    T3VoiceForegroundReleaseCoordinator(
      isIdle = { T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE },
      releaseForeground = ::stopRuntimeForeground,
    )
  private val operationLock = foregroundReleaseCoordinator.lock
  private var recordingOwner: T3VoiceOperationOwner? = null
  private var playbackOwner: T3VoiceOperationOwner? = null
  private var handoffInProgress = false
  private var handoffEligibleSessionId: String? = null
  private var handoffEligibleLeaseGeneration: Long? = null
  private var handoffEnvironmentOrigin: String? = null
  private var awaitingHandoffAction = false
  private lateinit var recorder: T3VoiceRecorder
  private lateinit var player: T3VoicePcmPlayer
  private lateinit var playbackAudioFocus: T3VoicePlaybackAudioFocus
  private lateinit var cueCoordinator: T3VoiceCueCoordinator
  private var nextCueGeneration = 0L
  private var realtimeReadyCue: Pair<String, Long>? = null
  private var realtimeEndedCue: Pair<String, Long>? = null
  private var pendingRecordingStart: T3VoicePendingRecordingStart? = null
  private var recordingEndedCue: Pair<String, Long>? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private val nativeControlHeartbeat =
    T3VoiceNativeControlHeartbeat { sessionId, termination ->
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId) {
            when (termination) {
              T3VoiceNativeControlTermination.SESSION_ENDED -> {
                awaitingHandoffAction = handoffEligibleSessionId == sessionId
                nativeHandoffPoller.beginTerminalWindow()
                realtime.stop(sessionId)
              }
              T3VoiceNativeControlTermination.CONTROL_REJECTED ->
                realtime.failNativeControl(sessionId, retryable = false)
              T3VoiceNativeControlTermination.TRANSIENT_FAILURE ->
                realtime.failNativeControl(sessionId, retryable = true)
            }
          }
        }
      }
    }
  private val nativeHandoffPoller =
    T3VoiceNativeHandoffPoller(
      execute = { action -> executeNativeHandoff(action) },
      onSettled = { sessionId ->
        mainHandler.post {
          if (serviceDestroyed) return@post
          synchronized(operationLock) {
            if (handoffEligibleSessionId == sessionId) {
              if (T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId) {
                runCatching { realtime.stop(sessionId) }
              }
              backgroundRealtimeAttempt?.takeIf {
                it.serverSession?.state?.sessionId == sessionId
              }?.let {
                abandonBackgroundRealtimeLocked(it, closeServer = true)
              }
              clearHandoffEligibilityLocked()
              if (
                T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE &&
                  T3VoiceStateStore.state.value.isForeground
              ) {
                stopRuntimeForegroundLocked()
              }
            }
          }
        }
      },
    )
  private val realtimeDelegate =
    lazy(LazyThreadSafetyMode.SYNCHRONIZED) {
      T3VoiceWebRtcSession(
        context = applicationContext,
        onStateChanged = stateChanged@{ sessionId, connectionState, muted, inputReady ->
          if (serviceDestroyed) return@stateChanged
          T3VoiceStateStore.setRealtime(
            sessionId = sessionId,
            connectionState = connectionState,
            muted = muted,
            inputReady = inputReady,
          )
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              if (connectionState == "connected" && !inputReady) {
                beginRealtimeReadyCueLocked(sessionId)
              }
              if (connectionState == "connected" && inputReady) {
                backgroundRealtimeAttempt?.takeIf {
                  it.serverSession?.state?.sessionId == sessionId &&
                    backgroundSnapshot.phase == T3VoiceBackgroundPhase.REALTIME_STARTING
                }?.operationId?.let { operationId ->
                  applyBackgroundEventLocked(T3VoiceBackgroundEvent.RealtimeConnected(operationId))
                }
              }
              updateNativeControlSurfacesLocked()
            }
          }
        },
        onRouteChanged = routeChanged@{ sessionId, change ->
          if (serviceDestroyed) return@routeChanged
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.AudioRouteChanged(
              nativeSessionId = sessionId,
              routeId = change.routeId,
              routeType = change.routeType,
              reason = change.reason.name.lowercase().replace('_', '-'),
            ),
          )
        },
        onError = realtimeError@{ sessionId, code, message, recoverable ->
          if (serviceDestroyed) return@realtimeError
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "realtime:$sessionId",
              code = code,
              message = message,
              recoverable = recoverable,
            ),
          )
        },
        onTerminated = terminated@{ sessionId, outcome, code, retryable, diagnosticGeneration ->
          if (serviceDestroyed) return@terminated
          synchronized(operationLock) {
            cancelRealtimeReadyCueLocked(sessionId)
            val terminated =
              T3VoiceStateStore.terminateRealtime(
                T3VoiceRuntimeEvent.RealtimeTerminated(
                  nativeSessionId = sessionId,
                  outcome = outcome,
                  code = code,
                  retryable = retryable,
                ),
              )
            if (terminated) {
              if (!awaitingHandoffAction) {
                backgroundRealtimeAttempt?.takeIf {
                  it.serverSession?.state?.sessionId == sessionId
                }?.let {
                  abandonBackgroundRealtimeLocked(it, closeServer = true)
                }
              }
              nativeControlHeartbeat.stop()
              if (!handoffInProgress && !awaitingHandoffAction) {
                if (outcome == "ended" && cueSettings.enabled) {
                  beginRealtimeEndedCueLocked(sessionId)
                } else {
                  stopRuntimeForegroundLocked()
                }
              }
              T3VoiceDiagnostics.record(
                diagnosticGeneration,
                T3VoiceDiagnosticCategory.LIFECYCLE,
                T3VoiceDiagnosticCode.FOREGROUND_RELEASED,
              )
            }
          }
        },
      )
    }
  private val realtime: T3VoiceWebRtcSession
    get() = realtimeDelegate.value

  private fun beginRealtimeReadyCueLocked(sessionId: String) {
    val state = T3VoiceStateStore.state.value
    if (
      state.activeRealtimeSessionId != sessionId ||
        state.realtimeConnectionState != "connected" ||
        state.realtimeInputReady
    ) return
    if (realtimeReadyCue?.first == sessionId) return
    val generation = ++nextCueGeneration
    realtimeReadyCue = sessionId to generation
    if (!cueSettings.enabled || !cueCoordinator.requestReady(generation) { completion ->
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) {
            completeRealtimeReadyCueLocked(sessionId, completion.generation)
          }
        }
      }) {
      completeRealtimeReadyCueLocked(sessionId, generation)
    }
  }

  private fun completeRealtimeReadyCueLocked(sessionId: String, generation: Long) {
    if (realtimeReadyCue != sessionId to generation) return
    realtimeReadyCue = null
    val state = T3VoiceStateStore.state.value
    if (
      state.activeRealtimeSessionId != sessionId ||
        state.realtimeConnectionState != "connected"
    ) return
    runCatching { realtime.setInputReady(sessionId, true) }
      .onFailure { realtime.failNativeControl(sessionId, retryable = true) }
  }

  private fun cancelRealtimeReadyCueLocked(sessionId: String) {
    val pending = realtimeReadyCue?.takeIf { it.first == sessionId } ?: return
    realtimeReadyCue = null
    cueCoordinator.stop(pending.second)
  }

  private fun beginRealtimeEndedCueLocked(sessionId: String) {
    val generation = ++nextCueGeneration
    realtimeEndedCue = sessionId to generation
    val started = cueCoordinator.requestEnded(generation) { completion ->
      mainHandler.post {
        if (!serviceDestroyed) synchronized(operationLock) {
          if (realtimeEndedCue == sessionId to completion.generation) {
            realtimeEndedCue = null
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          }
        }
      }
    }
    if (!started) {
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
    val generation = ++nextCueGeneration
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
      completeRecordingStartLocked(owner, generation)
      return
    }
    val started =
      cueCoordinator.requestReady(generation) { completion ->
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) {
            completeRecordingStartLocked(owner, completion.generation)
          }
        }
      }
    if (!started) completeRecordingStartLocked(owner, generation)
  }

  private fun completeRecordingStartLocked(owner: T3VoiceOperationOwner, cueGeneration: Long) {
    val pending = pendingRecordingStart
      ?.takeIf { it.owner == owner && it.cueGeneration == cueGeneration }
      ?: return
    pendingRecordingStart = null
    var captureStarted = false
    try {
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

  private fun disablePendingCuesLocked() {
    pendingRecordingStart?.let { pending ->
      cueCoordinator.stop(pending.cueGeneration)
    }
    realtimeReadyCue?.let { (_, generation) ->
      cueCoordinator.stop(generation)
    }
    val endingGenerations = listOfNotNull(recordingEndedCue?.second, realtimeEndedCue?.second)
    recordingEndedCue = null
    realtimeEndedCue = null
    endingGenerations.forEach(cueCoordinator::stop)
    if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    }
  }

  private fun beginRecordingEndedCueLocked(recordingId: String) {
    if (!cueSettings.enabled) {
      if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
        stopRuntimeForegroundLocked()
      }
      return
    }
    val generation = ++nextCueGeneration
    recordingEndedCue = recordingId to generation
    val started = cueCoordinator.requestEnded(generation) { completion ->
      mainHandler.post {
        if (!serviceDestroyed) synchronized(operationLock) {
          if (recordingEndedCue == recordingId to completion.generation) {
            recordingEndedCue = null
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          }
        }
      }
    }
    if (!started) {
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

  override fun onCreate() {
    super.onCreate()
    readinessStore = T3VoiceReadinessStore(applicationContext)
    cueSettingsStore = T3VoiceCueSettingsStore(applicationContext)
    backgroundSnapshotStore = T3VoiceBackgroundSnapshotStore(applicationContext)
    backgroundRealtimeCleanupStore = T3VoiceBackgroundRealtimeCleanupStore(applicationContext)
    backgroundThreadOperationStore = T3VoiceBackgroundThreadOperationStore(applicationContext)
    backgroundSnapshot = backgroundSnapshotStore.read()
    readinessConfig =
      readinessStore.read().copy(
        microphonePermissionGranted = hasPermission(Manifest.permission.RECORD_AUDIO),
        notificationPermissionGranted =
          Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPermission(Manifest.permission.POST_NOTIFICATIONS),
      )
    cueSettings = cueSettingsStore.read()
    cueCoordinator = T3VoiceCueCoordinator()
    when (val cleanup = backgroundRealtimeCleanupStore.load()) {
      is T3VoiceBackgroundRealtimeCleanupLoadResult.Available ->
        backgroundRealtimeCleanup = cleanup.marker
      T3VoiceBackgroundRealtimeCleanupLoadResult.Locked -> {
        backgroundRealtimeCleanupLocked = true
        T3VoiceDiagnostics.record(
          0, T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
        )
      }
      T3VoiceBackgroundRealtimeCleanupLoadResult.Missing -> Unit
    }
    val interruptedRealtimeOperation =
      backgroundSnapshot.operationId?.takeIf {
        backgroundSnapshot.mode == T3VoiceBackgroundMode.REALTIME &&
          backgroundSnapshot.phase in
          setOf(
            T3VoiceBackgroundPhase.REALTIME_STARTING,
            T3VoiceBackgroundPhase.REALTIME_ACTIVE,
          )
      }
    if (interruptedRealtimeOperation !== null) {
      backgroundRestoreRequested = true
      backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.RESTORE_INTERRUPTED_SESSION
      if (backgroundRealtimeCleanup === null && !backgroundRealtimeCleanupLocked) {
        interruptedBackgroundRealtimeCleanupMarker(interruptedRealtimeOperation)?.let { marker ->
          backgroundRealtimeCleanupStore.write(marker)
          backgroundRealtimeCleanup = marker
          backgroundRestoreRequested = false
        }
      }
    }
    recorder =
      T3VoiceRecorder(applicationContext, terminalLock = operationLock) { termination ->
        synchronized(operationLock) {
          val owner =
            recordingOwner?.takeIf {
              it.id ==
                when (termination) {
                  is T3VoiceRecordingTermination.Completed -> termination.recording.recordingId
                  is T3VoiceRecordingTermination.Cancelled -> termination.recordingId
                  is T3VoiceRecordingTermination.Failed -> termination.recordingId
                }
            } ?: return@T3VoiceRecorder
          when (termination) {
            is T3VoiceRecordingTermination.Completed -> {
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recording.recordingId,
                  recording = termination.recording,
                  outcome = "completed",
                  reason = termination.reason,
                ),
                stopForeground = false,
              )
              backgroundThreadAttempt?.takeIf { it.operationId == owner.id }?.let { attempt ->
                handleBackgroundThreadRecordingLocked(attempt, termination.recording)
              }
            }
            is T3VoiceRecordingTermination.Cancelled ->
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recordingId,
                  recording = null,
                  outcome = "cancelled",
                  reason = termination.reason,
                ),
                stopForeground = false,
              )
            is T3VoiceRecordingTermination.Failed -> {
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recordingId,
                  recording = null,
                  outcome = "failed",
                  reason = "finalization-failed",
                ),
                stopForeground = false,
              )
            }
          }
          beginRecordingEndedCueLocked(owner.id)
        }
      }
    val loadedThreadOperation = backgroundThreadOperationStore.load()
    if (!T3VoiceBackgroundThreadRecordingRecovery.restore(
        loadedThreadOperation,
        recorder::restoreCompleted,
      )) {
      val active = (loadedThreadOperation as? T3VoiceBackgroundThreadOperationLoadResult.Available)
        ?.state as? T3VoiceBackgroundThreadOperationState.Active
      if (active != null) {
        backgroundThreadOperationStore.writeActive(
          active.copy(recording = null, detached = true, cancelRequested = true),
        )
      }
    }
    T3VoiceStateStore.recordingTermination.value?.recording?.let(recorder::restoreCompleted)
    recorder.sweepStaleCache()
    player =
      T3VoicePcmPlayer(
        onChunkConsumed = { playbackId, chunkIndex ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.PlaybackChunkConsumed(playbackId, chunkIndex),
          )
        },
        onFinished = finished@{ playbackId ->
          if (serviceDestroyed) return@finished
          synchronized(operationLock) {
            playbackOwner?.takeIf { it.id == playbackId }?.let { owner ->
              terminatePlaybackLocked(
                owner,
                T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "completed"),
              )
              backgroundThreadAttempt?.takeIf {
                playbackId == backgroundThreadPlaybackId(it, it.playingSegment)
              }?.let { attempt ->
                val segment = requireNotNull(attempt.playingSegment)
                attempt.playingSegment = null
                attempt.playbackFailures = 0
                val persisted = applyBackgroundEventLocked(
                  T3VoiceBackgroundEvent.PlaybackDrained(requireNotNull(attempt.operationId), segment),
                )
                if (persisted != null && backgroundThreadAttempt === attempt) {
                  startNextBackgroundThreadSpeechLocked(attempt)
                }
              }
            }
          }
        },
        onError = failed@{ playbackId, cause ->
          if (serviceDestroyed) return@failed
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "playback:$playbackId",
              code = "pcm-playback-failed",
              message = cause.message ?: "PCM playback failed.",
              recoverable = true,
            ),
          )
          synchronized(operationLock) {
            handlePlaybackTerminationLocked(playbackId, "failed", retryBackgroundThread = true)
          }
        },
      )
    playbackAudioFocus =
      T3VoicePlaybackAudioFocus(
        this,
        onSuspend = {
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              playbackOwner?.let { owner -> runCatching { player.pause(owner.id) } }
            }
          }
        },
        onResume = {
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              playbackOwner?.let { owner -> runCatching { player.resume(owner.id) } }
            }
          }
        },
        onTerminate = {
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              playbackOwner?.let { owner ->
                runCatching { player.cancel(owner.id) }
                handlePlaybackTerminationLocked(
                  owner.id,
                  "cancelled",
                  retryBackgroundThread = true,
                )
              }
            }
          }
        },
      )
    createNotificationChannel()
    T3VoiceStateStore.setServiceReady()
    synchronized(operationLock) {
      if (reconcilePersistedThreadOperationLocked()) {
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) { startBackgroundThreadLocked() }
        }
      }
    }
  }

  private fun reconcilePersistedThreadOperationLocked(): Boolean {
    val loaded = backgroundThreadOperationStore.load()
    val now = System.currentTimeMillis()
    val grant = runCatching { T3VoiceRuntimeGrantStore(applicationContext).load() }.getOrNull()
    val preparedClaim = ((loaded as? T3VoiceBackgroundThreadOperationLoadResult.Available)?.state
      as? T3VoiceBackgroundThreadOperationState.Prepared)?.claim
    val parentGrantAvailable =
      preparedClaim != null &&
        T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
          grant ?: T3VoiceRuntimeGrantLoadResult.Missing,
          preparedClaim,
          now,
        ) != null
    when (T3VoiceBackgroundThreadStoredStatePolicy.decide(
      loaded,
      parentGrantAvailable,
      now,
    )) {
      T3VoiceBackgroundThreadStoredStateDecision.NONE -> return false
      T3VoiceBackgroundThreadStoredStateDecision.RESTORE -> return true
      T3VoiceBackgroundThreadStoredStateDecision.CANCEL_PREPARED -> {
        val prepared = (loaded as T3VoiceBackgroundThreadOperationLoadResult.Available)
          .state as T3VoiceBackgroundThreadOperationState.Prepared
        backgroundThreadOperationStore.writePrepared(
          prepared.claim,
          cancelRequested = true,
        )
        return true
      }
      T3VoiceBackgroundThreadStoredStateDecision.CANCEL_UNDISPATCHED -> {
        val active = (loaded as T3VoiceBackgroundThreadOperationLoadResult.Available)
          .state as T3VoiceBackgroundThreadOperationState.Active
        backgroundThreadOperationStore.writeActive(
          active.copy(detached = true, cancelRequested = true),
        )
        return true
      }
      T3VoiceBackgroundThreadStoredStateDecision.REVOKE -> Unit
    }
    revokePersistedThreadOperationLocked(loaded, grant)
    return false
  }

  private fun revokePersistedThreadOperationLocked(
    loaded: T3VoiceBackgroundThreadOperationLoadResult,
    grant: T3VoiceRuntimeGrantLoadResult?,
  ) {
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
    )
    val pending = readinessStore.pendingRuntimeRevocation() ?: when (loaded) {
      is T3VoiceBackgroundThreadOperationLoadResult.Available ->
        T3VoicePendingRuntimeRevocation(
          loaded.state.claim.runtimeId,
          loaded.state.claim.environmentOrigin,
        )
      T3VoiceBackgroundThreadOperationLoadResult.Locked ->
        readinessStore.activeAuthority()?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        } ?: (grant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant?.metadata?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
      T3VoiceBackgroundThreadOperationLoadResult.Missing -> null
    }
    if (pending != null) {
      val disabled = readinessConfig.copy(enabled = false, generation = readinessConfig.generation + 1)
      readinessStore.writeDisabledForRuntimeRevocation(disabled, pending)
      readinessConfig = disabled
      T3VoiceRuntimeGrantStore(applicationContext).clear(deleteKey = true)
      controllerCommands.invalidateReadiness()
    } else if (loaded == T3VoiceBackgroundThreadOperationLoadResult.Locked) {
      backgroundThreadOperationStore.clearLockedAfterAuthorityRevocation()
      backgroundSnapshotStore.clear()
      backgroundSnapshot = T3VoiceBackgroundSnapshot()
    }
  }

  override fun onBind(intent: Intent?): IBinder {
    synchronized(operationLock) {
      restoreBackgroundRealtimeCleanupIfNeededLocked()
      restoreBackgroundRealtimeIfNeededLocked()
    }
    return binder
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(operationLock) {
      val cleaning = restoreBackgroundRealtimeCleanupIfNeededLocked()
      val restored = restoreBackgroundRealtimeIfNeededLocked()
      when (intent?.action) {
        ACTION_PRIMARY ->
          if (!cleaning && !restored) executeControlCommandLocked(T3VoiceControlCommand.PRIMARY)
        ACTION_STOP -> executeControlCommandLocked(T3VoiceControlCommand.STOP)
        ACTION_TOGGLE_MUTE -> executeControlCommandLocked(T3VoiceControlCommand.TOGGLE_MUTE)
        ACTION_DISABLE_READINESS -> disableReadinessLocked()
        ACTION_READINESS -> reconcileReadinessLocked()
        ACTION_START_RECORDING ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activeRecordingId,
            foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            startId = startId,
          )
        ACTION_START_PLAYBACK ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activePlaybackId,
            foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            startId = startId,
          )
        ACTION_START_REALTIME ->
          reconcileStartCommand(
            expectedOwnerId = intent.getStringExtra(EXTRA_OPERATION_ID),
            activeOwnerId = T3VoiceStateStore.state.value.activeRealtimeSessionId,
            foregroundServiceType =
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            startId = startId,
          )
        else ->
          if (readinessConfig.enabled) reconcileReadinessLocked() else stopSelf(startId)
      }
    }
    return if (T3VoiceForegroundLifecyclePolicy.shouldRemainStarted(readinessConfig)) {
      START_STICKY
    } else {
      START_NOT_STICKY
    }
  }

  override fun onDestroy() {
    synchronized(operationLock) {
      serviceDestroyed = true
      backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
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
      nativeControlHeartbeat.stop()
      nativeHandoffPoller.stop()
      stopBackgroundThreadLocked(cancelServer = true)
      abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
    }
    recorder.release()
    player.release()
    cueCoordinator.release()
    playbackAudioFocus.stop()
    if (realtimeDelegate.isInitialized()) realtime.release()
    nativeControlHeartbeat.destroy()
    nativeHandoffPoller.destroy()
    backgroundThreadAttempt?.cancelAllCalls()
    backgroundRealtimeIo.shutdownNow()
    backgroundThreadCancellationIo.shutdownNow()
    releaseWakeLockLocked()
    releaseMediaSessionLocked()
    T3VoiceStateStore.setInactive()
    super.onDestroy()
  }

  private fun startRuntimeForeground(foregroundServiceType: Int) {
    T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(foregroundServiceType)
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, foregroundServiceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    T3VoiceStateStore.setForeground(true)
    foregroundServiceTypes = foregroundServiceType
    updateNativeControlSurfacesLocked()
  }

  private fun keepServiceStarted(action: String, operationId: String) {
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
      T3VoiceStartCommandDecision.STOP_STALE_START -> stopSelf(startId)
    }
  }

  private fun ensureRuntimeForeground(foregroundServiceType: Int) {
    check(Thread.holdsLock(operationLock)) {
      "Foreground acquisition must hold the operation lock."
    }
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

  private fun nativeRealtimeAuthorityLocked(): T3VoiceBackgroundRealtimeAuthorization? {
    val activeAuthority = readinessStore.activeAuthority() ?: return null
    val loaded =
      runCatching {
        T3VoiceRuntimeGrantStore(applicationContext).load()
      }.getOrNull() ?: return null
    return T3VoiceBackgroundRealtimeAuthorityPolicy.validate(
      readinessConfig,
      loaded,
      activeAuthority.targetIdentityDigest,
      System.currentTimeMillis(),
    )
  }

  private fun nativeThreadAuthorityLocked(): T3VoiceBackgroundThreadAuthorization? {
    val activeAuthority = readinessStore.activeAuthority() ?: return null
    val loaded = runCatching { T3VoiceRuntimeGrantStore(applicationContext).load() }.getOrNull()
      ?: return null
    return T3VoiceBackgroundThreadAuthorityPolicy.validate(
      readinessConfig,
      loaded,
      activeAuthority.targetIdentityDigest,
      System.currentTimeMillis(),
    )
  }

  private fun startBackgroundThreadLocked() {
    check(Thread.holdsLock(operationLock))
    if (backgroundThreadAttempt != null || T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE) return
    val persisted = backgroundThreadOperationStore.load()
    val persistedActive = (persisted as? T3VoiceBackgroundThreadOperationLoadResult.Available)
      ?.state as? T3VoiceBackgroundThreadOperationState.Active
    if (persistedActive != null) {
      val authority =
        if (persistedActive.cancelRequested) {
          T3VoiceBackgroundThreadAuthorityPolicy.cancellationAuthority(persistedActive)
        } else {
          val restored = T3VoiceBackgroundThreadAuthorityPolicy.restore(
            readinessConfig,
            readinessStore.activeAuthority(),
            persistedActive,
            System.currentTimeMillis(),
          )
          if (restored == null) {
            val loadedGrant = runCatching {
              T3VoiceRuntimeGrantStore(applicationContext).load()
            }.getOrNull()
            revokePersistedThreadOperationLocked(persisted, loadedGrant)
            return
          }
          restored
        }
      val attempt = T3VoiceBackgroundThreadAttempt(authority, persistedActive.claim.clientOperationId)
      backgroundSnapshot = persistedActive.snapshot
      backgroundSnapshotStore.write(persistedActive.snapshot)
      attempt.operationId = persistedActive.operationId
      attempt.operationGrantToken = persistedActive.token
      attempt.acknowledgedCursor = persistedActive.acknowledgedCursor
      attempt.recording = persistedActive.recording
      attempt.detached = persistedActive.detached
      attempt.cancelRequested = persistedActive.cancelRequested
      backgroundThreadAttempt = attempt
      ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      if (attempt.cancelRequested) {
        cancelBackgroundThreadOperation(attempt)
      } else if (attempt.recording != null && !backgroundSnapshot.dispatchAcknowledged) {
        val recording = requireNotNull(attempt.recording)
        if (backgroundSnapshot.phase == T3VoiceBackgroundPhase.IDLE) {
          if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.AuthorityValidated(
            authority.runtimeId, authority.readinessGeneration, T3VoiceBackgroundMode.THREAD,
            authority.autoRearm,
          )) == null) return
          if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.StartRecording(
            persistedActive.operationId, recording.recordingId,
          )) == null) return
          if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.RecordingFinalized(
            persistedActive.operationId, recording.recordingId,
          )) == null) return
          if (applyBackgroundEventLocked(
              T3VoiceBackgroundEvent.UploadStarted(persistedActive.operationId),
            ) == null) return
        }
        uploadBackgroundThreadRecording(attempt, recording)
      } else if (backgroundSnapshot.eventCursor > attempt.acknowledgedCursor) {
        acknowledgeBackgroundThread(
          attempt,
          persistedActive.token,
          persistedActive.operationId,
          backgroundSnapshot.eventCursor,
        )
      } else if (backgroundSnapshot.dispatchAcknowledged || attempt.detached) {
        pollBackgroundThread(attempt)
      } else {
        if (backgroundSnapshot.phase != T3VoiceBackgroundPhase.IDLE) {
          applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
        }
        if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.AuthorityValidated(
          authority.runtimeId, authority.readinessGeneration, T3VoiceBackgroundMode.THREAD,
          authority.autoRearm,
        )) == null) return
        startBackgroundThreadRecordingLocked(attempt)
      }
      return
    }
    val prepared = (persisted as? T3VoiceBackgroundThreadOperationLoadResult.Available)
      ?.state as? T3VoiceBackgroundThreadOperationState.Prepared
    val loadedGrant = runCatching { T3VoiceRuntimeGrantStore(applicationContext).load() }
      .getOrNull()
    val authorization =
      if (prepared?.cancelRequested == true) {
        T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
          loadedGrant ?: T3VoiceRuntimeGrantLoadResult.Missing,
          prepared.claim,
          System.currentTimeMillis(),
        ) ?: run {
          revokePersistedThreadOperationLocked(persisted, loadedGrant)
          return
        }
      } else {
        nativeThreadAuthorityLocked() ?: return
      }
    val authority = authorization.authority
    val claim = when (persisted) {
      T3VoiceBackgroundThreadOperationLoadResult.Missing ->
        T3VoiceBackgroundThreadClaim(
          authority.runtimeId, authority.readinessGeneration, authority.environmentOrigin,
          authority.selectedProjectId, authority.selectedThreadId, "thread-${UUID.randomUUID()}",
        ).also(backgroundThreadOperationStore::writePrepared)
      is T3VoiceBackgroundThreadOperationLoadResult.Available -> {
        val candidate = persisted.state.claim
        if (candidate.runtimeId != authority.runtimeId ||
          candidate.readinessGeneration != authority.readinessGeneration ||
          candidate.environmentOrigin != authority.environmentOrigin ||
          candidate.projectId != authority.selectedProjectId ||
          candidate.threadId != authority.selectedThreadId) return
        candidate
      }
      T3VoiceBackgroundThreadOperationLoadResult.Locked -> return
    }
    val attempt = T3VoiceBackgroundThreadAttempt(authority, claim.clientOperationId)
    attempt.cancelRequested = prepared?.cancelRequested == true
    attempt.detached = attempt.cancelRequested
    backgroundThreadAttempt = attempt
    ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
    createBackgroundThreadOperation(attempt, authorization.runtimeGrantToken)
  }

  private fun createBackgroundThreadOperation(
    attempt: T3VoiceBackgroundThreadAttempt,
    runtimeGrantToken: String,
  ) {
    acquireWakeLockLocked()
    val call = backgroundThreadServer.newCreateCall(
      attempt.authority.environmentOrigin,
      runtimeGrantToken,
      T3VoiceBackgroundThreadTurnCreateInput(
        attempt.authority.runtimeId, attempt.authority.readinessGeneration, attempt.clientOperationId,
      ),
    )
    if (!attempt.beginCall(call, allowCancellationRecovery = attempt.cancelRequested)) {
      releaseWakeLockForBackgroundBackoffLocked()
      return
    }
    backgroundRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          handleBackgroundThreadCreatedLocked(attempt, runtimeGrantToken, result)
        }
      }
    }
  }

  private fun handleBackgroundThreadCreatedLocked(
    attempt: T3VoiceBackgroundThreadAttempt,
    runtimeGrantToken: String,
    result: T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnCreateResult>,
  ) {
    if (backgroundThreadAttempt !== attempt || attempt.stopped) return
    val created = (result as? T3VoiceBackgroundThreadTurnResult.Success)?.value
    if (created == null || !T3VoiceBackgroundThreadAuthorityPolicy.validateCreated(
        attempt.authority, attempt.clientOperationId, created, System.currentTimeMillis())) {
      val retryable = (result as? T3VoiceBackgroundThreadTurnResult.Failure)?.kind in setOf(
        T3VoiceBackgroundHttpFailureKind.RETRYABLE,
        T3VoiceBackgroundHttpFailureKind.CONFLICT,
        T3VoiceBackgroundHttpFailureKind.CANCELLED,
      )
      if (T3VoiceBackgroundThreadPreparedCancellationPolicy.shouldFenceCreateFailure(
          attempt.cancelRequested,
          attempt.operationId,
          retryable,
        )) {
        T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
          operation = "background-thread",
          code = "native-thread-cancel-recovery-rejected",
          message = "Background thread voice requires authorization reconciliation.",
          recoverable = true,
        ))
        fenceBackgroundThreadForReconciliationLocked(attempt)
      } else if (retryable) {
        attempt.retryFailures += 1
        releaseWakeLockForBackgroundBackoffLocked()
        mainHandler.postDelayed({
          if (!serviceDestroyed) synchronized(operationLock) {
            if (backgroundThreadAttempt === attempt && !attempt.stopped) {
              createBackgroundThreadOperation(attempt, runtimeGrantToken)
            }
          }
        }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
      } else failBackgroundThreadLocked(attempt, "native-thread-create-failed")
      return
    }
    attempt.retryFailures = 0
    attempt.operationId = created.snapshot.operationId
    attempt.operationGrantToken = created.operationGrant.token
    val operationSnapshot =
      if (backgroundSnapshot.mode == T3VoiceBackgroundMode.THREAD &&
        backgroundSnapshot.operationId == created.snapshot.operationId) backgroundSnapshot else
        T3VoiceBackgroundSnapshot(
          runtimeId = attempt.authority.runtimeId,
          readinessGeneration = attempt.authority.readinessGeneration,
          mode = T3VoiceBackgroundMode.THREAD,
          phase = T3VoiceBackgroundPhase.IDLE,
          autoRearm = attempt.authority.autoRearm,
        )
    attempt.acknowledgedCursor = minOf(
      created.snapshot.acknowledgedSequence,
      operationSnapshot.eventCursor,
    )
    val active = T3VoiceBackgroundThreadOperationState.Active(
      T3VoiceBackgroundThreadClaim(
        attempt.authority.runtimeId, attempt.authority.readinessGeneration,
        attempt.authority.environmentOrigin, attempt.authority.selectedProjectId,
        attempt.authority.selectedThreadId, attempt.clientOperationId,
      ),
      created.snapshot.operationId,
      created.operationGrant.expiresAtEpochMillis,
      created.operationGrant.token,
      attempt.acknowledgedCursor,
      attempt.recording,
      attempt.detached,
      attempt.cancelRequested,
      operationSnapshot,
    )
    backgroundThreadOperationStore.writeActive(active)
    if (attempt.cancelRequested) {
      cancelBackgroundThreadOperation(attempt)
      return
    }
    if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.AuthorityValidated(
      attempt.authority.runtimeId, attempt.authority.readinessGeneration,
      T3VoiceBackgroundMode.THREAD, attempt.authority.autoRearm,
    )) == null) return
    if (created.snapshot.phase == "created" && !created.snapshot.dispatchAccepted) {
      val recording = attempt.recording
      if (recording == null) {
        startBackgroundThreadRecordingLocked(attempt)
      } else {
        if (backgroundSnapshot.phase != T3VoiceBackgroundPhase.IDLE) {
          applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
        }
        if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.StartRecording(
            created.snapshot.operationId,
            recording.recordingId,
          )) == null) return
        handleBackgroundThreadRecordingLocked(attempt, recording)
      }
    } else {
      if (backgroundSnapshot.operationId != created.snapshot.operationId ||
        backgroundSnapshot.phase == T3VoiceBackgroundPhase.IDLE) {
        if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.StartRecording(
            created.snapshot.operationId,
            created.snapshot.operationId,
          )) == null) return
      }
      pollBackgroundThread(attempt)
    }
  }

  private fun startBackgroundThreadRecordingLocked(attempt: T3VoiceBackgroundThreadAttempt) {
    val operationId = attempt.operationId ?: return
    if (applyBackgroundEventLocked(
        T3VoiceBackgroundEvent.StartRecording(operationId, operationId),
      ) == null) return
    val owner = T3VoiceStateStore.claimRecording(operationId) ?: run {
      failBackgroundThreadLocked(attempt, "native-thread-microphone-unavailable"); return
    }
    recordingOwner = owner
    try {
      scheduleRecordingStartLocked(
        owner,
        T3VoiceEndpointDetectionConfig(),
        onFailure = {
          if (backgroundThreadAttempt === attempt) {
            failBackgroundThreadLocked(attempt, "native-thread-microphone-unavailable")
          }
        },
      )
    } catch (_: Throwable) {
      releaseRecordingLocked(owner, stopForeground = false)
      failBackgroundThreadLocked(attempt, "native-thread-microphone-unavailable")
    }
  }

  private fun handleBackgroundThreadRecordingLocked(
    attempt: T3VoiceBackgroundThreadAttempt,
    recording: T3VoiceRecordingResult,
  ) {
    val operationId = attempt.operationId ?: return
    val persisted = backgroundThreadOperationStore.load()
      as? T3VoiceBackgroundThreadOperationLoadResult.Available
    val active = persisted?.state as? T3VoiceBackgroundThreadOperationState.Active
    if (active?.claim?.clientOperationId != attempt.clientOperationId) {
      failBackgroundThreadLocked(attempt, "native-thread-state-unavailable")
      return
    }
    attempt.recording = recording
    if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.RecordingFinalized(
        operationId,
        recording.recordingId,
      )) == null) return
    if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.UploadStarted(operationId)) == null) return
    uploadBackgroundThreadRecording(attempt, recording)
  }

  private fun uploadBackgroundThreadRecording(
    attempt: T3VoiceBackgroundThreadAttempt,
    recording: T3VoiceRecordingResult,
  ) {
    val operationId = attempt.operationId ?: return
    val body = T3VoiceBackgroundThreadRecordingBodyPolicy.create(recording) ?: run {
      failBackgroundThreadLocked(attempt, "native-thread-upload-failed")
      return
    }
    acquireWakeLockLocked()
    val call = backgroundThreadServer.newUploadAudioCall(
      attempt.authority.environmentOrigin,
      requireNotNull(attempt.operationGrantToken),
      operationId,
      body,
    )
    if (!attempt.beginCall(call)) {
      releaseWakeLockForBackgroundBackoffLocked()
      return
    }
    backgroundRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          if (backgroundThreadAttempt !== attempt || attempt.stopped) return@synchronized
          val uploaded = (result as? T3VoiceBackgroundThreadTurnResult.Success)?.value
          if (uploaded == null || !T3VoiceBackgroundThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, backgroundSnapshot.eventCursor, uploaded.snapshot)) {
            val retryable = (result as? T3VoiceBackgroundThreadTurnResult.Failure)?.kind in setOf(
              T3VoiceBackgroundHttpFailureKind.RETRYABLE,
              T3VoiceBackgroundHttpFailureKind.CONFLICT,
              T3VoiceBackgroundHttpFailureKind.CANCELLED,
            )
            if (retryable) {
              attempt.retryFailures += 1
              releaseWakeLockForBackgroundBackoffLocked()
              mainHandler.postDelayed({
                if (!serviceDestroyed) synchronized(operationLock) {
                  if (backgroundThreadAttempt === attempt && !attempt.stopped) {
                    uploadBackgroundThreadRecording(attempt, recording)
                  }
                }
              }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
            } else failBackgroundThreadLocked(attempt, "native-thread-upload-failed")
          } else {
            attempt.retryFailures = 0
            pollBackgroundThread(attempt)
          }
        }
      }
    }
  }

  private fun pollBackgroundThread(attempt: T3VoiceBackgroundThreadAttempt) {
    if (attempt.polling || attempt.acknowledging || attempt.stopped) return
    val operationId = attempt.operationId ?: return
    val token = attempt.operationGrantToken ?: return
    acquireWakeLockLocked()
    attempt.polling = true
    val after = backgroundSnapshot.eventCursor
    val playbackCursor = backgroundSnapshot.playbackCursor
    val highestAdvertisedSegment = backgroundSnapshot.highestAdvertisedSpeechSegment
    val recoveryWork = if (!attempt.detached) T3VoiceBackgroundThreadSpeechPolicy.next(
      playbackCursor, highestAdvertisedSegment,
      emptyList(),
    ) else null
    val initialCall: T3VoiceBackgroundThreadCall<*> =
      if (recoveryWork == null) {
        backgroundThreadServer.newEventsCall(
          attempt.authority.environmentOrigin, token, operationId, after, 30_000,
        )
      } else {
        backgroundThreadServer.newSpeechCall(
          attempt.authority.environmentOrigin, token, operationId, recoveryWork.segmentIndex,
        )
      }
    if (!attempt.beginCall(initialCall)) {
      attempt.polling = false
      releaseWakeLockForBackgroundBackoffLocked()
      return
    }
    backgroundRealtimeIo.submit {
      val result = if (recoveryWork == null) {
        @Suppress("UNCHECKED_CAST")
        (initialCall as T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnEventsResult>).execute()
      } else null
      if (recoveryWork == null && !attempt.finishCall(initialCall)) {
        mainHandler.post { synchronized(operationLock) { attempt.polling = false } }
        return@submit
      }
      val events = (result as? T3VoiceBackgroundThreadTurnResult.Success)?.value
      val eventWork = events?.let { T3VoiceBackgroundThreadSpeechPolicy.next(
        playbackCursor, highestAdvertisedSegment,
        it.events,
      ) }
      val work = recoveryWork ?: eventWork
      val requestedSegment = work?.segmentIndex
      val speech = requestedSegment?.takeIf { !attempt.detached }?.let { segment ->
        val speechCall = if (recoveryWork != null) initialCall else
          backgroundThreadServer.newSpeechCall(
            attempt.authority.environmentOrigin, token, operationId, segment,
          )
        if (recoveryWork == null && !attempt.beginCall(speechCall)) null else {
          @Suppress("UNCHECKED_CAST")
          val response =
            (speechCall as T3VoiceBackgroundThreadCall<ByteArray>).execute()
          if (attempt.finishCall(speechCall)) {
            (response as? T3VoiceBackgroundThreadTurnResult.Success)?.value
          } else {
            null
          }
        }
      }
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          attempt.polling = false
          if (backgroundThreadAttempt !== attempt || attempt.stopped) return@synchronized
          if (recoveryWork != null) {
            if (speech == null) scheduleBackgroundThreadPollRetryLocked(attempt)
            else {
              attempt.pendingSpeech[recoveryWork.segmentIndex] = speech
              startNextBackgroundThreadSpeechLocked(attempt)
            }
            return@synchronized
          }
          val eventsResult = (result as? T3VoiceBackgroundThreadTurnResult.Success)?.value
          if (eventsResult == null || !T3VoiceBackgroundThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, after, eventsResult.snapshot) ||
            !T3VoiceBackgroundThreadEventBatchPolicy.isContiguous(
              after, eventsResult.events, eventsResult.snapshot.lastSequence,
            )) {
            val retryable = (result as? T3VoiceBackgroundThreadTurnResult.Failure)?.kind in setOf(
              T3VoiceBackgroundHttpFailureKind.RETRYABLE,
              T3VoiceBackgroundHttpFailureKind.CONFLICT,
              T3VoiceBackgroundHttpFailureKind.CANCELLED,
            )
            if (retryable) scheduleBackgroundThreadPollRetryLocked(attempt)
            else failBackgroundThreadLocked(attempt, "native-thread-events-failed")
            return@synchronized
          }
          attempt.retryFailures = 0
          if (eventWork != null && !attempt.detached && speech == null) {
            scheduleBackgroundThreadPollRetryLocked(attempt)
            return@synchronized
          }
          val acceptedEvents = T3VoiceBackgroundThreadSpeechPolicy.acceptedPrefix(eventsResult.events, eventWork)
          val batch = runCatching {
            T3VoiceBackgroundThreadBatchReducer.reduce(
              backgroundSnapshot,
              acceptedEvents.map { event ->
                backgroundThreadServerEvent(attempt, eventsResult.snapshot, event)
              },
            )
          }.getOrElse {
            failBackgroundThreadLocked(attempt, "native-thread-event-invalid")
            return@synchronized
          }
          if (T3VoiceBackgroundCommand.FETCH_EVENT_GAP in batch.commands) {
            scheduleBackgroundThreadPollRetryLocked(attempt)
            return@synchronized
          }
          if (acceptedEvents.isNotEmpty() && !persistBackgroundSnapshotLocked(batch.snapshot)) {
            failBackgroundThreadLocked(attempt, "native-thread-state-unavailable")
            return@synchronized
          }
          if (eventWork != null && speech != null) attempt.pendingSpeech[eventWork.segmentIndex] = speech
          val cursor = backgroundSnapshot.eventCursor
          when (T3VoiceBackgroundThreadEventCommitPolicy.afterBatch(
              cursor,
              attempt.acknowledgedCursor,
            )) {
            T3VoiceBackgroundThreadEventCommitDecision.ACKNOWLEDGE ->
              acknowledgeBackgroundThread(attempt, token, operationId, cursor)
            T3VoiceBackgroundThreadEventCommitDecision.CONTINUE ->
              startNextBackgroundThreadSpeechLocked(attempt)
          }
        }
      }
    }
  }

  private fun acknowledgeBackgroundThread(
    attempt: T3VoiceBackgroundThreadAttempt,
    token: String,
    operationId: String,
    cursor: Long,
  ) {
    acquireWakeLockLocked()
    attempt.acknowledging = true
    val call = backgroundThreadServer.newAcknowledgeCall(
      attempt.authority.environmentOrigin, token, operationId, cursor,
    )
    if (!attempt.beginCall(call)) {
      attempt.acknowledging = false
      releaseWakeLockForBackgroundBackoffLocked()
      return
    }
    backgroundRealtimeIo.submit {
      val acknowledged = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          if (backgroundThreadAttempt !== attempt || attempt.stopped) return@synchronized
          val ack = (acknowledged as? T3VoiceBackgroundThreadTurnResult.Success)?.value
          if (ack != null && T3VoiceBackgroundThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, cursor, ack) &&
            ack.acknowledgedSequence >= cursor) {
            attempt.acknowledging = false
            attempt.retryFailures = 0
            val persisted = backgroundThreadOperationStore.updateActive(attempt.clientOperationId) {
              it.copy(acknowledgedCursor = cursor)
            }
            if (persisted !is T3VoiceBackgroundThreadOperationUpdateResult.Updated) {
              failBackgroundThreadLocked(attempt, "native-thread-state-unavailable")
              return@synchronized
            }
            attempt.acknowledgedCursor = cursor
            startNextBackgroundThreadSpeechLocked(attempt)
            return@synchronized
          }
          val retryable = (acknowledged as? T3VoiceBackgroundThreadTurnResult.Failure)?.kind in setOf(
            T3VoiceBackgroundHttpFailureKind.RETRYABLE,
            T3VoiceBackgroundHttpFailureKind.CONFLICT,
            T3VoiceBackgroundHttpFailureKind.CANCELLED,
          )
          if (retryable) {
            attempt.retryFailures += 1
            releaseWakeLockForBackgroundBackoffLocked()
            mainHandler.postDelayed({
              if (!serviceDestroyed) synchronized(operationLock) {
                if (backgroundThreadAttempt === attempt && !attempt.stopped) {
                  acknowledgeBackgroundThread(attempt, token, operationId, cursor)
                }
              }
            }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
          } else {
            attempt.acknowledging = false
            failBackgroundThreadLocked(attempt, "native-thread-ack-failed")
          }
        }
      }
    }
  }

  private fun scheduleBackgroundThreadPollRetryLocked(attempt: T3VoiceBackgroundThreadAttempt) {
    attempt.retryFailures += 1
    val delay = T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures)
    releaseWakeLockForBackgroundBackoffLocked()
    mainHandler.postDelayed({
      if (!serviceDestroyed) synchronized(operationLock) {
        if (backgroundThreadAttempt === attempt && !attempt.stopped) pollBackgroundThread(attempt)
      }
    }, delay)
  }

  private fun backgroundThreadServerEvent(
    attempt: T3VoiceBackgroundThreadAttempt,
    snapshot: T3VoiceBackgroundThreadTurnSnapshot,
    event: T3VoiceBackgroundThreadTurnEvent,
  ): T3VoiceBackgroundEvent.ServerEvent {
    val phase = when (event) {
      is T3VoiceBackgroundThreadTurnEvent.Phase -> serverPhase(event.phase)
      is T3VoiceBackgroundThreadTurnEvent.DispatchCorrelation -> T3VoiceBackgroundServerPhase.DISPATCHING
      is T3VoiceBackgroundThreadTurnEvent.SpeechReady,
      is T3VoiceBackgroundThreadTurnEvent.SpeechTerminal -> T3VoiceBackgroundServerPhase.SPEAKING
      is T3VoiceBackgroundThreadTurnEvent.AttentionRequired -> T3VoiceBackgroundServerPhase.ATTENTION_REQUIRED
      is T3VoiceBackgroundThreadTurnEvent.Failure ->
        if (event.retryable) T3VoiceBackgroundServerPhase.FAILED_RETRYABLE else T3VoiceBackgroundServerPhase.FAILED_PERMANENT
      is T3VoiceBackgroundThreadTurnEvent.Terminal -> when (event.outcome) {
        "completed" -> T3VoiceBackgroundServerPhase.COMPLETED
        "cancelled" -> T3VoiceBackgroundServerPhase.CANCELLED
        else -> T3VoiceBackgroundServerPhase.FAILED_PERMANENT
      }
    }
    val speechReady = event as? T3VoiceBackgroundThreadTurnEvent.SpeechReady
    val speechTerminal = event as? T3VoiceBackgroundThreadTurnEvent.SpeechTerminal
    val correlation = event as? T3VoiceBackgroundThreadTurnEvent.DispatchCorrelation
    return T3VoiceBackgroundEvent.ServerEvent(
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

  private fun serverPhase(value: String): T3VoiceBackgroundServerPhase = when (value) {
    "created" -> T3VoiceBackgroundServerPhase.CREATED
    "transcribing" -> T3VoiceBackgroundServerPhase.TRANSCRIBING
    "dispatching" -> T3VoiceBackgroundServerPhase.DISPATCHING
    "waiting" -> T3VoiceBackgroundServerPhase.WAITING
    "speaking" -> T3VoiceBackgroundServerPhase.SPEAKING
    "completed" -> T3VoiceBackgroundServerPhase.COMPLETED
    "attention-required" -> T3VoiceBackgroundServerPhase.ATTENTION_REQUIRED
    "cancelled" -> T3VoiceBackgroundServerPhase.CANCELLED
    "failed" -> T3VoiceBackgroundServerPhase.FAILED_PERMANENT
    else -> error("Unknown native thread phase.")
  }

  private fun startNextBackgroundThreadSpeechLocked(attempt: T3VoiceBackgroundThreadAttempt) {
    if (attempt.playingSegment != null || attempt.pendingSpeech.isEmpty()) {
      finishBackgroundThreadIfDrainedLocked(attempt)
      if (backgroundThreadAttempt === attempt && attempt.playingSegment == null &&
        attempt.pendingSpeech.isEmpty() && !attempt.polling &&
        T3VoiceBackgroundThreadTerminalPolicy.shouldPollAfterAck(
          backgroundSnapshot,
          attempt.detached,
        )) pollBackgroundThread(attempt)
      return
    }
    val entry = requireNotNull(attempt.pendingSpeech.pollFirstEntry())
    val segment = entry.key
    val playbackId = backgroundThreadPlaybackId(attempt, segment)
    if (applyBackgroundEventLocked(T3VoiceBackgroundEvent.PlaybackStarted(
        requireNotNull(attempt.operationId),
        segment,
      )) == null) return
    attempt.playingSegment = segment
    try {
      binder.startPlayback(playbackId, 24_000, 1)
      binder.enqueuePlaybackChunk(playbackId, 0, java.util.Base64.getEncoder().encodeToString(entry.value))
      binder.finishPlayback(playbackId, 0)
    } catch (_: Throwable) {
      attempt.playingSegment = null
      failBackgroundThreadLocked(attempt, "native-thread-playback-failed")
    }
  }

  private fun handlePlaybackTerminationLocked(
    playbackId: String,
    outcome: String,
    retryBackgroundThread: Boolean,
  ) {
    playbackOwner?.takeIf { it.id == playbackId }?.let { owner ->
      terminatePlaybackLocked(
        owner,
        T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, outcome),
      )
    }
    val attempt = backgroundThreadAttempt?.takeIf {
      playbackId == backgroundThreadPlaybackId(it, it.playingSegment)
    } ?: return
    attempt.playingSegment = null
    attempt.playbackFailures += 1
    if (retryBackgroundThread &&
      T3VoiceBackgroundThreadPlaybackPolicy.shouldRetry(attempt.playbackFailures)) {
      scheduleBackgroundThreadPollRetryLocked(attempt)
    } else {
      failBackgroundThreadLocked(attempt, "native-thread-playback-failed")
    }
  }

  private fun backgroundThreadPlaybackId(attempt: T3VoiceBackgroundThreadAttempt, segment: Int?): String =
    "thread-playback:${attempt.operationId}:${segment ?: -1}"

  private fun finishBackgroundThreadIfDrainedLocked(attempt: T3VoiceBackgroundThreadAttempt) {
    if (attempt.playingSegment != null || attempt.pendingSpeech.isNotEmpty() ||
      !T3VoiceBackgroundThreadTerminalPolicy.canCleanup(
        backgroundSnapshot, attempt.acknowledgedCursor, attempt.detached,
      )) return
    attempt.operationId ?: return
    val completed = T3VoiceBackgroundThreadLocalCleanupCoordinator.complete(
      deleteRecording = {
        attempt.recording?.let {
          runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
        } ?: true
      },
      clearDurableState = {
        runCatching {
          backgroundThreadOperationStore.clear(attempt.clientOperationId)
        }.getOrDefault(false)
      },
    )
    if (!completed) {
      attempt.retryFailures += 1
      releaseWakeLockForBackgroundBackoffLocked()
      mainHandler.postDelayed({
        if (!serviceDestroyed) synchronized(operationLock) {
          if (backgroundThreadAttempt === attempt && !attempt.stopped) {
            finishBackgroundThreadIfDrainedLocked(attempt)
          }
        }
      }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
      return
    }
    backgroundThreadAttempt = null
    if (backgroundSnapshot.terminalSummary == T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED) {
      T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
        operation = "background-thread",
        code = "native-thread-attention-required",
        message = "Open the app to continue this thread.",
        recoverable = true,
      ))
    }
    if (T3VoiceBackgroundThreadTerminalPolicy.shouldAutoRearm(backgroundSnapshot) &&
      readinessConfig.isEffective()) {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.RearmGuardElapsed)
      startBackgroundThreadLocked()
      if (T3VoiceBackgroundThreadRearmPolicy.shouldReconcileAfterStart(
          backgroundThreadAttempt != null,
        )) {
        applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
        stopRuntimeForegroundLocked()
      }
    } else {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
      stopRuntimeForegroundLocked()
    }
  }

  private fun failBackgroundThreadLocked(attempt: T3VoiceBackgroundThreadAttempt, code: String) {
    if (backgroundThreadAttempt !== attempt) return
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
      operation = "background-thread", code = code,
      message = "Background thread voice could not continue.", recoverable = true,
    ))
    if (backgroundSnapshot.dispatchAcknowledged) {
      fenceBackgroundThreadForReconciliationLocked(attempt)
      return
    }
    stopBackgroundThreadLocked(cancelServer = true)
  }

  private fun fenceBackgroundThreadForReconciliationLocked(
    attempt: T3VoiceBackgroundThreadAttempt,
  ) {
    stopBackgroundThreadAudioLocked(attempt, "reconciliation-required")
    attempt.cancelAllCalls()
    attempt.stopped = true
    attempt.detached = true
    val loaded = backgroundThreadOperationStore.load()
      as? T3VoiceBackgroundThreadOperationLoadResult.Available
    val active = loaded?.state as? T3VoiceBackgroundThreadOperationState.Active
    if (active != null) {
      backgroundThreadOperationStore.writeActive(active.copy(detached = true))
    }
    backgroundThreadAttempt = null
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
    )
    val pending = T3VoicePendingRuntimeRevocation(
      attempt.authority.runtimeId,
      attempt.authority.environmentOrigin,
    )
    val disabled = readinessConfig.copy(enabled = false, generation = readinessConfig.generation + 1)
    readinessStore.writeDisabledForRuntimeRevocation(disabled, pending)
    readinessConfig = disabled
    T3VoiceRuntimeGrantStore(applicationContext).clear(deleteKey = true)
    controllerCommands.invalidateReadiness()
    applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
    if (recordingEndedCue == null && realtimeEndedCue == null) stopRuntimeForegroundLocked()
  }

  private fun stopBackgroundThreadLocked(cancelServer: Boolean) {
    val attempt = backgroundThreadAttempt ?: return
    val initiallyPersisted = backgroundThreadOperationStore.load()
      as? T3VoiceBackgroundThreadOperationLoadResult.Available
    val prepared = initiallyPersisted?.state as? T3VoiceBackgroundThreadOperationState.Prepared
    if (cancelServer && prepared != null && attempt.operationId == null) {
      attempt.cancelRequested = true
      attempt.detached = true
      backgroundThreadOperationStore.writePrepared(
        prepared.claim,
        cancelRequested = true,
      )
      attempt.cancelActiveCall()
      val authorization = T3VoiceBackgroundThreadAuthorityPolicy.validatePreparedCancellation(
        T3VoiceRuntimeGrantStore(applicationContext).load(),
        prepared.claim,
        System.currentTimeMillis(),
      )
      if (authorization == null) {
        T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
          operation = "background-thread",
          code = "native-thread-cancel-authorization-unavailable",
          message = "Background thread voice requires authorization reconciliation.",
          recoverable = true,
        ))
        fenceBackgroundThreadForReconciliationLocked(attempt)
      } else {
        applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
        createBackgroundThreadOperation(attempt, authorization.runtimeGrantToken)
      }
      return
    }
    attempt.cancelActiveCall()
    val dispatched = backgroundSnapshot.dispatchAcknowledged
    attempt.stopped = !dispatched
    val operationId = attempt.operationId
    val token = attempt.operationGrantToken
    val persisted = backgroundThreadOperationStore.load() as? T3VoiceBackgroundThreadOperationLoadResult.Available
    val active = persisted?.state as? T3VoiceBackgroundThreadOperationState.Active
    if (active != null && cancelServer) {
      attempt.cancelRequested = true
      attempt.detached = true
      backgroundThreadOperationStore.writeActive(active.copy(detached = true, cancelRequested = true))
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
      if (operationId != null && token != null) {
        cancelBackgroundThreadOperation(attempt)
      }
      return
    }
    backgroundThreadAttempt = null
    val completed = T3VoiceBackgroundThreadLocalStopCoordinator.complete(
      clearDurableState = {
        runCatching {
          backgroundThreadOperationStore.clear(attempt.clientOperationId)
        }.getOrDefault(false)
      },
      stopSnapshot = { applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop) },
      reconcileForeground = {},
    )
    if (!completed) {
      backgroundThreadAttempt = attempt
      T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
        operation = "background-thread",
        code = "native-thread-stop-reconciliation-required",
        message = "Background thread voice requires authorization reconciliation.",
        recoverable = true,
      ))
      fenceBackgroundThreadForReconciliationLocked(attempt)
    } else {
      reconcileAfterBackgroundThreadStopLocked(attempt)
    }
  }

  private fun reconcileAfterBackgroundThreadStopLocked(
    attempt: T3VoiceBackgroundThreadAttempt,
  ) {
    if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    } else {
      updateNativeControlSurfacesLocked()
    }
  }

  private fun cancelBackgroundThreadOperation(attempt: T3VoiceBackgroundThreadAttempt) {
    val operationId = attempt.operationId ?: return
    val token = attempt.operationGrantToken ?: return
    acquireWakeLockLocked()
    val call = backgroundThreadServer.newCancelCall(
      attempt.authority.environmentOrigin, token, operationId,
    )
    attempt.beginCancellationCall(call)
    backgroundThreadCancellationIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCancellationCall(call)) return@synchronized
          if (backgroundThreadAttempt !== attempt) return@synchronized
          when (T3VoiceBackgroundThreadCancelPolicy.decide(result)) {
            T3VoiceBackgroundThreadCancelDecision.COMPLETE -> {
              val completed = T3VoiceBackgroundThreadLocalCleanupCoordinator.complete(
                deleteRecording = {
                  attempt.recording?.let {
                    runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
                  } ?: true
                },
                clearDurableState = {
                  runCatching {
                    backgroundThreadOperationStore.clear(attempt.clientOperationId)
                  }.getOrDefault(false)
                },
              )
              if (!completed) {
                attempt.retryFailures += 1
                releaseWakeLockForBackgroundBackoffLocked()
                mainHandler.postDelayed({
                  if (!serviceDestroyed) synchronized(operationLock) {
                    if (backgroundThreadAttempt === attempt && attempt.cancelRequested) {
                      cancelBackgroundThreadOperation(attempt)
                    }
                  }
                }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
                return@synchronized
              }
              attempt.stopped = true
              backgroundThreadAttempt = null
              applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
              reconcileAfterBackgroundThreadStopLocked(attempt)
            }
            T3VoiceBackgroundThreadCancelDecision.RETRY -> {
              attempt.retryFailures += 1
              releaseWakeLockForBackgroundBackoffLocked()
              mainHandler.postDelayed({
                if (!serviceDestroyed) synchronized(operationLock) {
                  if (backgroundThreadAttempt === attempt && attempt.cancelRequested) {
                    cancelBackgroundThreadOperation(attempt)
                  }
                }
              }, T3VoiceBackgroundThreadRetryPolicy.delayMillis(attempt.retryFailures))
            }
            T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION -> {
              T3VoiceDiagnostics.record(
                0,
                T3VoiceDiagnosticCategory.TERMINAL,
                T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
              )
              check(T3VoiceBackgroundThreadCancelReconciliationPolicy.requiresFence(
                T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION,
              ))
              fenceBackgroundThreadForReconciliationLocked(attempt)
            }
          }
        }
      }
    }
  }

  private fun fenceBackgroundRealtimeForReadinessLocked(next: T3VoiceReadinessConfig) {
    val attempt = backgroundRealtimeAttempt ?: return
    if (T3VoiceBackgroundRealtimeAttemptPolicy.owns(attempt, attempt.operationId, next)) return
    abandonBackgroundRealtimeLocked(attempt, closeServer = true)
    nativeControlHeartbeat.stop()
    nativeHandoffPoller.stop()
    clearHandoffEligibilityLocked()
    attempt.serverSession?.state?.sessionId?.takeIf {
      T3VoiceStateStore.state.value.activeRealtimeSessionId == it
    }?.let { sessionId ->
      val stopped = runCatching { realtime.stop(sessionId) }.getOrDefault(false)
      if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(sessionId)
    }
  }

  private fun fenceBackgroundThreadForReadinessLocked(next: T3VoiceReadinessConfig) {
    val attempt = backgroundThreadAttempt ?: return
    if (T3VoiceBackgroundThreadAttemptPolicy.owns(attempt, next)) return
    stopBackgroundThreadAudioLocked(attempt, "readiness-changed")
    stopBackgroundThreadLocked(cancelServer = true)
  }

  private fun startBackgroundRealtimeLocked() {
    check(Thread.holdsLock(operationLock)) { "Background Realtime start must hold the operation lock." }
    if (
      !T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(
        backgroundRealtimeCleanup,
        backgroundRealtimeCleanupLocked,
      )
    ) {
      if (!backgroundRealtimeCleanupLocked) scheduleBackgroundRealtimeCleanupLocked()
      return
    }
    if (
      backgroundRealtimeAttempt != null ||
        T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE
    ) {
      return
    }
    val authorization = nativeRealtimeAuthorityLocked() ?: return
    val authority = authorization.authority
    val diagnosticGeneration = T3VoiceDiagnostics.nextGeneration()
    if (
      backgroundSnapshot.phase != T3VoiceBackgroundPhase.LOCKED &&
        (backgroundSnapshot.runtimeId != authority.runtimeId ||
          backgroundSnapshot.readinessGeneration != authority.readinessGeneration ||
          backgroundSnapshot.mode != T3VoiceBackgroundMode.REALTIME)
    ) {
      backgroundSnapshot = T3VoiceBackgroundSnapshot()
      backgroundSnapshotStore.write(backgroundSnapshot)
    }
    applyBackgroundEventLocked(
      T3VoiceBackgroundEvent.AuthorityValidated(
        runtimeId = authority.runtimeId,
        readinessGeneration = authority.readinessGeneration,
        mode = T3VoiceBackgroundMode.REALTIME,
        autoRearm = false,
      ),
    )
    val persistedOperationId =
      backgroundSnapshot.operationId?.takeIf {
        backgroundSnapshot.phase == T3VoiceBackgroundPhase.REALTIME_STARTING ||
          backgroundSnapshot.phase == T3VoiceBackgroundPhase.REALTIME_ACTIVE
      }
    val operationId = persistedOperationId ?: "realtime-${UUID.randomUUID()}"
    if (persistedOperationId === null) {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.StartRealtime(operationId))
    } else if (backgroundSnapshot.phase == T3VoiceBackgroundPhase.REALTIME_ACTIVE) {
      backgroundSnapshot = backgroundSnapshot.copy(phase = T3VoiceBackgroundPhase.REALTIME_STARTING)
      backgroundSnapshotStore.write(backgroundSnapshot)
    }
    val attempt =
      T3VoiceBackgroundRealtimeAttempt(
        operationId = operationId,
        authority = authority,
        diagnosticGeneration = diagnosticGeneration,
      )
    backgroundRealtimeAttempt = attempt
    T3VoiceDiagnostics.record(
      diagnosticGeneration,
      T3VoiceDiagnosticCategory.LIFECYCLE,
      T3VoiceDiagnosticCode.AUTHORITY_VALIDATED,
    )
    try {
      ensureRuntimeForeground(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
      )
    } catch (_: Throwable) {
      T3VoiceStateStore.emit(
        T3VoiceRuntimeEvent.RuntimeError(
          operation = "background-realtime",
          code = "native-foreground-unavailable",
          message = "Android could not acquire background voice ownership.",
          recoverable = true,
        ),
      )
      failBackgroundRealtimeLocked(attempt, closeServer = false, releaseForeground = false)
      return
    }
    val startCall =
      backgroundRealtimeServer.newStartCall(
        authority.environmentOrigin,
        authorization.runtimeGrantToken,
        T3VoiceBackgroundRealtimeStartInput(
          runtimeId = authority.runtimeId,
          generation = authority.readinessGeneration,
          clientOperationId = operationId,
        ),
      )
    attempt.activeCall = startCall
    attempt.future =
      backgroundRealtimeIo.submit {
        val result = startCall.execute()
        mainHandler.post {
          if (serviceDestroyed) return@post
          synchronized(operationLock) {
            handleBackgroundRealtimeStartedLocked(operationId, authority, result)
          }
        }
      }
  }

  private fun restoreBackgroundRealtimeIfNeededLocked(): Boolean {
    if (!backgroundRestoreRequested) return false
    restoreBackgroundRealtimeCleanupIfNeededLocked()
    return true
  }

  private fun handleBackgroundRealtimeStartedLocked(
    operationId: String,
    authority: T3VoiceBackgroundRealtimeAuthority,
    result: T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeStartResult>,
  ) {
    val attempt = backgroundRealtimeAttempt
    if (!T3VoiceBackgroundRealtimeAttemptPolicy.owns(attempt, operationId, readinessConfig)) {
      return
    }
    requireNotNull(attempt)
    if (result !is T3VoiceBackgroundRealtimeResult.Success) {
      emitBackgroundRealtimeFailure(
        (result as T3VoiceBackgroundRealtimeResult.Failure).kind,
      )
      failBackgroundRealtimeLocked(attempt)
      return
    }
    val start = result.value
    attempt.serverSession = start
    attempt.activeCall = null
    if (
      !T3VoiceBackgroundRealtimeAuthorityPolicy.validateStartedSession(
        attempt.authority,
        start,
        System.currentTimeMillis(),
      )
    ) {
      emitBackgroundRealtimeFailure(T3VoiceBackgroundHttpFailureKind.PERMANENT)
      failBackgroundRealtimeLocked(attempt)
      return
    }
    T3VoiceDiagnostics.record(
      attempt.diagnosticGeneration,
      T3VoiceDiagnosticCategory.LIFECYCLE,
      T3VoiceDiagnosticCode.SERVER_SESSION_STARTED,
    )
    val controlGrant =
      runCatching { T3VoiceBackgroundRealtimeAuthorityPolicy.nativeControlGrant(start) }
        .getOrElse {
          failBackgroundRealtimeLocked(attempt)
          return
        }
    try {
      binder.prepareRealtimeSession(
        nativeSessionId = start.state.sessionId,
        environmentOrigin = attempt.authority.environmentOrigin,
        audioRouteId = readinessConfig.audioRouteId,
        nativeControlGrant = controlGrant,
        callback =
          object : T3VoiceWebRtcResultCallback<String> {
            override fun onSuccess(result: String) {
              offerBackgroundRealtime(operationId, start, result)
            }

            override fun onFailure(code: String, message: String, cause: Throwable?) {
              mainHandler.post {
                if (serviceDestroyed) return@post
                synchronized(operationLock) {
                  backgroundRealtimeAttempt?.takeIf { it.operationId == operationId }?.let {
                    failBackgroundRealtimeLocked(it)
                  }
                }
              }
            }
          },
      )
    } catch (_: Throwable) {
      failBackgroundRealtimeLocked(attempt)
    }
  }

  private fun offerBackgroundRealtime(
    operationId: String,
    start: T3VoiceBackgroundRealtimeStartResult,
    offerSdp: String,
  ) {
    val attempt = synchronized(operationLock) {
      backgroundRealtimeAttempt?.takeIf {
        T3VoiceBackgroundRealtimeAttemptPolicy.owns(it, operationId, readinessConfig) &&
          it.serverSession === start
      }
    } ?: return
    val offerCall =
      backgroundRealtimeServer.newOfferCall(
        attempt.authority.environmentOrigin,
        start.controlGrant.token,
        start,
        offerSdp,
      )
    synchronized(operationLock) {
      if (
        backgroundRealtimeAttempt !== attempt ||
          !T3VoiceBackgroundRealtimeAttemptPolicy.owns(attempt, operationId, readinessConfig) ||
          attempt.serverSession !== start
      ) {
        offerCall.cancel()
        return
      }
      attempt.activeCall = offerCall
      try {
        attempt.future =
          backgroundRealtimeIo.submit {
            val result = offerCall.execute()
            mainHandler.post {
              if (serviceDestroyed) return@post
              synchronized(operationLock) {
                handleBackgroundRealtimeAnswerLocked(operationId, start, result)
              }
            }
          }
      } catch (_: Throwable) {
        attempt.activeCall = null
        offerCall.cancel()
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) {
            if (backgroundRealtimeAttempt === attempt) failBackgroundRealtimeLocked(attempt)
          }
        }
      }
    }
  }

  private fun handleBackgroundRealtimeAnswerLocked(
    operationId: String,
    start: T3VoiceBackgroundRealtimeStartResult,
    result: T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeAnswer>,
  ) {
    val attempt = backgroundRealtimeAttempt
    if (
      !T3VoiceBackgroundRealtimeAttemptPolicy.owns(attempt, operationId, readinessConfig) ||
        attempt?.serverSession !== start
    ) {
      return
    }
    if (result !is T3VoiceBackgroundRealtimeResult.Success) {
      emitBackgroundRealtimeFailure(
        (result as T3VoiceBackgroundRealtimeResult.Failure).kind,
      )
      failBackgroundRealtimeLocked(attempt)
      return
    }
    attempt.activeCall = null
    binder.applyRealtimeAnswer(
      start.state.sessionId,
      result.value.sdp,
      object : T3VoiceWebRtcResultCallback<Unit> {
        override fun onSuccess(result: Unit) {
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              if (
                T3VoiceBackgroundRealtimeAttemptPolicy.owns(
                  backgroundRealtimeAttempt,
                  operationId,
                  readinessConfig,
                )
              ) {
                runCatching {
                  binder.setAudioRoute(start.state.sessionId, readinessConfig.audioRouteId)
                }
                T3VoiceDiagnostics.record(
                  attempt.diagnosticGeneration,
                  T3VoiceDiagnosticCategory.STATE,
                  T3VoiceDiagnosticCode.SIGNALING_COMPLETED,
                )
              }
            }
          }
        }

        override fun onFailure(code: String, message: String, cause: Throwable?) {
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              backgroundRealtimeAttempt?.takeIf { it.operationId == operationId }?.let {
                failBackgroundRealtimeLocked(it)
              }
            }
          }
        }
      },
    )
  }

  private fun failBackgroundRealtimeLocked(
    attempt: T3VoiceBackgroundRealtimeAttempt,
    closeServer: Boolean = true,
    releaseForeground: Boolean = true,
  ) {
    T3VoiceDiagnostics.record(
      attempt.diagnosticGeneration,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.FAILED,
    )
    abandonBackgroundRealtimeLocked(attempt, closeServer)
    val sessionId = attempt.serverSession?.state?.sessionId
    if (sessionId != null && T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId) {
      runCatching { realtime.stop(sessionId) }
    }
    if (releaseForeground && T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    }
  }

  private fun emitBackgroundRealtimeFailure(
    kind: T3VoiceBackgroundHttpFailureKind,
  ) {
    T3VoiceStateStore.emit(
      T3VoiceRuntimeEvent.RuntimeError(
        operation = "background-realtime",
        code =
          when (kind) {
            T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED -> "native-authority-rejected"
            T3VoiceBackgroundHttpFailureKind.CONFLICT -> "native-session-conflict"
            T3VoiceBackgroundHttpFailureKind.RETRYABLE,
            T3VoiceBackgroundHttpFailureKind.CANCELLED,
            -> "native-session-retryable"
            T3VoiceBackgroundHttpFailureKind.PERMANENT -> "native-session-invalid"
          },
        message = "Background Realtime voice could not start.",
        recoverable =
          kind == T3VoiceBackgroundHttpFailureKind.RETRYABLE ||
            kind == T3VoiceBackgroundHttpFailureKind.CANCELLED ||
            kind == T3VoiceBackgroundHttpFailureKind.CONFLICT,
      ),
    )
  }

  private fun abandonBackgroundRealtimeLocked(
    attempt: T3VoiceBackgroundRealtimeAttempt?,
    closeServer: Boolean,
  ) {
    if (attempt == null || backgroundRealtimeAttempt !== attempt) return
    if (closeServer) {
      val marker = T3VoiceBackgroundRealtimeCleanupMarker.from(attempt)
      backgroundRealtimeCleanupStore.write(marker)
      backgroundRealtimeCleanup = marker
    }
    backgroundRealtimeAttempt = null
    attempt.activeCall?.cancel()
    attempt.activeCall = null
    attempt.future?.cancel(true)
    if (closeServer && !serviceDestroyed) {
      scheduleBackgroundRealtimeCleanupLocked(
        knownSession = attempt.serverSession,
        diagnosticGeneration = attempt.diagnosticGeneration,
      )
    } else if (backgroundSnapshot.operationId == attempt.operationId) {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
    }
  }

  private fun scheduleBackgroundRealtimeCleanupLocked(
    knownSession: T3VoiceBackgroundRealtimeStartResult? = null,
    diagnosticGeneration: Long? = null,
  ) {
    val marker = backgroundRealtimeCleanup ?: return
    if (backgroundRealtimeCleanupInFlight) return
    backgroundRealtimeCleanupInFlight = true
    acquireWakeLockLocked()
    diagnosticGeneration?.let {
      T3VoiceDiagnostics.record(
        it,
        T3VoiceDiagnosticCategory.LIFECYCLE,
        T3VoiceDiagnosticCode.CLOSE_REQUESTED,
      )
    }
    runCatching {
      backgroundRealtimeIo.submit {
        val decision = executeBackgroundRealtimeCleanup(marker, knownSession)
        mainHandler.post {
          if (serviceDestroyed) return@post
          synchronized(operationLock) {
            handleBackgroundRealtimeCleanupResultLocked(marker, decision)
          }
        }
      }
    }.onFailure {
      backgroundRealtimeCleanupInFlight = false
      scheduleBackgroundRealtimeCleanupRetryLocked(marker)
    }
  }

  private fun executeBackgroundRealtimeCleanup(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
    knownSession: T3VoiceBackgroundRealtimeStartResult?,
  ): T3VoiceBackgroundRealtimeCleanupDecision {
    val start =
      if (knownSession !== null) {
        knownSession
      } else {
        val loadedGrant =
          runCatching { T3VoiceRuntimeGrantStore(applicationContext).load() }
            .getOrElse { T3VoiceRuntimeGrantLoadResult.Locked }
        if (loadedGrant == T3VoiceRuntimeGrantLoadResult.Locked) {
          return T3VoiceBackgroundRealtimeCleanupDecision.RETRY
        }
        val authority =
          T3VoiceBackgroundRealtimeCleanupPolicy.authority(marker, loadedGrant)
            ?: return T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED
        when (
          val result =
            backgroundRealtimeServer.start(
              marker.environmentOrigin,
              authority.runtimeGrantToken,
              T3VoiceBackgroundRealtimeStartInput(
                runtimeId = marker.runtimeId,
                generation = marker.readinessGeneration,
                clientOperationId = marker.operationId,
              ),
            )
        ) {
          is T3VoiceBackgroundRealtimeResult.Success -> result.value
          is T3VoiceBackgroundRealtimeResult.Failure ->
            return T3VoiceBackgroundRealtimeCleanupPolicy.startFailure(result)
        }
      }
    if (start.state.conversationId != marker.conversationId) {
      return T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED
    }
    if (start.state.phase == "ended" || start.state.phase == "error") {
      return T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE
    }
    return T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
      backgroundRealtimeServer.close(marker.environmentOrigin, start.controlGrant.token, start),
    )
  }

  private fun handleBackgroundRealtimeCleanupResultLocked(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
    decision: T3VoiceBackgroundRealtimeCleanupDecision,
  ) {
    if (serviceDestroyed || backgroundRealtimeCleanup != marker) return
    backgroundRealtimeCleanupInFlight = false
    when (decision) {
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE ->
        finishBackgroundRealtimeCleanupLocked(marker)
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY ->
        scheduleBackgroundRealtimeCleanupRetryLocked(marker)
      T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED -> {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
          backgroundRealtimeCleanupFailures + 1,
        )
        fenceBackgroundRealtimeCleanupForReconciliationLocked(marker)
      }
    }
  }

  private fun fenceBackgroundRealtimeCleanupForReconciliationLocked(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
  ) {
    backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
    val reconciliation =
      T3VoiceBackgroundRealtimeReconciliationPolicy.fence(readinessConfig, marker)
    readinessStore.writeDisabledForRuntimeRevocation(
      reconciliation.readiness,
      reconciliation.pendingRevocation,
    )
    readinessConfig = reconciliation.readiness
    T3VoiceRuntimeGrantStore(applicationContext).clear(deleteKey = true)
    controllerCommands.invalidateReadiness()
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.RuntimeError(
      operation = "background-realtime-cleanup",
      code = "native-realtime-authority-rejected",
      message = "Background voice authorization must be refreshed.",
      recoverable = true,
    ))
    if (recordingEndedCue == null && realtimeEndedCue == null) stopRuntimeForegroundLocked()
  }

  private fun scheduleBackgroundRealtimeCleanupRetryLocked(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
    minimumDelayMillis: Long = 0,
  ) {
    if (backgroundRealtimeCleanup != marker || backgroundRealtimeCleanupInFlight) return
    backgroundRealtimeCleanupFailures += 1
    val delay =
      maxOf(
        minimumDelayMillis,
        T3VoiceBackgroundRealtimeCleanupPolicy.retryDelayMillis(backgroundRealtimeCleanupFailures),
      )
    releaseWakeLockForBackgroundBackoffLocked()
    mainHandler.postDelayed(
      {
        synchronized(operationLock) {
          if (!serviceDestroyed && backgroundRealtimeCleanup == marker && !backgroundRealtimeCleanupInFlight) {
            scheduleBackgroundRealtimeCleanupLocked()
          }
        }
      },
      delay,
    )
  }

  private fun finishBackgroundRealtimeCleanupLocked(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
  ) {
    if (backgroundRealtimeCleanup != marker) return
    if (!backgroundRealtimeCleanupStore.clear(marker)) {
      backgroundRealtimeCleanup = null
      backgroundRealtimeCleanupLocked = true
      backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
      return
    }
    backgroundRealtimeCleanup = null
    backgroundRealtimeCleanupFailures = 0
    if (backgroundSnapshot.operationId == marker.operationId) {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
    }
    val restart = T3VoiceBackgroundRealtimeRestartPolicy.shouldRestart(backgroundRealtimeRestartRequest)
    backgroundRealtimeRestartRequest = T3VoiceBackgroundRealtimeRestartRequest.NONE
    if (restart && !serviceDestroyed) startBackgroundRealtimeLocked()
    else if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    } else {
      updateNativeControlSurfacesLocked()
    }
  }

  private fun restoreBackgroundRealtimeCleanupIfNeededLocked(): Boolean {
    if (backgroundRealtimeCleanupLocked) return true
    val marker =
      backgroundRealtimeCleanup
        ?: when (val loaded = backgroundRealtimeCleanupStore.load()) {
          is T3VoiceBackgroundRealtimeCleanupLoadResult.Available -> loaded.marker
          T3VoiceBackgroundRealtimeCleanupLoadResult.Missing -> {
            if (!backgroundRestoreRequested) return false
            val operationId = backgroundSnapshot.operationId ?: return true
            interruptedBackgroundRealtimeCleanupMarker(operationId)
              ?.also(backgroundRealtimeCleanupStore::write)
              ?: return true
          }
          T3VoiceBackgroundRealtimeCleanupLoadResult.Locked -> {
            backgroundRealtimeCleanupLocked = true
            return true
          }
        }
    backgroundRealtimeCleanup = marker
    backgroundRestoreRequested = false
    scheduleBackgroundRealtimeCleanupLocked()
    return true
  }

  private fun interruptedBackgroundRealtimeCleanupMarker(
    operationId: String,
  ): T3VoiceBackgroundRealtimeCleanupMarker? {
    val active = readinessStore.activeAuthority() ?: return null
    val conversationId = readinessConfig.targetId ?: return null
    if (
      active.runtimeId != backgroundSnapshot.runtimeId ||
        active.config.generation != backgroundSnapshot.operationGeneration ||
        active.operation != T3VoiceRuntimeGrantOperation.REALTIME_START
    ) {
      return null
    }
    return T3VoiceBackgroundRealtimeCleanupMarker(
      runtimeId = active.runtimeId,
      readinessGeneration = active.config.generation,
      environmentOrigin = active.environmentOrigin,
      operationId = operationId,
      conversationId = conversationId,
    )
  }

  private fun applyBackgroundEventLocked(
    event: T3VoiceBackgroundEvent,
  ): T3VoiceBackgroundTransition? {
    val transition = T3VoiceBackgroundReducer.reduce(backgroundSnapshot, event)
    if (!persistBackgroundSnapshotLocked(transition.snapshot)) {
      backgroundThreadAttempt?.let {
        failBackgroundThreadLocked(it, "native-thread-state-unavailable")
      }
      return null
    }
    return transition
  }

  private fun persistBackgroundSnapshotLocked(
    snapshot: T3VoiceBackgroundSnapshot,
  ): Boolean {
    val attempt = backgroundThreadAttempt
    val dispatchedRecording = attempt?.recording?.takeIf {
      snapshot.mode == T3VoiceBackgroundMode.THREAD && snapshot.dispatchAcknowledged
    }
    if (attempt?.operationId != null && snapshot.mode == T3VoiceBackgroundMode.THREAD) {
      val persisted = backgroundThreadOperationStore.updateActive(attempt.clientOperationId) { active ->
        active.copy(
          recording = if (dispatchedRecording == null) attempt.recording else null,
          detached = attempt.detached,
          cancelRequested = attempt.cancelRequested,
          snapshot = T3VoiceBackgroundThreadPersistencePolicy.snapshotAfterTransition(
            active,
            snapshot,
          ),
        )
      }
      if (persisted !is T3VoiceBackgroundThreadOperationUpdateResult.Updated) return false
    }
    backgroundSnapshot = snapshot
    val snapshotPersisted = runCatching {
      backgroundSnapshotStore.write(backgroundSnapshot)
    }.isSuccess
    if (attempt?.operationId == null && !snapshotPersisted) return false
    if (dispatchedRecording != null) attempt.recording = null
    dispatchedRecording?.let { recording ->
      runCatching { recorder.delete(recording.recordingId, recording.uri) }
    }
    return true
  }

  private fun executeControlCommandLocked(command: T3VoiceControlCommand) {
    backgroundRealtimeRestartRequest =
      T3VoiceBackgroundRealtimeRestartPolicy.afterControl(backgroundRealtimeRestartRequest, command)
    when (T3VoiceControlPolicy.pendingStartDecision(
        command,
        T3VoiceStateStore.state.value.phase,
        backgroundThreadAttempt != null,
      )) {
      T3VoicePendingControlDecision.IGNORE -> {
        updateNativeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.CANCEL -> {
        stopBackgroundThreadLocked(cancelServer = true)
        stopRuntimeForegroundLocked()
        updateNativeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.NOT_APPLICABLE -> Unit
    }
    when (T3VoiceControlPolicy.pendingStartDecision(
        command,
        T3VoiceStateStore.state.value.phase,
        backgroundRealtimeAttempt != null,
      )) {
      T3VoicePendingControlDecision.IGNORE -> {
        updateNativeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.CANCEL -> {
        abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
        stopRuntimeForegroundLocked()
        updateNativeControlSurfacesLocked()
        return
      }
      T3VoicePendingControlDecision.NOT_APPLICABLE -> Unit
    }
    val nativeRealtimeAvailable = nativeRealtimeAuthorityLocked() != null
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
      T3VoiceControlDecision.START_NATIVE_REALTIME -> startBackgroundRealtimeLocked()
      T3VoiceControlDecision.START_NATIVE_THREAD -> startBackgroundThreadLocked()
      T3VoiceControlDecision.REQUEST_CONTROLLER_START ->
        controllerCommands.requestPrimary(
          readinessConfig.generation,
          readinessConfig.microphonePermissionGranted,
        )
      T3VoiceControlDecision.STOP_ACTIVE -> stopActiveOperationLocked()
      T3VoiceControlDecision.TOGGLE_REALTIME_MUTE -> {
        val state = T3VoiceStateStore.state.value
        state.activeRealtimeSessionId?.let { realtime.setMuted(it, !state.realtimeMuted) }
      }
      T3VoiceControlDecision.IGNORE -> Unit
    }
    updateNativeControlSurfacesLocked()
  }

  private fun stopActiveOperationLocked() {
    val state = T3VoiceStateStore.state.value
    stopBackgroundThreadLocked(cancelServer = true)
    abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
    nativeHandoffPoller.stop()
    clearHandoffEligibilityLocked()
    stopTraditionalAudioLocked(state, "notification-stop")
    state.activeRealtimeSessionId?.let {
      nativeControlHeartbeat.stop()
      val stopped = runCatching { realtime.stop(it) }.getOrDefault(false)
      if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(it)
    }
    if (recordingEndedCue == null && realtimeEndedCue == null) stopRuntimeForegroundLocked()
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

  private fun stopBackgroundThreadAudioLocked(
    attempt: T3VoiceBackgroundThreadAttempt,
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

  private fun executeNativeHandoff(action: T3VoiceNativeHandoffAction): T3VoiceNativeHandoffOutcome {
    val completed = CountDownLatch(1)
    val completionLock = Any()
    var terminal = false
    var outcome: T3VoiceNativeHandoffOutcome =
      T3VoiceNativeHandoffOutcome.Failed("recognition-start", "operation-timeout")
    val complete: (T3VoiceNativeHandoffOutcome) -> Boolean = { next ->
      synchronized(completionLock) {
        if (terminal) {
          false
        } else {
          terminal = true
          outcome = next
          completed.countDown()
          true
        }
      }
    }
    mainHandler.post {
      if (serviceDestroyed) {
        complete(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"))
        return@post
      }
      try {
        synchronized(operationLock) { executeNativeHandoffLocked(action, complete) }
      } catch (_: Throwable) {
        complete(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"))
      }
    }
    if (!completed.await(HANDOFF_COMMAND_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
      val timeoutWon =
        complete(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "operation-timeout"))
      if (timeoutWon) {
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) {
            cancelNativeHandoffRecordingLocked(
              T3VoiceNativeHandoffPolicy.recordingId(action.actionId),
              "handoff-timeout",
            )
            abortNativeHandoffRealtimeLocked(action)
            handoffInProgress = false
            awaitingHandoffAction = false
            if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
              stopRuntimeForegroundLocked()
            }
          }
        }
      }
    }
    return outcome
  }

  private fun clearHandoffEligibilityLocked() {
    handoffEligibleSessionId = null
    handoffEligibleLeaseGeneration = null
    handoffEnvironmentOrigin = null
    awaitingHandoffAction = false
  }

  private fun executeNativeHandoffLocked(
    action: T3VoiceNativeHandoffAction,
    complete: (T3VoiceNativeHandoffOutcome) -> Boolean,
  ) {
    val finish = { outcome: T3VoiceNativeHandoffOutcome ->
      val won = complete(outcome)
      if (won) {
        handoffInProgress = false
        awaitingHandoffAction = false
        if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
          stopRuntimeForegroundLocked()
        }
      }
      won
    }
    val state = T3VoiceStateStore.state.value
    val recordingId = T3VoiceNativeHandoffPolicy.recordingId(action.actionId)
    if (!T3VoiceNativeHandoffPolicy.matchesGrant(
        action,
        handoffEligibleSessionId,
        handoffEligibleLeaseGeneration,
      )) {
      finish(T3VoiceNativeHandoffOutcome.Failed("target-resolution", "target-unavailable"))
      return
    }
    if (state.phase == T3VoiceRuntimePhase.RECORDING && state.activeRecordingId == recordingId) {
      emitThreadVoiceHandoff(action, recordingId)
      finish(T3VoiceNativeHandoffOutcome.Listening)
      return
    }
    if (state.phase == T3VoiceRuntimePhase.ARMING && state.activeRecordingId == recordingId) {
      val pending = pendingRecordingStart?.takeIf { it.owner.id == recordingId }
      if (pending == null) {
        finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"))
      } else {
        pending.onStarted.clear()
        pending.onFailure.clear()
        pending.onStarted += {
          if (finish(T3VoiceNativeHandoffOutcome.Listening)) {
            emitThreadVoiceHandoff(action, recordingId)
          }
        }
        pending.onFailure += {
          finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "microphone-unavailable"))
        }
      }
      return
    }
    if (
      state.activeRealtimeSessionId != action.sessionId && state.phase != T3VoiceRuntimePhase.IDLE
    ) {
      finish(T3VoiceNativeHandoffOutcome.Failed("target-resolution", "target-unavailable"))
      return
    }
    handoffInProgress = true
    awaitingHandoffAction = true
    try {
      nativeControlHeartbeat.stop()
      if (state.activeRealtimeSessionId == action.sessionId) {
        realtime.drainPlayout(action.sessionId) {
          mainHandler.post {
            if (!serviceDestroyed) synchronized(operationLock) {
              if (
                handoffInProgress &&
                  T3VoiceNativeHandoffPolicy.matchesGrant(
                    action,
                    handoffEligibleSessionId,
                    handoffEligibleLeaseGeneration,
                  )
              ) {
                continueNativeHandoffAfterDrainLocked(action, recordingId, finish)
              }
            }
          }
        }
      } else {
        continueNativeHandoffAfterDrainLocked(action, recordingId, finish)
      }
    } catch (_: Throwable) {
      abortNativeHandoffRealtimeLocked(action)
      finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"))
    }
  }

  private fun abortNativeHandoffRealtimeLocked(action: T3VoiceNativeHandoffAction) {
    realtime.cancelPlayoutDrain(action.sessionId)
    if (T3VoiceStateStore.state.value.activeRealtimeSessionId == action.sessionId) {
      runCatching { realtime.stop(action.sessionId) }
    }
  }

  private fun continueNativeHandoffAfterDrainLocked(
    action: T3VoiceNativeHandoffAction,
    recordingId: String,
    finish: (T3VoiceNativeHandoffOutcome) -> Boolean,
  ) {
    val activeRealtimeSessionId = T3VoiceStateStore.state.value.activeRealtimeSessionId
    if (activeRealtimeSessionId != null) {
      if (activeRealtimeSessionId != action.sessionId || !realtime.stop(action.sessionId)) {
        finish(T3VoiceNativeHandoffOutcome.Failed("realtime-release", "realtime-release-failed"))
        return
      }
    }
    if (T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE) {
      finish(T3VoiceNativeHandoffOutcome.Failed("realtime-release", "realtime-release-failed"))
      return
    }
    val owner = T3VoiceStateStore.claimRecording(recordingId)
    if (owner == null) {
      finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable"))
      return
    }
    recordingOwner = owner
    try {
      scheduleRecordingStartLocked(
        owner,
        T3VoiceEndpointDetectionConfig(),
        onStarted = {
          if (finish(T3VoiceNativeHandoffOutcome.Listening)) {
            emitThreadVoiceHandoff(action, recordingId)
          } else {
            cancelNativeHandoffRecordingLocked(recordingId, "handoff-timeout")
          }
        },
        onFailure = {
          finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "microphone-unavailable"))
        },
      )
    } catch (_: SecurityException) {
      releaseRecordingLocked(owner, stopForeground = false)
      finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "permission-denied"))
    } catch (_: Throwable) {
      releaseRecordingLocked(owner, stopForeground = false)
      finish(T3VoiceNativeHandoffOutcome.Failed("recognition-start", "microphone-unavailable"))
    }
  }

  private fun cancelNativeHandoffRecordingLocked(recordingId: String, reason: String) {
    val state = T3VoiceStateStore.state.value
    stopTraditionalAudioLocked(
      state,
      reason,
      ownsRecording = { it == recordingId },
      ownsPlayback = { false },
    )
  }

  private fun emitThreadVoiceHandoff(action: T3VoiceNativeHandoffAction, recordingId: String) {
    val environmentOrigin = handoffEnvironmentOrigin ?: return
    T3VoiceStateStore.publishThreadVoiceHandoff(
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = action.actionId,
        projectId = action.projectId,
        threadId = action.threadId,
        recordingId = recordingId,
        autoRearm = action.autoRearm,
        environmentOrigin = environmentOrigin,
        expiresAtEpochMillis = action.expiresAtEpochMillis,
      ),
    )
  }

  private fun requireRecordingOwner(recordingId: String): T3VoiceOperationOwner =
    checkNotNull(recordingOwner?.takeIf { it.id == recordingId }) {
      "Recording $recordingId does not own the active recorder."
    }

  private fun requirePlaybackOwner(playbackId: String): T3VoiceOperationOwner =
    checkNotNull(playbackOwner?.takeIf { it.id == playbackId }) {
      "Playback $playbackId does not own the active player."
    }

  private fun releaseRecordingLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.releaseRecording(owner)) return
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminateRecordingLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.terminateRecording(owner, event)) return
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun releasePlaybackLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.releasePlayback(owner)) return
    playbackAudioFocus.stop()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminatePlaybackLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.PlaybackTerminated,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.terminatePlayback(owner, event)) return
    playbackAudioFocus.stop()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun stopRuntimeForegroundLocked() {
    foregroundReleaseCoordinator.releaseWhileLocked()
  }

  private fun releaseWakeLockForBackgroundBackoffLocked() {
    if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
    }
  }

  private fun stopRuntimeForeground() {
    val threadAttempt = backgroundThreadAttempt
    val hasThreadWork = threadAttempt?.let {
      it.hasActiveCall() || it.playingSegment != null ||
        T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE
    } == true
    if (!T3VoiceBackgroundWakeLockPolicy.shouldRetain(
        hasThreadWork = hasThreadWork,
        hasRealtimeMedia = backgroundRealtimeAttempt !== null,
        hasRealtimeCleanupInFlight = backgroundRealtimeCleanupInFlight,
      )) {
      releaseWakeLockLocked()
    }
    if (backgroundRealtimeCleanup !== null || backgroundRealtimeCleanupLocked) {
      updateNativeControlSurfacesLocked()
      return
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
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    T3VoiceStateStore.setForeground(false)
    foregroundServiceTypes = 0
    releaseMediaSessionLocked()
    stopSelf()
  }

  private fun reconcileReadinessLocked() {
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
      else if (backgroundRealtimeCleanup === null && !backgroundRealtimeCleanupLocked) stopSelf()
    }
    updateNativeControlSurfacesLocked()
  }

  private fun disableReadinessLocked() {
    if (!T3VoiceDisablePolicy.shouldCreatePendingDisable(
        readinessConfig,
        readinessStore.pendingDisabled(),
      )) {
      reconcileReadinessLocked()
      return
    }
    val disabled = readinessConfig.copy(enabled = false, generation = readinessConfig.generation + 1)
    val grantMetadata = T3VoiceRuntimeGrantStore(applicationContext).storedMetadata()
    val prepared = readinessStore.prepared()
    val activeAuthority = readinessStore.activeAuthority()
    val revocation =
      readinessStore.pendingRuntimeRevocation()
        ?: grantMetadata?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
        ?: prepared?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
        ?: activeAuthority?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
    readinessConfig = disabled
    readinessStore.writeDisabledWithPending(disabled, revocation)
    controllerCommands.invalidateReadiness()
    T3VoiceStateStore.emit(
      T3VoiceRuntimeEvent.ReadinessDisabled(disabled.generation, "notification"),
    )
    reconcileReadinessLocked()
  }

  private fun keepReadinessServiceStarted() {
    startService(Intent(this, T3VoiceRuntimeService::class.java).apply { action = ACTION_READINESS })
  }

  private fun acquireWakeLockLocked() {
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
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
  }

  private fun ensureMediaSessionLocked() {
    if (mediaSession != null) return
    mediaSession = MediaSession(this, "T3VoiceRuntime").apply {
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
            mainHandler.post {
              if (serviceDestroyed) return@post
              synchronized(operationLock) {
                executeControlCommandLocked(command)
              }
            }
            return true
          }

          override fun onPlay() {
            if (serviceDestroyed) return
            synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.PRIMARY) }
          }

          override fun onPause() {
            if (serviceDestroyed) return
            synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.STOP) }
          }

          override fun onStop() {
            if (serviceDestroyed) return
            synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.STOP) }
          }
        },
      )
    }
  }

  private fun releaseMediaSessionLocked() {
    mediaSession?.release()
    mediaSession = null
  }

  private fun updateNativeControlSurfacesLocked() {
    val session = mediaSession ?: return
    val state = T3VoiceStateStore.state.value
    val active = nativeControlSurfaceActiveLocked(state)
    session.setPlaybackState(
      PlaybackState.Builder()
        .setActions(
          PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_STOP,
        )
        .setState(
          if (active) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
          PlaybackState.PLAYBACK_POSITION_UNKNOWN,
          1f,
        )
        .build(),
    )
    session.isActive = readinessConfig.isEffective() || active
    if (state.isForeground) {
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
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

  @Suppress("DEPRECATION")
  private fun buildNotification(): Notification {
    val state = T3VoiceStateStore.state.value
    val active = nativeControlSurfaceActiveLocked(state)
    val starting =
      state.phase == T3VoiceRuntimePhase.ARMING ||
        (state.phase == T3VoiceRuntimePhase.REALTIME && !state.realtimeInputReady)
    val controllerAttached = controllerCommands.isAttached()
    val canStart =
      backgroundRealtimeAttempt == null &&
        backgroundThreadAttempt == null &&
        (nativeRealtimeAuthorityLocked() != null || nativeThreadAuthorityLocked() != null)
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
          starting -> "T3 voice starting"
          active -> "T3 voice active"
          else -> "T3 voice ready"
        },
      )
      .setContentText(
        when {
          starting -> "Preparing audio. Use Stop to cancel."
          active -> "Use the voice control to stop the active operation."
          canStart -> "Voice controls are ready."
          controllerAttached -> "Microphone permission is required."
          readinessConfig.mode == T3VoiceReadinessMode.REALTIME ->
            "Open T3 to refresh voice authorization."
          else -> "Open T3 to unlock voice controls."
        },
      )
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    if (active) {
      builder.addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
      if (state.phase == T3VoiceRuntimePhase.REALTIME) {
        builder.addAction(
          android.R.drawable.ic_btn_speak_now,
          if (state.realtimeMuted) "Unmute" else "Mute",
          muteIntent,
        )
      }
    } else if (canStart) {
      builder.addAction(android.R.drawable.ic_media_play, "Start", primaryIntent)
    }
    if (readinessConfig.enabled) {
      builder.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Disable", disableReadinessIntent)
    }
    return builder.build()
  }

  private fun nativeControlSurfaceActiveLocked(state: T3VoiceRuntimeState): Boolean {
    val threadAttempt = backgroundThreadAttempt
    return T3VoiceNativeControlSurfacePolicy.isActive(
      phase = state.phase,
      realtimeAttemptActive = backgroundRealtimeAttempt != null,
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
    private const val HANDOFF_COMMAND_TIMEOUT_MILLIS = 5_000L
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
