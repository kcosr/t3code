package expo.modules.t3voice

import android.content.Context
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.util.Base64
import org.json.JSONObject

internal data class VoiceRuntimePersistedAuthority(
  val runtimeId: String,
  val generation: Long,
  val provisioningOperationId: String,
  val targetDigest: String,
  val target: VoiceRuntimeTarget,
  val environmentOrigin: String,
  val readinessEnabled: Boolean,
  val token: String,
  val issuedAtEpochMillis: Long,
  val expiresAtEpochMillis: Long,
)

internal sealed interface VoiceRuntimeAuthorityLoadResult {
  data object Missing : VoiceRuntimeAuthorityLoadResult
  data object Locked : VoiceRuntimeAuthorityLoadResult
  data class Available(val authority: VoiceRuntimePersistedAuthority) :
    VoiceRuntimeAuthorityLoadResult
}

internal object VoiceRuntimeAuthorityLifecyclePolicy {
  fun canDispatch(readinessEnabled: Boolean, consumerCount: Int): Boolean =
    readinessEnabled || consumerCount > 0

  fun shouldClear(
    readinessEnabled: Boolean,
    consumerCount: Int,
    idle: Boolean,
  ): Boolean = !readinessEnabled && consumerCount == 0 && idle
}

internal class VoiceRuntimeAuthorityStore(
  private val storage: T3VoiceBackgroundKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher,
  private val now: () -> Long = System::currentTimeMillis,
) {
  constructor(context: Context) : this(
    T3VoiceBackgroundPreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.canonical.runtime-authority.v1"),
  )

  @Synchronized
  fun write(authority: VoiceRuntimePersistedAuthority) {
    validate(authority)
    val metadata = metadata(authority)
    val encrypted = cipher.encrypt(authority.token.toByteArray(StandardCharsets.UTF_8), metadata)
    check(storage.put(values(authority, encrypted))) {
      "Could not persist canonical voice runtime authority."
    }
  }

  @Synchronized
  fun load(): VoiceRuntimeAuthorityLoadResult {
    val present = KEYS.associateWith(storage::getString)
    if (present.values.all { it == null }) return VoiceRuntimeAuthorityLoadResult.Missing
    if (present.values.any { it == null }) return VoiceRuntimeAuthorityLoadResult.Locked
    return try {
      val authority = decode(present.mapValues { requireNotNull(it.value) })
      if (authority.expiresAtEpochMillis <= now()) VoiceRuntimeAuthorityLoadResult.Locked
      else VoiceRuntimeAuthorityLoadResult.Available(authority)
    } catch (_: Throwable) {
      VoiceRuntimeAuthorityLoadResult.Locked
    }
  }

  @Synchronized
  fun clear(deleteKey: Boolean = true) {
    check(storage.clear(KEYS)) { "Could not clear canonical voice runtime authority." }
    if (deleteKey) cipher.deleteKey()
  }

  private fun decode(values: Map<String, String>): VoiceRuntimePersistedAuthority {
    require(values.getValue(KEY_VERSION) == VERSION)
    val targetValue = JSONObject(values.getValue(KEY_TARGET))
    val target = when (targetValue.getString("mode")) {
      "realtime" -> {
        require(targetValue.keys().asSequence().toSet() == REALTIME_TARGET_FIELDS)
        VoiceRuntimeTarget.Realtime(
          targetValue.getString("environmentId"),
          targetValue.getString("conversationId"),
        )
      }
      "thread" -> {
        require(targetValue.keys().asSequence().toSet() == THREAD_TARGET_FIELDS)
        val endpoint = targetValue.getJSONObject("endpointPolicy")
        require(endpoint.keys().asSequence().toSet() == ENDPOINT_FIELDS)
        VoiceRuntimeTarget.Thread(
          targetValue.getString("environmentId"),
          targetValue.getString("projectId"),
          targetValue.getString("threadId"),
          targetValue.getString("speechPreset"),
          targetValue.getBoolean("autoRearm"),
          endpoint.getLong("endSilenceMs"),
          endpoint.optLongOrNull("noSpeechTimeoutMs"),
          endpoint.getLong("maximumUtteranceMs"),
          targetValue.getBoolean("speechEnabled"),
          targetValue.getLong("rearmGuardMs"),
        )
      }
      else -> error("Unsupported canonical voice authority target.")
    }
    val encrypted = T3VoiceEncryptedGrant(
      Base64.getDecoder().decode(values.getValue(KEY_IV)),
      Base64.getDecoder().decode(values.getValue(KEY_CIPHERTEXT)),
    )
    val unsigned = VoiceRuntimePersistedAuthority(
      values.getValue(KEY_RUNTIME_ID),
      values.getValue(KEY_GENERATION).toLong(),
      values.getValue(KEY_PROVISIONING_OPERATION_ID),
      values.getValue(KEY_TARGET_DIGEST),
      target,
      values.getValue(KEY_ENVIRONMENT_ORIGIN),
      values.getValue(KEY_READINESS_ENABLED).toBooleanStrict(),
      "pending",
      values.getValue(KEY_ISSUED_AT).toLong(),
      values.getValue(KEY_EXPIRES_AT).toLong(),
    )
    validate(unsigned)
    val token = String(cipher.decrypt(encrypted, metadata(unsigned)), StandardCharsets.UTF_8)
    return unsigned.copy(token = token).also(::validate)
  }

  private fun values(
    authority: VoiceRuntimePersistedAuthority,
    encrypted: T3VoiceEncryptedGrant,
  ): Map<String, String> = mapOf(
    KEY_VERSION to VERSION,
    KEY_RUNTIME_ID to authority.runtimeId,
    KEY_GENERATION to authority.generation.toString(),
    KEY_PROVISIONING_OPERATION_ID to authority.provisioningOperationId,
    KEY_TARGET_DIGEST to authority.targetDigest,
    KEY_TARGET to targetJson(authority.target),
    KEY_ENVIRONMENT_ORIGIN to T3VoiceBackgroundOriginPolicy.normalize(authority.environmentOrigin),
    KEY_READINESS_ENABLED to authority.readinessEnabled.toString(),
    KEY_ISSUED_AT to authority.issuedAtEpochMillis.toString(),
    KEY_EXPIRES_AT to authority.expiresAtEpochMillis.toString(),
    KEY_IV to Base64.getEncoder().encodeToString(encrypted.initializationVector),
    KEY_CIPHERTEXT to Base64.getEncoder().encodeToString(encrypted.ciphertext),
  )

  private fun metadata(authority: VoiceRuntimePersistedAuthority): ByteArray = listOf(
    VERSION,
    authority.runtimeId,
    authority.generation,
    authority.provisioningOperationId,
    authority.targetDigest,
    targetJson(authority.target),
    T3VoiceBackgroundOriginPolicy.normalize(authority.environmentOrigin),
    authority.readinessEnabled,
    authority.issuedAtEpochMillis,
    authority.expiresAtEpochMillis,
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private fun targetJson(target: VoiceRuntimeTarget): String = when (target) {
    is VoiceRuntimeTarget.Realtime -> VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target)
    is VoiceRuntimeTarget.Thread -> VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)
  }

  private fun validate(authority: VoiceRuntimePersistedAuthority) {
    require(authority.runtimeId.isNotBlank())
    require(authority.generation > 0)
    require(authority.provisioningOperationId.isNotBlank())
    require(authority.targetDigest == T3VoiceRuntimeTargetIdentity.digest(targetJson(authority.target)))
    require(authority.token.isNotBlank())
    require(authority.token.length <= 128)
    require(authority.issuedAtEpochMillis <= authority.expiresAtEpochMillis)
    require(authority.expiresAtEpochMillis > 0)
    T3VoiceBackgroundOriginPolicy.normalize(authority.environmentOrigin)
  }

  private fun JSONObject.optLongOrNull(key: String): Long? =
    if (isNull(key)) null else getLong(key)

  private companion object {
    const val VERSION = "t3-canonical-voice-authority-v2"
    const val KEY_VERSION = "canonical_authority_version"
    const val KEY_RUNTIME_ID = "canonical_authority_runtime_id"
    const val KEY_GENERATION = "canonical_authority_generation"
    const val KEY_PROVISIONING_OPERATION_ID = "canonical_authority_provisioning_operation_id"
    const val KEY_TARGET_DIGEST = "canonical_authority_target_digest"
    const val KEY_TARGET = "canonical_authority_target"
    const val KEY_ENVIRONMENT_ORIGIN = "canonical_authority_environment_origin"
    const val KEY_READINESS_ENABLED = "canonical_authority_readiness_enabled"
    const val KEY_ISSUED_AT = "canonical_authority_issued_at"
    const val KEY_EXPIRES_AT = "canonical_authority_expires_at"
    const val KEY_IV = "canonical_authority_iv"
    const val KEY_CIPHERTEXT = "canonical_authority_ciphertext"
    val KEYS = setOf(
      KEY_VERSION, KEY_RUNTIME_ID, KEY_GENERATION, KEY_PROVISIONING_OPERATION_ID,
      KEY_TARGET_DIGEST, KEY_TARGET, KEY_ENVIRONMENT_ORIGIN, KEY_READINESS_ENABLED,
      KEY_ISSUED_AT, KEY_EXPIRES_AT, KEY_IV, KEY_CIPHERTEXT,
    )
    val REALTIME_TARGET_FIELDS = setOf("mode", "environmentId", "conversationId")
    val THREAD_TARGET_FIELDS = setOf(
      "mode", "environmentId", "projectId", "threadId", "speechPreset", "autoRearm",
      "endpointPolicy", "speechEnabled", "rearmGuardMs",
    )
    val ENDPOINT_FIELDS = setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs")
  }
}
