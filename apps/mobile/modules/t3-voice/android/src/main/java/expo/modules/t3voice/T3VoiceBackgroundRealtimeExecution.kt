package expo.modules.t3voice

import java.util.concurrent.Future

internal data class T3VoiceBackgroundRealtimeAuthority(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val runtimeGrantToken: String,
  val conversationId: String,
)

internal object T3VoiceBackgroundRealtimeAuthorityPolicy {
  fun validate(
    readiness: T3VoiceReadinessConfig,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
    expectedTargetIdentityDigest: String,
    nowMillis: Long,
  ): T3VoiceBackgroundRealtimeAuthority? {
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
    return T3VoiceBackgroundRealtimeAuthority(
      runtimeId = metadata.runtimeId,
      readinessGeneration = metadata.readinessGeneration,
      environmentOrigin = T3VoiceBackgroundOriginPolicy.normalize(metadata.environmentOrigin),
      runtimeGrantToken = grant.token,
      conversationId = conversationId,
    )
  }

  fun validateStartedSession(
    authority: T3VoiceBackgroundRealtimeAuthority,
    result: T3VoiceBackgroundRealtimeStartResult,
    nowMillis: Long,
  ): Boolean {
    val control = result.controlGrant
    val heartbeatSeconds = control.heartbeatIntervalSeconds
    val failureGraceSeconds = control.failureGraceSeconds
    val remainingControlMillis = control.expiresAtEpochMillis - nowMillis
    return result.state.conversationId == authority.conversationId &&
      result.state.phase == "signaling" &&
      result.expiresAtEpochMillis > nowMillis &&
      control.expiresAtEpochMillis > nowMillis &&
      control.expiresAtEpochMillis <= result.expiresAtEpochMillis &&
      heartbeatSeconds in MINIMUM_HEARTBEAT_SECONDS..MAXIMUM_HEARTBEAT_SECONDS &&
      failureGraceSeconds in
        (heartbeatSeconds * MINIMUM_FAILURE_HEARTBEATS)..MAXIMUM_FAILURE_GRACE_SECONDS &&
      remainingControlMillis >= (heartbeatSeconds + failureGraceSeconds) * 1_000L
  }

  fun nativeControlGrant(
    result: T3VoiceBackgroundRealtimeStartResult,
  ): T3VoiceNativeControlGrant =
    T3VoiceNativeControlGrant(
      token = result.controlGrant.token,
      sessionId = result.state.sessionId,
      leaseGeneration = result.state.leaseGeneration,
      expiresAtEpochMillis = result.controlGrant.expiresAtEpochMillis,
      heartbeatIntervalMillis =
        Math.multiplyExact(result.controlGrant.heartbeatIntervalSeconds, 1_000L),
      failureGraceMillis = Math.multiplyExact(result.controlGrant.failureGraceSeconds, 1_000L),
    )

  private const val MINIMUM_HEARTBEAT_SECONDS = 5L
  private const val MAXIMUM_HEARTBEAT_SECONDS = 5 * 60L
  private const val MINIMUM_FAILURE_HEARTBEATS = 2L
  private const val MAXIMUM_FAILURE_GRACE_SECONDS = 10 * 60L
}

internal data class T3VoiceBackgroundRealtimeAttempt(
  val operationId: String,
  val authority: T3VoiceBackgroundRealtimeAuthority,
  val diagnosticGeneration: Long,
  var serverSession: T3VoiceBackgroundRealtimeStartResult? = null,
  var future: Future<*>? = null,
)

internal object T3VoiceBackgroundRealtimeAttemptPolicy {
  fun owns(
    attempt: T3VoiceBackgroundRealtimeAttempt?,
    operationId: String,
    readiness: T3VoiceReadinessConfig,
  ): Boolean =
    attempt?.operationId == operationId &&
      attempt.authority.readinessGeneration == readiness.generation &&
      readiness.isEffective() &&
      readiness.mode == T3VoiceReadinessMode.REALTIME &&
      readiness.targetId == attempt.authority.conversationId
}

internal data class T3VoiceBackgroundRealtimeCleanupMarker(
  val runtimeId: String,
  val readinessGeneration: Long,
  val environmentOrigin: String,
  val operationId: String,
  val conversationId: String,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128) { "Invalid native runtime ID." }
    require(readinessGeneration > 0) { "Invalid readiness generation." }
    T3VoiceBackgroundOriginPolicy.normalize(environmentOrigin)
    require(operationId.isNotBlank() && operationId.length <= 128) {
      "Invalid native Realtime operation ID."
    }
    require(conversationId.isNotBlank() && conversationId.length <= 1_024) {
      "Invalid native Realtime conversation ID."
    }
  }

  companion object {
    fun from(attempt: T3VoiceBackgroundRealtimeAttempt) =
      T3VoiceBackgroundRealtimeCleanupMarker(
        runtimeId = attempt.authority.runtimeId,
        readinessGeneration = attempt.authority.readinessGeneration,
        environmentOrigin = attempt.authority.environmentOrigin,
        operationId = attempt.operationId,
        conversationId = attempt.authority.conversationId,
      )
  }
}

internal data class T3VoiceBackgroundRealtimeCleanupAuthority(
  val marker: T3VoiceBackgroundRealtimeCleanupMarker,
  val runtimeGrantToken: String,
)

internal enum class T3VoiceBackgroundRealtimeCleanupDecision {
  COMPLETE,
  RETRY,
  BLOCKED,
}

internal object T3VoiceBackgroundRealtimeCleanupPolicy {
  fun canStartNewSession(
    pending: T3VoiceBackgroundRealtimeCleanupMarker?,
    storageLocked: Boolean,
  ): Boolean = pending === null && !storageLocked

  fun authority(
    marker: T3VoiceBackgroundRealtimeCleanupMarker,
    loadedGrant: T3VoiceRuntimeGrantLoadResult,
  ): T3VoiceBackgroundRealtimeCleanupAuthority? {
    val grant = (loadedGrant as? T3VoiceRuntimeGrantLoadResult.Available)?.grant ?: return null
    val metadata = grant.metadata
    if (
      metadata.runtimeId != marker.runtimeId ||
        metadata.readinessGeneration != marker.readinessGeneration ||
        T3VoiceBackgroundOriginPolicy.normalize(metadata.environmentOrigin) !=
        T3VoiceBackgroundOriginPolicy.normalize(marker.environmentOrigin) ||
        metadata.operation != T3VoiceRuntimeGrantOperation.REALTIME_START
    ) {
      return null
    }
    return T3VoiceBackgroundRealtimeCleanupAuthority(marker, grant.token)
  }

  fun startFailure(
    failure: T3VoiceBackgroundRealtimeResult.Failure,
  ): T3VoiceBackgroundRealtimeCleanupDecision = failureDecision(failure)

  fun closeResult(
    result: T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeCloseResult>,
  ): T3VoiceBackgroundRealtimeCleanupDecision =
    when (result) {
      is T3VoiceBackgroundRealtimeResult.Success ->
        if (
          result.value.closed ||
            result.value.state.phase == "ended" ||
            result.value.state.phase == "error"
        ) {
          T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE
        } else {
          T3VoiceBackgroundRealtimeCleanupDecision.RETRY
        }
      is T3VoiceBackgroundRealtimeResult.Failure -> failureDecision(result)
    }

  fun retryDelayMillis(failedAttempts: Int): Long {
    require(failedAttempts >= 1)
    val shift = (failedAttempts - 1).coerceAtMost(6)
    return (INITIAL_RETRY_MILLIS shl shift).coerceAtMost(MAXIMUM_RETRY_MILLIS)
  }

  private fun failureDecision(
    failure: T3VoiceBackgroundRealtimeResult.Failure,
  ): T3VoiceBackgroundRealtimeCleanupDecision =
    when (failure.kind) {
      T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED ->
        T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE
      T3VoiceBackgroundHttpFailureKind.PERMANENT ->
        if (failure.statusCode == 404 || failure.statusCode == 410) {
          T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE
        } else {
          T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED
        }
      T3VoiceBackgroundHttpFailureKind.CONFLICT,
      T3VoiceBackgroundHttpFailureKind.RETRYABLE,
      T3VoiceBackgroundHttpFailureKind.CANCELLED,
      -> T3VoiceBackgroundRealtimeCleanupDecision.RETRY
    }

  private const val INITIAL_RETRY_MILLIS = 250L
  private const val MAXIMUM_RETRY_MILLIS = 10_000L
}
