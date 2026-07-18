package expo.modules.t3voice

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

internal class T3VoiceForegroundReleaseCoordinator(
  private val canRelease: () -> Boolean,
  private val releaseForeground: () -> Unit,
) {
  val lock = Any()

  fun releaseWhileLocked() {
    check(Thread.holdsLock(lock)) { "Foreground release must hold the operation lock." }
    check(canRelease()) { "Cannot release foreground ownership while voice is retained." }
    releaseForeground()
  }
}

class T3VoiceRuntimeService : Service() {
  internal inner class VoiceBinder : Binder() {
    val runtimeSnapshots: StateFlow<T3VoiceControllerSnapshot>
      get() = semanticController.snapshots

    fun runtimeSnapshot(): T3VoiceControllerSnapshot = semanticController.snapshot()

    val terminalRuntimeFailures: StateFlow<T3VoiceTerminalRuntimeFailure?>
      get() = T3VoiceTerminalRuntimeFailureStore.head

    fun terminalRuntimeFailure(): T3VoiceTerminalRuntimeFailure? =
      T3VoiceTerminalRuntimeFailureStore.head.value

    fun acknowledgeTerminalRuntimeFailure(failureId: Long) {
      T3VoiceTerminalRuntimeFailureStore.acknowledge(failureId)
    }

    val readinessSnapshots: StateFlow<T3VoiceReadinessSnapshot>
      get() = mutableReadinessSnapshots.asStateFlow()

    fun readinessSnapshot(): T3VoiceReadinessSnapshot =
      synchronized(operationLock) { readinessOwner.snapshot() }

    fun configureReadiness(
      configuration: T3VoiceReadinessConfiguration,
    ): T3VoiceReadinessSnapshot =
      synchronized(operationLock) {
        val previous = readinessOwner.checkpoint()
        try {
          readinessOwner.configureTransaction(configuration) { snapshot ->
            publishReadinessLocked(snapshot)
            startForReadiness(this@T3VoiceRuntimeService)
            ensureRuntimeForeground(SEMANTIC_FOREGROUND_SERVICE_TYPES)
            scheduleReadinessExpiryLocked(configuration)
            reconcileSemanticControlsLocked(semanticController.snapshot())
            snapshot
          }
        } catch (cause: Throwable) {
          readinessExpiryCoordinator.cancel()
          publishReadinessLocked(previous.snapshot)
          previous.configuration?.let(readinessExpiryCoordinator::replace)
          runCatching { reconcileSemanticControlsLocked(semanticController.snapshot()) }
          stopRuntimeForegroundLocked()
          throw cause
        }
      }

    fun disableReadiness(generation: Long): T3VoiceReadinessSnapshot =
      synchronized(operationLock) {
        disableReadinessLocked(generation)
      }

    fun pendingReadinessDisableGeneration(): Long? =
      readinessDisableMarker.pendingGeneration()

    fun acknowledgeReadinessDisable(generation: Long) {
      readinessDisableMarker.acknowledge(generation)
    }

    val audioRoutePreferences: StateFlow<T3VoiceAudioRoutePreference>
      get() = semanticDriver.audioRoutePreferences

    fun dispatchRuntime(command: T3VoiceRuntimeCommand): T3VoiceCommandResult =
      dispatchSemanticCommand(command)

    fun audioRoutePreference(): Map<String, Any?> =
      semanticDriver.audioRoutePreference().toResultBody()

    fun setAudioRoutePreference(route: String): Map<String, Any?> =
      semanticDriver.setAudioRoutePreference(route).toResultBody()

    fun voiceCuesEnabled(): Boolean = semanticDriver.voiceCuesEnabled()

    fun setVoiceCuesEnabled(enabled: Boolean): Map<String, Any?> =
      semanticDriver.setVoiceCuesEnabled(enabled)

    fun voiceCueStartupPreRollMs(): Int = semanticDriver.voiceCueStartupPreRollMs()

    fun setVoiceCueStartupPreRollMs(startupPreRollMs: Int): Map<String, Any?> =
      semanticDriver.setVoiceCueStartupPreRollMs(startupPreRollMs)

    val events: SharedFlow<T3VoiceRuntimeEvent>
      get() = T3VoiceStateStore.events

    val recordingTermination: StateFlow<T3VoiceRuntimeEvent.RecordingTerminated?>
      get() = T3VoiceStateStore.recordingTermination

    val playbackTermination: StateFlow<T3VoiceRuntimeEvent.PlaybackTerminated?>
      get() = T3VoiceStateStore.playbackTermination

    fun startRecording(
      recordingId: String,
      endpointConfig: T3VoiceEndpointDetectionConfig,
    ) {
      synchronized(operationLock) {
        requireLegacyMediaAdmissionLocked()
        val owner =
          checkNotNull(T3VoiceStateStore.claimRecording(recordingId)) {
            "The voice runtime is already in use."
          }
        recordingOwner = owner
        try {
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
          check(semanticDriver.acquireLegacyAudio()) { "Android denied recording audio focus." }
          recorder.start(recordingId, endpointConfig)
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

    fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) {
      synchronized(operationLock) {
        requireLegacyMediaAdmissionLocked()
        val owner =
          checkNotNull(T3VoiceStateStore.claimPlayback(playbackId)) {
            "The voice runtime is already in use."
          }
        playbackOwner = owner
        try {
          ensureRuntimeForeground(ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
          check(semanticDriver.acquireLegacyAudio()) { "Android denied playback audio focus." }
          player.start(playbackId, sampleRate, channelCount)
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

    fun getDiagnostics(): List<Map<String, Any>> = T3VoiceDiagnostics.snapshot()
  }

  private val binder = VoiceBinder()
  private val foregroundReleaseCoordinator =
    T3VoiceForegroundReleaseCoordinator(
      canRelease = ::canStopServiceLocked,
      releaseForeground = ::stopRuntimeForeground,
    )
  private val operationLock = foregroundReleaseCoordinator.lock
  private var recordingOwner: T3VoiceOperationOwner? = null
  private var playbackOwner: T3VoiceOperationOwner? = null
  private lateinit var recorder: T3VoiceRecorder
  private lateinit var player: T3VoicePcmPlayer
  private lateinit var semanticDriver: T3VoiceNativeRuntimeDriver
  private lateinit var semanticController: T3VoiceRuntimeController
  private lateinit var androidControls: T3VoiceAndroidControls
  private lateinit var semanticWakeLock: PowerManager.WakeLock
  private val readinessOwner = T3VoiceReadinessOwner()
  private var readinessLaunch: T3VoiceReadinessLaunch? = null
  private lateinit var readinessExpiryCoordinator: T3VoiceReadinessExpiryCoordinator
  private lateinit var readinessDisableMarker: T3VoiceReadinessDisableMarker
  private val mutableReadinessSnapshots =
    MutableStateFlow<T3VoiceReadinessSnapshot>(T3VoiceReadinessSnapshot.Disabled(0))
  private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private var semanticSnapshotCollection: Job? = null
  private var foregroundServiceTypes = 0
  private val mainHandler = Handler(Looper.getMainLooper())
  override fun onCreate() {
    super.onCreate()
    readinessDisableMarker = T3VoiceReadinessDisableMarker(applicationContext)
    readinessExpiryCoordinator =
      T3VoiceReadinessExpiryCoordinator(
        readinessOwner,
        T3VoiceAndroidReadinessExpiryAlarm(applicationContext),
      ) { snapshot ->
        publishReadinessLocked(snapshot)
        reconcileSemanticControlsLocked(semanticController.snapshot())
      }
    semanticDriver =
      T3VoiceNativeRuntimeDriver(
        applicationContext,
        callback = { generation, callback ->
          if (this::semanticController.isInitialized) {
            semanticController.onCallback(generation, callback)
          }
        },
        onUnownedAudioFocusActions = ::handleLegacyAudioFocusActions,
      )
    semanticController =
      T3VoiceRuntimeController(semanticDriver, T3VoiceTerminalRuntimeFailureStore::publish)
    semanticWakeLock =
      getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, SEMANTIC_WAKE_LOCK_TAG)
        .apply { setReferenceCounted(false) }
    androidControls =
      T3VoiceAndroidControls(applicationContext) { action, owner, generation ->
        synchronized(operationLock) {
          dispatchAndroidControlLocked(action, owner, generation)
        }
      }
    semanticSnapshotCollection =
      serviceScope.launch {
        semanticController.snapshots.collectLatest { snapshot ->
          synchronized(operationLock) {
            reconcileSemanticControlsLocked(snapshot)
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
    createNotificationChannel()
    T3VoiceStateStore.setServiceReady()
  }

  override fun onBind(intent: Intent?): IBinder = binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    synchronized(operationLock) {
      when (intent?.action) {
        ACTION_STOP -> stopActiveOperationLocked()
        ACTION_START_SEMANTIC_RUNTIME ->
          reconcileSemanticStartCommand(
            generation = intent.getLongExtra(EXTRA_SEMANTIC_GENERATION, INVALID_GENERATION),
            startId = startId,
          )
        ACTION_SEMANTIC_CONTROL ->
          dispatchAndroidControlLocked(
            generation = intent.getLongExtra(EXTRA_SEMANTIC_GENERATION, INVALID_GENERATION),
            action = intent.getStringExtra(EXTRA_SEMANTIC_ACTION)
              ?.let { runCatching { T3VoiceAndroidControlAction.valueOf(it) }.getOrNull() },
            owner = intent.getStringExtra(EXTRA_CONTROL_OWNER)
              ?.let { runCatching { T3VoiceAndroidControlOwner.valueOf(it) }.getOrNull() },
          ).also {
            if (canStopServiceLocked()) stopSelf(startId)
          }
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
        ACTION_START_READINESS -> {
          if (readinessOwner.snapshot().retainsService()) {
            ensureRuntimeForeground(SEMANTIC_FOREGROUND_SERVICE_TYPES)
          } else if (canStopServiceLocked()) {
            stopSelf(startId)
          }
        }
        ACTION_READINESS_EXPIRY -> {
          readinessExpiryCoordinator.onAlarm(
            intent.getLongExtra(EXTRA_READINESS_GENERATION, INVALID_GENERATION),
          )
          if (canStopServiceLocked()) stopSelf(startId)
        }
        else -> if (canStopServiceLocked()) stopSelf(startId)
      }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    semanticSnapshotCollection?.cancel()
    semanticSnapshotCollection = null
    serviceScope.cancel()
    if (this::readinessExpiryCoordinator.isInitialized) readinessExpiryCoordinator.cancel()
    if (this::semanticWakeLock.isInitialized && semanticWakeLock.isHeld) semanticWakeLock.release()
    if (this::androidControls.isInitialized) androidControls.release()
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
    }
    if (this::semanticDriver.isInitialized) semanticDriver.shutdown()
    recorder.release()
    player.release()
    T3VoiceStateStore.setInactive()
    super.onDestroy()
  }

  private fun startRuntimeForeground(foregroundServiceType: Int) {
    val requestedTypes = foregroundServiceTypes or foregroundServiceType
    val notification = currentNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, requestedTypes)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    foregroundServiceTypes = requestedTypes
    T3VoiceStateStore.setForeground(true)
  }

  private fun reconcileSemanticStartCommand(generation: Long, startId: Int) {
    val snapshot = semanticController.snapshot()
    when (
      T3VoiceSemanticStartIntentPolicy.decide(
        requestedGeneration = generation,
        snapshot = snapshot,
        serviceCanStop = canStopServiceLocked(),
      )
    ) {
      T3VoiceSemanticStartIntentDecision.ACTIVATE -> Unit
      T3VoiceSemanticStartIntentDecision.IGNORE_STALE -> return
      T3VoiceSemanticStartIntentDecision.STOP_IDLE_SERVICE -> {
        stopSelf(startId)
        return
      }
    }

    try {
      ensureRuntimeForeground(SEMANTIC_FOREGROUND_SERVICE_TYPES)
      if (semanticController.activateInitialStart(generation)) return
      semanticController.onCallback(
        generation,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure(
            code = "voice-start-activation-lost",
            message = "The admitted voice start could not be activated.",
            recoverable = true,
          ),
        ),
      )
    } catch (_: Throwable) {
      semanticController.onCallback(
        generation,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure(
            code = "foreground-service-start-failed",
            message = "Android could not start voice in the foreground.",
            recoverable = true,
          ),
        ),
      )
      val failed = semanticController.snapshot()
      reconcileSemanticControlsLocked(failed)
    } finally {
      stopRuntimeForegroundLocked()
    }
    when (
      T3VoiceSemanticStartFailurePolicy.decide(
        foregroundAcquired = T3VoiceStateStore.state.value.isForeground,
      )
    ) {
      T3VoiceSemanticStartFailureDecision.RETAIN_FOREGROUND_FAILURE ->
        if (canStopServiceLocked()) stopSelf(startId)
      T3VoiceSemanticStartFailureDecision.STOP_UNPROMOTED_START -> {
        // Clear the startForegroundService obligation immediately. An attached binder may keep
        // this instance alive long enough for React to observe the in-memory Failed snapshot.
        if (canStopServiceLocked()) stopSelf(startId)
      }
    }
  }

  private fun dispatchAndroidControlLocked(
    generation: Long,
    action: T3VoiceAndroidControlAction?,
    owner: T3VoiceAndroidControlOwner?,
  ) {
    if (action == null || owner == null) return
    dispatchAndroidControlLocked(action, owner, generation)
  }

  private fun dispatchAndroidControlLocked(
    action: T3VoiceAndroidControlAction,
    owner: T3VoiceAndroidControlOwner,
    generation: Long,
  ) {
    when (owner) {
      T3VoiceAndroidControlOwner.READINESS -> {
        if (generation != readinessOwner.snapshot().generation) return
        when (action) {
          T3VoiceAndroidControlAction.START -> startPreparedReadinessLocked(generation)
          T3VoiceAndroidControlAction.DISABLE ->
            disableReadinessLocked(generation + 1, persistMarker = true)
          else -> Unit
        }
      }
      T3VoiceAndroidControlOwner.OPERATION -> {
        val snapshot = semanticController.snapshot()
        if (generation != snapshot.generation) return
        val command =
          when (action) {
            T3VoiceAndroidControlAction.SWITCH_TO_THREAD ->
              preparedThreadStartFor(snapshot)?.let {
                T3VoiceRuntimeCommand.SwitchRealtimeToThread(it.target, it.settings)
              }
            else ->
              action.toNotificationActionId()?.let { id ->
                T3VoiceNotificationActions.forSnapshot(snapshot)
                  .firstOrNull { it.id == id }
                  ?.command
              }
          } ?: return
        val result = semanticController.dispatch(command)
        reconcileSemanticControlsLocked(result.snapshot)
      }
    }
  }

  private fun startPreparedReadinessLocked(generation: Long) {
    if (!isCompletelyIdle() || hasActiveLegacyMediaOwnerLocked()) return
    when (val decision = readinessOwner.start(generation)) {
      is T3VoiceReadinessStartDecision.Start -> {
        val result = dispatchSemanticCommand(decision.command)
        if (result.outcome == T3VoiceCommandOutcome.APPLIED) {
          readinessLaunch =
            T3VoiceReadinessLaunch(
              operationGeneration = result.snapshot.generation,
              readinessGeneration = generation,
            )
        }
      }
      is T3VoiceReadinessStartDecision.Expired -> {
        publishReadinessLocked(decision.snapshot)
        reconcileSemanticControlsLocked(semanticController.snapshot())
      }
      T3VoiceReadinessStartDecision.IgnoreStale,
      T3VoiceReadinessStartDecision.Unavailable,
      -> Unit
    }
  }

  private fun disableReadinessLocked(
    generation: Long,
    persistMarker: Boolean = false,
  ): T3VoiceReadinessSnapshot.Disabled {
    readinessOwner.validateNextGeneration(generation)
    if (persistMarker) readinessDisableMarker.mark(generation)
    val disabled = readinessOwner.disable(generation)
    readinessExpiryCoordinator.cancel()
    publishReadinessLocked(disabled)
    reconcileSemanticControlsLocked(semanticController.snapshot())
    return disabled
  }

  private fun publishReadinessLocked(snapshot: T3VoiceReadinessSnapshot) {
    mutableReadinessSnapshots.value = snapshot
  }

  private fun scheduleReadinessExpiryLocked(configuration: T3VoiceReadinessConfiguration) {
    readinessExpiryCoordinator.replace(configuration)
  }

  private fun dispatchSemanticCommand(command: T3VoiceRuntimeCommand): T3VoiceCommandResult {
    val result =
      synchronized(operationLock) {
        if (
          (command is T3VoiceRuntimeCommand.StartRealtime ||
            command is T3VoiceRuntimeCommand.StartThread) &&
            !T3VoiceRuntimeAdmissionPolicy.canStartSemantic(hasActiveLegacyMediaOwnerLocked())
        ) {
          return@synchronized T3VoiceCommandResult(
            outcome = T3VoiceCommandOutcome.REJECTED,
            snapshot = semanticController.snapshot(),
            rejection = T3VoiceCommandRejection.BUSY,
          )
        }
        semanticController.dispatch(command).also {
          reconcileSemanticControlsLocked(it.snapshot)
        }
      }
    if (
      result.outcome == T3VoiceCommandOutcome.APPLIED &&
        (command is T3VoiceRuntimeCommand.StartRealtime ||
          command is T3VoiceRuntimeCommand.StartThread)
    ) {
      try {
        startForSemanticRuntime(this, result.snapshot.generation)
      } catch (cause: Throwable) {
        synchronized(operationLock) {
          if (semanticController.snapshot().generation == result.snapshot.generation) {
            semanticController.dispatch(T3VoiceRuntimeCommand.Stop)
          }
          val rolledBack = semanticController.snapshot()
          reconcileSemanticControlsLocked(rolledBack)
        }
        throw IllegalStateException("Android could not start the voice foreground service.", cause)
      }
    }
    return result
  }

  private fun requireLegacyMediaAdmissionLocked() {
    check(
      T3VoiceRuntimeAdmissionPolicy.canStartLegacy(semanticController.snapshot().state),
    ) { "A native voice runtime operation is already active." }
  }

  private fun hasActiveLegacyMediaOwnerLocked(): Boolean {
    val state = T3VoiceStateStore.state.value
    return recordingOwner != null ||
      playbackOwner != null ||
      state.activeRecordingId != null ||
      state.activePlaybackId != null
  }

  @SuppressLint("WakelockTimeout")
  private fun reconcileSemanticWakeLock(state: T3VoiceControllerState) {
    if (T3VoiceRuntimeLifecyclePolicy.shouldHoldWakeLock(state)) {
      if (!semanticWakeLock.isHeld) semanticWakeLock.acquire()
    } else if (semanticWakeLock.isHeld) {
      semanticWakeLock.release()
    }
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
      T3VoiceStartCommandDecision.STOP_STALE_START ->
        if (canStopServiceLocked()) stopSelf(startId)
    }
  }

  private fun ensureRuntimeForeground(foregroundServiceType: Int) {
    check(Thread.holdsLock(operationLock)) {
      "Foreground acquisition must hold the operation lock."
    }
    if (
      !T3VoiceStateStore.state.value.isForeground ||
        foregroundServiceTypes and foregroundServiceType != foregroundServiceType
    ) {
      startRuntimeForeground(foregroundServiceType)
    }
    check(T3VoiceStateStore.state.value.isForeground) {
      "Android could not acquire foreground voice ownership."
    }
  }

  private fun stopActiveOperationLocked() {
    val state = T3VoiceStateStore.state.value
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
    stopRuntimeForegroundLocked()
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
    semanticDriver.releaseLegacyAudio()
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminateRecordingLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.terminateRecording(owner, event)) return
    semanticDriver.releaseLegacyAudio()
    if (recordingOwner == owner) recordingOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun releasePlaybackLocked(
    owner: T3VoiceOperationOwner,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.releasePlayback(owner)) return
    semanticDriver.releaseLegacyAudio()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun terminatePlaybackLocked(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.PlaybackTerminated,
    stopForeground: Boolean = true,
  ) {
    if (!T3VoiceStateStore.terminatePlayback(owner, event)) return
    semanticDriver.releaseLegacyAudio()
    if (playbackOwner == owner) playbackOwner = null
    if (stopForeground) stopRuntimeForegroundLocked()
  }

  private fun stopRuntimeForegroundLocked() {
    if (
      canStopServiceLocked() && T3VoiceStateStore.state.value.isForeground
    ) {
      foregroundReleaseCoordinator.releaseWhileLocked()
    }
  }

  private fun handleLegacyAudioFocusActions(actions: List<T3VoiceAudioFocusAction>) {
    mainHandler.post {
      synchronized(operationLock) {
        actions.forEach { action ->
          when (action) {
            T3VoiceAudioFocusAction.MUTE_CAPTURE -> Unit
            T3VoiceAudioFocusAction.UNMUTE_CAPTURE -> Unit
            T3VoiceAudioFocusAction.PAUSE_PLAYBACK ->
              playbackOwner?.let { owner -> runCatching { player.pause(owner.id) } }
            T3VoiceAudioFocusAction.RESUME_PLAYBACK ->
              playbackOwner?.let { owner -> runCatching { player.resume(owner.id) } }
            T3VoiceAudioFocusAction.TERMINATE_SESSION -> {
              recordingOwner?.let { owner ->
                runCatching { recorder.cancel(owner.id) }
                terminateRecordingLocked(
                  owner,
                  T3VoiceRuntimeEvent.RecordingTerminated(
                    recordingId = owner.id,
                    recording = null,
                    outcome = "cancelled",
                    reason = "audio-focus-lost",
                  ),
                )
              }
              playbackOwner?.let { owner ->
                runCatching { player.cancel(owner.id) }
                terminatePlaybackLocked(
                  owner,
                  T3VoiceRuntimeEvent.PlaybackTerminated(owner.id, "cancelled"),
                )
              }
            }
          }
        }
      }
    }
  }

  private fun isCompletelyIdle(): Boolean {
    val raw = T3VoiceStateStore.state.value
    val rawIdle =
      recordingOwner == null &&
        playbackOwner == null &&
        raw.activeRecordingId == null &&
        raw.activePlaybackId == null
    val semanticIdle =
      !this::semanticController.isInitialized ||
        !semanticController.snapshot().state.needsForeground()
    return rawIdle && semanticIdle
  }

  private fun canStopServiceLocked(): Boolean =
    T3VoiceServiceOwnershipPolicy.canStop(
      operationIdle = isCompletelyIdle(),
      readiness = readinessOwner.snapshot(),
    )

  private fun preparedThreadStartFor(
    snapshot: T3VoiceControllerSnapshot,
  ): T3VoiceThreadStart? {
    val realtime = snapshot.state as? T3VoiceControllerState.Realtime ?: return null
    return readinessOwner.preparedThreadStartFor(realtime.target.environmentId)
  }

  private fun reconcileSemanticControlsLocked(snapshot: T3VoiceControllerSnapshot) {
    if (snapshot != semanticController.snapshot()) return
    when (
      T3VoiceReadinessFailurePolicy.disposition(
        snapshot,
        readinessOwner.snapshot(),
        readinessLaunch,
      )
    ) {
      T3VoiceReadinessFailureDisposition.NEEDS_REFRESH ->
        readinessOwner.markNeedsRefresh()?.let(::publishReadinessLocked)
      T3VoiceReadinessFailureDisposition.UNAVAILABLE ->
        readinessOwner.markUnavailable()?.let(::publishReadinessLocked)
      T3VoiceReadinessFailureDisposition.NONE -> Unit
    }
    readinessLaunch?.let { launch ->
      if (
        snapshot.generation != launch.operationGeneration ||
        snapshot.state is T3VoiceControllerState.Idle ||
        snapshot.state is T3VoiceControllerState.Failed
      ) {
        readinessLaunch = null
      }
    }
    if (semanticController.settleQuiescedFailure(snapshot.generation)) {
      reconcileSemanticControlsLocked(semanticController.snapshot())
      return
    }
    val render =
      androidControls.render(
        snapshot,
        readinessOwner.snapshot(),
        preparedThreadStartFor(snapshot) != null,
        NOTIFICATION_CHANNEL_ID,
      )
    reconcileSemanticWakeLock(snapshot.state)
    if (render.changed && T3VoiceStateStore.state.value.isForeground) {
      render.notification?.let { notification ->
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
      }
    }
    stopRuntimeForegroundLocked()
  }

  private fun currentNotification(): Notification {
    val snapshot =
      if (this::semanticController.isInitialized) {
        semanticController.snapshot().takeIf {
          it.state.needsForeground() || readinessOwner.snapshot().retainsService()
        }
      } else {
        null
      }
    return if (snapshot != null && this::androidControls.isInitialized) {
      checkNotNull(
        androidControls.render(
          snapshot,
          readinessOwner.snapshot(),
          preparedThreadStartFor(snapshot) != null,
          NOTIFICATION_CHANNEL_ID,
        ).notification,
      ) {
        "Retained voice state did not produce a foreground notification."
      }
    } else {
      buildNotification()
    }
  }

  private fun stopRuntimeForeground() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    foregroundServiceTypes = 0
    T3VoiceStateStore.setForeground(false)
    stopSelf()
  }

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
    return builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle("T3 voice is active")
      .setContentText("Tap Stop to end the active voice operation.")
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
      .build()
  }

  companion object {
    private const val NOTIFICATION_CHANNEL_ID = "t3_voice_runtime"
    private const val NOTIFICATION_ID = 3107
    private const val STOP_REQUEST_CODE = 3108
    private const val CONTENT_REQUEST_CODE = 3109
    private const val ACTION_STOP = "expo.modules.t3voice.action.STOP"
    private const val ACTION_START_RECORDING = "expo.modules.t3voice.action.START_RECORDING"
    private const val ACTION_START_PLAYBACK = "expo.modules.t3voice.action.START_PLAYBACK"
    private const val EXTRA_OPERATION_ID = "operationId"
    internal const val ACTION_SEMANTIC_CONTROL =
      "expo.modules.t3voice.action.SEMANTIC_CONTROL"
    internal const val EXTRA_SEMANTIC_ACTION = "semanticAction"
    internal const val EXTRA_SEMANTIC_GENERATION = "semanticGeneration"
    internal const val EXTRA_CONTROL_OWNER = "controlOwner"
    private const val ACTION_START_SEMANTIC_RUNTIME =
      "expo.modules.t3voice.action.START_SEMANTIC_RUNTIME"
    private const val ACTION_START_READINESS = "expo.modules.t3voice.action.START_READINESS"
    internal const val ACTION_READINESS_EXPIRY =
      "expo.modules.t3voice.action.READINESS_EXPIRY"
    internal const val EXTRA_READINESS_GENERATION = "readinessGeneration"
    private const val INVALID_GENERATION = -1L
    private const val SEMANTIC_WAKE_LOCK_TAG = "t3tools:voice-runtime"
    private val SEMANTIC_FOREGROUND_SERVICE_TYPES =
      ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    fun startForRecording(context: Context, recordingId: String) {
      start(context, ACTION_START_RECORDING, recordingId)
    }

    fun startForPlayback(context: Context, playbackId: String) {
      start(context, ACTION_START_PLAYBACK, playbackId)
    }

    fun startForSemanticRuntime(context: Context, generation: Long) {
      val intent =
        Intent(context, T3VoiceRuntimeService::class.java).apply {
          action = ACTION_START_SEMANTIC_RUNTIME
          putExtra(EXTRA_SEMANTIC_GENERATION, generation)
        }
      start(context, intent)
    }

    fun startForReadiness(context: Context) {
      val intent =
        Intent(context, T3VoiceRuntimeService::class.java).apply {
          action = ACTION_START_READINESS
        }
      start(context, intent)
    }

    fun requestStop(context: Context) {
      start(context, ACTION_STOP, null)
    }

    private fun start(context: Context, action: String, operationId: String?) {
      val intent =
        Intent(context, T3VoiceRuntimeService::class.java).apply {
          this.action = action
          if (operationId != null) putExtra(EXTRA_OPERATION_ID, operationId)
        }
      start(context, intent)
    }

    private fun start(context: Context, intent: Intent) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }
}

private fun T3VoiceAndroidControlAction.toNotificationActionId(): T3VoiceNotificationActionId? =
  when (this) {
    T3VoiceAndroidControlAction.MUTE -> T3VoiceNotificationActionId.MUTE
    T3VoiceAndroidControlAction.UNMUTE -> T3VoiceNotificationActionId.UNMUTE
    T3VoiceAndroidControlAction.FINISH_UTTERANCE -> T3VoiceNotificationActionId.FINISH_UTTERANCE
    T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT -> T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT
    T3VoiceAndroidControlAction.SKIP -> T3VoiceNotificationActionId.SKIP
    T3VoiceAndroidControlAction.STOP -> T3VoiceNotificationActionId.STOP
    T3VoiceAndroidControlAction.START,
    T3VoiceAndroidControlAction.DISABLE,
    T3VoiceAndroidControlAction.SWITCH_TO_THREAD,
    -> null
  }
