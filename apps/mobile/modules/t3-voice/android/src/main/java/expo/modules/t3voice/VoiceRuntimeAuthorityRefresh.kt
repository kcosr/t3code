package expo.modules.t3voice

import java.nio.charset.StandardCharsets
import java.time.Instant
import org.json.JSONObject

internal sealed interface VoiceRuntimeRefreshResult {
  data class Success(val authority: VoiceRuntimePersistedAuthority) : VoiceRuntimeRefreshResult
  data class Retryable(val statusCode: Int?) : VoiceRuntimeRefreshResult
  data class Rejected(val statusCode: Int?) : VoiceRuntimeRefreshResult
}

internal class VoiceRuntimeAuthorityRefreshClient(
  private val transport: VoiceRuntimeHttpTransport = VoiceRuntimeHttpTransport(),
) {
  fun refresh(
    authority: VoiceRuntimePersistedAuthority,
    attempt: VoiceRuntimeRefreshAttempt,
  ): VoiceRuntimeRefreshResult {
    require(authority.readinessEnabled)
    require(authority.runtimeId == attempt.fence.runtimeId)
    require(authority.generation == attempt.fence.generation)
    require(authority.provisioningOperationId == attempt.fence.provisioningOperationId)
    require(authority.targetDigest == attempt.fence.targetDigest)
    require(authority.target.grantOperation() == attempt.fence.operation)
    require(authority.refreshRotationCounter == attempt.expectedRotationCounter)
    val body = JSONObject()
      .put("refreshRequestId", attempt.refreshRequestId)
      .put("provisioningOperationId", attempt.fence.provisioningOperationId)
      .put("generation", attempt.fence.generation)
      .put("operation", attempt.fence.operation.wireValue)
      .put("targetDigest", attempt.fence.targetDigest)
      .put("expectedRotationCounter", attempt.expectedRotationCounter)
      .put("candidateCredentialHash", attempt.candidateCredentialHash)
      .toString()
      .toByteArray(StandardCharsets.UTF_8)
    val result = transport.execute(
      VoiceRuntimeHttpRequest(
        origin = attempt.fence.environmentOrigin,
        path = "/api/voice/runtime/runtimes/${pathSegment(attempt.fence.runtimeId)}/grant/refresh",
        method = VoiceRuntimeHttpMethod.POST,
        authority = VoiceRuntimeAuthority(REFRESH_HEADER, attempt.currentCredential),
        body = VoiceRuntimeByteArrayBody(body, "application/json"),
        maximumRequestBytes = MAXIMUM_BODY_BYTES.toLong(),
        maximumResponseBytes = MAXIMUM_BODY_BYTES,
      ),
    )
    return when (result) {
      is VoiceRuntimeHttpResult.Success ->
        runCatching { parseSuccess(result, authority, attempt) }
          .getOrElse { VoiceRuntimeRefreshResult.Rejected(result.statusCode) }
      is VoiceRuntimeHttpResult.Failure -> when (result.kind) {
        VoiceRuntimeHttpFailureKind.RETRYABLE,
        VoiceRuntimeHttpFailureKind.CANCELLED,
        -> VoiceRuntimeRefreshResult.Retryable(result.statusCode)
        VoiceRuntimeHttpFailureKind.AUTHORITY_REJECTED,
        VoiceRuntimeHttpFailureKind.CONFLICT,
        VoiceRuntimeHttpFailureKind.PERMANENT,
        -> VoiceRuntimeRefreshResult.Rejected(result.statusCode)
      }
    }
  }

  private fun parseSuccess(
    response: VoiceRuntimeHttpResult.Success,
    current: VoiceRuntimePersistedAuthority,
    attempt: VoiceRuntimeRefreshAttempt,
  ): VoiceRuntimeRefreshResult.Success {
    require(response.contentType?.substringBefore(';')?.trim() == "application/json")
    val json = JSONObject(String(response.body, StandardCharsets.UTF_8))
    require(json.keys().asSequence().toSet() == RESULT_FIELDS)
    require(json.getString("runtimeId") == attempt.fence.runtimeId)
    require(json.getLong("generation") == attempt.fence.generation)
    require(json.getString("provisioningOperationId") == attempt.fence.provisioningOperationId)
    require(json.getString("targetDigest") == attempt.fence.targetDigest)
    require(json.getString("operation") == attempt.fence.operation.wireValue)
    require(json.getBoolean("readinessEnabled"))
    val targetJson = json.getJSONObject("target")
    val target = when (attempt.fence.operation) {
      T3VoiceRuntimeGrantOperation.REALTIME_START -> VoiceRuntimeBridge.parseRealtimeTarget(
        targetJson.toMapStrict(),
      )
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START -> VoiceRuntimeBridge.parseThreadTarget(
        targetJson.toMapStrict(),
      )
    }
    require(target == current.target)
    val issuedAt = Instant.parse(json.getString("issuedAt")).toEpochMilli()
    val expiresAt = Instant.parse(json.getString("expiresAt")).toEpochMilli()
    val refreshed = VoiceRuntimePersistedAuthority(
      runtimeId = attempt.fence.runtimeId,
      generation = attempt.fence.generation,
      provisioningOperationId = attempt.fence.provisioningOperationId,
      targetDigest = attempt.fence.targetDigest,
      target = target,
      environmentOrigin = attempt.fence.environmentOrigin,
      readinessEnabled = true,
      token = json.getString("token"),
      issuedAtEpochMillis = issuedAt,
      expiresAtEpochMillis = expiresAt,
      refreshRotationCounter = json.getLong("refreshRotationCounter"),
    )
    require(refreshed.refreshRotationCounter == attempt.expectedRotationCounter + 1)
    require(refreshed.expiresAtEpochMillis > refreshed.issuedAtEpochMillis)
    return VoiceRuntimeRefreshResult.Success(refreshed)
  }

  private fun JSONObject.toMapStrict(): Map<String, Any?> = keys().asSequence().associateWith { key ->
    when (val value = get(key)) {
      JSONObject.NULL -> null
      is JSONObject -> value.toMapStrict()
      else -> value
    }
  }

  private fun pathSegment(value: String): String {
    require(value.matches(PATH_SEGMENT_PATTERN)) { "Invalid canonical voice runtime ID." }
    return value
  }

  private companion object {
    const val REFRESH_HEADER = "x-t3-voice-refresh"
    const val MAXIMUM_BODY_BYTES = 64 * 1024
    val PATH_SEGMENT_PATTERN = Regex("^[A-Za-z0-9._~-]{1,128}$")
    val RESULT_FIELDS = setOf(
      "token", "runtimeId", "generation", "provisioningOperationId", "targetDigest", "target",
      "operation", "readinessEnabled", "refreshRotationCounter", "issuedAt", "expiresAt",
    )
  }
}
