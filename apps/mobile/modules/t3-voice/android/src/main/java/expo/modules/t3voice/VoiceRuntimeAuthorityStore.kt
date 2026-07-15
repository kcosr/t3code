package expo.modules.t3voice

import android.content.Context
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.Base64
import java.util.UUID
import org.json.JSONObject

internal fun VoiceRuntimeTarget.grantOperation(): T3VoiceRuntimeGrantOperation = when (this) {
  is VoiceRuntimeTarget.Realtime -> T3VoiceRuntimeGrantOperation.REALTIME_START
  is VoiceRuntimeTarget.Thread -> T3VoiceRuntimeGrantOperation.THREAD_TURN_START
}

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
  val refreshRotationCounter: Long = 0,
)

internal data class VoiceRuntimeAuthorityFence(
  val runtimeId: String,
  val generation: Long,
  val provisioningOperationId: String,
  val targetDigest: String,
  val target: VoiceRuntimeTarget,
  val operation: T3VoiceRuntimeGrantOperation,
  val environmentOrigin: String,
)

internal data class VoiceRuntimePreparedRefreshCredential(
  val fence: VoiceRuntimeAuthorityFence,
  val credentialHash: String,
)

internal data class VoiceRuntimePreparedAttachedAuthority(
  val fence: VoiceRuntimeAuthorityFence,
  val readiness: T3VoiceReadinessConfig,
)

internal data class VoiceRuntimeAuthorityPreparation(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val provisioningOperationId: String,
  val expectedCurrentGeneration: Long,
  val generation: Long,
  val targetDigest: String,
  val target: VoiceRuntimeTarget,
  val operation: T3VoiceRuntimeGrantOperation,
  val environmentOrigin: String,
  val readinessEnabled: Boolean,
) {
  fun fence() = VoiceRuntimeAuthorityFence(
    runtimeId,
    generation,
    provisioningOperationId,
    targetDigest,
    target,
    operation,
    VoiceRuntimeOriginPolicy.normalize(environmentOrigin),
  )
}

internal data class VoiceRuntimeAuthorityPreparationResult(
  val preparation: VoiceRuntimeAuthorityPreparation,
  val refreshCredentialHash: String?,
)

internal data class VoiceRuntimeAuthorityInspection(
  val state: String,
  val preparation: VoiceRuntimeAuthorityPreparation,
  val readiness: T3VoiceReadinessConfig,
  val refreshCredentialHash: String?,
  val issuedAtEpochMillis: Long?,
  val expiresAtEpochMillis: Long?,
  val refreshRotationCounter: Long?,
)

internal data class VoiceRuntimeRefreshAttempt(
  val fence: VoiceRuntimeAuthorityFence,
  val refreshRequestId: String,
  val expectedRotationCounter: Long,
  val currentCredential: String,
  val candidateCredentialHash: String,
)

internal sealed interface VoiceRuntimeAuthorityLoadResult {
  data object Missing : VoiceRuntimeAuthorityLoadResult
  data object Locked : VoiceRuntimeAuthorityLoadResult
  data class Available(val authority: VoiceRuntimePersistedAuthority) :
    VoiceRuntimeAuthorityLoadResult
}

internal data class VoiceRuntimeRetiredAuthorityFence(
  val runtimeId: String,
  val generation: Long,
)

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
  private val storage: VoiceRuntimeKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher,
  private val now: () -> Long = System::currentTimeMillis,
  private val randomBytes: (ByteArray) -> Unit = SecureRandom()::nextBytes,
  private val requestId: () -> String = { UUID.randomUUID().toString() },
) {
  constructor(context: Context) : this(
    VoiceRuntimePreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.canonical.runtime-authority.v1"),
  )

  @Synchronized
  fun prepareAttachedAuthority(
    fence: VoiceRuntimeAuthorityFence,
    readiness: T3VoiceReadinessConfig,
  ): VoiceRuntimePreparedAttachedAuthority {
    validateFence(fence)
    validateAttachedReadiness(fence, readiness)
    require(load() == VoiceRuntimeAuthorityLoadResult.Missing) {
      "Canonical authority must be disabled before attached preparation."
    }
    require(REFRESH_KEYS.all { storage.getString(it) == null }) {
      "Persistent readiness authority must be revoked before attached authority is prepared."
    }
    val expected = VoiceRuntimePreparedAttachedAuthority(fence, readiness)
    inspectPreparedAttachedAuthority()?.let { prepared ->
      require(prepared == expected) { "A different attached authority is already prepared." }
      return prepared
    }
    check(storage.put(mapOf(KEY_PREPARED_ATTACHED to attachedPreparationJson(expected)))) {
      "Could not persist prepared attached authority."
    }
    return requireNotNull(inspectPreparedAttachedAuthority()) {
      "Prepared attached authority could not be verified."
    }
  }

  @Synchronized
  fun inspectPreparedAttachedAuthority(): VoiceRuntimePreparedAttachedAuthority? =
    storage.getString(KEY_PREPARED_ATTACHED)?.let(::parseAttachedPreparation)

  @Synchronized
  fun prepareRefreshCredential(
    fence: VoiceRuntimeAuthorityFence,
    readinessEnabled: Boolean,
  ): VoiceRuntimePreparedRefreshCredential? {
    validateFence(fence)
    if (!readinessEnabled) {
      check(storage.clear(REFRESH_KEYS)) { "Could not clear canonical refresh authority." }
      return null
    }
    require(inspectPreparedAttachedAuthority() == null) {
      "Attached authority must be revoked before persistent readiness is prepared."
    }
    readCredential(PREPARED_PREFIX)?.let { prepared ->
      if (prepared.fence == fence && prepared.requestId == null && prepared.rotationCounter == null) {
        return VoiceRuntimePreparedRefreshCredential(fence, prepared.credentialHash)
      }
    }
    val credential = generateCredential()
    val hash = credentialHash(credential)
    val encrypted = encryptCredential(PREPARED_PREFIX, fence, null, null, hash, credential)
    check(storage.put(REFRESH_KEYS.associateWith { null } + encrypted)) {
      "Could not persist prepared canonical refresh authority."
    }
    return VoiceRuntimePreparedRefreshCredential(fence, hash)
  }

  @Synchronized
  fun inspectPreparedRefreshCredential(
    fence: VoiceRuntimeAuthorityFence,
  ): VoiceRuntimePreparedRefreshCredential? = readCredential(PREPARED_PREFIX)
    ?.takeIf { it.fence == fence && it.requestId == null && it.rotationCounter == null }
    ?.let { VoiceRuntimePreparedRefreshCredential(fence, it.credentialHash) }

  @Synchronized
  fun inspectPreparedRefreshCredential(): VoiceRuntimePreparedRefreshCredential? =
    readCredential(PREPARED_PREFIX)
      ?.takeIf { it.requestId == null && it.rotationCounter == null }
      ?.let { VoiceRuntimePreparedRefreshCredential(it.fence, it.credentialHash) }

  @Synchronized
  fun <T> activate(
    authority: VoiceRuntimePersistedAuthority,
    activate: () -> T,
  ): T {
    validate(authority)
    val fence = authority.fence()
    val prepared = readCredential(PREPARED_PREFIX)
    if (authority.readinessEnabled) {
      require(prepared?.fence == fence && prepared.requestId == null) {
        "The canonical refresh credential reservation is stale."
      }
      require(inspectPreparedAttachedAuthority() == null) {
        "Persistent readiness cannot consume an attached authority reservation."
      }
      require(authority.refreshRotationCounter == 0L) {
        "Initial canonical refresh authority has an invalid rotation counter."
      }
    } else {
      require(prepared == null) { "Attached-only authority cannot retain a refresh credential." }
      require(inspectPreparedAttachedAuthority()?.fence == fence) {
        "The attached authority reservation is stale."
      }
    }
    val previous = ALL_KEYS.associateWith(storage::getString)
    val authorityEncrypted = cipher.encrypt(
      authority.token.toByteArray(StandardCharsets.UTF_8),
      metadata(authority),
    )
    val refreshValues = if (prepared == null) {
      REFRESH_KEYS.associateWith { null }
    } else {
      val raw = prepared.credential
      encryptCredential(CURRENT_PREFIX, fence, null, authority.refreshRotationCounter,
        prepared.credentialHash, raw) + REFRESH_KEYS.filter { it.startsWith(PREPARED_PREFIX) ||
        it.startsWith(CANDIDATE_PREFIX) }.associateWith { null }
    }
    check(storage.put(
      values(authority, authorityEncrypted) + refreshValues + RETIRED_KEYS.associateWith { null } +
        PREPARED_TRANSITION_KEYS.associateWith { null } + (KEY_PREPARED_ATTACHED to null),
    )) {
      "Could not atomically activate canonical voice runtime authority."
    }
    return try {
      activate()
    } catch (cause: Throwable) {
      check(storage.put(previous)) { "Could not roll back canonical voice runtime authority." }
      throw cause
    }
  }

  @Synchronized
  fun prepareTransition(authority: VoiceRuntimePersistedAuthority) {
    validate(authority)
    require(!authority.readinessEnabled) { "A handoff transition cannot install readiness authority." }
    val current = requireNotNull(loadIgnoringExpiry()) {
      "Canonical source authority is unavailable for handoff."
    }
    require(current.runtimeId == authority.runtimeId &&
      current.generation + 1 == authority.generation &&
      VoiceRuntimeOriginPolicy.normalize(current.environmentOrigin) ==
        VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin)) {
      "Canonical handoff source authority is stale."
    }
    loadPreparedTransition()?.let { prepared ->
      require(prepared == authority) { "A different handoff transition is already prepared." }
      return
    }
    val encrypted = cipher.encrypt(
      authority.token.toByteArray(StandardCharsets.UTF_8),
      metadata(authority),
    )
    check(storage.put(prefixedTransitionValues(values(authority, encrypted)))) {
      "Could not persist prepared handoff authority."
    }
    require(loadPreparedTransition() == authority) {
      "Prepared handoff authority could not be verified."
    }
  }

  @Synchronized
  fun <T> activatePreparedTransition(
    authority: VoiceRuntimePersistedAuthority,
    activate: () -> T,
  ): T {
    validate(authority)
    require(loadPreparedTransition() == authority) { "Prepared handoff authority is unavailable." }
    val previous = ALL_KEYS.associateWith(storage::getString)
    val preparedValues = PREPARED_TRANSITION_KEYS.associateWith(storage::getString)
    require(preparedValues.values.none { it == null }) { "Prepared handoff authority is incomplete." }
    val promoted = preparedValues.mapKeys { (key) -> key.removePrefix(PREPARED_TRANSITION_PREFIX) }
      .mapValues { requireNotNull(it.value) }
    check(storage.put(
      promoted + PREPARED_TRANSITION_KEYS.associateWith { null } +
        REFRESH_KEYS.associateWith { null } + RETIRED_KEYS.associateWith { null },
    )) { "Could not atomically activate prepared handoff authority." }
    return try {
      activate()
    } catch (cause: Throwable) {
      check(storage.put(previous)) { "Could not roll back prepared handoff authority." }
      throw cause
    }
  }

  @Synchronized
  fun discardPreparedTransition() {
    check(storage.clear(PREPARED_TRANSITION_KEYS)) {
      "Could not clear prepared handoff authority."
    }
  }

  @Synchronized
  fun discardPreparedTransition(expected: VoiceRuntimePersistedAuthority): Boolean {
    val prepared = loadPreparedTransition() ?: return false
    if (prepared != expected) return false
    check(storage.clear(PREPARED_TRANSITION_KEYS)) {
      "Could not clear prepared handoff authority."
    }
    return true
  }

  @Synchronized
  fun beginRefresh(): VoiceRuntimeRefreshAttempt {
    val authority = loadIgnoringExpiry()
      ?: error("Canonical voice runtime authority is unavailable for refresh.")
    require(authority.readinessEnabled) { "Attached-only authority cannot be refreshed." }
    val fence = authority.fence()
    val current = requireNotNull(readCredential(CURRENT_PREFIX)) {
      "Canonical refresh authority is unavailable."
    }
    require(current.fence == fence && current.rotationCounter == authority.refreshRotationCounter) {
      "Canonical refresh authority is stale."
    }
    readCredential(CANDIDATE_PREFIX)?.let { candidate ->
      require(candidate.fence == fence &&
        candidate.rotationCounter == authority.refreshRotationCounter &&
        candidate.requestId != null) { "Canonical refresh candidate is stale." }
      return VoiceRuntimeRefreshAttempt(
        fence, candidate.requestId, authority.refreshRotationCounter,
        current.credential, candidate.credentialHash,
      )
    }
    val candidateCredential = generateCredential()
    val candidateHash = credentialHash(candidateCredential)
    val refreshRequestId = requestId()
    val candidate = encryptCredential(
      CANDIDATE_PREFIX,
      fence,
      refreshRequestId,
      authority.refreshRotationCounter,
      candidateHash,
      candidateCredential,
    )
    check(storage.put(candidate)) { "Could not persist canonical refresh candidate." }
    return VoiceRuntimeRefreshAttempt(
      fence, refreshRequestId, authority.refreshRotationCounter,
      current.credential, candidateHash,
    )
  }

  @Synchronized
  fun resumeDisabledRefresh(): Pair<VoiceRuntimePersistedAuthority, VoiceRuntimeRefreshAttempt>? {
    val authority = loadIgnoringExpiry() ?: return null
    require(!authority.readinessEnabled) {
      "Enabled readiness must use normal refresh admission."
    }
    val candidate = readCredential(CANDIDATE_PREFIX) ?: return null
    val current = requireNotNull(readCredential(CURRENT_PREFIX)) {
      "Disabled refresh recovery is missing the current credential."
    }
    val fence = authority.fence()
    require(current.fence == fence && current.rotationCounter == authority.refreshRotationCounter)
    require(candidate.fence == fence &&
      candidate.rotationCounter == authority.refreshRotationCounter &&
      candidate.requestId != null)
    return authority to VoiceRuntimeRefreshAttempt(
      fence,
      candidate.requestId,
      authority.refreshRotationCounter,
      current.credential,
      candidate.credentialHash,
    )
  }

  @Synchronized
  fun disableReadiness(
    expectedRuntimeId: String,
    expectedGeneration: Long,
  ): VoiceRuntimePersistedAuthority? {
    val current = loadIgnoringExpiry() ?: return null
    if (current.runtimeId != expectedRuntimeId || current.generation != expectedGeneration) {
      return null
    }
    val preserveRefreshRecovery = if (readCredential(CANDIDATE_PREFIX) != null) {
      val active = requireNotNull(readCredential(CURRENT_PREFIX)) {
        "In-flight refresh recovery is missing the current credential."
      }
      val candidate = requireNotNull(readCredential(CANDIDATE_PREFIX))
      val fence = current.fence()
      require(active.fence == fence && active.rotationCounter == current.refreshRotationCounter)
      require(candidate.fence == fence &&
        candidate.rotationCounter == current.refreshRotationCounter &&
        candidate.requestId != null)
      true
    } else {
      false
    }
    val disabled = current.copy(readinessEnabled = false)
    val encrypted = cipher.encrypt(
      disabled.token.toByteArray(StandardCharsets.UTF_8),
      metadata(disabled),
    )
    check(storage.put(
      values(disabled, encrypted) +
        if (preserveRefreshRecovery) emptyMap() else REFRESH_KEYS.associateWith { null },
    )) { "Could not durably disable canonical voice readiness." }
    return disabled
  }

  @Synchronized
  fun <T> promoteRefresh(
    attempt: VoiceRuntimeRefreshAttempt,
    authority: VoiceRuntimePersistedAuthority,
    activate: () -> T,
  ): T {
    validate(authority)
    require(authority.fence() == attempt.fence)
    require(authority.readinessEnabled)
    require(authority.refreshRotationCounter == attempt.expectedRotationCounter + 1)
    val currentAuthority = requireNotNull(loadIgnoringExpiry())
    require(currentAuthority.fence() == attempt.fence &&
      currentAuthority.readinessEnabled &&
      currentAuthority.refreshRotationCounter == attempt.expectedRotationCounter)
    val candidate = requireNotNull(readCredential(CANDIDATE_PREFIX))
    require(candidate.fence == attempt.fence &&
      candidate.requestId == attempt.refreshRequestId &&
      candidate.rotationCounter == attempt.expectedRotationCounter &&
      candidate.credentialHash == attempt.candidateCredentialHash)
    val previous = ALL_KEYS.associateWith(storage::getString)
    val encryptedAuthority = cipher.encrypt(
      authority.token.toByteArray(StandardCharsets.UTF_8),
      metadata(authority),
    )
    val encryptedCurrent = encryptCredential(
      CURRENT_PREFIX,
      attempt.fence,
      null,
      authority.refreshRotationCounter,
      candidate.credentialHash,
      candidate.credential,
    )
    check(storage.put(
      values(authority, encryptedAuthority) + encryptedCurrent +
        REFRESH_KEYS.filter { it.startsWith(CANDIDATE_PREFIX) }.associateWith { null },
    )) { "Could not atomically promote canonical refresh authority." }
    return try {
      activate()
    } catch (cause: Throwable) {
      check(storage.put(previous)) { "Could not roll back canonical refresh authority." }
      throw cause
    }
  }

  @Synchronized
  fun promoteDisabledRefresh(
    attempt: VoiceRuntimeRefreshAttempt,
    authority: VoiceRuntimePersistedAuthority,
  ): VoiceRuntimePersistedAuthority {
    validate(authority)
    require(authority.fence() == attempt.fence)
    require(authority.readinessEnabled)
    require(authority.refreshRotationCounter == attempt.expectedRotationCounter + 1)
    val current = requireNotNull(loadIgnoringExpiry())
    require(current.fence() == attempt.fence &&
      current.refreshRotationCounter == attempt.expectedRotationCounter)
    val candidate = requireNotNull(readCredential(CANDIDATE_PREFIX))
    require(candidate.fence == attempt.fence &&
      candidate.requestId == attempt.refreshRequestId &&
      candidate.rotationCounter == attempt.expectedRotationCounter &&
      candidate.credentialHash == attempt.candidateCredentialHash)
    val disabled = authority.copy(readinessEnabled = false)
    val encryptedAuthority = cipher.encrypt(
      disabled.token.toByteArray(StandardCharsets.UTF_8),
      metadata(disabled),
    )
    check(storage.put(
      values(disabled, encryptedAuthority) + REFRESH_KEYS.associateWith { null },
    )) { "Could not retain the rotated authority behind the readiness-disable fence." }
    return disabled
  }

  @Synchronized
  fun hasPendingRefresh(): Boolean = readCredential(CANDIDATE_PREFIX) != null

  @Synchronized
  fun rejectRefresh(attempt: VoiceRuntimeRefreshAttempt) {
    val candidate = requireNotNull(readCredential(CANDIDATE_PREFIX))
    require(candidate.fence == attempt.fence &&
      candidate.requestId == attempt.refreshRequestId &&
      candidate.rotationCounter == attempt.expectedRotationCounter &&
      candidate.credentialHash == attempt.candidateCredentialHash)
    check(storage.put(
      credentialKeys(CANDIDATE_PREFIX).associateWith { null } + (KEY_REFRESH_REJECTED to "1"),
    )) { "Could not fence rejected canonical refresh authority." }
  }

  @Synchronized
  fun rejectDisabledRefresh(attempt: VoiceRuntimeRefreshAttempt) {
    val authority = requireNotNull(loadIgnoringExpiry())
    require(!authority.readinessEnabled && authority.fence() == attempt.fence)
    val candidate = requireNotNull(readCredential(CANDIDATE_PREFIX))
    require(candidate.fence == attempt.fence &&
      candidate.requestId == attempt.refreshRequestId &&
      candidate.rotationCounter == attempt.expectedRotationCounter &&
      candidate.credentialHash == attempt.candidateCredentialHash)
    check(storage.clear(REFRESH_KEYS)) {
      "Could not consume rejected disabled refresh recovery."
    }
  }

  @Synchronized
  fun isRefreshRejected(): Boolean = when (val value = storage.getString(KEY_REFRESH_REJECTED)) {
    null -> false
    "1" -> true
    else -> error("Invalid canonical refresh rejection state.")
  }

  @Synchronized
  fun load(): VoiceRuntimeAuthorityLoadResult {
    val present = KEYS.associateWith(storage::getString)
    if (present.values.all { it == null }) return VoiceRuntimeAuthorityLoadResult.Missing
    if (present.values.any { it == null }) return VoiceRuntimeAuthorityLoadResult.Locked
    if (runCatching(::isRefreshRejected).getOrDefault(true)) return VoiceRuntimeAuthorityLoadResult.Locked
    return try {
      val authority = decode(present.mapValues { requireNotNull(it.value) })
      if (authority.expiresAtEpochMillis <= now()) VoiceRuntimeAuthorityLoadResult.Locked
      else VoiceRuntimeAuthorityLoadResult.Available(authority)
    } catch (_: Throwable) {
      VoiceRuntimeAuthorityLoadResult.Locked
    }
  }

  @Synchronized
  fun retireLegacyV2(): VoiceRuntimeRetiredAuthorityFence? {
    retiredFence()?.let { return it }
    if (storage.getString(KEY_VERSION) != LEGACY_VERSION) return null
    val present = LEGACY_KEYS.associateWith(storage::getString)
    if (present.values.any { it == null }) return null
    val runtimeId = requireNotNull(present[KEY_RUNTIME_ID])
    val generation = requireNotNull(present[KEY_GENERATION]).toLong()
    require(runtimeId.isNotBlank() && runtimeId.length <= 128)
    require(generation > 0)
    check(storage.put(
      LEGACY_KEYS.associateWith { null } + mapOf(
        KEY_RETIRED_RUNTIME_ID to runtimeId,
        KEY_RETIRED_GENERATION to generation.toString(),
      ),
    )) { "Could not retire the legacy voice runtime authority." }
    cipher.deleteKey()
    return VoiceRuntimeRetiredAuthorityFence(runtimeId, generation)
  }

  @Synchronized
  fun retiredFence(): VoiceRuntimeRetiredAuthorityFence? {
    val runtimeId = storage.getString(KEY_RETIRED_RUNTIME_ID)
    val generation = storage.getString(KEY_RETIRED_GENERATION)
    if (runtimeId == null && generation == null) return null
    require(runtimeId != null && runtimeId.isNotBlank() && runtimeId.length <= 128)
    val parsedGeneration = requireNotNull(generation).toLong()
    require(parsedGeneration > 0)
    return VoiceRuntimeRetiredAuthorityFence(runtimeId, parsedGeneration)
  }

  @Synchronized
  fun loadForRefresh(): VoiceRuntimePersistedAuthority? =
    if (runCatching(::isRefreshRejected).getOrDefault(true)) null else loadIgnoringExpiry()

  @Synchronized
  fun loadRejectedAuthority(): VoiceRuntimePersistedAuthority? =
    if (runCatching(::isRefreshRejected).getOrDefault(false)) loadIgnoringExpiry() else null

  private fun loadIgnoringExpiry(): VoiceRuntimePersistedAuthority? {
    val present = KEYS.associateWith(storage::getString)
    if (present.values.any { it == null }) return null
    return runCatching { decode(present.mapValues { requireNotNull(it.value) }) }.getOrNull()
  }

  private fun loadPreparedTransition(): VoiceRuntimePersistedAuthority? {
    val present = PREPARED_TRANSITION_KEYS.associateWith(storage::getString)
    if (present.values.all { it == null }) return null
    require(present.values.none { it == null }) { "Prepared handoff authority is incomplete." }
    return decode(
      present.mapKeys { (key) -> key.removePrefix(PREPARED_TRANSITION_PREFIX) }
        .mapValues { requireNotNull(it.value) },
    )
  }

  @Synchronized
  fun inspectPreparedTransition(): VoiceRuntimePersistedAuthority? = loadPreparedTransition()

  private fun prefixedTransitionValues(values: Map<String, String>): Map<String, String> =
    values.mapKeys { (key) -> "$PREPARED_TRANSITION_PREFIX$key" }

  @Synchronized
  fun clear(deleteKey: Boolean = true) {
    check(storage.clear(ALL_KEYS)) { "Could not clear canonical voice runtime authority." }
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
      values.getValue(KEY_REFRESH_ROTATION_COUNTER).toLong(),
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
    KEY_ENVIRONMENT_ORIGIN to VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin),
    KEY_READINESS_ENABLED to authority.readinessEnabled.toString(),
    KEY_ISSUED_AT to authority.issuedAtEpochMillis.toString(),
    KEY_EXPIRES_AT to authority.expiresAtEpochMillis.toString(),
    KEY_REFRESH_ROTATION_COUNTER to authority.refreshRotationCounter.toString(),
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
    VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin),
    authority.readinessEnabled,
    authority.issuedAtEpochMillis,
    authority.expiresAtEpochMillis,
    authority.refreshRotationCounter,
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private fun targetJson(target: VoiceRuntimeTarget): String = when (target) {
    is VoiceRuntimeTarget.Realtime -> VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target)
    is VoiceRuntimeTarget.Thread -> VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)
  }

  private fun attachedPreparationJson(
    preparation: VoiceRuntimePreparedAttachedAuthority,
  ): String = JSONObject()
    .put("fence", JSONObject(fenceJson(preparation.fence)))
    .put("readiness", JSONObject()
      .put("enabled", preparation.readiness.enabled)
      .put("mode", preparation.readiness.mode.name)
      .put("targetId", preparation.readiness.targetId ?: JSONObject.NULL)
      .put("audioRouteId", preparation.readiness.audioRouteId)
      .put("autoRearm", preparation.readiness.autoRearm)
      .put("microphonePermissionGranted", preparation.readiness.microphonePermissionGranted)
      .put("notificationPermissionGranted", preparation.readiness.notificationPermissionGranted)
      .put("generation", preparation.readiness.generation))
    .toString()

  private fun parseAttachedPreparation(value: String): VoiceRuntimePreparedAttachedAuthority {
    val json = JSONObject(value)
    require(json.keys().asSequence().toSet() == ATTACHED_PREPARATION_FIELDS)
    val fence = parseFence(json.getJSONObject("fence").toString())
    val readinessJson = json.getJSONObject("readiness")
    require(readinessJson.keys().asSequence().toSet() == ATTACHED_READINESS_FIELDS)
    val readiness = T3VoiceReadinessConfig(
      enabled = readinessJson.getBoolean("enabled"),
      mode = T3VoiceReadinessMode.valueOf(readinessJson.getString("mode")),
      targetId = if (readinessJson.isNull("targetId")) null else readinessJson.getString("targetId"),
      audioRouteId = readinessJson.getString("audioRouteId"),
      autoRearm = readinessJson.getBoolean("autoRearm"),
      microphonePermissionGranted = readinessJson.getBoolean("microphonePermissionGranted"),
      notificationPermissionGranted = readinessJson.getBoolean("notificationPermissionGranted"),
      generation = readinessJson.getLong("generation"),
    )
    validateAttachedReadiness(fence, readiness)
    return VoiceRuntimePreparedAttachedAuthority(fence, readiness)
  }

  private fun validateAttachedReadiness(
    fence: VoiceRuntimeAuthorityFence,
    readiness: T3VoiceReadinessConfig,
  ) {
    require(!readiness.enabled)
    require(readiness.generation == fence.generation)
    when (val target = fence.target) {
      is VoiceRuntimeTarget.Realtime -> {
        require(readiness.mode == T3VoiceReadinessMode.REALTIME)
        require(readiness.targetId == target.conversationId)
      }
      is VoiceRuntimeTarget.Thread -> {
        require(readiness.mode == T3VoiceReadinessMode.THREAD)
        require(readiness.targetId == "${target.projectId}/${target.threadId}")
      }
    }
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
    require(authority.refreshRotationCounter >= 0)
    VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin)
  }

  private fun JSONObject.optLongOrNull(key: String): Long? =
    if (isNull(key)) null else getLong(key)

  private data class StoredCredential(
    val fence: VoiceRuntimeAuthorityFence,
    val requestId: String?,
    val rotationCounter: Long?,
    val credentialHash: String,
    val credential: String,
  )

  private fun encryptCredential(
    prefix: String,
    fence: VoiceRuntimeAuthorityFence,
    requestId: String?,
    rotationCounter: Long?,
    hash: String,
    credential: String,
  ): Map<String, String> {
    validateFence(fence)
    require(hash == credentialHash(credential))
    val aad = credentialMetadata(prefix, fence, requestId, rotationCounter, hash)
    val encrypted = cipher.encrypt(credential.toByteArray(StandardCharsets.UTF_8), aad)
    return mapOf(
      "${prefix}fence" to fenceJson(fence),
      "${prefix}request_id" to (requestId ?: NONE),
      "${prefix}rotation_counter" to (rotationCounter?.toString() ?: NONE),
      "${prefix}hash" to hash,
      "${prefix}iv" to Base64.getEncoder().encodeToString(encrypted.initializationVector),
      "${prefix}ciphertext" to Base64.getEncoder().encodeToString(encrypted.ciphertext),
    )
  }

  private fun readCredential(prefix: String): StoredCredential? {
    val keys = credentialKeys(prefix)
    val values = keys.associateWith(storage::getString)
    if (values.values.all { it == null }) return null
    require(values.values.none { it == null }) { "Incomplete canonical refresh authority." }
    val fence = parseFence(values.getValue("${prefix}fence")!!)
    val requestId = values.getValue("${prefix}request_id")!!.takeUnless { it == NONE }
    val rotationCounter = values.getValue("${prefix}rotation_counter")!!.takeUnless { it == NONE }?.toLong()
    val hash = values.getValue("${prefix}hash")!!
    require(hash.matches(SHA256_PATTERN))
    val encrypted = T3VoiceEncryptedGrant(
      Base64.getDecoder().decode(values.getValue("${prefix}iv")!!),
      Base64.getDecoder().decode(values.getValue("${prefix}ciphertext")!!),
    )
    val plaintext = cipher.decrypt(
      encrypted,
      credentialMetadata(prefix, fence, requestId, rotationCounter, hash),
    )
    val credential = String(plaintext, StandardCharsets.UTF_8)
    plaintext.fill(0)
    require(credentialHash(credential) == hash)
    return StoredCredential(fence, requestId, rotationCounter, hash, credential)
  }

  private fun credentialMetadata(
    prefix: String,
    fence: VoiceRuntimeAuthorityFence,
    requestId: String?,
    rotationCounter: Long?,
    hash: String,
  ): ByteArray = listOf(
    VERSION, prefix, fence.runtimeId, fence.generation, fence.provisioningOperationId,
    fence.targetDigest, fence.operation.wireValue,
    targetJson(fence.target),
    VoiceRuntimeOriginPolicy.normalize(fence.environmentOrigin),
    requestId ?: NONE, rotationCounter ?: NONE, hash,
  ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private fun fenceJson(fence: VoiceRuntimeAuthorityFence): String = JSONObject()
    .put("runtimeId", fence.runtimeId)
    .put("generation", fence.generation)
    .put("provisioningOperationId", fence.provisioningOperationId)
    .put("targetDigest", fence.targetDigest)
    .put("target", JSONObject(targetJson(fence.target)))
    .put("operation", fence.operation.wireValue)
    .put("environmentOrigin", VoiceRuntimeOriginPolicy.normalize(fence.environmentOrigin))
    .toString()

  private fun parseFence(value: String): VoiceRuntimeAuthorityFence {
    val json = JSONObject(value)
    require(json.keys().asSequence().toSet() == FENCE_FIELDS)
    return VoiceRuntimeAuthorityFence(
      json.getString("runtimeId"),
      json.getLong("generation"),
      json.getString("provisioningOperationId"),
      json.getString("targetDigest"),
      parseTarget(json.getJSONObject("target")),
      T3VoiceRuntimeGrantOperation.fromWireValue(json.getString("operation")),
      json.getString("environmentOrigin"),
    ).also(::validateFence)
  }

  private fun VoiceRuntimePersistedAuthority.fence() = VoiceRuntimeAuthorityFence(
    runtimeId, generation, provisioningOperationId, targetDigest, target, target.grantOperation(),
    VoiceRuntimeOriginPolicy.normalize(environmentOrigin),
  )

  private fun validateFence(fence: VoiceRuntimeAuthorityFence) {
    require(fence.runtimeId.isNotBlank() && fence.runtimeId.length <= 128)
    require(fence.generation > 0)
    require(fence.provisioningOperationId.isNotBlank() && fence.provisioningOperationId.length <= 256)
    require(fence.targetDigest.matches(SHA256_PATTERN))
    require(fence.operation == fence.target.grantOperation())
    require(fence.targetDigest == T3VoiceRuntimeTargetIdentity.digest(targetJson(fence.target)))
    VoiceRuntimeOriginPolicy.normalize(fence.environmentOrigin)
  }

  private fun generateCredential(): String {
    val bytes = ByteArray(32)
    randomBytes(bytes)
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).also {
      bytes.fill(0)
      require(it.matches(CREDENTIAL_PATTERN))
    }
  }

  private fun credentialHash(credential: String): String = MessageDigest.getInstance("SHA-256")
    .digest(credential.toByteArray(StandardCharsets.US_ASCII))
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }

  private companion object {
    const val VERSION = "t3-canonical-voice-authority-v3"
    const val LEGACY_VERSION = "t3-canonical-voice-authority-v2"
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
    const val KEY_REFRESH_ROTATION_COUNTER = "canonical_authority_refresh_rotation_counter"
    const val KEY_RETIRED_RUNTIME_ID = "canonical_authority_retired_runtime_id"
    const val KEY_RETIRED_GENERATION = "canonical_authority_retired_generation"
    const val PREPARED_PREFIX = "canonical_refresh_prepared_"
    const val CURRENT_PREFIX = "canonical_refresh_current_"
    const val CANDIDATE_PREFIX = "canonical_refresh_candidate_"
    const val KEY_REFRESH_REJECTED = "canonical_refresh_rejected"
    const val PREPARED_TRANSITION_PREFIX = "canonical_transition_prepared_"
    const val KEY_PREPARED_ATTACHED = "canonical_attached_prepared"
    const val NONE = "-"
    val KEYS = setOf(
      KEY_VERSION, KEY_RUNTIME_ID, KEY_GENERATION, KEY_PROVISIONING_OPERATION_ID,
      KEY_TARGET_DIGEST, KEY_TARGET, KEY_ENVIRONMENT_ORIGIN, KEY_READINESS_ENABLED,
      KEY_ISSUED_AT, KEY_EXPIRES_AT, KEY_REFRESH_ROTATION_COUNTER, KEY_IV, KEY_CIPHERTEXT,
    )
    val LEGACY_KEYS = KEYS - KEY_REFRESH_ROTATION_COUNTER
    val RETIRED_KEYS = setOf(KEY_RETIRED_RUNTIME_ID, KEY_RETIRED_GENERATION)
    fun credentialKeys(prefix: String) = setOf(
      "${prefix}fence", "${prefix}request_id", "${prefix}rotation_counter",
      "${prefix}hash", "${prefix}iv", "${prefix}ciphertext",
    )
    val REFRESH_KEYS = credentialKeys(PREPARED_PREFIX) + credentialKeys(CURRENT_PREFIX) +
      credentialKeys(CANDIDATE_PREFIX) + KEY_REFRESH_REJECTED
    val PREPARED_TRANSITION_KEYS = KEYS.mapTo(mutableSetOf()) { "$PREPARED_TRANSITION_PREFIX$it" }
    val ALL_KEYS = KEYS + REFRESH_KEYS + RETIRED_KEYS + PREPARED_TRANSITION_KEYS +
      KEY_PREPARED_ATTACHED
    val REALTIME_TARGET_FIELDS = setOf("mode", "environmentId", "conversationId")
    val THREAD_TARGET_FIELDS = setOf(
      "mode", "environmentId", "projectId", "threadId", "speechPreset", "autoRearm",
      "endpointPolicy", "speechEnabled", "rearmGuardMs",
    )
    val ENDPOINT_FIELDS = setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs")
    val FENCE_FIELDS = setOf(
      "runtimeId", "generation", "provisioningOperationId", "targetDigest", "target", "operation",
      "environmentOrigin",
    )
    val ATTACHED_PREPARATION_FIELDS = setOf("fence", "readiness")
    val ATTACHED_READINESS_FIELDS = setOf(
      "enabled", "mode", "targetId", "audioRouteId", "autoRearm",
      "microphonePermissionGranted", "notificationPermissionGranted", "generation",
    )
    val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
    val CREDENTIAL_PATTERN = Regex("^[A-Za-z0-9_-]{43}$")
  }

  private fun parseTarget(value: JSONObject): VoiceRuntimeTarget = when (value.getString("mode")) {
    "realtime" -> VoiceRuntimeBridge.parseRealtimeTarget(value.toMapStrict())
    "thread" -> VoiceRuntimeBridge.parseThreadTarget(value.toMapStrict())
    else -> error("Unsupported canonical voice authority target.")
  }

  private fun JSONObject.toMapStrict(): Map<String, Any?> = keys().asSequence().associateWith { key ->
    when (val value = get(key)) {
      JSONObject.NULL -> null
      is JSONObject -> value.toMapStrict()
      else -> value
    }
  }
}
