package expo.modules.t3voice

import java.util.concurrent.Future

internal data class VoiceRealtimeExecutionAuthority(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val conversationId: String,
)

internal data class VoiceRuntimeRealtimeAuthorization(
  val authority: VoiceRealtimeExecutionAuthority,
) {
  val runtimeId get() = authority.runtimeId
  val readinessGeneration get() = authority.readinessGeneration
  val environmentOrigin get() = authority.environmentOrigin
  val conversationId get() = authority.conversationId
}

internal object VoiceRuntimeRealtimeAuthorityPolicy {
  fun validateCanonical(
    persisted: VoiceRuntimePersistedAuthority,
    consumerCount: Int,
    microphonePermissionGranted: Boolean,
    nowMillis: Long,
  ): VoiceRuntimeRealtimeAuthorization? {
    val target = persisted.target as? VoiceRuntimeTarget.Realtime ?: return null
    if (!microphonePermissionGranted ||
      !VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(
        persisted.readinessEnabled,
        consumerCount,
      )) return null
    return VoiceRuntimeRealtimeAuthorization(
      VoiceRealtimeExecutionAuthority(
        persisted.runtimeId,
        persisted.generation,
        VoiceRuntimeOriginPolicy.normalize(persisted.environmentOrigin),
        target.conversationId,
      ),
    )
  }
  fun validate(
    readiness: T3VoiceReadinessConfig,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
    expectedTargetIdentityDigest: String,
    nowMillis: Long,
  ): VoiceRuntimeRealtimeAuthorization? {
    if (
      !readiness.isEffective() ||
        readiness.mode != T3VoiceReadinessMode.REALTIME ||
        !readiness.microphonePermissionGranted
    ) {
      return null
    }
    val conversationId = readiness.targetId ?: return null
    val grant = (loadedGrant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant ?: return null
    val metadata = grant.metadata
    if (
      metadata.readinessGeneration != readiness.generation ||
        metadata.operation != T3VoiceRuntimeGrantOperation.REALTIME_START ||
        metadata.targetIdentityDigest != expectedTargetIdentityDigest ||
        metadata.expiresAtEpochMillis <= nowMillis
    ) {
      return null
    }
    return VoiceRuntimeRealtimeAuthorization(
      authority =
        VoiceRealtimeExecutionAuthority(
          runtimeId = metadata.runtimeId,
          readinessGeneration = metadata.readinessGeneration,
          environmentOrigin = VoiceRuntimeOriginPolicy.normalize(metadata.environmentOrigin),
          conversationId = conversationId,
        ),
    )
  }

  fun validateStartedSession(
    authorization: VoiceRuntimeRealtimeAuthorization,
    result: VoiceRuntimeRealtimeStartResult,
    nowMillis: Long,
  ): Boolean = validateStartedSession(authorization.authority, result, nowMillis)

  fun validateStartedSession(
    authority: VoiceRealtimeExecutionAuthority,
    result: VoiceRuntimeRealtimeStartResult,
    nowMillis: Long,
  ): Boolean {
    val heartbeatSeconds = result.heartbeatIntervalSeconds
    return result.state.conversationId == authority.conversationId &&
      result.state.phase == "signaling" &&
      result.expiresAtEpochMillis > nowMillis &&
      heartbeatSeconds in MINIMUM_HEARTBEAT_SECONDS..MAXIMUM_HEARTBEAT_SECONDS
  }

  fun runtimeControlLease(
    result: VoiceRuntimeRealtimeStartResult,
  ): VoiceRuntimeControlLease =
    VoiceRuntimeControlLease(
      sessionId = result.state.sessionId,
      leaseGeneration = result.state.leaseGeneration,
      heartbeatIntervalMillis =
        Math.multiplyExact(result.heartbeatIntervalSeconds, 1_000L),
      failureGraceMillis = Math.multiplyExact(result.heartbeatIntervalSeconds, 3_000L),
    )

  private const val MINIMUM_HEARTBEAT_SECONDS = 5L
  private const val MAXIMUM_HEARTBEAT_SECONDS = 5 * 60L
}

internal data class VoiceRuntimeRealtimeAttempt(
  val operationId: String,
  val authority: VoiceRealtimeExecutionAuthority,
  val diagnosticGeneration: Long,
  var serverSession: VoiceRuntimeRealtimeStartResult? = null,
  var activeCall: VoiceRuntimeRealtimeCall<*>? = null,
  var future: Future<*>? = null,
) {
  constructor(
    operationId: String,
    authorization: VoiceRuntimeRealtimeAuthorization,
    diagnosticGeneration: Long,
  ) : this(operationId, authorization.authority, diagnosticGeneration)
}

internal object VoiceRuntimeRealtimeAttemptPolicy {
  fun owns(
    attempt: VoiceRuntimeRealtimeAttempt?,
    operationId: String,
    readiness: T3VoiceReadinessConfig,
  ): Boolean =
    attempt?.operationId == operationId &&
      attempt.authority.readinessGeneration == readiness.generation &&
      readiness.isEffective() &&
      readiness.mode == T3VoiceReadinessMode.REALTIME &&
      readiness.targetId == attempt.authority.conversationId
}

internal data class VoiceRuntimeRealtimeCleanupMarker(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val operationId: String,
  val conversationId: String,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128) { "Invalid native runtime ID." }
    require(readinessGeneration > 0) { "Invalid readiness generation." }
    VoiceRuntimeOriginPolicy.normalize(environmentOrigin)
    require(operationId.isNotBlank() && operationId.length <= 128) {
      "Invalid native Realtime operation ID."
    }
    require(conversationId.isNotBlank() && conversationId.length <= 1_024) {
      "Invalid native Realtime conversation ID."
    }
  }

  companion object {
    fun from(attempt: VoiceRuntimeRealtimeAttempt) =
      VoiceRuntimeRealtimeCleanupMarker(
        runtimeId = attempt.authority.runtimeId,
        readinessGeneration = attempt.authority.readinessGeneration,
        environmentOrigin = attempt.authority.environmentOrigin,
        operationId = attempt.operationId,
        conversationId = attempt.authority.conversationId,
      )
  }
}

internal data class VoiceRuntimeRealtimeCleanupAuthority(
  val marker: VoiceRuntimeRealtimeCleanupMarker,
)

internal enum class VoiceRuntimeRealtimeCleanupDecision {
  COMPLETE,
  RETRY,
  BLOCKED,
}

internal enum class VoiceRuntimeRealtimeRestartRequest {
  NONE,
  RESTORE_INTERRUPTED_SESSION,
}

internal object VoiceRuntimeRealtimeRestartPolicy {
  fun afterControl(
    current: VoiceRuntimeRealtimeRestartRequest,
    command: T3VoiceControlCommand,
  ): VoiceRuntimeRealtimeRestartRequest =
    if (command == T3VoiceControlCommand.STOP) VoiceRuntimeRealtimeRestartRequest.NONE else current

  fun shouldRestart(request: VoiceRuntimeRealtimeRestartRequest): Boolean =
    request == VoiceRuntimeRealtimeRestartRequest.RESTORE_INTERRUPTED_SESSION
}

internal object VoiceRuntimeRealtimeCleanupPolicy {
  fun canStartNewSession(
    pending: VoiceRuntimeRealtimeCleanupMarker?,
    storageLocked: Boolean,
  ): Boolean = pending === null && !storageLocked

  fun authority(
    marker: VoiceRuntimeRealtimeCleanupMarker,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
  ): VoiceRuntimeRealtimeCleanupAuthority? {
    val grant = (loadedGrant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant ?: return null
    val metadata = grant.metadata
    if (
      metadata.runtimeId != marker.runtimeId ||
        metadata.readinessGeneration != marker.readinessGeneration ||
        VoiceRuntimeOriginPolicy.normalize(metadata.environmentOrigin) !=
        VoiceRuntimeOriginPolicy.normalize(marker.environmentOrigin) ||
        metadata.operation != T3VoiceRuntimeGrantOperation.REALTIME_START
    ) {
      return null
    }
    return VoiceRuntimeRealtimeCleanupAuthority(marker)
  }

  fun authority(
    marker: VoiceRuntimeRealtimeCleanupMarker,
    persisted: VoiceRuntimePersistedAuthority,
  ): VoiceRuntimeRealtimeCleanupAuthority? {
    if (persisted.target !is VoiceRuntimeTarget.Realtime ||
      persisted.runtimeId != marker.runtimeId ||
      persisted.generation != marker.readinessGeneration ||
      VoiceRuntimeOriginPolicy.normalize(persisted.environmentOrigin) !=
      VoiceRuntimeOriginPolicy.normalize(marker.environmentOrigin)) return null
    return VoiceRuntimeRealtimeCleanupAuthority(marker)
  }

  fun startFailure(
    failure: VoiceRuntimeRealtimeResult.Failure,
  ): VoiceRuntimeRealtimeCleanupDecision = failureDecision(failure)

  fun closeResult(
    result: VoiceRuntimeRealtimeResult<VoiceRuntimeRealtimeCloseResult>,
  ): VoiceRuntimeRealtimeCleanupDecision =
    when (result) {
      is VoiceRuntimeRealtimeResult.Success ->
        if (
          result.value.closed ||
            result.value.state.phase == "ended" ||
            result.value.state.phase == "error"
        ) {
          VoiceRuntimeRealtimeCleanupDecision.COMPLETE
        } else {
          VoiceRuntimeRealtimeCleanupDecision.RETRY
        }
      is VoiceRuntimeRealtimeResult.Failure -> failureDecision(result)
    }

  fun retryDelayMillis(failedAttempts: Int): Long {
    require(failedAttempts >= 1)
    val shift = (failedAttempts - 1).coerceAtMost(6)
    return (INITIAL_RETRY_MILLIS shl shift).coerceAtMost(MAXIMUM_RETRY_MILLIS)
  }

  private fun failureDecision(
    failure: VoiceRuntimeRealtimeResult.Failure,
  ): VoiceRuntimeRealtimeCleanupDecision =
    when (failure.kind) {
      VoiceRuntimeHttpFailureKind.AUTHORITY_REJECTED ->
        VoiceRuntimeRealtimeCleanupDecision.BLOCKED
      VoiceRuntimeHttpFailureKind.PERMANENT ->
        if (failure.statusCode == 404 || failure.statusCode == 410) {
          VoiceRuntimeRealtimeCleanupDecision.COMPLETE
        } else {
          VoiceRuntimeRealtimeCleanupDecision.BLOCKED
        }
      VoiceRuntimeHttpFailureKind.CONFLICT,
      VoiceRuntimeHttpFailureKind.RETRYABLE,
      VoiceRuntimeHttpFailureKind.CANCELLED,
      -> VoiceRuntimeRealtimeCleanupDecision.RETRY
    }

  private const val INITIAL_RETRY_MILLIS = 250L
  private const val MAXIMUM_RETRY_MILLIS = 10_000L
}

internal data class VoiceRuntimeRealtimeReconciliation(
  val readiness: T3VoiceReadinessConfig,
  val pendingRevocation: T3VoicePendingRuntimeRevocation,
)

internal object VoiceRuntimeRealtimeReconciliationPolicy {
  fun fence(
    readiness: T3VoiceReadinessConfig,
    marker: VoiceRuntimeRealtimeCleanupMarker,
  ): VoiceRuntimeRealtimeReconciliation =
    VoiceRuntimeRealtimeReconciliation(
      readiness.copy(enabled = false, generation = readiness.generation + 1),
      T3VoicePendingRuntimeRevocation(marker.runtimeId, marker.environmentOrigin),
    )
}
