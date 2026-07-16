package expo.modules.t3voice.store

import expo.modules.t3voice.bridge.VoiceRuntimeBridge
import expo.modules.t3voice.kernel.T3VoiceReadinessConfig
import expo.modules.t3voice.kernel.T3VoiceReadinessMode
import expo.modules.t3voice.kernel.VoiceRuntimeTarget
import expo.modules.t3voice.net.VoiceRuntimeOriginPolicy

import android.content.Context
import org.json.JSONObject

internal fun VoiceRuntimeTarget.grantOperation(): T3VoiceRuntimeGrantOperation = when (this) {
  is VoiceRuntimeTarget.Realtime -> T3VoiceRuntimeGrantOperation.REALTIME_START
  is VoiceRuntimeTarget.Thread -> T3VoiceRuntimeGrantOperation.THREAD_TURN_START
}

internal data class VoiceRuntimePersistedAuthority(
  val runtimeId: String,
  val generation: Long,
  val targetDigest: String,
  val target: VoiceRuntimeTarget,
  val environmentOrigin: String,
  val readinessEnabled: Boolean,
)

internal data class VoiceRuntimeAuthorityFence(
  val runtimeId: String,
  val generation: Long,
  val targetDigest: String,
  val target: VoiceRuntimeTarget,
  val environmentOrigin: String,
)

internal data class VoiceRuntimePreparedAttachedAuthority(
  val fence: VoiceRuntimeAuthorityFence,
  val readiness: T3VoiceReadinessConfig,
)

internal data class VoiceRuntimeAuthorityInspection(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val expectedCurrentGeneration: Long,
  val generation: Long,
  val target: VoiceRuntimeTarget,
  val environmentOrigin: String,
  val readinessEnabled: Boolean,
  val readiness: T3VoiceReadinessConfig,
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
) {
  constructor(context: Context) : this(
    VoiceRuntimePreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.canonical.runtime-authority.v1"),
  )

  @Synchronized
  fun inspectPreparedAttachedAuthority(): VoiceRuntimePreparedAttachedAuthority? =
    storage.getString(KEY_PREPARED_ATTACHED)?.let(::parseAttachedPreparation)

  @Synchronized
  fun discardInitialPreparation() {
    check(storage.clear(setOf(KEY_PREPARED_ATTACHED))) {
      "Could not discard prepared canonical voice authority."
    }
  }

  @Synchronized
  fun <T> activate(
    authority: VoiceRuntimePersistedAuthority,
    activate: () -> T,
  ): T {
    validate(authority)
    val previous = ALL_KEYS.associateWith(storage::getString)
    check(storage.put(
      values(authority) + RETIRED_KEYS.associateWith { null } +
        PREPARED_TRANSITION_KEYS.associateWith { null } + (KEY_PREPARED_ATTACHED to null),
    )) { "Could not atomically activate canonical voice runtime authority." }
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
    val current = requireNotNull(loadAvailable()) {
      "Canonical source authority is unavailable for handoff."
    }
    require(
      current.runtimeId == authority.runtimeId &&
        current.generation + 1 == authority.generation &&
        VoiceRuntimeOriginPolicy.normalize(current.environmentOrigin) ==
        VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin),
    ) { "Canonical handoff source authority is stale." }
    loadPreparedTransition()?.let { prepared ->
      require(prepared == authority) { "A different handoff transition is already prepared." }
      return
    }
    check(storage.put(prefixedTransitionValues(values(authority)))) {
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
    val promoted = preparedValues
      .mapKeys { (key) -> key.removePrefix(PREPARED_TRANSITION_PREFIX) }
      .mapValues { requireNotNull(it.value) }
    check(storage.put(
      promoted + PREPARED_TRANSITION_KEYS.associateWith { null } +
        RETIRED_KEYS.associateWith { null },
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
    discardPreparedTransition()
    return true
  }

  @Synchronized
  fun disableReadiness(
    expectedRuntimeId: String,
    expectedGeneration: Long,
  ): VoiceRuntimePersistedAuthority? {
    val current = loadAvailable() ?: return null
    if (current.runtimeId != expectedRuntimeId || current.generation != expectedGeneration) {
      return null
    }
    val disabled = current.copy(readinessEnabled = false)
    check(storage.put(values(disabled))) { "Could not durably disable canonical voice readiness." }
    return disabled
  }

  @Synchronized
  fun load(): VoiceRuntimeAuthorityLoadResult {
    val present = KEYS.associateWith(storage::getString)
    if (present.values.all { it == null }) return VoiceRuntimeAuthorityLoadResult.Missing
    if (present.values.any { it == null }) return VoiceRuntimeAuthorityLoadResult.Locked
    return try {
      VoiceRuntimeAuthorityLoadResult.Available(
        decode(present.mapValues { requireNotNull(it.value) }),
      )
    } catch (_: Throwable) {
      VoiceRuntimeAuthorityLoadResult.Locked
    }
  }

  @Synchronized
  fun retireLegacyV2(): VoiceRuntimeRetiredAuthorityFence? {
    retiredFence()?.let { return it }
    if (storage.getString(KEY_VERSION) != LEGACY_VERSION) return null
    val runtimeId = storage.getString(KEY_RUNTIME_ID) ?: return null
    val generation = storage.getString(KEY_GENERATION)?.toLongOrNull() ?: return null
    require(runtimeId.isNotBlank() && runtimeId.length <= 128)
    require(generation > 0)
    check(storage.put(
      ALL_KEYS.associateWith { null } + mapOf(
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
  fun inspectPreparedTransition(): VoiceRuntimePersistedAuthority? = loadPreparedTransition()

  @Synchronized
  fun clear(deleteKey: Boolean = true) {
    check(storage.clear(ALL_KEYS)) { "Could not clear canonical voice runtime authority." }
    if (deleteKey) cipher.deleteKey()
  }

  private fun loadAvailable(): VoiceRuntimePersistedAuthority? =
    (load() as? VoiceRuntimeAuthorityLoadResult.Available)?.authority

  private fun loadPreparedTransition(): VoiceRuntimePersistedAuthority? {
    val present = PREPARED_TRANSITION_KEYS.associateWith(storage::getString)
    if (present.values.all { it == null }) return null
    require(present.values.none { it == null }) { "Prepared handoff authority is incomplete." }
    return decode(
      present.mapKeys { (key) -> key.removePrefix(PREPARED_TRANSITION_PREFIX) }
        .mapValues { requireNotNull(it.value) },
    )
  }

  private fun prefixedTransitionValues(values: Map<String, String>): Map<String, String> =
    values.mapKeys { (key) -> "$PREPARED_TRANSITION_PREFIX$key" }

  private fun decode(values: Map<String, String>): VoiceRuntimePersistedAuthority {
    require(values.getValue(KEY_VERSION) == VERSION)
    val authority = VoiceRuntimePersistedAuthority(
      values.getValue(KEY_RUNTIME_ID),
      values.getValue(KEY_GENERATION).toLong(),
      values.getValue(KEY_TARGET_DIGEST),
      parseTarget(JSONObject(values.getValue(KEY_TARGET))),
      values.getValue(KEY_ENVIRONMENT_ORIGIN),
      values.getValue(KEY_READINESS_ENABLED).toBooleanStrict(),
    )
    validate(authority)
    return authority
  }

  private fun values(authority: VoiceRuntimePersistedAuthority): Map<String, String> = mapOf(
    KEY_VERSION to VERSION,
    KEY_RUNTIME_ID to authority.runtimeId,
    KEY_GENERATION to authority.generation.toString(),
    KEY_TARGET_DIGEST to authority.targetDigest,
    KEY_TARGET to targetJson(authority.target),
    KEY_ENVIRONMENT_ORIGIN to VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin),
    KEY_READINESS_ENABLED to authority.readinessEnabled.toString(),
  )

  private fun targetJson(target: VoiceRuntimeTarget): String = when (target) {
    is VoiceRuntimeTarget.Realtime -> VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target)
    is VoiceRuntimeTarget.Thread -> VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)
  }

  private fun parseAttachedPreparation(value: String): VoiceRuntimePreparedAttachedAuthority {
    val json = JSONObject(value)
    require(json.keys().asSequence().toSet() == ATTACHED_PREPARATION_FIELDS)
    val fence = parseFence(json.getJSONObject("fence"))
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

  private fun parseFence(json: JSONObject): VoiceRuntimeAuthorityFence {
    require(json.keys().asSequence().toSet() == FENCE_FIELDS)
    return VoiceRuntimeAuthorityFence(
      json.getString("runtimeId"),
      json.getLong("generation"),
      json.getString("targetDigest"),
      parseTarget(json.getJSONObject("target")),
      json.getString("environmentOrigin"),
    ).also(::validateFence)
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
    require(authority.runtimeId.isNotBlank() && authority.runtimeId.length <= 128)
    require(authority.generation > 0)
    require(authority.targetDigest == T3VoiceRuntimeTargetIdentity.digest(targetJson(authority.target)))
    VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin)
  }

  private fun validateFence(fence: VoiceRuntimeAuthorityFence) {
    validate(
      VoiceRuntimePersistedAuthority(
        fence.runtimeId,
        fence.generation,
        fence.targetDigest,
        fence.target,
        fence.environmentOrigin,
        false,
      ),
    )
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

  private companion object {
    const val VERSION = "t3-canonical-voice-authority-v3"
    const val LEGACY_VERSION = "t3-canonical-voice-authority-v2"
    const val KEY_VERSION = "canonical_authority_version"
    const val KEY_RUNTIME_ID = "canonical_authority_runtime_id"
    const val KEY_GENERATION = "canonical_authority_generation"
    const val KEY_TARGET_DIGEST = "canonical_authority_target_digest"
    const val KEY_TARGET = "canonical_authority_target"
    const val KEY_ENVIRONMENT_ORIGIN = "canonical_authority_environment_origin"
    const val KEY_READINESS_ENABLED = "canonical_authority_readiness_enabled"
    const val KEY_RETIRED_RUNTIME_ID = "canonical_authority_retired_runtime_id"
    const val KEY_RETIRED_GENERATION = "canonical_authority_retired_generation"
    const val PREPARED_TRANSITION_PREFIX = "canonical_transition_prepared_"
    const val KEY_PREPARED_ATTACHED = "canonical_attached_prepared"
    val KEYS = setOf(
      KEY_VERSION,
      KEY_RUNTIME_ID,
      KEY_GENERATION,
      KEY_TARGET_DIGEST,
      KEY_TARGET,
      KEY_ENVIRONMENT_ORIGIN,
      KEY_READINESS_ENABLED,
    )
    val RETIRED_KEYS = setOf(KEY_RETIRED_RUNTIME_ID, KEY_RETIRED_GENERATION)
    val PREPARED_TRANSITION_KEYS = KEYS.mapTo(mutableSetOf()) {
      "$PREPARED_TRANSITION_PREFIX$it"
    }
    val ALL_KEYS = KEYS + RETIRED_KEYS + PREPARED_TRANSITION_KEYS + KEY_PREPARED_ATTACHED
    val FENCE_FIELDS = setOf(
      "runtimeId", "generation", "targetDigest", "target", "environmentOrigin",
    )
    val ATTACHED_PREPARATION_FIELDS = setOf("fence", "readiness")
    val ATTACHED_READINESS_FIELDS = setOf(
      "enabled", "mode", "targetId", "audioRouteId", "autoRearm",
      "microphonePermissionGranted", "notificationPermissionGranted", "generation",
    )
  }
}
