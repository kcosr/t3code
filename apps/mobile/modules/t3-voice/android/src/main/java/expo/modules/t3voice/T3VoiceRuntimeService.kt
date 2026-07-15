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

  fun releaseIfIdleWhileLocked(): Boolean {
    check(Thread.holdsLock(lock)) { "Foreground release must hold the operation lock." }
    if (!isIdle()) return false
    releaseForeground()
    return true
  }
}

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

private data class T3VoiceNotificationSnapshot(
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

  internal inner class VoiceBinder : Binder() {
    private fun binderMessage(payloadKind: String) =
      VoiceKernelMessage.Command(callerIdentity = "voice-binder", payloadKind = payloadKind)

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

    fun disableRuntimeVoiceReadiness(): T3VoiceDisabledReadiness =
      mailbox.submitAndAwait(binderMessage("disable-readiness")) {
        synchronized(operationLock) { disableRuntimeVoiceReadinessLocked() }
      }

    fun disableRuntimeVoiceReadinessIfIdle(
      expectedRuntimeId: String?,
      expectedGeneration: Long?,
    ): T3VoiceDisabledReadiness? = mailbox.submitAndAwait(binderMessage("disable-readiness-if-idle")) {
      synchronized(operationLock) {
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
            voiceRuntimeRealtimeEngine?.snapshot() != null || runtimeThreadAttempt != null ||
              durableThreadOwnership ||
              T3VoiceStateStore.state.value.phase != T3VoiceRuntimePhase.IDLE,
          )) return@synchronized null
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
        voiceRuntimeSessionCredentialStore.clear()
        clearIdleRealtimeEngineLocked()
        return T3VoiceDisabledReadiness(next, revocation?.runtimeId)
    }

    fun pendingRuntimeRevocation(): T3VoicePendingRuntimeRevocation? =
      readinessStore.pendingRuntimeRevocation()

    fun runtimeVoiceOwnership(): Map<String, Any?>? = mailbox.submitAndAwait(binderMessage("ownership")) {
      synchronized(operationLock) {
        val state = T3VoiceStateStore.state.value
        val authority = readinessStore.activeAuthority()
        val canonicalFence = T3VoiceRuntimeOwnershipPolicy.canonicalFence(
          readinessConfig,
          authority,
          persistedAuthority(),
          readinessStore.prepared(),
          canonicalPreparedAuthority?.takeIf { !it.config.enabled },
        )
        val activeRealtimeOrigin = handoffEnvironmentOrigin?.takeIf {
          state.activeRealtimeSessionId != null
        }
        if (activeRealtimeOrigin == null && canonicalFence == null) return@synchronized null
        mapOf(
          "sequence" to state.sequence.toDouble(),
          "active" to runtimeControlSurfaceActiveLocked(state),
          "phase" to state.phase.name.lowercase(),
          "runtimeId" to canonicalFence?.runtimeId,
          "generation" to (canonicalFence?.generation ?: readinessConfig.generation).toDouble(),
          "environmentOrigin" to (activeRealtimeOrigin ?: canonicalFence?.environmentOrigin),
          "mode" to if (activeRealtimeOrigin != null) "realtime" else readinessConfig.mode.name.lowercase(),
          "targetId" to readinessConfig.targetId,
          "nativeSessionId" to state.activeRealtimeSessionId,
        )
      }
    }

    fun acknowledgeRuntimeRevocation(expected: T3VoicePendingRuntimeRevocation): Boolean =
      mailbox.submitAndAwait(binderMessage("acknowledge-revocation")) {
        synchronized(operationLock) {
        val pendingMatches = readinessStore.pendingRuntimeRevocation() == expected
        val acknowledged = T3VoiceRevocationAcknowledgementCoordinator.run(
          pendingMatches = pendingMatches,
          clearDerivedState = clearDerived@{
            when (val loaded = runtimeThreadOperationStore.load()) {
              is VoiceRuntimeThreadOperationLoadResult.Available -> {
                val threadOperation = loaded.state
                if (!VoiceRuntimeThreadRevocationPolicy.matches(threadOperation, expected)) {
                  return@clearDerived false
                }
                val activeAttempt = runtimeThreadAttempt?.takeIf {
                  it.clientOperationId == threadOperation.claim.clientOperationId
                }
                activeAttempt?.let {
                  it.cancelAllCalls()
                  it.stopped = true
                }
                val cleared = VoiceRuntimeThreadLocalCleanupCoordinator.complete(
                  deleteRecording = {
                    (threadOperation as? VoiceRuntimeThreadOperationState.Active)?.recording?.let {
                      runCatching { recorder.delete(it.recordingId, it.uri) }.isSuccess
                    } ?: true
                  },
                  clearDurableState = {
                    runCatching {
                      runtimeThreadOperationStore.clear(threadOperation.claim.clientOperationId)
                    }.getOrDefault(false)
                  },
                )
                if (!cleared) {
                  return@clearDerived false
                }
                if (activeAttempt != null) runtimeThreadAttempt = null
                if (runtimeSnapshot.mode == VoiceRuntimeExecutionMode.THREAD) {
                  applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
                }
              }
              VoiceRuntimeThreadOperationLoadResult.Locked ->
                if (!runtimeThreadOperationStore.clearLockedAfterAuthorityRevocation()) {
                  return@clearDerived false
                }
              VoiceRuntimeThreadOperationLoadResult.Missing -> Unit
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

    fun registerVoiceController(generation: Long) {
      mailbox.submit(binderMessage("register-controller")) {
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
          updateRuntimeControlSurfacesLocked()
        }
      }
    }

    fun unregisterVoiceController(generation: Long) {
      mailbox.submit(binderMessage("unregister-controller")) {
        synchronized(operationLock) {
          controllerCommands.unregister(generation)
          reconcileReadinessLocked()
        }
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
      mailbox.submit(binderMessage("start-recording")) {
        synchronized(operationLock) {
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
        synchronized(operationLock) {
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
        synchronized(operationLock) {
          val owner = requireRecordingOwner(
            recordingId,
            T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
          )
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
    }

    fun deleteRecording(recordingId: String, uri: String) {
      mailbox.submit(binderMessage("delete-recording")) {
        synchronized(operationLock) {
          val recording = checkNotNull(
            T3VoiceStateStore.recordingTermination.value
              ?.takeIf { it.recordingId == recordingId }
              ?.recording,
          ) { "Recording $recordingId is not owned by the bridge." }
          check(recording.uri == uri) { "Recording $recordingId URI does not match its terminal result." }
          recorder.delete(recordingId, recording.uri)
          T3VoiceStateStore.clearRecordingTermination(recordingId)
        }
      }
    }

    fun acknowledgeRecordingTermination(recordingId: String) {
      T3VoiceStateStore.clearRecordingTermination(recordingId)
    }

    fun discardUnownedRecordingTermination(recordingId: String): Boolean =
      mailbox.submitAndAwait(binderMessage("discard-recording-termination")) {
        synchronized(operationLock) {
        if (T3VoiceStateStore.isThreadVoiceHandoffRecordingProtected(recordingId)) {
          return@synchronized false
        }
        val termination = T3VoiceStateStore.recordingTermination.value
          ?.takeIf { it.recordingId == recordingId }
          ?: return@synchronized false
        termination.recording?.let { recording ->
          runCatching { recorder.delete(recordingId, recording.uri) }
            .onFailure {
              T3VoiceDiagnostics.record(
                0,
                T3VoiceDiagnosticCategory.TERMINAL,
                T3VoiceDiagnosticCode.FAILED,
              )
            }
        }
        T3VoiceStateStore.clearRecordingTermination(recordingId)
          true
        }
      }

    fun pendingRecordingTermination(): Map<String, Any?>? =
      T3VoiceStateStore.recordingTermination.value?.toEventBody()

    fun pendingThreadVoiceHandoff(): Map<String, Any>? =
      mailbox.submitAndAwait(binderMessage("pending-thread-handoff")) {
        synchronized(operationLock) {
        val handoff = T3VoiceStateStore.pendingThreadVoiceHandoff() ?: return@synchronized null
        if (
          handoff.expiresAtEpochMillis <= System.currentTimeMillis() &&
            !isThreadVoiceHandoffProtected(handoff.actionId)
        ) {
          discardRealtimeHandoffRecordingLocked(handoff.recordingId, "handoff-adoption-expired")
          T3VoiceStateStore.clearThreadVoiceHandoff(handoff.actionId)
          return@synchronized null
        }
          handoff.toEventBody()
        }
      }

    fun beginThreadVoiceHandoffAdoption(actionId: String): Boolean =
      mailbox.submitAndAwait(binderMessage("begin-thread-handoff-adoption")) {
        synchronized(operationLock) {
        val handoff = T3VoiceStateStore.pendingThreadVoiceHandoff()
          ?.takeIf { it.actionId == actionId }
          ?: return@synchronized false
        if (T3VoiceStateStore.isThreadVoiceHandoffAdopted(actionId)) {
          return@synchronized true
        }
        val protectUntil = handoff.expiresAtEpochMillis + HANDOFF_ADOPTION_CLAIM_GRACE_MILLIS
        if (protectUntil <= System.currentTimeMillis()) {
          expireThreadVoiceHandoffLocked(actionId, handoff.recordingId)
          return@synchronized false
        }
        if (!T3VoiceStateStore.beginThreadVoiceHandoffAdoption(actionId, protectUntil)) {
          return@synchronized false
        }
        recordingOwner?.takeIf {
          it.id == handoff.recordingId &&
            it.domain == T3VoiceOperationOwnerDomain.REALTIME_HANDOFF
        }?.let { owner ->
          recordingOwner = owner.copy(
            domain = T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
            operationId = handoff.recordingId,
          )
        }
        mainHandler.postDelayed(
          {
            if (!serviceDestroyed) synchronized(operationLock) {
              expireThreadVoiceHandoffLocked(actionId, handoff.recordingId)
            }
          },
          maxOf(0L, protectUntil - System.currentTimeMillis()),
        )
          true
        }
      }

    fun acknowledgeThreadVoiceHandoff(actionId: String, outcome: String) {
      mailbox.submit(binderMessage("acknowledge-thread-handoff")) {
        synchronized(operationLock) {
        val handoff = T3VoiceStateStore.pendingThreadVoiceHandoff()
          ?.takeIf { it.actionId == actionId }
          ?: return@synchronized
        if (outcome == "adopted") {
          T3VoiceStateStore.markThreadVoiceHandoffAdopted(actionId)
        } else if (!T3VoiceStateStore.isThreadVoiceHandoffAdopted(actionId)) {
          discardRealtimeHandoffRecordingLocked(handoff.recordingId, "handoff-adoption-failed")
          T3VoiceStateStore.clearThreadVoiceHandoff(actionId)
          }
        }
      }
    }

    fun armThreadVoiceHandoff(nativeSessionId: String) {
      mailbox.submit(binderMessage("arm-thread-handoff")) {
        synchronized(operationLock) {
          if (handoffEligibleSessionId != nativeSessionId) return@synchronized
          awaitingHandoffAction = true
        }
      }
    }

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      mailbox.submit(binderMessage("start-playback")) {
        synchronized(operationLock) {
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
        synchronized(operationLock) {
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

    fun acknowledgePlaybackTermination(playbackId: String) {
      T3VoiceStateStore.clearPlaybackTermination(playbackId)
    }

    fun pendingPlaybackTermination(): Map<String, Any>? =
      T3VoiceStateStore.playbackTermination.value?.toEventBody()

    fun prepareRealtimeSession(
      nativeSessionId: String,
      environmentOrigin: String,
      audioRouteId: String,
      callback: T3VoiceWebRtcResultCallback<String>,
    ) {
      mailbox.submit(binderMessage("prepare-realtime")) {
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
            check(T3VoiceStateStore.state.value.activeRealtimeSessionId == nativeSessionId) {
              "The Realtime peer terminated during preparation."
            }
            awaitingHandoffAction = false
            handoffEligibleSessionId = nativeSessionId
            handoffEnvironmentOrigin = environmentOrigin
            keepServiceStarted(ACTION_START_REALTIME, nativeSessionId)
          } catch (cause: Throwable) {
            handoffEligibleSessionId = null
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
    }

    fun applyRealtimeAnswer(
      nativeSessionId: String,
      sdp: String,
      callback: T3VoiceWebRtcResultCallback<Unit>,
    ) {
      realtime.applyAnswer(nativeSessionId, sdp, callback)
    }

    fun stopRealtimeSession(nativeSessionId: String): Boolean =
      mailbox.submitAndAwait(binderMessage("stop-realtime")) {
        synchronized(operationLock) {
          cancelRealtimeReadyCueLocked(nativeSessionId)
          realtime.stop(nativeSessionId)
        }
      }

    fun drainAndStopRealtimeSession(nativeSessionId: String) {
      mailbox.submit(binderMessage("drain-stop-realtime")) {
        synchronized(operationLock) {
          if (T3VoiceStateStore.state.value.activeRealtimeSessionId != nativeSessionId) {
            return@synchronized
          }
          drainRealtimeForStopLocked(nativeSessionId)
        }
      }
    }

    fun setRealtimeMuted(nativeSessionId: String, muted: Boolean) {
      realtime.setMuted(nativeSessionId, muted)
    }

    fun getAudioRoutes(): List<Map<String, Any>> = realtime.routes()

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()

    fun recordThreadVoiceHandoffClientStage(stage: String) {
      val code = when (stage) {
        "accepted" -> T3VoiceDiagnosticCode.HANDOFF_CLIENT_ACCEPTED
        "navigation-requested" -> T3VoiceDiagnosticCode.HANDOFF_NAVIGATION_REQUESTED
        "composer-adopted" -> T3VoiceDiagnosticCode.HANDOFF_COMPOSER_ADOPTED
        else -> error("Unsupported thread voice handoff client stage.")
      }
      T3VoiceDiagnostics.record(0, T3VoiceDiagnosticCategory.STATE, code)
    }

    fun setVoiceCuesEnabled(enabled: Boolean): T3VoiceCueSettings =
      mailbox.submitAndAwait(binderMessage("set-cues-enabled")) {
        synchronized(operationLock) {
          val wasEnabled = cueSettings.enabled
          cueSettings = cueSettingsStore.write(enabled)
          if (wasEnabled && !enabled) disablePendingCuesLocked()
          cueSettings
        }
      }

    fun setAudioRoute(nativeSessionId: String, routeId: String): List<Map<String, Any>> =
      realtime.selectRoute(nativeSessionId, routeId)

    fun voiceRuntimeSnapshot(): VoiceRuntimeSnapshot =
      mailbox.submitAndAwait(binderMessage("snapshot")) {
        synchronized(operationLock) { voiceRuntimeController.snapshot() }
      }

    fun setVoiceRuntimeSessionCredential(environmentOrigin: String, credential: String) =
      mailbox.submit(binderMessage("set-session-credential")) {
        synchronized(operationLock) {
          voiceRuntimeSessionCredentialStore.set(environmentOrigin, credential)
        }
      }

    fun configureVoiceRuntimeAuthority(
      authority: VoiceRuntimeBridge.ParsedAuthority,
    ): VoiceRuntimeSnapshot = mailbox.submitAndAwait(binderMessage("configure-authority")) {
      synchronized(operationLock) {
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
      val slotFence = voiceRuntimeRealtimeEngineSlot.fence()
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
                slotFence,
                requireNotNull(realtimeAuthority),
                candidateEngine,
              )
            realtimeAuthority == null && installedBinding != null ->
              voiceRuntimeRealtimeEngineSlot.stageIdleClear(slotFence)
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
        synchronized(operationLock) {
          val snapshot = voiceRuntimeController.snapshot()
          val persisted = (voiceRuntimeAuthorityStore.load()
            as? VoiceRuntimeAuthorityLoadResult.Available)?.authority
          if (persisted != null && persisted.runtimeId == snapshot.identity.runtimeId) {
            return@synchronized VoiceRuntimeAuthorityInspection(
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
        synchronized(operationLock) {
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
        synchronized(operationLock) { voiceRuntimeController.attach(presentation) }
      }

    fun updateVoiceRuntimeAttachment(
      lease: VoiceRuntimeConsumerLease,
      presentation: VoiceRuntimePresentation,
    ): VoiceRuntimeConsumerLease = mailbox.submitAndAwait(binderMessage("update-attachment")) {
      synchronized(operationLock) { voiceRuntimeController.updateAttachment(lease, presentation) }
    }

    fun detachVoiceRuntime(lease: VoiceRuntimeConsumerLease) = mailbox.submit(binderMessage("detach")) {
      synchronized(operationLock) {
        voiceRuntimeController.detach(lease)
        if (!voiceRuntimeController.hasConsumers()) cancelVoiceRuntimeThreadRearmLocked()
        clearIdleAttachedOnlyAuthorityLocked()
      }
    }

    fun readVoiceRuntime(
      lease: VoiceRuntimeConsumerLease,
      after: VoiceRuntimeCursor?,
    ): VoiceRuntimeDelivery = mailbox.submitAndAwait(binderMessage("read")) {
      synchronized(operationLock) { voiceRuntimeController.deliver(lease, after) }
    }

    fun acknowledgeVoiceRuntime(lease: VoiceRuntimeConsumerLease, through: VoiceRuntimeCursor) =
      mailbox.submit(binderMessage("acknowledge")) {
        synchronized(operationLock) { voiceRuntimeController.acknowledge(lease, through) }
      }

    fun acknowledgeVoiceRuntimeRetainedRecord(
      identity: VoiceRuntimeIdentity,
      key: VoiceRuntimeRetainedRecordKey,
    ) = mailbox.submit(binderMessage("acknowledge-retained-record")) {
      synchronized(operationLock) { voiceRuntimeController.acknowledgeRetainedRecord(identity, key) }
    }

    fun dispatchVoiceRuntime(
      command: VoiceRuntimeNativeCommand,
      admission: T3VoiceBinderOperationAdmission,
    ): VoiceRuntimeCommandReceipt = mailbox.submitAndAwait(binderMessage("dispatch")) {
      if (command !is VoiceRuntimeNativeCommand.StopMode) {
        synchronized(operationLock) {
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
        is VoiceRuntimeNativeCommand.Thread -> synchronized(operationLock) {
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
          synchronized(operationLock) {
            ensureRuntimeForeground(
              ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
          }
          val admissionResult = voiceRuntimeRealtimeBinderOffload.submitStart(
            admit = {
              engine.admitStart(
                command.commandId,
                VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
                admission::tryAdmit,
              )
            },
            complete = { pending ->
              val result = engine.start(pending)
              if (result is VoiceRuntimeRealtimeCommandResult.Rejected &&
                result.reason == "start-cancelled") {
                synchronized(operationLock) { reconcileForegroundAfterVoiceStopLocked() }
              }
            },
          )
          if (admissionResult is VoiceRuntimeRealtimeCommandResult.Rejected &&
            admissionResult.reason == "start-cancelled") {
            synchronized(operationLock) { reconcileForegroundAfterVoiceStopLocked() }
          }
          realtimeCommandReceipt(command, admissionResult)
        }
        is VoiceRuntimeNativeCommand.StopMode -> {
          check(admission.tryAdmit()) { "The voice stop was cancelled before admission." }
          val operation = synchronized(operationLock) { voiceRuntimeController.snapshot().operation }
          if (operation is VoiceRuntimeOperation.ThreadTurn) {
            synchronized(operationLock) {
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
              requireRealtimeEngineLocked(command.identity).stop(
                command.commandId,
                VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
                policy,
              ),
            )
          }
        }
        is VoiceRuntimeNativeCommand.SetRealtimeMuted -> realtimeBooleanReceipt(command) {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          requireRealtimeEngineLocked(command.identity).setMuted(
            VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
            command.muted,
          )
        }
        is VoiceRuntimeNativeCommand.UpdateRealtimeFocus -> {
          check(admission.tryAdmit()) { "The voice operation was cancelled before admission." }
          val engine = requireRealtimeEngineLocked(command.identity)
          val fence = VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId)
          val focused = voiceRuntimeRealtimeBinderOffload.submitFocus(
            admit = { engine.admitFocus(fence) },
            operation = {
              engine.updateFocus(
                fence,
                command.commandId,
                command.focus,
              )
            },
            onFailure = { recordVoiceRuntimeRealtimeControlFailure() },
            failure = { VoiceRuntimeFenceException("Realtime focus update failed.") },
          )
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
          synchronized(operationLock) {
            val pending = voiceRuntimeRealtimeEngine?.snapshot()?.pendingAction
              as? VoiceRuntimeRealtimeAction.ConfirmationRequired
              ?: throw VoiceRuntimeFenceException("Realtime confirmation is stale.")
            if (pending.actionId != command.actionId ||
              pending.confirmationId != command.confirmationId) {
              throw VoiceRuntimeFenceException("Realtime confirmation is stale.")
            }
            voiceRuntimeController.claimPresentationAction(command.lease, command.actionId)
          }
          val engine = requireRealtimeEngineLocked(command.identity)
          val admissionResult = voiceRuntimeRealtimeBinderOffload.submitAcknowledgement(
            operation = {
              engine.acknowledgePresentationAction(
                VoiceRuntimeRealtimeFence(command.identity, command.modeSessionId),
                command.commandId,
                command.actionId,
                VoiceRuntimeRealtimePresentationDecision.Confirmation(
                  command.confirmationId,
                  command.decision,
                ),
              )
            },
            onAcknowledged = {
              synchronized(operationLock) {
                voiceRuntimeController.acknowledgePresentationAction(command.lease, command.actionId)
              }
            },
            onFailure = { recordVoiceRuntimeRealtimeControlFailure() },
            failure = { VoiceRuntimeFenceException("Realtime confirmation acknowledgement failed.") },
          )
          realtimeCommandReceipt(command, admissionResult)
        }
      }
    }

    fun readVoiceRuntimeDraft(lease: VoiceRuntimeConsumerLease, artifactId: String) =
      mailbox.submitAndAwait(binderMessage("read-draft")) {
        synchronized(operationLock) { voiceRuntimeController.readDraft(lease, artifactId) }
      }

    fun acknowledgeVoiceRuntimeDraft(
      lease: VoiceRuntimeConsumerLease,
      artifactId: String,
      outcome: String,
    ) = mailbox.submit(binderMessage("acknowledge-draft")) {
      synchronized(operationLock) { voiceRuntimeController.acknowledgeDraft(lease, artifactId, outcome) }
    }

    fun claimVoiceRuntimePresentationAction(
      lease: VoiceRuntimeConsumerLease,
      actionId: String,
    ) = mailbox.submitAndAwait(binderMessage("claim-presentation-action")) {
      synchronized(operationLock) { voiceRuntimeController.claimPresentationAction(lease, actionId) }
    }

    fun acknowledgeVoiceRuntimePresentationAction(
      lease: VoiceRuntimeConsumerLease,
      actionId: String,
      outcome: String,
      message: String?,
    ) {
      mailbox.submit(binderMessage("acknowledge-presentation-action")) {
        val realtime = synchronized(operationLock) {
          val pending = voiceRuntimeRealtimeEngine?.snapshot()?.pendingAction
          val realtimeActionId = when (pending) {
            is VoiceRuntimeRealtimeAction.NavigateThread -> pending.actionId
            is VoiceRuntimeRealtimeAction.ConfirmationRequired ->
              throw VoiceRuntimeFenceException(
                "Realtime confirmations require an explicit approval decision.",
              )
            else -> null
          }
          if (realtimeActionId != actionId) {
            return@synchronized null
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
        voiceRuntimeRealtimeBinderOffload.submitPresentationAcknowledgement(
          hasRealtimeMatch = realtime != null,
          operation = {
            requireNotNull(realtime).first.acknowledgePresentationAction(
              realtime.second,
              "action-$actionId-${UUID.randomUUID()}",
              actionId,
              realtime.third,
            )
          },
          onAcknowledged = {
            synchronized(operationLock) {
              voiceRuntimeController.acknowledgePresentationAction(lease, actionId)
            }
          },
          onFailure = { recordVoiceRuntimeRealtimeControlFailure() },
          failure = { VoiceRuntimeFenceException("Realtime action acknowledgement failed.") },
        )
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
    VoiceRuntimeRealtimeEngineSlot<VoiceRuntimeRealtimeEngine>(isActive = {
      it.isOperational()
    })
  private val voiceRuntimeRealtimeEngine: VoiceRuntimeRealtimeEngine?
    get() = voiceRuntimeRealtimeEngineSlot.snapshot().current?.engine
  private val voiceRuntimeRealtimeServer = VoiceRuntimeRealtimeHttpGateway(::sessionCredential)
  private val voiceRuntimeRealtimeHeartbeatIo: ExecutorService = Executors.newCachedThreadPool()
  private val voiceRuntimeRealtimeActionIo: ExecutorService = Executors.newCachedThreadPool()
  private val voiceRuntimeRealtimeOfferIo: ExecutorService = Executors.newCachedThreadPool()
  private val voiceRuntimeRealtimeStartIo: ExecutorService = Executors.newCachedThreadPool()
  private val voiceRuntimeRealtimeCleanupIo: ExecutorService = Executors.newCachedThreadPool()
  private val voiceRuntimeRealtimeControlIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val voiceRuntimeRealtimeBinderOffload = VoiceRuntimeRealtimeBinderOffload(
    startPost = { voiceRuntimeRealtimeStartIo.submit(it) },
    controlPost = { voiceRuntimeRealtimeControlIo.submit(it) },
  )
  private var voiceRuntimeRealtimeHeartbeatTask: Runnable? = null
  private var voiceRuntimeRealtimeActionTask: Runnable? = null
  private var voiceRuntimeRealtimeDrainTask: Runnable? = null
  private var voiceRuntimeRealtimeFinalizationTask: Runnable? = null
  private var voiceRuntimeThreadRearmTask: Runnable? = null
  private var canonicalPreparedAuthority: T3VoicePreparedReadiness? = null
  private val startCommandStickiness = T3VoiceStartCommandStickinessCache()
  private var readinessConfig = T3VoiceReadinessConfig()
    set(value) {
      field = value
      startCommandStickiness.publish(value)
    }
  private var cueSettings = T3VoiceCueSettings()
  private var runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
  @Volatile private var serviceDestroyed = false
  private val runtimeRealtimeIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val runtimeThreadCancellationIo: ExecutorService = Executors.newSingleThreadExecutor()
  private val runtimeThreadServer = VoiceRuntimeThreadTurnDelegate()
  private var runtimeThreadAttempt: VoiceRuntimeThreadAttempt? = null
  private var pendingRuntimeHandoffActivation: T3VoicePendingRuntimeHandoffActivation? = null
  private var realtimeFinalizationTransitionAuthority: VoiceRuntimePersistedAuthority? = null
  private var detachedThreadContinuationAdmission = false
  private val controllerCommands = T3VoiceControllerCommands()
  private var mediaSession: MediaSession? = null
  @Volatile private var foregroundServiceTypes = 0
  @Volatile private var notificationSnapshot = T3VoiceNotificationSnapshot()
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
  private var handoffEnvironmentOrigin: String? = null
  private var awaitingHandoffAction = false
  private lateinit var recorder: T3VoiceRecorder
  private lateinit var player: T3VoicePcmPlayer
  private lateinit var playbackAudioFocus: T3VoicePlaybackAudioFocus
  private lateinit var cueCoordinator: T3VoiceCueCoordinator
  private var nextCueGeneration = 0L
  private var realtimeReadyCue: Pair<String, Long>? = null
  private var realtimeEndedCue: Pair<String, Long>? = null
  private var realtimeStopDrainSessionId: String? = null
  private var pendingRecordingStart: T3VoicePendingRecordingStart? = null
  private var recordingEndedCue: Pair<String, Long>? = null
  private val mainHandler = Handler(Looper.getMainLooper())
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
              val canonical = voiceRuntimeRealtimeEngine?.snapshot()?.takeIf {
                it.fence.modeSessionId == sessionId
              }
              if (canonical != null && connectionState == "connected" && !inputReady) {
                canonical.serverSessionId?.let { serverSessionId ->
                  val engine = voiceRuntimeRealtimeEngine
                  voiceRuntimeRealtimeControlIo.submit {
                    runCatching { engine?.onPeerConnected(canonical.fence, serverSessionId) }
                  }
                }
              } else if (connectionState == "connected" && !inputReady) {
                beginRealtimeReadyCueLocked(sessionId)
              }
              updateRuntimeControlSurfacesLocked()
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
          mainHandler.post {
            if (serviceDestroyed) return@post
            synchronized(operationLock) {
              val canonical = voiceRuntimeRealtimeEngine?.snapshot()?.takeIf {
                it.fence.modeSessionId == sessionId
              }
              if (canonical != null) {
                T3VoiceStateStore.terminateRealtime(
                  T3VoiceRuntimeEvent.RealtimeTerminated(
                    nativeSessionId = sessionId,
                    outcome = outcome,
                    code = code,
                    retryable = retryable,
                  ),
                )
                canonical.serverSessionId?.let { serverSessionId ->
                  val engine = voiceRuntimeRealtimeEngine
                  voiceRuntimeRealtimeControlIo.submit {
                    runCatching {
                      engine?.onPeerTerminated(canonical.fence, serverSessionId, code)
                    }
                  }
                }
                updateRuntimeControlSurfacesLocked()
                return@synchronized
              }
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
          }
        },
      )
    }
  private val realtime: T3VoiceWebRtcSession
    get() = realtimeDelegate.value

  private fun beginRealtimeReadyCueLocked(sessionId: String) {
    val state = T3VoiceStateStore.state.value
    if (
      handoffInProgress ||
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

  private fun drainRealtimeForStopLocked(sessionId: String) {
    if (realtimeStopDrainSessionId == sessionId) return
    cancelRealtimeReadyCueLocked(sessionId)
    realtimeStopDrainSessionId = sessionId
    try {
      realtime.drainPlayout(sessionId) {
        mainHandler.post {
          if (!serviceDestroyed) synchronized(operationLock) {
            if (realtimeStopDrainSessionId == sessionId) realtimeStopDrainSessionId = null
            if (
              !handoffInProgress &&
                T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId
            ) {
              runCatching { realtime.stop(sessionId) }
            }
          }
        }
      }
    } catch (_: Throwable) {
      if (realtimeStopDrainSessionId == sessionId) realtimeStopDrainSessionId = null
      if (T3VoiceStateStore.state.value.activeRealtimeSessionId == sessionId) {
        runCatching { realtime.stop(sessionId) }
      }
    }
  }

  private fun completeRealtimeReadyCueLocked(sessionId: String, generation: Long) {
    if (realtimeReadyCue != sessionId to generation) return
    realtimeReadyCue = null
    val state = T3VoiceStateStore.state.value
    if (
      handoffInProgress ||
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

  override fun onCreate() {
    super.onCreate()
    readinessStore = T3VoiceReadinessStore(applicationContext)
    cueSettingsStore = T3VoiceCueSettingsStore(applicationContext)
    runtimeSnapshotStore = VoiceRuntimeExecutionSnapshotStore(applicationContext)
    runtimeThreadOperationStore = VoiceRuntimeThreadOperationStore(applicationContext)
    voiceRuntimeAuthorityStore = VoiceRuntimeAuthorityStore(applicationContext)
    voiceRuntimeSessionCredentialStore = VoiceRuntimeSessionCredentialStore(applicationContext)
    val retiredAuthorityFence = voiceRuntimeAuthorityStore.retireLegacyV2()
    if (retiredAuthorityFence != null) voiceRuntimeSessionCredentialStore.clear()
    voiceRuntimeRealtimeRepository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(applicationContext)
    runtimeSnapshot = runtimeSnapshotStore.read()
    runCatching {
      VoiceRuntimeLegacyRealtimeCutover(
        runtimeSnapshotStore,
        VoiceRuntimeRealtimeCleanupStore(applicationContext),
      ).migrate(runtimeSnapshot)
    }.onSuccess { cutover ->
      runtimeSnapshot = cutover.snapshot
      if (cutover.migrated) {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.LEGACY_REALTIME_RETIRED,
        )
      }
    }.onFailure {
      // The retired owner remains unavailable even if its local tombstone cannot be cleared.
      runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
      )
    }
    readinessConfig =
      readinessStore.read().copy(
        microphonePermissionGranted = hasPermission(Manifest.permission.RECORD_AUDIO),
        notificationPermissionGranted =
          Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            hasPermission(Manifest.permission.POST_NOTIFICATIONS),
      )
    val startupAttachedPreparationResult = runCatching {
      voiceRuntimeAuthorityStore.inspectPreparedAttachedAuthority()
    }
    var startupAttachedPreparation = startupAttachedPreparationResult.getOrNull()
    var canonicalInstalled = voiceRuntimeAuthorityStore.load()
      as? VoiceRuntimeAuthorityLoadResult.Available
    val startupFinalization = runCatching {
      voiceRuntimeRealtimeRepository.loadFinalization()
    }.onFailure {
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
      )
    }.getOrNull()
    val startupRealtimeCheckpoint = runCatching {
      voiceRuntimeRealtimeRepository.load()
    }.onFailure {
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
      )
    }.getOrNull()
    canonicalInstalled?.authority?.let { canonical ->
      val reconciled = runCatching {
        if (!canonical.readinessEnabled) {
          val aligned = T3VoiceCanonicalReadinessPolicy.transient(readinessConfig, canonical)
          readinessStore.write(aligned)
          readinessConfig = verifyReadiness(aligned)
        } else {
          when (val decision = VoiceRuntimeCommittedReadinessPolicy.reconcile(
              canonical,
              readinessStore.prepared(),
              readinessStore.activeAuthority(),
            )) {
            VoiceRuntimeCommittedReadinessDecision.NotRequired ->
              error("Persistent readiness reconciliation was not required.")
            is VoiceRuntimeCommittedReadinessDecision.Current ->
              readinessConfig = verifyReadiness(decision.authority.config)
            is VoiceRuntimeCommittedReadinessDecision.Promote -> {
              readinessStore.writeActivated(decision.authority.config, decision.authority)
              readinessConfig = verifyReadiness(decision.authority.config)
            }
            VoiceRuntimeCommittedReadinessDecision.Mismatch ->
              error("Canonical authority and readiness state do not match.")
          }
        }
      }.isSuccess
      if (!reconciled) {
        runCatching { voiceRuntimeAuthorityStore.clear() }
        runCatching { readinessStore.write(readinessConfig.copy(enabled = false)) }
        readinessConfig = readinessConfig.copy(enabled = false)
        canonicalInstalled = null
      }
    }
    val startupPersistentReadinessResult =
      if (canonicalInstalled == null) runCatching { readinessStore.prepared() }
      else Result.success(null)
    val startupPersistentReadiness = startupPersistentReadinessResult.getOrNull()
    val startupPersistentPreparationResult =
      if (canonicalInstalled == null) {
        runCatching {
          T3VoiceStartupAuthorityFencePolicy.persistentPreparation(
            startupPersistentReadiness,
          )
        }
      } else {
        Result.success(null)
      }
    val startupActiveAuthorityResult = runCatching { readinessStore.activeAuthority() }
    val startupActiveAuthority = startupActiveAuthorityResult.getOrNull()
    val recoveredFences = arrayOf(
      startupFinalization?.fence?.identity?.let {
        T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation)
      },
      startupRealtimeCheckpoint?.fence?.identity?.let {
        T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation)
      },
      retiredAuthorityFence?.let {
        T3VoiceRecoveredAuthorityFence(it.runtimeId, it.generation)
      },
      startupActiveAuthority?.let {
        T3VoiceRecoveredAuthorityFence(it.runtimeId, it.config.generation)
      },
    )
    val preparationSelection = startupPersistentPreparationResult.mapCatching { persistent ->
      check(startupPersistentReadinessResult.isSuccess)
      check(startupAttachedPreparationResult.isSuccess)
      check(startupActiveAuthorityResult.isSuccess)
      T3VoiceStartupAuthorityFencePolicy.selectPreparation(
        persistent,
        startupAttachedPreparation?.takeIf { canonicalInstalled == null },
      )
    }
    var startupResolution = preparationSelection.fold(
      onSuccess = { preparation ->
        T3VoiceStartupAuthorityFencePolicy.resolve(preparation, *recoveredFences)
      },
      onFailure = {
        val recoveredRuntimeId = recoveredFences.filterNotNull().firstOrNull()?.runtimeId
        val preparationRuntimeId = runCatching {
          T3VoiceStartupAuthorityFencePolicy.selectRuntimeId(
            startupPersistentReadiness?.runtimeId,
            startupAttachedPreparation?.fence?.runtimeId,
          )
        }.getOrNull()
        val selectedRuntimeId = recoveredRuntimeId ?: preparationRuntimeId
        val recoveredGeneration = recoveredFences.asSequence()
          .filterNotNull()
          .filter { it.runtimeId == selectedRuntimeId }
          .maxOfOrNull { it.generation }
        val preparationGeneration = sequenceOf(
          startupPersistentReadiness?.let { it.runtimeId to it.config.generation },
          startupAttachedPreparation?.fence?.let { it.runtimeId to it.generation },
        ).filterNotNull()
          .filter { it.first == selectedRuntimeId }
          .maxOfOrNull { it.second }
        T3VoiceStartupAuthorityResolution(
          preparation = null,
          runtimeId = selectedRuntimeId,
          initialGeneration = recoveredGeneration ?: preparationGeneration,
          discardPreparation = canonicalInstalled == null && (
            startupPersistentReadinessResult.isFailure ||
              startupAttachedPreparationResult.isFailure || startupPersistentReadiness != null ||
              startupActiveAuthorityResult.isFailure ||
              startupAttachedPreparation != null
          ),
        )
      },
    )
    if (startupResolution.discardPreparation) {
      val readinessRuntimeIds = listOfNotNull(
        startupActiveAuthority?.runtimeId,
        startupPersistentReadiness?.runtimeId,
        startupAttachedPreparation?.fence?.runtimeId,
      )
      val readinessGeneration = readinessConfig.generation.takeIf {
        startupResolution.runtimeId == null ||
          readinessRuntimeIds.any { runtimeId -> runtimeId == startupResolution.runtimeId }
      }
      val generationFloor = maxOf(
        startupResolution.initialGeneration ?: 0,
        readinessGeneration ?: 0,
      )
      val pendingRevocation = startupPersistentReadiness?.let {
        T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
      } ?: startupAttachedPreparation?.let {
        T3VoicePendingRuntimeRevocation(it.fence.runtimeId, it.fence.environmentOrigin)
      }
      val disabled = readinessConfig.copy(enabled = false, generation = generationFloor)
      readinessStore.writeDisabledForRuntimeRevocation(disabled, pendingRevocation)
      voiceRuntimeAuthorityStore.discardInitialPreparation()
      readinessConfig = disabled
      startupAttachedPreparation = null
      T3VoiceDiagnostics.record(
        0,
        T3VoiceDiagnosticCategory.TERMINAL,
        T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
      )
      startupResolution = startupResolution.copy(
        preparation = null,
        initialGeneration = generationFloor,
      )
    }
    val installedRuntimeId = T3VoiceRecoveredRealtimeAuthorityPolicy.runtimeId(
      canonicalInstalled?.authority,
      startupFinalization,
      startupRealtimeCheckpoint,
      retiredAuthorityFence,
      startupActiveAuthority,
    ) ?: startupResolution.runtimeId
    val canonicalRuntimeId = VoiceRuntimeDeviceIdentityStore(applicationContext)
      .getOrCreate(installedRuntimeId)
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
      realtimeTerminalAcknowledgement = voiceRuntimeRealtimeRepository::acknowledgeTerminal,
      onJournalChanged = { cursor ->
        T3VoiceStateStore.emit(T3VoiceRuntimeEvent.VoiceRuntimeWake(
          cursor.runtimeId,
          cursor.runtimeInstanceId,
          cursor.generation,
          cursor.sequence,
        ))
      },
      initialGeneration = when {
        canonicalInstalled != null -> null
        else -> startupResolution.initialGeneration
      },
    )
    startupAttachedPreparation?.takeIf { canonicalInstalled == null }?.let { prepared ->
      val config = verifyReadiness(prepared.readiness)
      readinessStore.write(config)
      readinessConfig = config
      canonicalPreparedAuthority = T3VoicePreparedReadiness(
        config,
        prepared.fence.runtimeId,
        prepared.fence.environmentOrigin,
        prepared.fence.target.grantOperation(),
        prepared.fence.targetDigest,
      )
    }
    cueSettings = cueSettingsStore.read()
    cueCoordinator = T3VoiceCueCoordinator()
    val canonicalRestored = canonicalInstalled?.authority?.let(::restoreCanonicalAuthorityLocked) == true
    if (!installRecoveredRealtimeStateLocked() && canonicalRestored) {
      canonicalInstalled?.authority?.let(::installRealtimeEngineLocked)
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
              runtimeThreadAttempt?.takeIf { it.operationId == owner.id }?.let { attempt ->
                handleRuntimeThreadRecordingLocked(attempt, termination.recording)
              }
            }
            is T3VoiceRecordingTermination.Cancelled -> {
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
              failNativeThreadRecordingLocked(owner, "native-thread-recording-cancelled")
            }
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
              failNativeThreadRecordingLocked(owner, "native-thread-recording-failed")
            }
          }
          beginRecordingEndedCueLocked(owner.id)
        }
      }
    val loadedThreadOperation = runtimeThreadOperationStore.load()
    if (!VoiceRuntimeThreadRecordingRecovery.restore(
        loadedThreadOperation,
        recorder::restoreCompleted,
      )) {
      val active = (loadedThreadOperation as? VoiceRuntimeThreadOperationLoadResult.Available)
        ?.state as? VoiceRuntimeThreadOperationState.Active
      if (active != null) {
        runtimeThreadOperationStore.writeActive(
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
              runtimeThreadAttempt?.takeIf {
                playbackId == runtimeThreadPlaybackId(it, it.playingSegment)
              }?.let { attempt ->
                val segment = requireNotNull(attempt.playingSegment)
                attempt.playingSegment = null
                attempt.playbackFailures = 0
                val persisted = applyRuntimeEventLocked(
                  VoiceRuntimeExecutionEvent.PlaybackDrained(requireNotNull(attempt.operationId), segment),
                )
                if (persisted != null && runtimeThreadAttempt === attempt) {
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
            handlePlaybackTerminationLocked(playbackId, "failed")
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
          if (!serviceDestroyed) synchronized(operationLock) { startRuntimeThreadLocked() }
        }
      }
    }
  }

  private fun reconcilePersistedThreadOperationLocked(): Boolean {
    val loaded = runtimeThreadOperationStore.load()
    val now = System.currentTimeMillis()
    val grant = persistedAuthority()
    val preparedClaim = ((loaded as? VoiceRuntimeThreadOperationLoadResult.Available)?.state
      as? VoiceRuntimeThreadOperationState.Prepared)?.claim
    val parentGrantAvailable =
      preparedClaim != null &&
        grant?.let { persisted ->
          val target = persisted.target as? VoiceRuntimeTarget.Thread
          target != null && persisted.runtimeId == preparedClaim.runtimeId &&
            persisted.generation == preparedClaim.readinessGeneration &&
            persisted.environmentOrigin == preparedClaim.environmentOrigin &&
            target.projectId == preparedClaim.projectId && target.threadId == preparedClaim.threadId
        } == true
    when (VoiceRuntimeThreadStoredStatePolicy.decide(
      loaded,
      parentGrantAvailable,
      now,
    )) {
      VoiceRuntimeThreadStoredStateDecision.NONE -> return false
      VoiceRuntimeThreadStoredStateDecision.RESTORE -> return true
      VoiceRuntimeThreadStoredStateDecision.CANCEL_PREPARED -> {
        val prepared = (loaded as VoiceRuntimeThreadOperationLoadResult.Available)
          .state as VoiceRuntimeThreadOperationState.Prepared
        runtimeThreadOperationStore.writePrepared(
          prepared.claim,
          cancelRequested = true,
        )
        return true
      }
      VoiceRuntimeThreadStoredStateDecision.CANCEL_UNDISPATCHED -> {
        val active = (loaded as VoiceRuntimeThreadOperationLoadResult.Available)
          .state as VoiceRuntimeThreadOperationState.Active
        runtimeThreadOperationStore.writeActive(
          active.copy(detached = true, cancelRequested = true),
        )
        return true
      }
      VoiceRuntimeThreadStoredStateDecision.REVOKE -> Unit
    }
    revokePersistedThreadOperationLocked(loaded, grant)
    return false
  }

  private fun revokePersistedThreadOperationLocked(
    loaded: VoiceRuntimeThreadOperationLoadResult,
    grant: VoiceRuntimePersistedAuthority?,
  ) {
    T3VoiceDiagnostics.record(
      0,
      T3VoiceDiagnosticCategory.TERMINAL,
      T3VoiceDiagnosticCode.THREAD_RECONCILIATION_REQUIRED,
    )
    val pending = readinessStore.pendingRuntimeRevocation() ?: when (loaded) {
      is VoiceRuntimeThreadOperationLoadResult.Available ->
        T3VoicePendingRuntimeRevocation(
          loaded.state.claim.runtimeId,
          loaded.state.claim.environmentOrigin,
        )
      VoiceRuntimeThreadOperationLoadResult.Locked ->
        readinessStore.activeAuthority()?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        } ?: grant?.let {
          T3VoicePendingRuntimeRevocation(it.runtimeId, it.environmentOrigin)
        }
      VoiceRuntimeThreadOperationLoadResult.Missing -> null
    }
    if (pending != null) {
      val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
        readinessConfig,
        voiceRuntimeController.snapshot().identity.generation,
      )
      readinessStore.writeDisabledForRuntimeRevocation(disabled, pending)
      readinessConfig = disabled
      canonicalPreparedAuthority = null
      voiceRuntimeAuthorityStore.clear()
      controllerCommands.invalidateReadiness()
    } else if (loaded == VoiceRuntimeThreadOperationLoadResult.Locked) {
      runtimeThreadOperationStore.clearLockedAfterAuthorityRevocation()
      runtimeSnapshotStore.clear()
      runtimeSnapshot = VoiceRuntimeExecutionSnapshot()
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
        synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.PRIMARY) }
      }
      ACTION_STOP -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
      ) {
        synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.STOP) }
      }
      ACTION_TOGGLE_MUTE -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_TOGGLE_MUTE),
      ) {
        synchronized(operationLock) { executeControlCommandLocked(T3VoiceControlCommand.TOGGLE_MUTE) }
      }
      ACTION_DISABLE_READINESS -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_DISABLE_READINESS),
      ) {
        synchronized(operationLock) { disableReadinessLocked() }
      }
      ACTION_READINESS -> mailbox.submit(
        VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_READINESS),
      ) {
        synchronized(operationLock) { reconcileReadinessLocked() }
      }
      ACTION_START_RECORDING -> {
        val foregroundServiceType = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        promoteForegroundOnMainThread(foregroundServiceType)
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_RECORDING),
        ) {
          synchronized(operationLock) {
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
        promoteForegroundOnMainThread(foregroundServiceType)
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_PLAYBACK),
        ) {
          synchronized(operationLock) {
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
        promoteForegroundOnMainThread(foregroundServiceType)
        mailbox.submit(
          VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_START_REALTIME),
        ) {
          synchronized(operationLock) {
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
        synchronized(operationLock) {
          if (readinessConfig.enabled) reconcileReadinessLocked() else stopSelf(startId)
        }
      }
    }
    // The kernel may update readiness just after this read; one intent may return stale stickiness.
    return startCommandStickiness.value
  }

  override fun onDestroy() {
    mailbox.drainAndQuit()
    synchronized(operationLock) {
      serviceDestroyed = true
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
      T3VoiceStateStore.pendingThreadVoiceHandoff()?.let { handoff ->
        discardRealtimeHandoffRecordingLocked(handoff.recordingId, "service-destroyed")
        T3VoiceStateStore.clearThreadVoiceHandoff(handoff.actionId)
      }
      stopRuntimeThreadLocked(cancelServer = true)
      cancelVoiceRuntimeRealtimeTasksLocked()
      cancelVoiceRuntimeRealtimeFinalizationLocked()
    }
    recorder.release()
    player.release()
    cueCoordinator.release()
    playbackAudioFocus.stop()
    if (realtimeDelegate.isInitialized()) realtime.release()
    runtimeThreadAttempt?.cancelAllCalls()
    runtimeRealtimeIo.shutdownNow()
    runtimeThreadCancellationIo.shutdownNow()
    voiceRuntimeRealtimeHeartbeatIo.shutdownNow()
    voiceRuntimeRealtimeActionIo.shutdownNow()
    voiceRuntimeRealtimeOfferIo.shutdownNow()
    voiceRuntimeRealtimeStartIo.shutdownNow()
    voiceRuntimeRealtimeCleanupIo.shutdownNow()
    voiceRuntimeRealtimeControlIo.shutdownNow()
    releaseWakeLockLocked()
    releaseMediaSessionLocked()
    T3VoiceStateStore.setInactive()
    super.onDestroy()
  }

  private fun startRuntimeForeground(foregroundServiceType: Int) {
    T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(foregroundServiceType)
    val snapshot = captureNotificationSnapshotLocked()
    notificationSnapshot = snapshot
    val notification = buildNotification(snapshot)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, foregroundServiceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    T3VoiceStateStore.setForeground(true)
    foregroundServiceTypes = foregroundServiceType
    updateRuntimeControlSurfacesLocked()
  }

  private fun promoteForegroundOnMainThread(foregroundServiceType: Int) {
    T3VoiceForegroundLifecyclePolicy.requireDeclaredNonzero(foregroundServiceType)
    val notification = buildNotification(notificationSnapshot)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, foregroundServiceType)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundServiceTypes = foregroundServiceType
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
    check(Thread.holdsLock(operationLock))
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
            revokePersistedThreadOperationLocked(persisted, null)
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
          revokePersistedThreadOperationLocked(persisted, null)
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
      mainHandler.postDelayed({
        if (!serviceDestroyed) synchronized(operationLock) {
          if (runtimeThreadAttempt === attempt && !attempt.stopped) {
            createRuntimeThreadOperation(attempt)
          }
        }
      }, VoiceRuntimeThreadRetryPolicy.delayMillis(++attempt.retryFailures))
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
    runtimeRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          handleRuntimeThreadCreatedLocked(attempt, result)
        }
      }
    }
  }

  private fun handleRuntimeThreadCreatedLocked(
    attempt: VoiceRuntimeThreadAttempt,
    result: VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnCreateResult>,
  ) {
    if (runtimeThreadAttempt !== attempt || attempt.stopped) return
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
        mainHandler.postDelayed({
          if (!serviceDestroyed) synchronized(operationLock) {
            if (runtimeThreadAttempt === attempt && !attempt.stopped) {
              createRuntimeThreadOperation(attempt)
            }
          }
        }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
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
          if (runtimeThreadAttempt === attempt) {
            if (!failRuntimeHandoffCaptureLocked(attempt)) {
              failRuntimeThreadLocked(attempt, "native-thread-microphone-unavailable")
            }
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
    runtimeRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call) || runtimeThreadAttempt !== attempt || attempt.stopped) {
            return@synchronized
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
              return@synchronized
            }
            attempt.retryFailures += 1
            mainHandler.postDelayed({
              if (!serviceDestroyed) synchronized(operationLock) {
                if (runtimeThreadAttempt === attempt && !attempt.stopped) {
                  requestRuntimeThreadDraftDisposition(attempt)
                }
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
            return@synchronized
          }
          val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
            it.copy(draftDispositionPending = false)
          }
          if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
            failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
            return@synchronized
          }
          attempt.retryFailures = 0
          attempt.draftDispositionPending = false
          if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, transitioned.snapshot)) {
            runtimeThreadAttempt = null
            scheduleRuntimeThreadRestoreLocked()
            return@synchronized
          }
          val recording = attempt.recording
          if (recording == null && recordingOwner?.let {
              it.domain == T3VoiceOperationOwnerDomain.THREAD_MODE && it.id == operationId
            } != true) {
            failRuntimeThreadLocked(attempt, "native-thread-recording-unavailable")
            return@synchronized
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
    }
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
    runtimeRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          if (runtimeThreadAttempt !== attempt || attempt.stopped) return@synchronized
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
              mainHandler.postDelayed({
                if (!serviceDestroyed) synchronized(operationLock) {
                  if (runtimeThreadAttempt === attempt && !attempt.stopped) {
                    uploadRuntimeThreadRecording(attempt, recording)
                  }
                }
              }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
            } else failRuntimeThreadLocked(attempt, "native-thread-upload-failed")
          } else {
            attempt.retryFailures = 0
            if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, uploaded.snapshot)) {
              runtimeThreadAttempt = null
              scheduleRuntimeThreadRestoreLocked()
              return@synchronized
            }
            if (uploaded.disposition == "draft-ready") fetchRuntimeThreadDraft(attempt)
            else pollRuntimeThread(attempt)
          }
        }
      }
    }
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
    runtimeRealtimeIo.submit {
      val result = initialCall.execute()
      if (!attempt.finishCall(initialCall)) {
        mainHandler.post { synchronized(operationLock) { attempt.polling = false } }
        return@submit
      }
      val events = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
      val eventWork = events?.let { VoiceRuntimeThreadSpeechPolicy.next(
        playbackCursor, highestAdvertisedSegment,
        it.events,
      ) }
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          attempt.polling = false
          if (runtimeThreadAttempt !== attempt || attempt.stopped) return@synchronized
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
            return@synchronized
          }
          attempt.retryFailures = 0
          if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, eventsResult.snapshot)) {
            runtimeThreadAttempt = null
            scheduleRuntimeThreadRestoreLocked()
            return@synchronized
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
            return@synchronized
          }
          if (VoiceRuntimeCommand.FETCH_EVENT_GAP in batch.commands) {
            scheduleRuntimeThreadPollRetryLocked(attempt)
            return@synchronized
          }
          if (acceptedEvents.isNotEmpty() && !persistRuntimeSnapshotLocked(batch.snapshot)) {
            failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
            return@synchronized
          }
          if (eventsResult.snapshot.phase == "draft-ready") {
            fetchRuntimeThreadDraft(attempt)
            return@synchronized
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
    }
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
    mainHandler.postDelayed({
      if (!serviceDestroyed) synchronized(operationLock) {
        if (runtimeThreadAttempt == null) startRuntimeThreadLocked()
      }
    }, VoiceRuntimeThreadRetryPolicy.delayMillis(1))
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
    runtimeRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          attempt.draftFetching = false
          if (!attempt.finishCall(call) || runtimeThreadAttempt !== attempt || attempt.stopped) {
            return@synchronized
          }
          val draft = (result as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (draft == null || draft.operationId != operationId ||
            draft.expiresAtEpochMillis <= System.currentTimeMillis()) {
            scheduleRuntimeThreadPollRetryLocked(attempt)
            return@synchronized
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
    }
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
    runtimeRealtimeIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call) || runtimeThreadAttempt !== attempt || attempt.stopped) {
            return@synchronized
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
              return@synchronized
            }
            voiceRuntimeController.completeDraftAcknowledgement("draft-$operationId")
            stopRuntimeThreadLocked(cancelServer = false)
          } else {
            attempt.retryFailures += 1
            releaseWakeLockForRuntimeBackoffLocked()
            mainHandler.postDelayed({
              if (!serviceDestroyed) synchronized(operationLock) {
                if (runtimeThreadAttempt === attempt && !attempt.stopped &&
                  attempt.draftConsumePending) consumeRuntimeThreadDraft(attempt)
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
          }
        }
      }
    }
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
    runtimeRealtimeIo.submit {
      val acknowledged = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCall(call)) return@synchronized
          if (runtimeThreadAttempt !== attempt || attempt.stopped) return@synchronized
          val ack = (acknowledged as? VoiceRuntimeThreadTurnResult.Success)?.value
          if (ack != null && VoiceRuntimeThreadAuthorityPolicy.validateSnapshot(
              attempt.authority, operationId, cursor, ack) &&
            ack.acknowledgedSequence >= cursor) {
            if (!stageAndMaterializeRuntimeThreadReceiptLocked(attempt, ack)) {
              runtimeThreadAttempt = null
              scheduleRuntimeThreadRestoreLocked()
              return@synchronized
            }
            attempt.acknowledging = false
            attempt.retryFailures = 0
            val persisted = runtimeThreadOperationStore.updateActive(attempt.clientOperationId) {
              it.copy(acknowledgedCursor = cursor)
            }
            if (persisted !is VoiceRuntimeThreadOperationUpdateResult.Updated) {
              failRuntimeThreadLocked(attempt, "native-thread-state-unavailable")
              return@synchronized
            }
            attempt.acknowledgedCursor = cursor
            startNextRuntimeThreadSpeechLocked(attempt)
            return@synchronized
          }
          val retryable = (acknowledged as? VoiceRuntimeThreadTurnResult.Failure)?.kind in setOf(
            VoiceRuntimeHttpFailureKind.RETRYABLE,
            VoiceRuntimeHttpFailureKind.CONFLICT,
            VoiceRuntimeHttpFailureKind.CANCELLED,
          )
          if (retryable) {
            attempt.retryFailures += 1
            releaseWakeLockForRuntimeBackoffLocked()
            mainHandler.postDelayed({
              if (!serviceDestroyed) synchronized(operationLock) {
                if (runtimeThreadAttempt === attempt && !attempt.stopped) {
                  acknowledgeRuntimeThread(attempt, credential, operationId, cursor)
                }
              }
            }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
          } else {
            attempt.acknowledging = false
            failRuntimeThreadLocked(attempt, "native-thread-ack-failed")
          }
        }
      }
    }
  }

  private fun scheduleRuntimeThreadPollRetryLocked(attempt: VoiceRuntimeThreadAttempt) {
    attempt.retryFailures += 1
    val delay = VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures)
    releaseWakeLockForRuntimeBackoffLocked()
    mainHandler.postDelayed({
      if (!serviceDestroyed) synchronized(operationLock) {
        if (runtimeThreadAttempt === attempt && !attempt.stopped) pollRuntimeThread(attempt)
      }
    }, delay)
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
      if (runtimeThreadAttempt === attempt && attempt.playingSegment == null &&
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
      runtimeRealtimeIo.submit {
        val result = call.execute()
        mainHandler.post {
          if (serviceDestroyed) return@post
          synchronized(operationLock) {
            if (!attempt.finishCall(call) || runtimeThreadAttempt !== attempt ||
              attempt.stopped || attempt.playingSegment != segment) return@synchronized
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
      }
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
    playbackOwner?.takeIf { it.id == playbackId }?.let { owner ->
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
      mainHandler.postDelayed({
        if (!serviceDestroyed) synchronized(operationLock) {
          if (runtimeThreadAttempt === attempt && !attempt.stopped) {
            finishRuntimeThreadIfDrainedLocked(attempt)
          }
        }
      }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
      return
    }
    runtimeThreadAttempt = null
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
    lateinit var task: Runnable
    task = Runnable {
      synchronized(operationLock) {
        if (voiceRuntimeThreadRearmTask !== task) return@synchronized
        voiceRuntimeThreadRearmTask = null
        if (serviceDestroyed || runtimeThreadAttempt != null ||
          voiceRuntimeController.snapshot().identity != expectedIdentity) return@synchronized
        val current = (voiceRuntimeAuthorityStore.load()
          as? VoiceRuntimeAuthorityLoadResult.Available)?.authority ?: return@synchronized
        val currentTarget = current.target as? VoiceRuntimeTarget.Thread ?: return@synchronized
        if (current.runtimeId != authority.runtimeId ||
          current.generation != authority.generation ||
          current.targetDigest != authority.targetDigest ||
          currentTarget != target ||
          !VoiceRuntimeThreadRearmPolicy.canSchedule(
            currentTarget,
            runtimeSnapshot.terminalSummary,
            current.readinessEnabled,
            voiceRuntimeController.consumerCount(),
          )) return@synchronized
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
    }
    voiceRuntimeThreadRearmTask = task
    mainHandler.postDelayed(task, VoiceRuntimeThreadRearmPolicy.delayMillis(target))
  }

  private fun cancelVoiceRuntimeThreadRearmLocked() {
    voiceRuntimeThreadRearmTask?.let(mainHandler::removeCallbacks)
    voiceRuntimeThreadRearmTask = null
  }

  private fun failRuntimeThreadLocked(attempt: VoiceRuntimeThreadAttempt, code: String) {
    if (runtimeThreadAttempt !== attempt) return
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
    voiceRuntimeAuthorityStore.clear()
    controllerCommands.invalidateReadiness()
    applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
    reconcileForegroundAfterVoiceStopLocked()
  }

  private fun stopRuntimeThreadLocked(cancelServer: Boolean) {
    cancelVoiceRuntimeThreadRearmLocked()
    val attempt = runtimeThreadAttempt ?: return
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
    runtimeThreadCancellationIo.submit {
      val result = call.execute()
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (!attempt.finishCancellationCall(call)) return@synchronized
          if (runtimeThreadAttempt !== attempt) return@synchronized
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
                mainHandler.postDelayed({
                  if (!serviceDestroyed) synchronized(operationLock) {
                    if (runtimeThreadAttempt === attempt && attempt.cancelRequested) {
                      cancelRuntimeThreadOperation(attempt)
                    }
                  }
                }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
                return@synchronized
              }
              attempt.stopped = true
              runtimeThreadAttempt = null
              applyRuntimeEventLocked(VoiceRuntimeExecutionEvent.Stop)
              reconcileAfterRuntimeThreadStopLocked(attempt)
            }
            VoiceRuntimeThreadCancelDecision.RETRY -> {
              attempt.retryFailures += 1
              releaseWakeLockForRuntimeBackoffLocked()
              mainHandler.postDelayed({
                if (!serviceDestroyed) synchronized(operationLock) {
                  if (runtimeThreadAttempt === attempt && attempt.cancelRequested) {
                    cancelRuntimeThreadOperation(attempt)
                  }
                }
              }, VoiceRuntimeThreadRetryPolicy.delayMillis(attempt.retryFailures))
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
    }
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
  ): VoiceRuntimeRealtimeEngine {
    lateinit var engine: VoiceRuntimeRealtimeEngine
    engine = VoiceRuntimeRealtimeEngine(
      authority = authority,
      now = System::currentTimeMillis,
      server = voiceRuntimeRealtimeServer,
      peer = realtimePeerPort(),
      cues = realtimeCuePort(),
      handoff = realtimeHandoffPort(),
      presentation = object : VoiceRuntimeRealtimePresentationSink {
        override fun publish(
          fence: VoiceRuntimeRealtimeFence,
          action: VoiceRuntimeRealtimeAction,
        ): VoiceRuntimeRetentionWriteResult = synchronized(operationLock) {
          if (serviceDestroyed || voiceRuntimeRealtimeEngine !== engine) {
            VoiceRuntimeRetentionWriteResult.UNAVAILABLE
          } else {
            voiceRuntimeController.publishRealtimePresentationAction(fence, action)
          }
        }

        override fun retract(
          fence: VoiceRuntimeRealtimeFence,
          action: VoiceRuntimeRealtimeAction,
        ): VoiceRuntimeRetentionRemovalResult = synchronized(operationLock) {
          if (serviceDestroyed || voiceRuntimeRealtimeEngine !== engine) {
            VoiceRuntimeRetentionRemovalResult.UNAVAILABLE
          } else {
            voiceRuntimeController.retractRealtimePresentationAction(fence, action)
          }
        }
      },
      repository = voiceRuntimeRealtimeRepository,
      stateSink = VoiceRuntimeRealtimeStateSink { checkpoint ->
        val deliver = {
          if (!serviceDestroyed) synchronized(operationLock) {
            if (voiceRuntimeRealtimeEngine === engine) {
              voiceRuntimeController.observeRealtime(checkpoint)
              if (checkpoint == null) {
                realtimeFinalizationTransitionAuthority =
                  voiceRuntimeRealtimeRepository.loadFinalization()?.let(::realtimeHandoffAuthority)
                    ?: voiceRuntimeAuthorityStore.inspectPreparedTransition()
                cancelVoiceRuntimeRealtimeTasksLocked()
                scheduleVoiceRuntimeRealtimeFinalizationLocked(engine)
                if (T3VoiceStateStore.state.value.phase == T3VoiceRuntimePhase.IDLE) {
                  stopRuntimeForegroundLocked()
                }
              } else {
                scheduleVoiceRuntimeRealtimeTasksLocked(engine, checkpoint)
              }
              updateRuntimeControlSurfacesLocked()
            }
          }
        }
        if (Thread.holdsLock(operationLock)) deliver() else mainHandler.post(deliver)
      },
      terminalSink = VoiceRuntimeRealtimeTerminalSink { summary ->
        val deliver = {
          if (!serviceDestroyed) synchronized(operationLock) {
            if (voiceRuntimeRealtimeEngine === engine) {
              voiceRuntimeController.publishRealtimeTerminal(summary)
            }
          }
        }
        if (Thread.holdsLock(operationLock)) deliver() else mainHandler.post(deliver)
      },
      finalizationSink = VoiceRuntimeRealtimeFinalizationSink { result ->
        val deliver = {
          if (!serviceDestroyed) synchronized(operationLock) {
            if (voiceRuntimeRealtimeEngine === engine) {
              handleRealtimeFinalizationResultLocked(engine, result)
            }
          }
        }
        // Never re-enter the engine while its monitor is publishing a synchronous outcome.
        mainHandler.post(deliver)
      },
      remoteDispatcher = VoiceRuntimeRealtimeRemoteDispatcher { block ->
        runCatching {
          voiceRuntimeRealtimeCleanupIo.submit {
            if (!serviceDestroyed) block()
          }
        }
      },
    )
    return engine
  }

  private fun installRealtimeEngineLocked(persisted: VoiceRuntimePersistedAuthority) {
    cancelVoiceRuntimeRealtimeTasksLocked()
    if (voiceRuntimeRealtimeRepository.load()?.pendingHandoffExchange == null &&
      voiceRuntimeRealtimeRepository.loadFinalization()?.handoffExchange == null) {
      voiceRuntimeAuthorityStore.inspectPreparedTransition()?.let {
        voiceRuntimeAuthorityStore.discardPreparedTransition(it)
      }
    }
    val expected = voiceRuntimeRealtimeEngineSlot.fence()
    val target = persisted.target as? VoiceRuntimeTarget.Realtime
    if (target == null) {
      if (expected.engine != null) {
        val installation = voiceRuntimeRealtimeEngineSlot.stageIdleClear(expected)
        voiceRuntimeRealtimeEngineSlot.commit(installation)
        voiceRuntimeRealtimeEngineSlot.complete(installation)
      }
      return
    }
    val authority = realtimeAuthorityLocked(persisted)
    val engine = createRealtimeEngineLocked(authority)
    val installation = if (engine.isOperational()) {
      voiceRuntimeRealtimeEngineSlot.stageRecoveredInstall(expected, authority, engine)
    } else {
      voiceRuntimeRealtimeEngineSlot.stageIdleInstall(expected, authority, engine)
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
    val installation = voiceRuntimeRealtimeEngineSlot.stageRecoveredInstall(
      voiceRuntimeRealtimeEngineSlot.fence(),
      authority,
      engine,
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
    engine: VoiceRuntimeRealtimeEngine,
    identity: VoiceRuntimeIdentity,
  ) {
    voiceRuntimeRealtimeCleanupIo.submit {
      val recovery = runCatching { engine.recoverInterrupted(identity) }
      mainHandler.post {
        if (serviceDestroyed) return@post
        synchronized(operationLock) {
          if (voiceRuntimeRealtimeEngine !== engine) return@synchronized
          if (recovery.isFailure) {
            T3VoiceDiagnostics.record(
              0,
              T3VoiceDiagnosticCategory.TERMINAL,
              T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
            )
            if (engine.isOperational()) {
              scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)
            } else {
              runCatching {
                voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
              }
            }
            return@synchronized
          }
          if (recovery.getOrNull() != null) {
            reconcileRealtimeEngineTerminalLocked(engine)
            return@synchronized
          }
          engine.snapshot()?.let {
            voiceRuntimeController.observeRealtime(it)
            scheduleVoiceRuntimeRealtimeTasksLocked(engine, it)
          }
          scheduleVoiceRuntimeRealtimeFinalizationLocked(engine)
          updateRuntimeControlSurfacesLocked()
        }
      }
    }
  }

  private fun realtimePeerPort(): VoiceRuntimeRealtimePeer = object : VoiceRuntimeRealtimePeer {
    override fun prepare(
      modeSessionId: String,
      onOffer: (String) -> Unit,
      onFailure: (String) -> Unit,
    ): Boolean = runCatching {
      check(T3VoiceStateStore.claimRealtime(modeSessionId)) { "The voice runtime is already in use." }
      val diagnosticGeneration = T3VoiceDiagnostics.nextGeneration()
      realtime.prepare(
        modeSessionId,
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
      keepServiceStarted(ACTION_START_REALTIME, modeSessionId)
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
    if (serviceDestroyed) return
    runCatching {
      voiceRuntimeRealtimeOfferIo.submit {
        if (!serviceDestroyed) block()
      }
    }
  }

  private fun realtimeCuePort(): VoiceRuntimeRealtimeCues = object : VoiceRuntimeRealtimeCues {
    override fun ready(generation: Long, onComplete: () -> Unit): Boolean {
      if (!cueSettings.enabled) return false
      val cueGeneration = ++nextCueGeneration
      return cueCoordinator.requestReady(cueGeneration) {
        dispatchVoiceRuntimeRealtimeControl(onComplete)
      }
    }

    override fun ended(generation: Long, onComplete: () -> Unit): Boolean {
      if (!cueSettings.enabled) return false
      val cueGeneration = ++nextCueGeneration
      return cueCoordinator.requestEnded(cueGeneration) {
        dispatchVoiceRuntimeRealtimeControl(onComplete)
      }
    }
  }

  private fun dispatchVoiceRuntimeRealtimeControl(block: () -> Unit) {
    if (serviceDestroyed) return
    runCatching {
      voiceRuntimeRealtimeControlIo.submit {
        if (!serviceDestroyed) block()
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
        synchronized(operationLock) {
          runCatching {
            val (persisted, reservation) = realtimeHandoffAuthorityLocked(result)
            voiceRuntimeController.validateAuthorityReplacement(
              reservation,
              persisted.target as VoiceRuntimeTarget.Thread,
            )
            voiceRuntimeAuthorityStore.prepareTransition(persisted)
          }.isSuccess
        }

      override fun rollback(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean =
        synchronized(operationLock) {
          val prepared = voiceRuntimeAuthorityStore.inspectPreparedTransition()
            ?: return@synchronized true
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
    val finalization = voiceRuntimeRealtimeRepository.loadFinalization()?.takeIf {
      it.handoffExchange?.actionId == result.actionId
    }
    val origin = finalization?.sourceEnvironmentOrigin
      ?: (persistedAuthority()?.environmentOrigin
        ?: error("Canonical handoff source authority is unavailable."))
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
      if (serviceDestroyed) {
        completion(false)
      } else {
        synchronized(operationLock) {
          beginRealtimeHandoffActivationLocked(result, completion)
        }
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) {
      begin()
      return false
    }
    mainHandler.post(begin)
    if (!completed.await(RUNTIME_HANDOFF_ACTIVATION_TIMEOUT_MILLIS, TimeUnit.MILLISECONDS)) {
      mainHandler.post {
        synchronized(operationLock) {
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
    engine: VoiceRuntimeRealtimeEngine,
    delayMillis: Long = 0,
  ) {
    if (voiceRuntimeRealtimeEngine !== engine || !engine.isOperational()) return
    if (voiceRuntimeRealtimeFinalizationTask != null) return
    lateinit var task: Runnable
    task = Runnable {
      synchronized(operationLock) {
        if (voiceRuntimeRealtimeFinalizationTask !== task) return@synchronized
        voiceRuntimeRealtimeFinalizationTask = null
        if (serviceDestroyed || voiceRuntimeRealtimeEngine !== engine) return@synchronized
      }
      voiceRuntimeRealtimeCleanupIo.submit {
        runCatching { engine.reconcileFinalization() }.onFailure {
          mainHandler.post {
            if (!serviceDestroyed) synchronized(operationLock) {
              if (voiceRuntimeRealtimeEngine === engine) {
                scheduleVoiceRuntimeRealtimeFinalizationLocked(engine, 1_000L)
              }
            }
          }
        }
      }
    }
    voiceRuntimeRealtimeFinalizationTask = task
    mainHandler.postDelayed(task, delayMillis)
  }

  private fun handleRealtimeFinalizationResultLocked(
    engine: VoiceRuntimeRealtimeEngine,
    result: VoiceRuntimeRealtimeFinalizationResult,
  ) {
    if (voiceRuntimeRealtimeEngine !== engine) return
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
          T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle(
            hasFinalization = voiceRuntimeRealtimeRepository.loadFinalization() != null,
            hasCheckpoint = voiceRuntimeRealtimeRepository.load() != null,
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

  private fun reconcileRealtimeEngineTerminalLocked(engine: VoiceRuntimeRealtimeEngine) {
    if (voiceRuntimeRealtimeEngine !== engine || engine.isOperational()) return
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
      val cleared = T3VoiceDisabledTerminalCleanupCoordinator.run(
        canonicalIdle = voiceRuntimeController.isIdle(),
        clearController = {
          runCatching {
            voiceRuntimeController.clearAuthority(
              "realtime-disabled-terminal-${UUID.randomUUID()}",
              voiceRuntimeController.snapshot().identity,
            )
          }.isSuccess
        },
        clearAuthority = {
          voiceRuntimeAuthorityStore.clear()
          check(readinessStore.clearDisabledAuthorityFence(
            T3VoiceDisabledAuthorityFence(
              notificationDisabledCanonical.runtimeId,
              notificationDisabledCanonical.generation,
            ),
          )) { "Could not clear the disabled Realtime authority fence." }
        },
        clearEngine = {
          voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
        },
      )
      if (!cleared) {
        T3VoiceDiagnostics.record(
          0,
          T3VoiceDiagnosticCategory.TERMINAL,
          T3VoiceDiagnosticCode.CLEANUP_RECONCILIATION_REQUIRED,
        )
        updateRuntimeControlSurfacesLocked()
        return
      }
      updateRuntimeControlSurfacesLocked()
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
          voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
          val installation = voiceRuntimeRealtimeEngineSlot.stageIdleInstall(
            voiceRuntimeRealtimeEngineSlot.fence(),
            canonicalAuthority,
            candidate,
          )
          voiceRuntimeRealtimeEngineSlot.commit(installation)
          voiceRuntimeRealtimeEngineSlot.complete(installation)
        }
      } else {
        voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
      }
    } else {
      voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
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
    if (binding.engine.isOperational()) return
    voiceRuntimeRealtimeEngineSlot.clear(voiceRuntimeRealtimeEngineSlot.fence())
  }

  private fun enterCanonicalRecoveryRequiredLocked(reason: String) {
    pendingRuntimeHandoffActivation?.let {
      completeRuntimeHandoffActivationLocked(it, false)
    }
    cancelVoiceRuntimeThreadRearmLocked()
    runtimeThreadAttempt?.let { attempt ->
      attempt.cancelAllCalls()
      attempt.stopped = true
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
    runCatching { voiceRuntimeAuthorityStore.clear() }
    runCatching { voiceRuntimeSessionCredentialStore.clear() }
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
    engine: VoiceRuntimeRealtimeEngine,
    checkpoint: VoiceRuntimeRealtimeCheckpoint,
  ) {
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
      lateinit var task: Runnable
      task = Runnable {
        voiceRuntimeRealtimeHeartbeatIo.submit {
          runCatching { engine.heartbeat(checkpoint.fence) }
          mainHandler.post {
            synchronized(operationLock) {
              if (voiceRuntimeRealtimeHeartbeatTask !== task) return@synchronized
              if (voiceRuntimeRealtimeEngine === engine && engine.snapshot() != null) {
                mainHandler.postDelayed(task, interval)
              } else voiceRuntimeRealtimeHeartbeatTask = null
            }
          }
        }
      }
      voiceRuntimeRealtimeHeartbeatTask = task
      mainHandler.postDelayed(task, interval)
    }
    if (
      checkpoint.phase == VoiceRealtimePhase.CONNECTED &&
        voiceRuntimeRealtimeActionTask == null
    ) {
      lateinit var task: Runnable
      task = Runnable {
        val admission = synchronized(operationLock) {
          if (voiceRuntimeRealtimeActionTask !== task || voiceRuntimeRealtimeEngine !== engine) {
            return@synchronized VoiceRuntimeRetentionAdmission.UNAVAILABLE
          }
          voiceRuntimeController.presentationCapacity()
        }
        if (admission in setOf(
            VoiceRuntimeRetentionAdmission.FULL,
            VoiceRuntimeRetentionAdmission.UNAVAILABLE,
          )) {
          synchronized(operationLock) {
            if (voiceRuntimeRealtimeActionTask === task) {
              mainHandler.postDelayed(task, 500L)
            }
          }
          return@Runnable
        }
        voiceRuntimeRealtimeActionIo.submit {
          runCatching { engine.pollActions(checkpoint.fence) }
          mainHandler.post {
            synchronized(operationLock) {
              if (voiceRuntimeRealtimeActionTask !== task) return@synchronized
              if (voiceRuntimeRealtimeEngine === engine && engine.snapshot() != null) {
                mainHandler.postDelayed(task, 100)
              } else voiceRuntimeRealtimeActionTask = null
            }
          }
        }
      }
      voiceRuntimeRealtimeActionTask = task
      mainHandler.post(task)
    }
    val deadline = checkpoint.drainDeadlineAtEpochMillis
    if (deadline != null && voiceRuntimeRealtimeDrainTask == null) {
      lateinit var task: Runnable
      task = Runnable {
        val shouldRun = synchronized(operationLock) {
          if (voiceRuntimeRealtimeDrainTask !== task) return@synchronized false
          voiceRuntimeRealtimeDrainTask = null
          voiceRuntimeRealtimeEngine === engine
        }
        if (shouldRun) {
          dispatchVoiceRuntimeRealtimeControl {
            runCatching { engine.onDrainDeadline(checkpoint.fence) }
          }
        }
      }
      voiceRuntimeRealtimeDrainTask = task
      mainHandler.postDelayed(task, (deadline - System.currentTimeMillis()).coerceAtLeast(0))
    }
  }

  private fun cancelVoiceRuntimeRealtimeTasksLocked() {
    voiceRuntimeRealtimeHeartbeatTask?.let(mainHandler::removeCallbacks)
    voiceRuntimeRealtimeActionTask?.let(mainHandler::removeCallbacks)
    voiceRuntimeRealtimeDrainTask?.let(mainHandler::removeCallbacks)
    voiceRuntimeRealtimeHeartbeatTask = null
    voiceRuntimeRealtimeActionTask = null
    voiceRuntimeRealtimeDrainTask = null
  }

  private fun cancelVoiceRuntimeRealtimeFinalizationLocked() {
    voiceRuntimeRealtimeFinalizationTask?.let(mainHandler::removeCallbacks)
    voiceRuntimeRealtimeFinalizationTask = null
  }

  private fun requireRealtimeEngineLocked(identity: VoiceRuntimeIdentity): VoiceRuntimeRealtimeEngine {
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
    val modeSessionId = engine.snapshot()?.fence?.modeSessionId
      ?: "realtime-mode-${UUID.randomUUID()}"
    ensureRuntimeForeground(
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
    )
    voiceRuntimeRealtimeStartIo.submit {
      runCatching {
        engine.start(
          "notification-start-${UUID.randomUUID()}",
          VoiceRuntimeRealtimeFence(identity, modeSessionId),
        )
      }
    }
  }

  private fun executeControlCommandLocked(command: T3VoiceControlCommand) {
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
        voiceRuntimeRealtimeEngine?.snapshot()?.let { checkpoint ->
          val engine = voiceRuntimeRealtimeEngine
          voiceRuntimeRealtimeControlIo.submit {
            runCatching { engine?.setMuted(checkpoint.fence, !checkpoint.muted) }
          }
        }
      }
      T3VoiceControlDecision.IGNORE -> Unit
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun stopActiveOperationLocked() {
    val state = T3VoiceStateStore.state.value
    stopRuntimeThreadLocked(cancelServer = true)
    val realtimeCheckpoint = voiceRuntimeRealtimeEngine?.snapshot()
    if (realtimeCheckpoint != null) {
      val engine = voiceRuntimeRealtimeEngine
      voiceRuntimeRealtimeControlIo.submit {
        runCatching {
          engine?.stop(
            "notification-stop-${UUID.randomUUID()}",
            realtimeCheckpoint.fence,
            VoiceRuntimeRealtimeStopPolicy.DRAIN,
          )
        }
      }
    } else {
      state.activeRealtimeSessionId?.let {
        val stopped = runCatching { realtime.stop(it) }.getOrDefault(false)
        if (!stopped) T3VoiceStateStore.releaseRealtimeClaim(it)
      }
    }
    clearHandoffEligibilityLocked()
    stopTraditionalAudioLocked(state, "notification-stop")
    reconcileForegroundAfterVoiceStopLocked()
  }

  private fun reconcileForegroundAfterVoiceStopLocked() {
    val cuePending = recordingEndedCue != null || realtimeEndedCue != null
    if (cuePending || !foregroundReleaseCoordinator.releaseIfIdleWhileLocked()) {
      updateRuntimeControlSurfacesLocked()
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

  private fun clearHandoffEligibilityLocked() {
    handoffEligibleSessionId = null
    handoffEnvironmentOrigin = null
    awaitingHandoffAction = false
  }

  private fun cancelRealtimeHandoffRecordingLocked(recordingId: String, reason: String) {
    val state = T3VoiceStateStore.state.value
    stopTraditionalAudioLocked(
      state,
      reason,
      ownsRecording = { it == recordingId },
      ownsPlayback = { false },
    )
  }

  private fun discardRealtimeHandoffRecordingLocked(recordingId: String, reason: String) {
    cancelRealtimeHandoffRecordingLocked(recordingId, reason)
    val termination = T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(recordingId)
      ?: T3VoiceStateStore.recordingTermination.value?.takeIf { it.recordingId == recordingId }
      ?: return
    termination.recording?.let { recording ->
      runCatching { recorder.delete(recordingId, recording.uri) }
    }
    T3VoiceStateStore.clearRealtimeHandoffRecordingTermination(recordingId)
    T3VoiceStateStore.clearRecordingTermination(recordingId)
  }

  private fun isThreadVoiceHandoffProtected(actionId: String): Boolean =
    T3VoiceStateStore.isThreadVoiceHandoffAdopted(actionId) ||
      T3VoiceStateStore.isThreadVoiceHandoffAdoptionClaimed(actionId, System.currentTimeMillis())

  private fun expireThreadVoiceHandoffLocked(actionId: String, recordingId: String) {
    val pending = T3VoiceStateStore.pendingThreadVoiceHandoff()
      ?.takeIf { it.actionId == actionId && it.recordingId == recordingId }
      ?: return
    if (pending.expiresAtEpochMillis > System.currentTimeMillis() || isThreadVoiceHandoffProtected(actionId)) {
      return
    }
    discardRealtimeHandoffRecordingLocked(recordingId, "handoff-adoption-expired")
    T3VoiceStateStore.clearThreadVoiceHandoff(actionId)
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
    val owner = checkNotNull(
      T3VoiceStateStore.claimPlayback(playbackId, domain, operationId),
    ) { "The voice runtime is already in use." }
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
        hasRealtimeMedia = voiceRuntimeRealtimeEngine?.snapshot() != null,
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
      else stopSelf()
    }
    updateRuntimeControlSurfacesLocked()
  }

  private fun disableReadinessLocked() {
    voiceRuntimeSessionCredentialStore.clear()
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
      voiceRuntimeAuthorityStore.clear()
      disabledAuthorityFence?.let {
        check(readinessStore.clearDisabledAuthorityFence(it)) {
          "Could not clear the idle disabled authority fence."
        }
      }
      clearIdleRealtimeEngineLocked()
    }
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
            mailbox.submit(VoiceKernelMessage.HostIntent(command.toVoiceKernelHostIntentAction())) {
              if (serviceDestroyed) return@submit
              synchronized(operationLock) {
                executeControlCommandLocked(command)
              }
            }
            return true
          }

          override fun onPlay() {
            if (serviceDestroyed) return
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_PRIMARY),
            ) {
              if (!serviceDestroyed) synchronized(operationLock) {
                executeControlCommandLocked(T3VoiceControlCommand.PRIMARY)
              }
            }
          }

          override fun onPause() {
            if (serviceDestroyed) return
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
            ) {
              if (!serviceDestroyed) synchronized(operationLock) {
                executeControlCommandLocked(T3VoiceControlCommand.STOP)
              }
            }
          }

          override fun onStop() {
            if (serviceDestroyed) return
            mailbox.submit(
              VoiceKernelMessage.HostIntent(VoiceKernelHostIntentAction.ACTION_STOP),
            ) {
              if (!serviceDestroyed) synchronized(operationLock) {
                executeControlCommandLocked(T3VoiceControlCommand.STOP)
              }
            }
          }
        },
      )
    }
  }

  private fun releaseMediaSessionLocked() {
    mediaSession?.release()
    mediaSession = null
  }

  private fun updateRuntimeControlSurfacesLocked() {
    val session = mediaSession ?: return
    val state = T3VoiceStateStore.state.value
    val active = runtimeControlSurfaceActiveLocked(state)
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
    val snapshot = captureNotificationSnapshotLocked(state, active)
    notificationSnapshot = snapshot
    if (state.isForeground) {
      getSystemService(NotificationManager::class.java).notify(
        NOTIFICATION_ID,
        buildNotification(snapshot),
      )
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
    val realtimeCheckpoint = voiceRuntimeRealtimeEngine?.snapshot()
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
    return voiceRuntimeRealtimeEngine?.snapshot() != null || VoiceRuntimeControlSurfacePolicy.isActive(
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
    private const val HANDOFF_ADOPTION_CLAIM_GRACE_MILLIS = 30_000L
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
