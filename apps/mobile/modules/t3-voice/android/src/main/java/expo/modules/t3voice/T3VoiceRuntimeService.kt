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
        T3VoiceDisabledReadiness(next, revocation?.runtimeId)
      }

    fun pendingRuntimeRevocation(): T3VoicePendingRuntimeRevocation? =
      readinessStore.pendingRuntimeRevocation()

    fun acknowledgeRuntimeRevocation(expected: T3VoicePendingRuntimeRevocation): Boolean =
      synchronized(operationLock) {
        if (!readinessStore.acknowledgeRuntimeRevocation(expected)) return@synchronized false
        backgroundRealtimeCleanup?.takeIf {
          it.runtimeId == expected.runtimeId &&
            T3VoiceBackgroundOriginPolicy.normalize(it.environmentOrigin) ==
            T3VoiceBackgroundOriginPolicy.normalize(expected.environmentOrigin)
        }?.let { marker ->
          if (!backgroundRealtimeCleanupStore.clear(marker)) {
            backgroundRealtimeCleanup = null
            backgroundRealtimeCleanupLocked = true
            return@let
          }
          backgroundRealtimeCleanup = null
          backgroundRealtimeCleanupInFlight = false
          backgroundRealtimeCleanupFailures = 0
          restartBackgroundRealtimeAfterCleanup = false
          if (backgroundSnapshot.operationId == marker.operationId) {
            applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
          }
        }
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
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
          recorder.start(recordingId, endpointConfig)
          keepServiceStarted(ACTION_START_RECORDING, recordingId)
        } catch (cause: Throwable) {
          releaseRecordingLocked(owner)
          throw cause
        }
      }
    }

    fun stopRecording(recordingId: String): Map<String, Any> =
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
        try {
          recorder.stop(recordingId).toResultBody()
        } finally {
          releaseRecordingLocked(owner)
        }
      }

    fun cancelRecording(recordingId: String) {
      synchronized(operationLock) {
        val owner = requireRecordingOwner(recordingId)
        try {
          recorder.cancel(recordingId)
        } finally {
          releaseRecordingLocked(owner)
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
          realtime.prepare(nativeSessionId, diagnosticGeneration, callback)
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

    fun stopRealtimeSession(nativeSessionId: String): Boolean = realtime.stop(nativeSessionId)

    fun setRealtimeMuted(nativeSessionId: String, muted: Boolean) {
      realtime.setMuted(nativeSessionId, muted)
    }

    fun getAudioRoutes(): List<Map<String, Any>> = realtime.routes()

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()

    fun setAudioRoute(nativeSessionId: String, routeId: String): List<Map<String, Any>> =
      realtime.selectRoute(nativeSessionId, routeId)
  }

  private val binder = VoiceBinder()
  private lateinit var readinessStore: T3VoiceReadinessStore
  private lateinit var backgroundSnapshotStore: T3VoiceBackgroundSnapshotStore
  private lateinit var backgroundRealtimeCleanupStore: T3VoiceBackgroundRealtimeCleanupStore
  private var readinessConfig = T3VoiceReadinessConfig()
  private var backgroundSnapshot = T3VoiceBackgroundSnapshot()
  private var backgroundRestoreRequested = false
  private var backgroundRealtimeAttempt: T3VoiceBackgroundRealtimeAttempt? = null
  private var backgroundRealtimeCleanup: T3VoiceBackgroundRealtimeCleanupMarker? = null
  private var backgroundRealtimeCleanupLocked = false
  private var backgroundRealtimeCleanupInFlight = false
  private var backgroundRealtimeCleanupFailures = 0
  private var restartBackgroundRealtimeAfterCleanup = false
  private val backgroundRealtimeIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val backgroundRealtimeServer = T3VoiceBackgroundRealtimeDelegate()
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
  private val mainHandler = Handler(Looper.getMainLooper())
  private val nativeControlHeartbeat =
    T3VoiceNativeControlHeartbeat { sessionId, termination ->
      mainHandler.post {
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
          synchronized(operationLock) {
            if (handoffEligibleSessionId == sessionId) {
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
        onStateChanged = { sessionId, connectionState, muted ->
          T3VoiceStateStore.setRealtime(
            sessionId = sessionId,
            connectionState = connectionState,
            muted = muted,
          )
          mainHandler.post {
            synchronized(operationLock) { updateNativeControlSurfacesLocked() }
          }
        },
        onRouteChanged = { sessionId, change ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.AudioRouteChanged(
              nativeSessionId = sessionId,
              routeId = change.routeId,
              routeType = change.routeType,
              reason = change.reason.name.lowercase().replace('_', '-'),
            ),
          )
        },
        onError = { sessionId, code, message, recoverable ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "realtime:$sessionId",
              code = code,
              message = message,
              recoverable = recoverable,
            ),
          )
        },
        onTerminated = { sessionId, outcome, code, retryable, diagnosticGeneration ->
          synchronized(operationLock) {
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
              if (!handoffInProgress && !awaitingHandoffAction) stopRuntimeForegroundLocked()
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
    backgroundSnapshotStore = T3VoiceBackgroundSnapshotStore(applicationContext)
    backgroundRealtimeCleanupStore = T3VoiceBackgroundRealtimeCleanupStore(applicationContext)
    backgroundSnapshot = backgroundSnapshotStore.read()
    readinessConfig =
      readinessStore.read().copy(
        microphonePermissionGranted = hasPermission(Manifest.permission.RECORD_AUDIO),
        notificationPermissionGranted =
          Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPermission(Manifest.permission.POST_NOTIFICATIONS),
      )
    when (val cleanup = backgroundRealtimeCleanupStore.load()) {
      is T3VoiceBackgroundRealtimeCleanupLoadResult.Available ->
        backgroundRealtimeCleanup = cleanup.marker
      T3VoiceBackgroundRealtimeCleanupLoadResult.Locked ->
        backgroundRealtimeCleanupLocked = true
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
      restartBackgroundRealtimeAfterCleanup = true
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
            is T3VoiceRecordingTermination.Completed ->
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recording.recordingId,
                  recording = termination.recording,
                  outcome = "completed",
                  reason = termination.reason,
                ),
              )
            is T3VoiceRecordingTermination.Cancelled ->
              terminateRecordingLocked(
                owner,
                T3VoiceRuntimeEvent.RecordingTerminated(
                  recordingId = termination.recordingId,
                  recording = null,
                  outcome = "cancelled",
                  reason = termination.reason,
                ),
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
              )
            }
          }
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
        onFinished = { playbackId ->
          synchronized(operationLock) {
            playbackOwner?.takeIf { it.id == playbackId }?.let { owner ->
              terminatePlaybackLocked(
                owner,
                T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "completed"),
              )
            }
          }
        },
        onError = { playbackId, cause ->
          T3VoiceStateStore.emit(
            T3VoiceRuntimeEvent.RuntimeError(
              operation = "playback:$playbackId",
              code = "pcm-playback-failed",
              message = cause.message ?: "PCM playback failed.",
              recoverable = true,
            ),
          )
          synchronized(operationLock) {
            playbackOwner?.takeIf { it.id == playbackId }?.let { owner ->
              terminatePlaybackLocked(
                owner,
                T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "failed"),
              )
            }
          }
        },
      )
    playbackAudioFocus =
      T3VoicePlaybackAudioFocus(
        this,
        onSuspend = {
          mainHandler.post {
            synchronized(operationLock) {
              playbackOwner?.let { owner -> runCatching { player.pause(owner.id) } }
            }
          }
        },
        onResume = {
          mainHandler.post {
            synchronized(operationLock) {
              playbackOwner?.let { owner -> runCatching { player.resume(owner.id) } }
            }
          }
        },
        onTerminate = {
          mainHandler.post {
            synchronized(operationLock) {
              playbackOwner?.let { owner ->
                runCatching { player.cancel(owner.id) }
                terminatePlaybackLocked(
                  owner,
                  T3VoiceRuntimeEvent.PlaybackTerminated(owner.id, "cancelled"),
                )
              }
            }
          }
        },
      )
    createNotificationChannel()
    T3VoiceStateStore.setServiceReady()
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
      recordingOwner?.let { owner ->
        runCatching { recorder.cancel(owner.id) }
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
      abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
    }
    recorder.release()
    player.release()
    playbackAudioFocus.stop()
    if (realtimeDelegate.isInitialized()) realtime.release()
    nativeControlHeartbeat.destroy()
    nativeHandoffPoller.destroy()
    backgroundRealtimeIo.shutdown()
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

  private fun nativeRealtimeAuthorityLocked(): T3VoiceBackgroundRealtimeAuthority? {
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

  private fun startBackgroundRealtimeLocked() {
    check(Thread.holdsLock(operationLock)) { "Background Realtime start must hold the operation lock." }
    if (
      !T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(
        backgroundRealtimeCleanup,
        backgroundRealtimeCleanupLocked,
      )
    ) {
      restartBackgroundRealtimeAfterCleanup = true
      if (!backgroundRealtimeCleanupLocked) scheduleBackgroundRealtimeCleanupLocked()
      return
    }
    if (
      backgroundRealtimeAttempt != null ||
        T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE
    ) {
      return
    }
    val authority = nativeRealtimeAuthorityLocked() ?: return
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
    attempt.future =
      backgroundRealtimeIo.submit {
        val result =
          backgroundRealtimeServer.start(
            authority.environmentOrigin,
            authority.runtimeGrantToken,
            T3VoiceBackgroundRealtimeStartInput(
              runtimeId = authority.runtimeId,
              generation = authority.readinessGeneration,
              clientOperationId = operationId,
            ),
          )
        mainHandler.post {
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
        nativeControlGrant = controlGrant,
        callback =
          object : T3VoiceWebRtcResultCallback<String> {
            override fun onSuccess(result: String) {
              offerBackgroundRealtime(operationId, start, result)
            }

            override fun onFailure(code: String, message: String, cause: Throwable?) {
              mainHandler.post {
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
    attempt.future =
      backgroundRealtimeIo.submit {
        val result =
          backgroundRealtimeServer.offer(
            attempt.authority.environmentOrigin,
            start.controlGrant.token,
            start,
            offerSdp,
          )
        mainHandler.post {
          synchronized(operationLock) {
            handleBackgroundRealtimeAnswerLocked(operationId, start, result)
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
    binder.applyRealtimeAnswer(
      start.state.sessionId,
      result.value.sdp,
      object : T3VoiceWebRtcResultCallback<Unit> {
        override fun onSuccess(result: Unit) {
          mainHandler.post {
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
                applyBackgroundEventLocked(T3VoiceBackgroundEvent.RealtimeConnected(operationId))
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
    attempt.future?.cancel(true)
    if (closeServer) {
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
    val loadedGrant =
      runCatching { T3VoiceRuntimeGrantStore(applicationContext).load() }
        .getOrElse { T3VoiceRuntimeGrantLoadResult.Locked }
    if (loadedGrant == T3VoiceRuntimeGrantLoadResult.Locked) {
      return T3VoiceBackgroundRealtimeCleanupDecision.RETRY
    }
    val authority =
      T3VoiceBackgroundRealtimeCleanupPolicy.authority(
        marker,
        loadedGrant,
      ) ?: return T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED
    val start =
      if (knownSession !== null) {
        knownSession
      } else {
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
    if (backgroundRealtimeCleanup != marker) return
    backgroundRealtimeCleanupInFlight = false
    when (decision) {
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE ->
        finishBackgroundRealtimeCleanupLocked(marker)
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY ->
        scheduleBackgroundRealtimeCleanupRetryLocked(marker)
      T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED -> Unit
    }
  }

  private fun scheduleBackgroundRealtimeCleanupRetryLocked(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
  ) {
    if (backgroundRealtimeCleanup != marker || backgroundRealtimeCleanupInFlight) return
    backgroundRealtimeCleanupFailures += 1
    val delay =
      T3VoiceBackgroundRealtimeCleanupPolicy.retryDelayMillis(backgroundRealtimeCleanupFailures)
    mainHandler.postDelayed(
      {
        synchronized(operationLock) {
          if (backgroundRealtimeCleanup == marker && !backgroundRealtimeCleanupInFlight) {
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
      restartBackgroundRealtimeAfterCleanup = false
      return
    }
    backgroundRealtimeCleanup = null
    backgroundRealtimeCleanupFailures = 0
    if (backgroundSnapshot.operationId == marker.operationId) {
      applyBackgroundEventLocked(T3VoiceBackgroundEvent.Stop)
    }
    val restart = restartBackgroundRealtimeAfterCleanup
    restartBackgroundRealtimeAfterCleanup = false
    if (restart) startBackgroundRealtimeLocked()
    else if (!readinessConfig.isEffective() && T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
      stopRuntimeForegroundLocked()
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

  private fun applyBackgroundEventLocked(event: T3VoiceBackgroundEvent) {
    val transition = T3VoiceBackgroundReducer.reduce(backgroundSnapshot, event)
    backgroundSnapshot = transition.snapshot
    backgroundSnapshotStore.write(backgroundSnapshot)
  }

  private fun executeControlCommandLocked(command: T3VoiceControlCommand) {
    if (
      backgroundRealtimeAttempt != null &&
        T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE &&
        (command == T3VoiceControlCommand.PRIMARY || command == T3VoiceControlCommand.STOP)
    ) {
      abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
      stopRuntimeForegroundLocked()
      updateNativeControlSurfacesLocked()
      return
    }
    val nativeRealtimeAvailable = nativeRealtimeAuthorityLocked() != null
    when (
      T3VoiceControlPolicy.decide(
        command,
        T3VoiceStateStore.state.value.phase,
        controllerCommands.isAttached(),
        nativeRealtimeAvailable = nativeRealtimeAvailable,
        readinessMode = readinessConfig.mode,
      )
    ) {
      T3VoiceControlDecision.START_NATIVE_REALTIME -> startBackgroundRealtimeLocked()
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
    abandonBackgroundRealtimeLocked(backgroundRealtimeAttempt, closeServer = true)
    nativeHandoffPoller.stop()
    clearHandoffEligibilityLocked()
    recordingOwner?.takeIf { it.id == state.activeRecordingId }?.let { owner ->
      runCatching { recorder.cancel(owner.id) }
      terminateRecordingLocked(
        owner,
        T3VoiceRuntimeEvent.RecordingTerminated(
          recordingId = owner.id,
          recording = null,
          outcome = "cancelled",
          reason = "notification-stop",
        ),
        stopForeground = false,
      )
    }
    playbackOwner?.takeIf { it.id == state.activePlaybackId }?.let { owner ->
      runCatching { player.cancel(owner.id) }
      terminatePlaybackLocked(
        owner,
        T3VoiceRuntimeEvent.PlaybackTerminated(owner.id, "cancelled"),
        stopForeground = false,
      )
    }
    state.activeRealtimeSessionId?.let {
      nativeControlHeartbeat.stop()
      val stopped = runCatching { realtime.stop(it) }.getOrDefault(false)
      if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(it)
    }
    stopRuntimeForegroundLocked()
  }

  private fun executeNativeHandoff(action: T3VoiceNativeHandoffAction): T3VoiceNativeHandoffOutcome {
    val completed = CountDownLatch(1)
    var outcome: T3VoiceNativeHandoffOutcome =
      T3VoiceNativeHandoffOutcome.Failed("recognition-start", "operation-timeout")
    mainHandler.post {
      try {
        outcome = synchronized(operationLock) { executeNativeHandoffLocked(action) }
      } catch (_: Throwable) {
        outcome = T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable")
      } finally {
        completed.countDown()
      }
    }
    if (!completed.await(HANDOFF_COMMAND_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
      return T3VoiceNativeHandoffOutcome.Failed("recognition-start", "operation-timeout")
    }
    return outcome
  }

  private fun clearHandoffEligibilityLocked() {
    handoffEligibleSessionId = null
    handoffEligibleLeaseGeneration = null
    handoffEnvironmentOrigin = null
    awaitingHandoffAction = false
  }

  private fun executeNativeHandoffLocked(action: T3VoiceNativeHandoffAction): T3VoiceNativeHandoffOutcome {
    val state = T3VoiceStateStore.state.value
    val recordingId = T3VoiceNativeHandoffPolicy.recordingId(action.actionId)
    if (!T3VoiceNativeHandoffPolicy.matchesGrant(
        action,
        handoffEligibleSessionId,
        handoffEligibleLeaseGeneration,
      )) {
      return T3VoiceNativeHandoffOutcome.Failed("target-resolution", "target-unavailable")
    }
    if (state.phase == T3VoiceRuntimePhase.RECORDING && state.activeRecordingId == recordingId) {
      emitThreadVoiceHandoff(action, recordingId)
      return T3VoiceNativeHandoffOutcome.Listening
    }
    if (
      state.activeRealtimeSessionId != action.sessionId && state.phase != T3VoiceRuntimePhase.IDLE
    ) {
      return T3VoiceNativeHandoffOutcome.Failed("target-resolution", "target-unavailable")
    }
    handoffInProgress = true
    return try {
      nativeControlHeartbeat.stop()
      val released =
        if (state.activeRealtimeSessionId == action.sessionId) realtime.stop(action.sessionId) else true
      if (!released || T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE) {
        return T3VoiceNativeHandoffOutcome.Failed("realtime-release", "realtime-release-failed")
      }
      val owner = T3VoiceStateStore.claimRecording(recordingId)
        ?: return T3VoiceNativeHandoffOutcome.Failed("recognition-start", "runtime-unavailable")
      recordingOwner = owner
      try {
        ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        recorder.start(recordingId, T3VoiceEndpointDetectionConfig())
        keepServiceStarted(ACTION_START_RECORDING, recordingId)
      } catch (_: SecurityException) {
        releaseRecordingLocked(owner, stopForeground = false)
        return T3VoiceNativeHandoffOutcome.Failed("recognition-start", "permission-denied")
      } catch (_: Throwable) {
        releaseRecordingLocked(owner, stopForeground = false)
        return T3VoiceNativeHandoffOutcome.Failed("recognition-start", "microphone-unavailable")
      }
      emitThreadVoiceHandoff(action, recordingId)
      T3VoiceNativeHandoffOutcome.Listening
    } finally {
      handoffInProgress = false
      awaitingHandoffAction = false
      if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) stopRuntimeForegroundLocked()
    }
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

  private fun stopRuntimeForeground() {
    releaseWakeLockLocked()
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
              ) ?: return false
            mainHandler.post {
              synchronized(operationLock) {
                executeControlCommandLocked(command)
              }
            }
            return true
          }

          override fun onPlay() {
            synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.PRIMARY) }
          }

          override fun onPause() {
            synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.STOP) }
          }

          override fun onStop() {
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
    val active =
      backgroundRealtimeAttempt != null ||
        backgroundRealtimeCleanup !== null ||
        backgroundRealtimeCleanupLocked ||
        (state.phase != T3VoiceRuntimePhase.IDLE && state.phase != T3VoiceRuntimePhase.INACTIVE)
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
    val active =
      backgroundRealtimeAttempt != null ||
        backgroundRealtimeCleanup !== null ||
        backgroundRealtimeCleanupLocked ||
        (state.phase != T3VoiceRuntimePhase.IDLE && state.phase != T3VoiceRuntimePhase.INACTIVE)
    val controllerAttached = controllerCommands.isAttached()
    val canStart =
      nativeRealtimeAuthorityLocked() != null ||
        (readinessConfig.mode == T3VoiceReadinessMode.THREAD &&
          controllerAttached &&
          readinessConfig.microphonePermissionGranted)
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
      .setContentTitle(if (active) "T3 voice active" else "T3 voice ready")
      .setContentText(
        when {
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
