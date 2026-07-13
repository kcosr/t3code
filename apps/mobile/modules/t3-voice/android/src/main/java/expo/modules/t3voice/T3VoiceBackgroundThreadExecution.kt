package expo.modules.t3voice

import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

internal data class T3VoiceBackgroundThreadAuthority(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val selectedProjectId: String,
  val selectedThreadId: String,
  val autoRearm: Boolean,
)

internal data class T3VoiceBackgroundThreadAuthorization(
  val authority: T3VoiceBackgroundThreadAuthority,
  val runtimeGrantToken: String,
)

internal object T3VoiceBackgroundThreadAuthorityPolicy {
  fun validate(
    readiness: T3VoiceReadinessConfig,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
    expectedTargetIdentityDigest: String,
    nowMillis: Long,
  ): T3VoiceBackgroundThreadAuthorization? {
    if (!readiness.isEffective() || readiness.mode != T3VoiceReadinessMode.THREAD ||
      !readiness.microphonePermissionGranted) return null
    val targetParts = readiness.targetId?.split('/') ?: return null
    if (targetParts.size != 2 || targetParts.any { it.isBlank() || it.length > 256 }) return null
    val (selectedProjectId, selectedThreadId) = targetParts
    val grant = (loadedGrant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant ?: return null
    val metadata = grant.metadata
    if (metadata.readinessGeneration != readiness.generation ||
      metadata.operation != T3VoiceRuntimeGrantOperation.THREAD_TURN_START ||
      metadata.targetIdentityDigest != expectedTargetIdentityDigest ||
      metadata.expiresAtEpochMillis <= nowMillis) return null
    return T3VoiceBackgroundThreadAuthorization(
      T3VoiceBackgroundThreadAuthority(
        metadata.runtimeId,
        metadata.readinessGeneration,
        T3VoiceBackgroundOriginPolicy.normalize(metadata.environmentOrigin),
        selectedProjectId,
        selectedThreadId,
        readiness.autoRearm,
      ),
      grant.token,
    )
  }

  fun validateCreated(
    authority: T3VoiceBackgroundThreadAuthority,
    clientOperationId: String,
    result: T3VoiceBackgroundThreadTurnCreateResult,
    nowMillis: Long,
  ): Boolean {
    val snapshot = result.snapshot
    return snapshot.runtimeId == authority.runtimeId &&
      snapshot.generation == authority.readinessGeneration &&
      snapshot.projectId == authority.selectedProjectId &&
      snapshot.threadId == authority.selectedThreadId &&
      snapshot.operationId.isNotBlank() && clientOperationId.isNotBlank() &&
      snapshot.acknowledgedSequence <= snapshot.lastSequence &&
      snapshot.expiresAtEpochMillis > nowMillis &&
      result.operationGrant.expiresAtEpochMillis > nowMillis &&
      result.operationGrant.expiresAtEpochMillis <= snapshot.expiresAtEpochMillis
  }

  fun validateSnapshot(
    authority: T3VoiceBackgroundThreadAuthority,
    operationId: String,
    priorCursor: Long,
    snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  ): Boolean =
    snapshot.operationId == operationId &&
      snapshot.runtimeId == authority.runtimeId &&
      snapshot.generation == authority.readinessGeneration &&
      snapshot.projectId == authority.selectedProjectId &&
      snapshot.threadId == authority.selectedThreadId &&
      snapshot.lastSequence >= priorCursor &&
      snapshot.acknowledgedSequence <= snapshot.lastSequence

  fun restore(
    readiness: T3VoiceReadinessConfig,
    activeAuthority: T3VoicePreparedReadiness?,
    state: T3VoiceBackgroundThreadOperationState.Active,
    nowMillis: Long,
  ): T3VoiceBackgroundThreadAuthority? {
    val target = "${state.claim.projectId}/${state.claim.threadId}"
    if (!readiness.isEffective() || readiness.mode != T3VoiceReadinessMode.THREAD ||
      !readiness.microphonePermissionGranted || readiness.targetId != target ||
      state.expiresAtEpochMillis <= nowMillis) return null
    val installed = activeAuthority ?: return null
    if (installed.runtimeId != state.claim.runtimeId ||
      installed.config.generation != state.claim.readinessGeneration ||
      installed.environmentOrigin != state.claim.environmentOrigin ||
      installed.operation != T3VoiceRuntimeGrantOperation.THREAD_TURN_START ||
      installed.targetIdentityDigest != T3VoiceRuntimeTargetIdentity.digest(target)) return null
    return T3VoiceBackgroundThreadAuthority(
      state.claim.runtimeId, state.claim.readinessGeneration, state.claim.environmentOrigin,
      state.claim.projectId, state.claim.threadId, state.snapshot.autoRearm,
    )
  }
}

internal data class T3VoiceBackgroundThreadAttempt(
  val authority: T3VoiceBackgroundThreadAuthority,
  val clientOperationId: String,
  var operationId: String? = null,
  var operationGrantToken: String? = null,
  var acknowledgedCursor: Long = 0,
  var recording: T3VoiceRecordingResult? = null,
  var polling: Boolean = false,
  var acknowledging: Boolean = false,
  val pendingSpeech: java.util.TreeMap<Int, ByteArray> = java.util.TreeMap(),
  var playingSegment: Int? = null,
  var playbackFailures: Int = 0,
  var detached: Boolean = false,
  var cancelRequested: Boolean = false,
  var retryFailures: Int = 0,
  var stopped: Boolean = false,
) {
  private var activeCall: T3VoiceBackgroundThreadCall<*>? = null
  private var cancellationCall: T3VoiceBackgroundThreadCall<*>? = null

  @Synchronized fun beginCall(
    call: T3VoiceBackgroundThreadCall<*>,
    allowCancellationRecovery: Boolean = false,
  ): Boolean {
    if (stopped || (cancelRequested && !allowCancellationRecovery)) {
      call.cancel()
      return false
    }
    activeCall?.cancel()
    activeCall = call
    return true
  }

  @Synchronized fun finishCall(call: T3VoiceBackgroundThreadCall<*>): Boolean {
    if (activeCall !== call) return false
    activeCall = null
    return true
  }

  @Synchronized fun cancelActiveCall() {
    activeCall?.cancel()
    activeCall = null
  }

  @Synchronized fun beginCancellationCall(call: T3VoiceBackgroundThreadCall<*>) {
    cancellationCall?.cancel()
    cancellationCall = call
  }

  @Synchronized fun finishCancellationCall(call: T3VoiceBackgroundThreadCall<*>): Boolean {
    if (cancellationCall !== call) return false
    cancellationCall = null
    return true
  }

  @Synchronized fun cancelAllCalls() {
    activeCall?.cancel()
    cancellationCall?.cancel()
    activeCall = null
    cancellationCall = null
  }

  @Synchronized fun hasActiveCall(): Boolean = activeCall != null || cancellationCall != null
}

internal object T3VoiceBackgroundThreadAttemptPolicy {
  fun owns(
    attempt: T3VoiceBackgroundThreadAttempt,
    readiness: T3VoiceReadinessConfig,
  ): Boolean =
    readiness.isEffective() &&
      readiness.mode == T3VoiceReadinessMode.THREAD &&
      readiness.generation == attempt.authority.readinessGeneration &&
      readiness.targetId ==
        "${attempt.authority.selectedProjectId}/${attempt.authority.selectedThreadId}" &&
      readiness.autoRearm == attempt.authority.autoRearm
}

internal object T3VoiceBackgroundThreadRetryPolicy {
  fun delayMillis(failures: Int): Long {
    require(failures >= 1)
    return (500L shl (failures - 1).coerceAtMost(6)).coerceAtMost(30_000L)
  }
}

internal object T3VoiceBackgroundThreadPlaybackPolicy {
  const val MAX_RETRIES = 3

  fun shouldRetry(failures: Int): Boolean {
    require(failures >= 1)
    return failures <= MAX_RETRIES
  }
}

internal object T3VoiceBackgroundThreadRevocationPolicy {
  fun matches(
    state: T3VoiceBackgroundThreadOperationState,
    expected: T3VoicePendingRuntimeRevocation,
  ): Boolean =
    state.claim.runtimeId == expected.runtimeId &&
      T3VoiceBackgroundOriginPolicy.normalize(state.claim.environmentOrigin) ==
      T3VoiceBackgroundOriginPolicy.normalize(expected.environmentOrigin)
}

internal enum class T3VoiceBackgroundThreadCancelDecision {
  COMPLETE,
  RETRY,
  AWAIT_REVOCATION,
}

internal object T3VoiceBackgroundThreadCancelPolicy {
  fun decide(result: T3VoiceBackgroundThreadTurnResult<*>): T3VoiceBackgroundThreadCancelDecision =
    when (result) {
      is T3VoiceBackgroundThreadTurnResult.Success -> T3VoiceBackgroundThreadCancelDecision.COMPLETE
      is T3VoiceBackgroundThreadTurnResult.Failure -> when {
        result.kind == T3VoiceBackgroundHttpFailureKind.PERMANENT &&
          result.statusCode in setOf(404, 410) -> T3VoiceBackgroundThreadCancelDecision.COMPLETE
        result.kind in setOf(
          T3VoiceBackgroundHttpFailureKind.RETRYABLE,
          T3VoiceBackgroundHttpFailureKind.CONFLICT,
          T3VoiceBackgroundHttpFailureKind.CANCELLED,
        ) -> T3VoiceBackgroundThreadCancelDecision.RETRY
        else -> T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION
      }
    }
}

internal object T3VoiceBackgroundThreadCancelReconciliationPolicy {
  fun requiresFence(decision: T3VoiceBackgroundThreadCancelDecision): Boolean =
    decision == T3VoiceBackgroundThreadCancelDecision.AWAIT_REVOCATION
}

internal object T3VoiceBackgroundThreadLocalCleanupCoordinator {
  fun complete(
    deleteRecording: () -> Boolean,
    clearDurableState: () -> Boolean,
  ): Boolean = deleteRecording() && clearDurableState()
}

internal object T3VoiceBackgroundThreadLocalStopCoordinator {
  fun complete(
    clearDurableState: () -> Boolean,
    stopSnapshot: () -> Unit,
    reconcileForeground: () -> Unit,
  ): Boolean {
    if (!clearDurableState()) return false
    stopSnapshot()
    reconcileForeground()
    return true
  }
}

internal object T3VoiceBackgroundThreadPreparedCancellationPolicy {
  fun runtimeGrantToken(loaded: T3VoiceRuntimeGrantLoadResult): String? =
    (loaded as? T3VoiceRuntimeGrantLoadResult.Available)?.grant?.token
}

internal object T3VoiceBackgroundThreadRearmPolicy {
  fun shouldReconcileAfterStart(hasAttempt: Boolean): Boolean = !hasAttempt
}

internal object T3VoiceBackgroundThreadRecordingRecovery {
  fun restore(
    loaded: T3VoiceBackgroundThreadOperationLoadResult,
    restoreCompleted: (T3VoiceRecordingResult) -> Boolean,
  ): Boolean {
    val recording =
      ((loaded as? T3VoiceBackgroundThreadOperationLoadResult.Available)?.state
        as? T3VoiceBackgroundThreadOperationState.Active)?.recording ?: return true
    return restoreCompleted(recording)
  }
}

internal enum class T3VoiceBackgroundThreadStoredStateDecision {
  NONE,
  RESTORE,
  CANCEL_UNSTARTED,
  REVOKE,
}

internal object T3VoiceBackgroundThreadStoredStatePolicy {
  fun decide(
    loaded: T3VoiceBackgroundThreadOperationLoadResult,
    parentGrantAvailable: Boolean,
    nowMillis: Long,
  ): T3VoiceBackgroundThreadStoredStateDecision = when (loaded) {
    T3VoiceBackgroundThreadOperationLoadResult.Missing ->
      T3VoiceBackgroundThreadStoredStateDecision.NONE
    T3VoiceBackgroundThreadOperationLoadResult.Locked ->
      T3VoiceBackgroundThreadStoredStateDecision.REVOKE
    is T3VoiceBackgroundThreadOperationLoadResult.Available -> when (val state = loaded.state) {
      is T3VoiceBackgroundThreadOperationState.Active ->
        if (state.expiresAtEpochMillis <= nowMillis) {
          T3VoiceBackgroundThreadStoredStateDecision.REVOKE
        } else if (
          state.snapshot.phase == T3VoiceBackgroundPhase.IDLE &&
            !state.snapshot.dispatchAcknowledged &&
            state.recording == null
        ) {
          T3VoiceBackgroundThreadStoredStateDecision.CANCEL_UNSTARTED
        } else {
          T3VoiceBackgroundThreadStoredStateDecision.RESTORE
        }
      is T3VoiceBackgroundThreadOperationState.Prepared ->
        if (parentGrantAvailable) {
          T3VoiceBackgroundThreadStoredStateDecision.RESTORE
        } else {
          T3VoiceBackgroundThreadStoredStateDecision.REVOKE
        }
    }
  }
}

internal object T3VoiceBackgroundThreadEventBatchPolicy {
  fun isContiguous(
    requestedAfter: Long,
    events: List<T3VoiceBackgroundThreadTurnEvent>,
    snapshotLastSequence: Long,
  ): Boolean {
    var expected = requestedAfter + 1
    events.forEach { event ->
      if (event.sequence != expected) return false
      expected += 1
    }
    return events.isNotEmpty() || snapshotLastSequence == requestedAfter
  }
}

internal enum class T3VoiceBackgroundThreadEventCommitDecision {
  ACKNOWLEDGE,
  CONTINUE,
}

internal object T3VoiceBackgroundThreadEventCommitPolicy {
  fun afterBatch(
    eventCursor: Long,
    acknowledgedCursor: Long,
  ): T3VoiceBackgroundThreadEventCommitDecision =
    if (eventCursor > acknowledgedCursor) {
      T3VoiceBackgroundThreadEventCommitDecision.ACKNOWLEDGE
    } else {
      T3VoiceBackgroundThreadEventCommitDecision.CONTINUE
    }
}

internal data class T3VoiceBackgroundThreadBatchTransition(
  val snapshot: T3VoiceBackgroundSnapshot,
  val commands: Set<T3VoiceBackgroundCommand>,
)

internal object T3VoiceBackgroundThreadBatchReducer {
  fun reduce(
    initial: T3VoiceBackgroundSnapshot,
    events: List<T3VoiceBackgroundEvent.ServerEvent>,
  ): T3VoiceBackgroundThreadBatchTransition {
    var snapshot = initial
    val commands = mutableSetOf<T3VoiceBackgroundCommand>()
    events.forEach { event ->
      val transition = T3VoiceBackgroundReducer.reduce(snapshot, event)
      snapshot = transition.snapshot
      commands += transition.commands
    }
    return T3VoiceBackgroundThreadBatchTransition(snapshot, commands)
  }
}

internal object T3VoiceBackgroundThreadTerminalPolicy {
  fun canCleanup(
    snapshot: T3VoiceBackgroundSnapshot,
    acknowledgedCursor: Long,
    detached: Boolean,
  ): Boolean {
    if (!snapshot.responseTerminal || acknowledgedCursor < snapshot.eventCursor) return false
    if (detached) return true
    return when (snapshot.terminalSummary) {
      T3VoiceBackgroundTerminalSummary.COMPLETED -> snapshot.speechFullyDrained()
      T3VoiceBackgroundTerminalSummary.CANCELLED,
      T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
      T3VoiceBackgroundTerminalSummary.FAILED_PERMANENT,
      T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED,
      -> true
      null -> false
    }
  }

  fun shouldAutoRearm(snapshot: T3VoiceBackgroundSnapshot): Boolean =
    snapshot.autoRearm &&
      snapshot.terminalSummary == T3VoiceBackgroundTerminalSummary.COMPLETED

  fun shouldPollAfterAck(
    snapshot: T3VoiceBackgroundSnapshot,
    detached: Boolean,
  ): Boolean {
    if (detached) return !snapshot.responseTerminal
    if (!snapshot.responseTerminal) return true
    return snapshot.terminalSummary == T3VoiceBackgroundTerminalSummary.COMPLETED &&
      !snapshot.speechTerminal
  }
}

internal object T3VoiceBackgroundThreadPersistencePolicy {
  fun snapshotAfterTransition(
    active: T3VoiceBackgroundThreadOperationState.Active,
    transition: T3VoiceBackgroundSnapshot,
  ): T3VoiceBackgroundSnapshot =
    transition.takeIf { it.operationId == active.operationId } ?: active.snapshot
}

internal object T3VoiceBackgroundWakeLockPolicy {
  fun shouldRetain(
    hasThreadWork: Boolean,
    hasRealtimeMedia: Boolean,
    hasRealtimeCleanupInFlight: Boolean,
  ): Boolean = hasThreadWork || hasRealtimeMedia || hasRealtimeCleanupInFlight
}

internal object T3VoiceRevocationAcknowledgementCoordinator {
  fun run(
    pendingMatches: Boolean,
    clearDerivedState: () -> Boolean,
    clearPendingFence: () -> Boolean,
  ): Boolean {
    if (!pendingMatches || !clearDerivedState()) return false
    return clearPendingFence()
  }
}

internal data class T3VoiceBackgroundThreadSpeechWork(
  val segmentIndex: Int,
  val advertisedSequence: Long?,
)

internal object T3VoiceBackgroundThreadSpeechPolicy {
  fun next(
    playbackCursor: Int,
    highestAdvertisedSegment: Int,
    events: List<T3VoiceBackgroundThreadTurnEvent>,
  ): T3VoiceBackgroundThreadSpeechWork? {
    if (playbackCursor < highestAdvertisedSegment) {
      return T3VoiceBackgroundThreadSpeechWork(playbackCursor + 1, null)
    }
    return events.filterIsInstance<T3VoiceBackgroundThreadTurnEvent.SpeechReady>()
      .firstOrNull { it.segmentIndex > playbackCursor }
      ?.let { T3VoiceBackgroundThreadSpeechWork(it.segmentIndex, it.sequence) }
  }

  fun acceptedPrefix(
    events: List<T3VoiceBackgroundThreadTurnEvent>,
    work: T3VoiceBackgroundThreadSpeechWork?,
  ): List<T3VoiceBackgroundThreadTurnEvent> =
    if (work?.advertisedSequence == null) events
    else events.takeWhile { it.sequence <= work.advertisedSequence }
}

internal class T3VoiceRecordingFileBody(recording: T3VoiceRecordingResult) :
  T3VoiceBackgroundRequestBody {
  private val file = Uri.parse(recording.uri).path?.let(::File)
    ?: error("Native thread recording URI is invalid.")
  override val contentType = T3VoiceRecordingResult.MIME_TYPE
  override val contentLength = recording.byteLength

  init {
    require(file.isFile && file.length() == recording.byteLength) {
      "Native thread recording file is unavailable."
    }
  }

  override fun openStream(): InputStream = FileInputStream(file)
}

internal object T3VoiceBackgroundThreadRecordingBodyPolicy {
  fun create(recording: T3VoiceRecordingResult): T3VoiceRecordingFileBody? =
    runCatching { T3VoiceRecordingFileBody(recording) }.getOrNull()
}
