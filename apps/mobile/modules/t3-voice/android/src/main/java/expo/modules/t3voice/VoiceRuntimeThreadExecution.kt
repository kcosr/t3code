package expo.modules.t3voice

import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

internal data class VoiceRuntimeThreadAuthority(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val selectedProjectId: String,
  val selectedThreadId: String,
  val autoRearm: Boolean,
  val endSilenceMs: Long = 2_200,
  val noSpeechTimeoutMs: Long? = null,
  val maximumUtteranceMs: Long = 3_600_000,
  val rearmGuardMs: Long = 0,
)

internal data class VoiceRuntimeThreadAuthorization(
  val authority: VoiceRuntimeThreadAuthority,
)

internal object VoiceRuntimeThreadAuthorityPolicy {
  fun validateCanonical(
    persisted: VoiceRuntimePersistedAuthority,
    consumerCount: Int,
    microphonePermissionGranted: Boolean,
    nowMillis: Long,
    allowDetachedContinuation: Boolean = false,
  ): VoiceRuntimeThreadAuthorization? {
    val target = persisted.target as? VoiceRuntimeTarget.Thread ?: return null
    if (!microphonePermissionGranted ||
      (!allowDetachedContinuation && !VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(
        persisted.readinessEnabled,
        consumerCount,
      ))) return null
    return VoiceRuntimeThreadAuthorization(
      VoiceRuntimeThreadAuthority(
        persisted.runtimeId,
        persisted.generation,
        VoiceRuntimeOriginPolicy.normalize(persisted.environmentOrigin),
        target.projectId,
        target.threadId,
        target.autoRearm,
        target.endSilenceMs,
        target.noSpeechTimeoutMs,
        target.maximumUtteranceMs,
        target.rearmGuardMs,
      ),
    )
  }

  fun restoreCanonical(
    persisted: VoiceRuntimePersistedAuthority,
    consumerCount: Int,
    microphonePermissionGranted: Boolean,
    state: VoiceRuntimeThreadOperationState.Active,
    nowMillis: Long,
  ): VoiceRuntimeThreadAuthority? {
    val authorized = validateCanonical(
      persisted,
      consumerCount,
      microphonePermissionGranted,
      nowMillis,
    ) ?: return null
    val authority = authorized.authority
    val claim = state.claim
    if (state.expiresAtEpochMillis <= nowMillis ||
      claim.runtimeId != authority.runtimeId ||
      claim.readinessGeneration != authority.readinessGeneration ||
      VoiceRuntimeOriginPolicy.normalize(claim.environmentOrigin) != authority.environmentOrigin ||
      claim.projectId != authority.selectedProjectId ||
      claim.threadId != authority.selectedThreadId) return null
    return authority
  }

  fun validate(
    readiness: T3VoiceReadinessConfig,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
    expectedTargetIdentityDigest: String,
    nowMillis: Long,
  ): VoiceRuntimeThreadAuthorization? {
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
    return VoiceRuntimeThreadAuthorization(
      VoiceRuntimeThreadAuthority(
        metadata.runtimeId,
        metadata.readinessGeneration,
        VoiceRuntimeOriginPolicy.normalize(metadata.environmentOrigin),
        selectedProjectId,
        selectedThreadId,
        readiness.autoRearm,
      ),
    )
  }

  fun validateCreated(
    authority: VoiceRuntimeThreadAuthority,
    clientOperationId: String,
    result: VoiceRuntimeThreadTurnCreateResult,
    nowMillis: Long,
  ): Boolean {
    val snapshot = result.snapshot
    return snapshot.runtimeId == authority.runtimeId &&
      snapshot.generation == authority.readinessGeneration &&
      snapshot.projectId == authority.selectedProjectId &&
      snapshot.threadId == authority.selectedThreadId &&
      snapshot.operationId.isNotBlank() && clientOperationId.isNotBlank() &&
      snapshot.acknowledgedSequence <= snapshot.lastSequence &&
      snapshot.operationTokenExpiresAtEpochMillis > nowMillis &&
      snapshot.operationTokenExpiresAtEpochMillis <= snapshot.retentionExpiresAtEpochMillis &&
      snapshot.retentionExpiresAtEpochMillis > nowMillis
  }

  fun cancellationAuthority(
    state: VoiceRuntimeThreadOperationState.Active,
  ): VoiceRuntimeThreadAuthority =
    VoiceRuntimeThreadAuthority(
      state.claim.runtimeId,
      state.claim.readinessGeneration,
      VoiceRuntimeOriginPolicy.normalize(state.claim.environmentOrigin),
      state.claim.projectId,
      state.claim.threadId,
      state.snapshot.autoRearm,
    )

  fun validatePreparedCancellation(
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
    activeAuthority: T3VoicePreparedReadiness?,
    claim: VoiceRuntimeThreadClaim,
    nowMillis: Long,
  ): VoiceRuntimeThreadAuthorization? {
    val grant = (loadedGrant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant ?: return null
    val target = "${claim.projectId}/${claim.threadId}"
    val installed = activeAuthority ?: return null
    if (
      grant.metadata.runtimeId != claim.runtimeId ||
        grant.metadata.readinessGeneration != claim.readinessGeneration ||
        VoiceRuntimeOriginPolicy.normalize(grant.metadata.environmentOrigin) !=
          VoiceRuntimeOriginPolicy.normalize(claim.environmentOrigin) ||
        grant.metadata.operation != T3VoiceRuntimeGrantOperation.THREAD_TURN_START ||
        installed.runtimeId != claim.runtimeId ||
        installed.config.generation != claim.readinessGeneration ||
        installed.config.mode != T3VoiceReadinessMode.THREAD ||
        installed.config.targetId != target ||
        VoiceRuntimeOriginPolicy.normalize(installed.environmentOrigin) !=
          VoiceRuntimeOriginPolicy.normalize(claim.environmentOrigin) ||
        installed.operation != T3VoiceRuntimeGrantOperation.THREAD_TURN_START ||
        installed.targetIdentityDigest != grant.metadata.targetIdentityDigest ||
        grant.metadata.expiresAtEpochMillis <= nowMillis
    ) return null
    return VoiceRuntimeThreadAuthorization(
      VoiceRuntimeThreadAuthority(
        claim.runtimeId,
        claim.readinessGeneration,
        VoiceRuntimeOriginPolicy.normalize(claim.environmentOrigin),
        claim.projectId,
        claim.threadId,
        false,
      ),
    )
  }

  fun validateSnapshot(
    authority: VoiceRuntimeThreadAuthority,
    operationId: String,
    priorCursor: Long,
    snapshot: VoiceRuntimeThreadTurnSnapshot,
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
    state: VoiceRuntimeThreadOperationState.Active,
    nowMillis: Long,
  ): VoiceRuntimeThreadAuthority? {
    val target = "${state.claim.projectId}/${state.claim.threadId}"
    if (!readiness.isEffective() || readiness.mode != T3VoiceReadinessMode.THREAD ||
      readiness.generation != state.claim.readinessGeneration ||
      !readiness.microphonePermissionGranted || readiness.targetId != target ||
      state.expiresAtEpochMillis <= nowMillis) return null
    val installed = activeAuthority ?: return null
    if (installed.runtimeId != state.claim.runtimeId ||
      installed.config.generation != state.claim.readinessGeneration ||
      installed.config.mode != T3VoiceReadinessMode.THREAD ||
      installed.config.targetId != target ||
      installed.environmentOrigin != state.claim.environmentOrigin ||
      installed.operation != T3VoiceRuntimeGrantOperation.THREAD_TURN_START) return null
    return VoiceRuntimeThreadAuthority(
      state.claim.runtimeId, state.claim.readinessGeneration, state.claim.environmentOrigin,
      state.claim.projectId, state.claim.threadId, state.snapshot.autoRearm,
    )
  }
}

internal object VoiceRuntimeThreadRearmPolicy {
  fun delayMillis(target: VoiceRuntimeTarget.Thread): Long = target.rearmGuardMs

  fun canSchedule(
    target: VoiceRuntimeTarget.Thread,
    terminal: VoiceRuntimeTerminalSummary?,
    readinessEnabled: Boolean,
    consumerCount: Int,
  ): Boolean = target.autoRearm &&
    terminal != VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED &&
    VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(readinessEnabled, consumerCount)
}

internal object VoiceRuntimeHandoffActivationPolicy {
  fun accepted(receipt: VoiceRuntimeCommandReceipt): Boolean =
    receipt.outcome is VoiceRuntimeCommandOutcome.Accepted
}

internal class VoiceRuntimeHandoffActivationRejected(
  val receipt: VoiceRuntimeCommandReceipt,
) : IllegalStateException("The detached thread continuation was not admitted.")

internal data class VoiceRuntimeThreadAttempt(
  val authority: VoiceRuntimeThreadAuthority,
  val clientOperationId: String,
  var runtimeInstanceId: String = "",
  var modeSessionId: String = "",
  var submissionPolicy: String = "auto-submit",
  var speechPlanId: String = "",
  var draftContext: VoiceRuntimeDraftContext? = null,
  var highestStartedSegment: Int? = null,
  var highestDrainedSegment: Int? = null,
  val segmentDispositions: MutableList<VoiceRuntimeSpeechDisposition> = mutableListOf(),
  var operationId: String? = null,
  var acknowledgedCursor: Long = 0,
  var recording: T3VoiceRecordingResult? = null,
  var polling: Boolean = false,
  var draftFetching: Boolean = false,
  var draftDispositionPending: Boolean = false,
  var draftConsumePending: Boolean = false,
  var acknowledging: Boolean = false,
  val pendingSpeech: java.util.TreeSet<Int> = java.util.TreeSet(),
  var playingSegment: Int? = null,
  var playbackFailures: Int = 0,
  var detached: Boolean = false,
  var cancelRequested: Boolean = false,
  var retryFailures: Int = 0,
  var stopped: Boolean = false,
) {
  private var activeCall: VoiceRuntimeThreadCall<*>? = null
  private var cancellationCall: VoiceRuntimeThreadCall<*>? = null

  @Synchronized fun beginCall(
    call: VoiceRuntimeThreadCall<*>,
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

  @Synchronized fun finishCall(call: VoiceRuntimeThreadCall<*>): Boolean {
    if (activeCall !== call) return false
    activeCall = null
    return true
  }

  @Synchronized fun cancelActiveCall() {
    activeCall?.cancel()
    activeCall = null
  }

  @Synchronized fun beginCancellationCall(call: VoiceRuntimeThreadCall<*>) {
    cancellationCall?.cancel()
    cancellationCall = call
  }

  @Synchronized fun finishCancellationCall(call: VoiceRuntimeThreadCall<*>): Boolean {
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

internal object VoiceRuntimeThreadAttemptPolicy {
  fun owns(
    attempt: VoiceRuntimeThreadAttempt,
    readiness: T3VoiceReadinessConfig,
  ): Boolean =
    readiness.isEffective() &&
      readiness.mode == T3VoiceReadinessMode.THREAD &&
      readiness.generation == attempt.authority.readinessGeneration &&
      readiness.targetId ==
        "${attempt.authority.selectedProjectId}/${attempt.authority.selectedThreadId}" &&
      readiness.autoRearm == attempt.authority.autoRearm
}

internal object VoiceRuntimeThreadRetryPolicy {
  fun delayMillis(failures: Int): Long {
    require(failures >= 1)
    return (500L shl (failures - 1).coerceAtMost(6)).coerceAtMost(30_000L)
  }
}

internal object VoiceRuntimeThreadPlaybackPolicy {
  const val MAX_RETRIES = 3

  fun shouldRetry(failures: Int): Boolean {
    require(failures >= 1)
    return failures <= MAX_RETRIES
  }
}

internal object VoiceRuntimeThreadRevocationPolicy {
  fun matches(
    state: VoiceRuntimeThreadOperationState,
    expected: T3VoicePendingRuntimeRevocation,
  ): Boolean =
    state.claim.runtimeId == expected.runtimeId &&
      VoiceRuntimeOriginPolicy.normalize(state.claim.environmentOrigin) ==
      VoiceRuntimeOriginPolicy.normalize(expected.environmentOrigin)
}

internal enum class VoiceRuntimeThreadCancelDecision {
  COMPLETE,
  RETRY,
  AWAIT_REVOCATION,
}

internal object VoiceRuntimeThreadCancelPolicy {
  fun decide(result: VoiceRuntimeThreadTurnResult<*>): VoiceRuntimeThreadCancelDecision =
    when (result) {
      is VoiceRuntimeThreadTurnResult.Success -> VoiceRuntimeThreadCancelDecision.COMPLETE
      is VoiceRuntimeThreadTurnResult.Failure -> when {
        result.kind == VoiceRuntimeHttpFailureKind.PERMANENT &&
          result.statusCode in setOf(404, 410) -> VoiceRuntimeThreadCancelDecision.COMPLETE
        result.kind in setOf(
          VoiceRuntimeHttpFailureKind.RETRYABLE,
          VoiceRuntimeHttpFailureKind.CONFLICT,
          VoiceRuntimeHttpFailureKind.CANCELLED,
        ) -> VoiceRuntimeThreadCancelDecision.RETRY
        else -> VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION
      }
    }
}

internal object VoiceRuntimeThreadCancelReconciliationPolicy {
  fun requiresFence(decision: VoiceRuntimeThreadCancelDecision): Boolean =
    decision == VoiceRuntimeThreadCancelDecision.AWAIT_REVOCATION
}

internal object VoiceRuntimeThreadLocalCleanupCoordinator {
  fun complete(
    deleteRecording: () -> Boolean,
    clearDurableState: () -> Boolean,
  ): Boolean = deleteRecording() && clearDurableState()
}

internal object VoiceRuntimeThreadLocalStopCoordinator {
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

internal object VoiceRuntimeThreadPreparedCancellationPolicy {
  fun shouldFenceCreateFailure(
    cancelRequested: Boolean,
    operationId: String?,
    retryable: Boolean,
  ): Boolean = cancelRequested && operationId == null && !retryable
}

internal object VoiceRuntimeThreadStartReconciliationPolicy {
  fun shouldReconcileAfterStart(hasAttempt: Boolean): Boolean = !hasAttempt
}

internal object VoiceRuntimeThreadRecordingRecovery {
  fun restore(
    loaded: VoiceRuntimeThreadOperationLoadResult,
    restoreCompleted: (T3VoiceRecordingResult) -> Boolean,
  ): Boolean {
    val recording =
      ((loaded as? VoiceRuntimeThreadOperationLoadResult.Available)?.state
        as? VoiceRuntimeThreadOperationState.Active)?.recording ?: return true
    return restoreCompleted(recording)
  }
}

internal enum class VoiceRuntimeThreadStoredStateDecision {
  NONE,
  RESTORE,
  CANCEL_PREPARED,
  CANCEL_UNDISPATCHED,
  REVOKE,
}

internal object VoiceRuntimeThreadStoredStatePolicy {
  fun decide(
    loaded: VoiceRuntimeThreadOperationLoadResult,
    parentGrantAvailable: Boolean,
    nowMillis: Long,
  ): VoiceRuntimeThreadStoredStateDecision = when (loaded) {
    VoiceRuntimeThreadOperationLoadResult.Missing ->
      VoiceRuntimeThreadStoredStateDecision.NONE
    VoiceRuntimeThreadOperationLoadResult.Locked ->
      VoiceRuntimeThreadStoredStateDecision.REVOKE
    is VoiceRuntimeThreadOperationLoadResult.Available -> when (val state = loaded.state) {
      is VoiceRuntimeThreadOperationState.Active ->
        if (state.expiresAtEpochMillis <= nowMillis) {
          VoiceRuntimeThreadStoredStateDecision.REVOKE
        } else if (!state.snapshot.dispatchAcknowledged && state.recording == null) {
          VoiceRuntimeThreadStoredStateDecision.CANCEL_UNDISPATCHED
        } else {
          VoiceRuntimeThreadStoredStateDecision.RESTORE
        }
      is VoiceRuntimeThreadOperationState.Prepared ->
        if (parentGrantAvailable) {
          VoiceRuntimeThreadStoredStateDecision.CANCEL_PREPARED
        } else {
          VoiceRuntimeThreadStoredStateDecision.REVOKE
        }
    }
  }
}

internal object VoiceRuntimeControlSurfacePolicy {
  fun isActive(
    phase: T3VoiceRuntimePhase,
    realtimeAttemptActive: Boolean,
    threadAttemptActive: Boolean,
    threadCancellationOnly: Boolean,
  ): Boolean =
    realtimeAttemptActive ||
      (threadAttemptActive && !threadCancellationOnly) ||
      (phase != T3VoiceRuntimePhase.IDLE && phase != T3VoiceRuntimePhase.INACTIVE)
}

internal object VoiceRuntimeThreadEventBatchPolicy {
  fun isContiguous(
    requestedAfter: Long,
    events: List<VoiceRuntimeThreadTurnEvent>,
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

internal enum class VoiceRuntimeThreadEventCommitDecision {
  ACKNOWLEDGE,
  CONTINUE,
}

internal object VoiceRuntimeThreadEventCommitPolicy {
  fun afterBatch(
    eventCursor: Long,
    acknowledgedCursor: Long,
  ): VoiceRuntimeThreadEventCommitDecision =
    if (eventCursor > acknowledgedCursor) {
      VoiceRuntimeThreadEventCommitDecision.ACKNOWLEDGE
    } else {
      VoiceRuntimeThreadEventCommitDecision.CONTINUE
    }
}

internal data class VoiceRuntimeThreadBatchTransition(
  val snapshot: VoiceRuntimeExecutionSnapshot,
  val commands: Set<VoiceRuntimeCommand>,
)

internal object VoiceRuntimeThreadBatchReducer {
  fun reduce(
    initial: VoiceRuntimeExecutionSnapshot,
    events: List<VoiceRuntimeExecutionEvent.ServerEvent>,
  ): VoiceRuntimeThreadBatchTransition {
    var snapshot = initial
    val commands = mutableSetOf<VoiceRuntimeCommand>()
    events.forEach { event ->
      val transition = VoiceRuntimeExecutionReducer.reduce(snapshot, event)
      snapshot = transition.snapshot
      commands += transition.commands
    }
    return VoiceRuntimeThreadBatchTransition(snapshot, commands)
  }
}

internal object VoiceRuntimeThreadTerminalPolicy {
  fun canCleanup(
    snapshot: VoiceRuntimeExecutionSnapshot,
    acknowledgedCursor: Long,
    detached: Boolean,
  ): Boolean {
    if (!snapshot.responseTerminal || acknowledgedCursor < snapshot.eventCursor) return false
    if (detached) return true
    return when (snapshot.terminalSummary) {
      VoiceRuntimeTerminalSummary.COMPLETED -> snapshot.speechFullyDrained()
      VoiceRuntimeTerminalSummary.CANCELLED,
      VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
      VoiceRuntimeTerminalSummary.FAILED_PERMANENT,
      VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED,
      -> true
      null -> false
    }
  }

  fun shouldAutoRearm(snapshot: VoiceRuntimeExecutionSnapshot): Boolean =
    snapshot.autoRearm &&
      snapshot.terminalSummary == VoiceRuntimeTerminalSummary.COMPLETED

  fun shouldPollAfterAck(
    snapshot: VoiceRuntimeExecutionSnapshot,
    detached: Boolean,
  ): Boolean {
    if (detached) return !snapshot.responseTerminal
    if (!snapshot.responseTerminal) return true
    return snapshot.terminalSummary == VoiceRuntimeTerminalSummary.COMPLETED &&
      !snapshot.speechTerminal
  }
}

internal object VoiceRuntimeThreadPersistencePolicy {
  fun snapshotAfterTransition(
    active: VoiceRuntimeThreadOperationState.Active,
    transition: VoiceRuntimeExecutionSnapshot,
  ): VoiceRuntimeExecutionSnapshot =
    transition.takeIf { it.operationId == active.operationId } ?: active.snapshot
}

internal object VoiceRuntimeWakeLockPolicy {
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

internal data class VoiceRuntimeThreadSpeechWork(
  val segmentIndex: Int,
  val advertisedSequence: Long?,
)

internal object VoiceRuntimeThreadSpeechPolicy {
  fun next(
    playbackCursor: Int,
    highestAdvertisedSegment: Int,
    events: List<VoiceRuntimeThreadTurnEvent>,
  ): VoiceRuntimeThreadSpeechWork? {
    if (playbackCursor < highestAdvertisedSegment) {
      return VoiceRuntimeThreadSpeechWork(playbackCursor + 1, null)
    }
    return events.filterIsInstance<VoiceRuntimeThreadTurnEvent.SpeechReady>()
      .firstOrNull { it.segmentIndex > playbackCursor }
      ?.let { VoiceRuntimeThreadSpeechWork(it.segmentIndex, it.sequence) }
  }

  fun acceptedPrefix(
    events: List<VoiceRuntimeThreadTurnEvent>,
    work: VoiceRuntimeThreadSpeechWork?,
  ): List<VoiceRuntimeThreadTurnEvent> =
    if (work?.advertisedSequence == null) events
    else events.takeWhile { it.sequence <= work.advertisedSequence }
}

internal class T3VoiceRecordingFileBody(recording: T3VoiceRecordingResult) :
  VoiceRuntimeRequestBody {
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

internal object VoiceRuntimeThreadRecordingBodyPolicy {
  fun create(recording: T3VoiceRecordingResult): T3VoiceRecordingFileBody? =
    runCatching { T3VoiceRecordingFileBody(recording) }.getOrNull()
}
