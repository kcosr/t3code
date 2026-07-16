package expo.modules.t3voice

import android.content.Context
import android.view.KeyEvent
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

internal enum class T3VoiceReadinessMode {
  REALTIME,
  THREAD,
}

internal data class T3VoiceReadinessConfig(
  val enabled: Boolean = false,
  val mode: T3VoiceReadinessMode = T3VoiceReadinessMode.REALTIME,
  val targetId: String? = null,
  val audioRouteId: String = "system",
  val autoRearm: Boolean = false,
  val microphonePermissionGranted: Boolean = false,
  val notificationPermissionGranted: Boolean = false,
  val generation: Long = 0,
) {
  fun isEffective(): Boolean = enabled && notificationPermissionGranted

  fun samePayload(other: T3VoiceReadinessConfig): Boolean =
    copy(generation = 0) == other.copy(generation = 0)

  fun sameReservationPayload(other: T3VoiceReadinessConfig): Boolean =
    copy(
      enabled = false,
      microphonePermissionGranted = false,
      notificationPermissionGranted = false,
      generation = 0,
    ) ==
      other.copy(
        enabled = false,
        microphonePermissionGranted = false,
        notificationPermissionGranted = false,
        generation = 0,
      )
}

internal data class T3VoicePreparedReadiness(
  val config: T3VoiceReadinessConfig,
  val runtimeId: String,
  val environmentOrigin: String,
  val operation: T3VoiceRuntimeGrantOperation,
  val targetIdentityDigest: String,
)

internal data class T3VoicePendingRuntimeRevocation(
  val runtimeId: String,
  val environmentOrigin: String,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128)
    VoiceRuntimeOriginPolicy.normalize(environmentOrigin)
  }
}

internal data class T3VoiceDisabledReadiness(
  val config: T3VoiceReadinessConfig,
  val runtimeId: String?,
)

internal data class T3VoiceDisabledAuthorityFence(
  val runtimeId: String,
  val generation: Long,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128)
    require(generation > 0)
  }
}

internal data class T3VoiceStartupAuthorityFence(
  val runtimeId: String,
  val expectedCurrentGeneration: Long,
)

internal data class T3VoiceRecoveredAuthorityFence(
  val runtimeId: String,
  val generation: Long,
) {
  init {
    require(runtimeId.isNotBlank() && runtimeId.length <= 128)
    require(generation > 0)
  }
}

internal data class T3VoiceStartupAuthorityResolution(
  val preparation: T3VoiceStartupAuthorityFence?,
  val runtimeId: String?,
  val initialGeneration: Long?,
  val discardPreparation: Boolean,
)

internal object T3VoiceStartupAuthorityFencePolicy {
  fun persistentPreparation(
    prepared: T3VoicePreparedReadiness?,
  ): T3VoiceStartupAuthorityFence? {
    prepared ?: return null
    require(prepared.config.generation > 0) {
      "Persistent readiness preparation has an invalid generation."
    }
    return T3VoiceStartupAuthorityFence(
      prepared.runtimeId,
      prepared.config.generation - 1,
    )
  }

  fun selectPreparation(
    persistent: T3VoiceStartupAuthorityFence?,
    attached: VoiceRuntimePreparedAttachedAuthority?,
  ): T3VoiceStartupAuthorityFence? {
    val attachedFence = attached?.let {
      require(it.fence.generation > 0) {
        "Attached authority preparation has an invalid generation."
      }
      T3VoiceStartupAuthorityFence(
        it.fence.runtimeId,
        it.fence.generation - 1,
      )
    }
    require(persistent == null || attachedFence == null) {
      "Persistent and attached authority preparations cannot coexist."
    }
    return persistent ?: attachedFence
  }

  fun selectRuntimeId(vararg runtimeIds: String?): String? {
    val distinct = runtimeIds.filterNotNull().distinct()
    require(distinct.size <= 1) {
      "Recovered voice authority fences belong to different runtimes."
    }
    return distinct.singleOrNull()
  }

  fun resolve(
    preparation: T3VoiceStartupAuthorityFence?,
    vararg recoveredFences: T3VoiceRecoveredAuthorityFence?,
  ): T3VoiceStartupAuthorityResolution {
    val allRecovered = recoveredFences.filterNotNull()
    val recoveredRuntimeId = allRecovered.firstOrNull()?.runtimeId
    val recovered = allRecovered.filter { it.runtimeId == recoveredRuntimeId }
    val recoveredGeneration = recovered.maxOfOrNull { it.generation }
    val recoveredConflict = allRecovered.any { it.runtimeId != recoveredRuntimeId }
    if (preparation == null) {
      return T3VoiceStartupAuthorityResolution(
        preparation = null,
        runtimeId = recoveredRuntimeId,
        initialGeneration = recoveredGeneration,
        discardPreparation = recoveredConflict,
      )
    }
    val compatible = !recoveredConflict && recovered.all { fence ->
      fence.runtimeId == preparation.runtimeId &&
        fence.generation == preparation.expectedCurrentGeneration
    }
    if (compatible) {
      return T3VoiceStartupAuthorityResolution(
        preparation,
        preparation.runtimeId,
        preparation.expectedCurrentGeneration,
        false,
      )
    }
    if (recoveredConflict ||
      (recoveredRuntimeId != null && recoveredRuntimeId != preparation.runtimeId)
    ) {
      return T3VoiceStartupAuthorityResolution(
        preparation = null,
        runtimeId = recoveredRuntimeId,
        initialGeneration = recoveredGeneration,
        discardPreparation = true,
      )
    }
    return T3VoiceStartupAuthorityResolution(
      preparation = null,
      runtimeId = preparation.runtimeId,
      initialGeneration = maxOf(
        preparation.expectedCurrentGeneration + 1,
        recoveredGeneration ?: 0,
      ),
      discardPreparation = true,
    )
  }

  fun resolveWithFallback(
    preparation: Result<T3VoiceStartupAuthorityFence?>,
    recoveredFences: List<T3VoiceRecoveredAuthorityFence?>,
    persistentReadiness: T3VoicePreparedReadiness?,
    attachedPreparation: VoiceRuntimePreparedAttachedAuthority?,
    canonicalInstalledPresent: Boolean,
    persistentReadinessRead: Boolean,
    attachedPreparationRead: Boolean,
    activeAuthorityRead: Boolean,
  ): T3VoiceStartupAuthorityResolution = preparation.fold(
    onSuccess = { resolve(it, *recoveredFences.toTypedArray()) },
    onFailure = {
      val recoveredRuntimeId = recoveredFences.filterNotNull().firstOrNull()?.runtimeId
      val preparationRuntimeId = runCatching {
        selectRuntimeId(persistentReadiness?.runtimeId, attachedPreparation?.fence?.runtimeId)
      }.getOrNull()
      val selectedRuntimeId = recoveredRuntimeId ?: preparationRuntimeId
      val recoveredGeneration = recoveredFences.asSequence().filterNotNull()
        .filter { it.runtimeId == selectedRuntimeId }.maxOfOrNull { it.generation }
      val preparationGeneration = sequenceOf(
        persistentReadiness?.let { it.runtimeId to it.config.generation },
        attachedPreparation?.fence?.let { it.runtimeId to it.generation },
      ).filterNotNull().filter { it.first == selectedRuntimeId }.maxOfOrNull { it.second }
      T3VoiceStartupAuthorityResolution(
        preparation = null,
        runtimeId = selectedRuntimeId,
        initialGeneration = recoveredGeneration ?: preparationGeneration,
        discardPreparation = !canonicalInstalledPresent && (
          !persistentReadinessRead || !attachedPreparationRead || persistentReadiness != null ||
            !activeAuthorityRead || attachedPreparation != null
          ),
      )
    },
  )
}

internal object T3VoiceDisabledTerminalCleanupCoordinator {
  fun run(
    canonicalIdle: Boolean,
    clearController: () -> Boolean,
    clearAuthority: () -> Unit,
    clearEngine: () -> Unit,
  ): Boolean {
    if (!canonicalIdle || !clearController()) return false
    clearAuthority()
    clearEngine()
    return true
  }
}

internal object T3VoiceConfigureReadinessPolicy {
  fun synthesize(
    current: T3VoiceReadinessConfig,
    generation: Long,
    enabled: Boolean,
  ): T3VoiceReadinessConfig {
    require(generation > 0)
    return current.copy(enabled = enabled, generation = generation)
  }
}

internal object T3VoiceDisabledAuthorityRetentionPolicy {
  fun shouldClearAtTerminal(
    authority: VoiceRuntimePersistedAuthority,
    disabledFence: T3VoiceDisabledAuthorityFence?,
    canonicalIdle: Boolean,
  ): Boolean =
    !authority.readinessEnabled &&
      disabledFence == T3VoiceDisabledAuthorityFence(authority.runtimeId, authority.generation) &&
      canonicalIdle
}

internal data class T3VoiceReadinessStoreCheckpoint(
  val values: Map<String, Any?>,
)

internal class T3VoiceReadinessStore(context: Context) {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  @Synchronized
  fun checkpoint(): T3VoiceReadinessStoreCheckpoint =
    T3VoiceReadinessStoreCheckpoint(preferences.all.mapValues { it.value })

  @Synchronized
  fun restore(checkpoint: T3VoiceReadinessStoreCheckpoint) {
    val edit = preferences.edit().clear()
    checkpoint.values.forEach { (key, value) ->
      when (value) {
        null -> edit.remove(key)
        is Boolean -> edit.putBoolean(key, value)
        is Long -> edit.putLong(key, value)
        is Int -> edit.putInt(key, value)
        is Float -> edit.putFloat(key, value)
        is String -> edit.putString(key, value)
        is Set<*> -> {
          @Suppress("UNCHECKED_CAST")
          edit.putStringSet(key, value as Set<String>)
        }
        else -> error("Unsupported readiness checkpoint value for $key.")
      }
    }
    check(edit.commit()) { "Could not restore voice readiness state." }
  }

  fun read(): T3VoiceReadinessConfig =
    T3VoiceReadinessConfig(
      enabled = preferences.getBoolean(KEY_ENABLED, false),
      mode =
        runCatching {
          T3VoiceReadinessMode.valueOf(
            preferences.getString(KEY_MODE, null) ?: T3VoiceReadinessMode.REALTIME.name,
          )
        }.getOrDefault(T3VoiceReadinessMode.REALTIME),
      targetId = preferences.getString(KEY_TARGET_ID, null),
      audioRouteId = preferences.getString(KEY_AUDIO_ROUTE_ID, "system") ?: "system",
      autoRearm = preferences.getBoolean(KEY_AUTO_REARM, false),
      microphonePermissionGranted = false,
      notificationPermissionGranted = false,
      generation = preferences.getLong(KEY_GENERATION, 0),
    )

  fun write(config: T3VoiceReadinessConfig) {
    check(
      preferences.edit()
        .putBoolean(KEY_ENABLED, config.enabled)
        .putString(KEY_MODE, config.mode.name)
        .putString(KEY_TARGET_ID, config.targetId)
        .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
        .putBoolean(KEY_AUTO_REARM, config.autoRearm)
        .putLong(KEY_GENERATION, config.generation)
        .remove(KEY_PREPARED)
        .remove(KEY_PREPARED_RUNTIME_ID)
        .remove(KEY_PREPARED_ENVIRONMENT_ORIGIN)
        .remove(KEY_PREPARED_OPERATION)
        .remove(KEY_PREPARED_TARGET_DIGEST)
        .remove(KEY_ACTIVE_RUNTIME_ID)
        .remove(KEY_ACTIVE_ENVIRONMENT_ORIGIN)
        .remove(KEY_ACTIVE_OPERATION)
        .remove(KEY_ACTIVE_TARGET_DIGEST)
        .commit(),
    ) { "Could not persist voice readiness." }
  }

  fun prepared(): T3VoicePreparedReadiness? {
    if (!preferences.getBoolean(KEY_PREPARED, false)) return null
    val runtimeId = preferences.getString(KEY_PREPARED_RUNTIME_ID, null) ?: return null
    val environmentOrigin = preferences.getString(KEY_PREPARED_ENVIRONMENT_ORIGIN, null) ?: return null
    val operation =
      T3VoiceRuntimeGrantOperation.fromWireValue(
        preferences.getString(KEY_PREPARED_OPERATION, null) ?: return null,
      )
    val targetIdentityDigest = preferences.getString(KEY_PREPARED_TARGET_DIGEST, null) ?: return null
    require(targetIdentityDigest.matches(SHA256_HEX_PATTERN))
    return T3VoicePreparedReadiness(
      read().copy(enabled = true),
      runtimeId,
      VoiceRuntimeOriginPolicy.normalize(environmentOrigin),
      operation,
      targetIdentityDigest,
    )
  }

  fun writePrepared(prepared: T3VoicePreparedReadiness) {
    val config = prepared.config
    require(config.enabled && config.generation > 0)
    require(prepared.runtimeId.isNotBlank() && prepared.runtimeId.length <= 128)
    val normalizedOrigin = VoiceRuntimeOriginPolicy.normalize(prepared.environmentOrigin)
    require(prepared.targetIdentityDigest.matches(SHA256_HEX_PATTERN))
    check(
      preferences.edit()
        .putBoolean(KEY_ENABLED, false)
        .putString(KEY_MODE, config.mode.name)
        .putString(KEY_TARGET_ID, config.targetId)
        .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
        .putBoolean(KEY_AUTO_REARM, config.autoRearm)
        .putLong(KEY_GENERATION, config.generation)
        .putBoolean(KEY_PREPARED, true)
        .putString(KEY_PREPARED_RUNTIME_ID, prepared.runtimeId)
        .putString(KEY_PREPARED_ENVIRONMENT_ORIGIN, normalizedOrigin)
        .putString(KEY_PREPARED_OPERATION, prepared.operation.wireValue)
        .putString(KEY_PREPARED_TARGET_DIGEST, prepared.targetIdentityDigest)
        .remove(KEY_ACTIVE_RUNTIME_ID)
        .remove(KEY_ACTIVE_ENVIRONMENT_ORIGIN)
        .remove(KEY_ACTIVE_OPERATION)
        .remove(KEY_ACTIVE_TARGET_DIGEST)
        .commit(),
    ) { "Could not reserve voice readiness." }
  }

  fun activeAuthority(): T3VoicePreparedReadiness? {
    val config = read()
    if (!config.enabled) return null
    val runtimeId = preferences.getString(KEY_ACTIVE_RUNTIME_ID, null) ?: return null
    val origin = preferences.getString(KEY_ACTIVE_ENVIRONMENT_ORIGIN, null) ?: return null
    val operation =
      T3VoiceRuntimeGrantOperation.fromWireValue(
        preferences.getString(KEY_ACTIVE_OPERATION, null) ?: return null,
      )
    val digest = preferences.getString(KEY_ACTIVE_TARGET_DIGEST, null) ?: return null
    require(digest.matches(SHA256_HEX_PATTERN))
    return T3VoicePreparedReadiness(
      config,
      runtimeId,
      VoiceRuntimeOriginPolicy.normalize(origin),
      operation,
      digest,
    )
  }

  fun writeActivated(config: T3VoiceReadinessConfig, authority: T3VoicePreparedReadiness) {
    require(config.enabled && config.generation == authority.config.generation)
    check(
      preferences.edit()
        .putBoolean(KEY_ENABLED, true)
        .putString(KEY_MODE, config.mode.name)
        .putString(KEY_TARGET_ID, config.targetId)
        .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
        .putBoolean(KEY_AUTO_REARM, config.autoRearm)
        .putLong(KEY_GENERATION, config.generation)
        .putString(KEY_ACTIVE_RUNTIME_ID, authority.runtimeId)
        .putString(
          KEY_ACTIVE_ENVIRONMENT_ORIGIN,
          VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin),
        )
        .putString(KEY_ACTIVE_OPERATION, authority.operation.wireValue)
        .putString(KEY_ACTIVE_TARGET_DIGEST, authority.targetIdentityDigest)
        .remove(KEY_PREPARED)
        .remove(KEY_PREPARED_RUNTIME_ID)
        .remove(KEY_PREPARED_ENVIRONMENT_ORIGIN)
        .remove(KEY_PREPARED_OPERATION)
        .remove(KEY_PREPARED_TARGET_DIGEST)
        .commit(),
    ) { "Could not activate voice readiness authority." }
  }

  fun pendingRuntimeRevocation(): T3VoicePendingRuntimeRevocation? {
    val runtimeId = preferences.getString(KEY_PENDING_REVOCATION_RUNTIME_ID, null)
    val environmentOrigin = preferences.getString(KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN, null)
    if (runtimeId === null && environmentOrigin === null) return null
    check(runtimeId !== null && environmentOrigin !== null) {
      "The pending runtime voice revocation is incomplete."
    }
    return T3VoicePendingRuntimeRevocation(runtimeId, environmentOrigin)
  }

  fun writeDisabledForRuntimeRevocation(
    config: T3VoiceReadinessConfig,
    revocation: T3VoicePendingRuntimeRevocation?,
  ) {
    require(!config.enabled)
    val edit =
      preferences.edit()
        .putBoolean(KEY_ENABLED, false)
        .putString(KEY_MODE, config.mode.name)
        .putString(KEY_TARGET_ID, config.targetId)
        .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
        .putBoolean(KEY_AUTO_REARM, config.autoRearm)
        .putLong(KEY_GENERATION, config.generation)
        .remove(KEY_PREPARED)
        .remove(KEY_PREPARED_RUNTIME_ID)
        .remove(KEY_PREPARED_ENVIRONMENT_ORIGIN)
        .remove(KEY_PREPARED_OPERATION)
        .remove(KEY_PREPARED_TARGET_DIGEST)
        .remove(KEY_ACTIVE_RUNTIME_ID)
        .remove(KEY_ACTIVE_ENVIRONMENT_ORIGIN)
        .remove(KEY_ACTIVE_OPERATION)
        .remove(KEY_ACTIVE_TARGET_DIGEST)
    if (revocation === null) {
      edit.remove(KEY_PENDING_REVOCATION_RUNTIME_ID)
        .remove(KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN)
    } else {
      edit.putString(KEY_PENDING_REVOCATION_RUNTIME_ID, revocation.runtimeId)
        .putString(
          KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN,
          VoiceRuntimeOriginPolicy.normalize(revocation.environmentOrigin),
        )
    }
    check(edit.commit()) { "Could not persist disabled voice authority." }
  }

  fun acknowledgeRuntimeRevocation(expected: T3VoicePendingRuntimeRevocation): Boolean {
    val pending = pendingRuntimeRevocation() ?: return false
    if (pending != expected) return false
    return preferences.edit()
      .remove(KEY_PENDING_REVOCATION_RUNTIME_ID)
      .remove(KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN)
      .commit()
  }

  fun pendingDisabled(): T3VoiceRuntimeEvent.ReadinessDisabled? {
    val generation = preferences.getLong(KEY_PENDING_DISABLED_GENERATION, -1)
    if (generation < 0) return null
    return T3VoiceRuntimeEvent.ReadinessDisabled(generation, "notification")
  }

  fun disabledAuthorityFence(): T3VoiceDisabledAuthorityFence? {
    val runtimeId = preferences.getString(KEY_DISABLED_AUTHORITY_RUNTIME_ID, null)
    val generation = preferences.getLong(KEY_DISABLED_AUTHORITY_GENERATION, -1)
    if (runtimeId == null && generation < 0) return null
    check(runtimeId != null && generation > 0) {
      "The disabled authority fence is incomplete."
    }
    return T3VoiceDisabledAuthorityFence(runtimeId, generation)
  }

  fun writeDisabledWithPending(
    config: T3VoiceReadinessConfig,
    revocation: T3VoicePendingRuntimeRevocation?,
    authorityFence: T3VoiceDisabledAuthorityFence?,
  ) {
    require(!config.enabled)
    val edit = preferences.edit()
      .putBoolean(KEY_ENABLED, false)
      .putString(KEY_MODE, config.mode.name)
      .putString(KEY_TARGET_ID, config.targetId)
      .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
      .putBoolean(KEY_AUTO_REARM, config.autoRearm)
      .putLong(KEY_GENERATION, config.generation)
      .putLong(KEY_PENDING_DISABLED_GENERATION, config.generation)
      .remove(KEY_PREPARED)
      .remove(KEY_PREPARED_RUNTIME_ID)
      .remove(KEY_PREPARED_ENVIRONMENT_ORIGIN)
      .remove(KEY_PREPARED_OPERATION)
      .remove(KEY_PREPARED_TARGET_DIGEST)
      .remove(KEY_ACTIVE_RUNTIME_ID)
      .remove(KEY_ACTIVE_ENVIRONMENT_ORIGIN)
      .remove(KEY_ACTIVE_OPERATION)
      .remove(KEY_ACTIVE_TARGET_DIGEST)
    if (authorityFence == null) {
      edit.remove(KEY_DISABLED_AUTHORITY_RUNTIME_ID)
        .remove(KEY_DISABLED_AUTHORITY_GENERATION)
    } else {
      edit.putString(KEY_DISABLED_AUTHORITY_RUNTIME_ID, authorityFence.runtimeId)
        .putLong(KEY_DISABLED_AUTHORITY_GENERATION, authorityFence.generation)
    }
    if (revocation !== null) {
      edit.putString(KEY_PENDING_REVOCATION_RUNTIME_ID, revocation.runtimeId)
        .putString(
          KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN,
          VoiceRuntimeOriginPolicy.normalize(revocation.environmentOrigin),
        )
    }
    check(edit.commit()) { "Could not persist notification-disabled voice authority." }
  }

  fun acknowledgePendingDisabled(generation: Long): Boolean {
    if (preferences.getLong(KEY_PENDING_DISABLED_GENERATION, -1) != generation) return false
    preferences.edit().remove(KEY_PENDING_DISABLED_GENERATION).apply()
    return true
  }

  fun clearDisabledAuthorityFence(expected: T3VoiceDisabledAuthorityFence): Boolean {
    if (disabledAuthorityFence() != expected) return false
    return preferences.edit()
      .remove(KEY_DISABLED_AUTHORITY_RUNTIME_ID)
      .remove(KEY_DISABLED_AUTHORITY_GENERATION)
      .commit()
  }

  companion object {
    private const val PREFERENCES_NAME = "t3_voice_readiness"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_MODE = "mode"
    private const val KEY_TARGET_ID = "target_id"
    private const val KEY_AUDIO_ROUTE_ID = "audio_route_id"
    private const val KEY_AUTO_REARM = "auto_rearm"
    private const val KEY_GENERATION = "generation"
    private const val KEY_PENDING_DISABLED_GENERATION = "pending_disabled_generation"
    private const val KEY_DISABLED_AUTHORITY_RUNTIME_ID = "disabled_authority_runtime_id"
    private const val KEY_DISABLED_AUTHORITY_GENERATION = "disabled_authority_generation"
    private const val KEY_PREPARED = "prepared"
    private const val KEY_PREPARED_RUNTIME_ID = "prepared_runtime_id"
    private const val KEY_PREPARED_ENVIRONMENT_ORIGIN = "prepared_environment_origin"
    private const val KEY_PREPARED_OPERATION = "prepared_operation"
    private const val KEY_PREPARED_TARGET_DIGEST = "prepared_target_digest"
    private const val KEY_PENDING_REVOCATION_RUNTIME_ID = "pending_revocation_runtime_id"
    private const val KEY_PENDING_REVOCATION_ENVIRONMENT_ORIGIN =
      "pending_revocation_environment_origin"
    private const val KEY_ACTIVE_RUNTIME_ID = "active_runtime_id"
    private const val KEY_ACTIVE_ENVIRONMENT_ORIGIN = "active_environment_origin"
    private const val KEY_ACTIVE_OPERATION = "active_operation"
    private const val KEY_ACTIVE_TARGET_DIGEST = "active_target_digest"
    private val SHA256_HEX_PATTERN = Regex("^[0-9a-f]{64}$")
  }
}

internal object T3VoiceReadinessReservationPolicy {
  fun requireActivation(
    locked: T3VoiceReadinessConfig,
    prepared: T3VoicePreparedReadiness?,
    desired: T3VoiceReadinessConfig,
    expectedGeneration: Long,
  ): T3VoiceReadinessConfig {
    require(desired.enabled && expectedGeneration > 0)
    val reserved = requireNotNull(prepared) { "Voice readiness has not been prepared." }
    require(
      locked.generation == expectedGeneration &&
        reserved.config.generation == expectedGeneration &&
        reserved.config.sameReservationPayload(desired),
    ) { "Voice readiness reservation is stale." }
    return desired.copy(generation = expectedGeneration)
  }
}

internal object T3VoiceCanonicalReadinessPolicy {
  fun disabled(
    current: T3VoiceReadinessConfig,
    canonicalGeneration: Long,
  ): T3VoiceReadinessConfig {
    require(canonicalGeneration >= 0)
    return current.copy(enabled = false, generation = canonicalGeneration)
  }

  fun transient(
    current: T3VoiceReadinessConfig,
    authority: VoiceRuntimePersistedAuthority,
  ): T3VoiceReadinessConfig {
    require(!authority.readinessEnabled)
    val target = authority.target
    return current.copy(
      enabled = false,
      mode = when (target) {
        is VoiceRuntimeTarget.Realtime -> T3VoiceReadinessMode.REALTIME
        is VoiceRuntimeTarget.Thread -> T3VoiceReadinessMode.THREAD
      },
      targetId = when (target) {
        is VoiceRuntimeTarget.Realtime -> target.conversationId
        is VoiceRuntimeTarget.Thread -> "${target.projectId}/${target.threadId}"
      },
      generation = authority.generation,
    )
  }
}

internal data class T3VoiceRuntimeOwnershipFence(
  val runtimeId: String,
  val generation: Long,
  val environmentOrigin: String,
)

internal object T3VoiceRuntimeOwnershipPolicy {
  fun canonicalFence(
    readiness: T3VoiceReadinessConfig,
    activeReadiness: T3VoicePreparedReadiness?,
    persistedAuthority: VoiceRuntimePersistedAuthority?,
    preparedPersistent: T3VoicePreparedReadiness? = null,
    preparedAttached: T3VoicePreparedReadiness? = null,
  ): T3VoiceRuntimeOwnershipFence? {
    if (
      activeReadiness != null &&
        readiness.enabled &&
        activeReadiness.config.generation == readiness.generation
    ) {
      return T3VoiceRuntimeOwnershipFence(
        activeReadiness.runtimeId,
        readiness.generation,
        activeReadiness.environmentOrigin,
      )
    }
    if (
      persistedAuthority != null &&
        persistedAuthority.generation == readiness.generation
    ) {
      return T3VoiceRuntimeOwnershipFence(
        persistedAuthority.runtimeId,
        persistedAuthority.generation,
        persistedAuthority.environmentOrigin,
      )
    }
    if (
      preparedPersistent != null &&
        preparedPersistent.config.enabled &&
        preparedPersistent.config.generation == readiness.generation
    ) {
      require(preparedPersistent.config.generation > 0)
      return T3VoiceRuntimeOwnershipFence(
        preparedPersistent.runtimeId,
        preparedPersistent.config.generation - 1,
        preparedPersistent.environmentOrigin,
      )
    }
    if (
      preparedAttached != null &&
        !preparedAttached.config.enabled &&
        preparedAttached.config.generation == readiness.generation
    ) {
      require(preparedAttached.config.generation > 0)
      return T3VoiceRuntimeOwnershipFence(
        preparedAttached.runtimeId,
        preparedAttached.config.generation - 1,
        preparedAttached.environmentOrigin,
      )
    }
    return null
  }
}

internal data class T3VoicePendingCommand(
  val commandId: String,
  val command: String,
  val controllerGeneration: Long,
  val readinessGeneration: Long,
) {
  fun toEventBody(): Map<String, Any> =
    mapOf(
      "commandId" to commandId,
      "command" to command,
      "controllerGeneration" to controllerGeneration.toDouble(),
      "readinessGeneration" to readinessGeneration.toDouble(),
    )
}

internal class T3VoiceControllerCommands {
  private val nextCommandId = AtomicLong(0)
  private val mutablePending = MutableStateFlow<T3VoicePendingCommand?>(null)
  private var controllerGeneration: Long? = null

  val pending: StateFlow<T3VoicePendingCommand?> = mutablePending.asStateFlow()

  @Synchronized
  fun isAttached(): Boolean = controllerGeneration != null

  @Synchronized
  fun invalidateReadiness() {
    mutablePending.value = null
  }

  @Synchronized
  fun requestPrimary(readinessGeneration: Long, microphonePermissionGranted: Boolean): T3VoicePendingCommand? {
    if (!microphonePermissionGranted) return null
    val controller = controllerGeneration ?: return null
    val existing = mutablePending.value
    if (existing != null && existing.controllerGeneration == controller) return existing
    return T3VoicePendingCommand(
      commandId = "voice-command-${nextCommandId.incrementAndGet()}",
      command = "primary",
      controllerGeneration = controller,
      readinessGeneration = readinessGeneration,
    ).also { mutablePending.value = it }
  }

}

internal object T3VoiceForegroundLifecyclePolicy {
  private const val DECLARED_SERVICE_TYPES =
    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
      android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK

  fun requireDeclaredNonzero(types: Int): Int {
    require(types != 0 && types and DECLARED_SERVICE_TYPES == types) {
      "Foreground service types must be a nonzero declared subset."
    }
    return types
  }

  fun shouldRemainStarted(config: T3VoiceReadinessConfig): Boolean = config.isEffective()

  fun readinessServiceTypes(
    config: T3VoiceReadinessConfig,
    @Suppress("UNUSED_PARAMETER") controllerAttached: Boolean,
  ): Int {
    var types = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (config.microphonePermissionGranted) {
      types = types or android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    return types
  }

  fun operationServiceTypes(phase: T3VoiceRuntimePhase): Int =
    when (phase) {
      T3VoiceRuntimePhase.RECORDING ->
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
      T3VoiceRuntimePhase.ARMING ->
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      T3VoiceRuntimePhase.PLAYING ->
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      T3VoiceRuntimePhase.REALTIME ->
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or
          android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
      T3VoiceRuntimePhase.INACTIVE,
      T3VoiceRuntimePhase.IDLE,
      -> 0
    }

  fun reconciledServiceTypes(
    phase: T3VoiceRuntimePhase,
    config: T3VoiceReadinessConfig,
    controllerAttached: Boolean,
  ): Int =
    requireDeclaredNonzero(
      operationServiceTypes(phase) or
        if (config.isEffective()) readinessServiceTypes(config, controllerAttached) else 0,
    )

  fun activeServiceTypes(
    operationTypes: Int,
    config: T3VoiceReadinessConfig,
    controllerAttached: Boolean,
  ): Int =
    requireDeclaredNonzero(
      operationTypes or
        if (config.isEffective()) readinessServiceTypes(config, controllerAttached) else 0,
    )
}

internal object T3VoiceDisablePolicy {
  fun shouldCreatePendingDisable(
    config: T3VoiceReadinessConfig,
    pending: T3VoiceRuntimeEvent.ReadinessDisabled?,
  ): Boolean = config.enabled && pending?.readinessGeneration != config.generation
}

internal object T3VoiceConditionalDisablePolicy {
  fun canDisable(
    expectedRuntimeId: String?,
    expectedGeneration: Long?,
    canonicalGeneration: Long,
    authorityIdentities: List<Pair<String, Long>>,
    nativeVoiceActive: Boolean,
  ): Boolean {
    if ((expectedRuntimeId == null) != (expectedGeneration == null) || nativeVoiceActive) return false
    val distinct = authorityIdentities.distinct()
    if (distinct.size > 1) return false
    val actual = distinct.singleOrNull()
    return if (expectedRuntimeId == null) {
      actual == null
    } else {
      actual == (expectedRuntimeId to expectedGeneration) &&
        canonicalGeneration == expectedGeneration
    }
  }
}

internal object VoiceRuntimePreparationPolicy {
  fun canPrepare(
    phase: T3VoiceRuntimePhase,
    realtimeAttemptActive: Boolean,
    threadAttemptActive: Boolean,
    realtimeCleanupPending: Boolean,
  ): Boolean =
    phase == T3VoiceRuntimePhase.IDLE &&
      !realtimeAttemptActive &&
      !threadAttemptActive &&
      !realtimeCleanupPending
}

internal object T3VoiceReadinessReconciliationPolicy {
  fun canApply(
    config: T3VoiceReadinessConfig,
    pendingDisabled: T3VoiceRuntimeEvent.ReadinessDisabled?,
  ): Boolean = !config.enabled || pendingDisabled == null
}

internal enum class T3VoiceControlCommand {
  PRIMARY,
  STOP,
  TOGGLE_MUTE,
}

internal enum class T3VoiceControlDecision {
  START_NATIVE_REALTIME,
  START_NATIVE_THREAD,
  REQUEST_CONTROLLER_START,
  STOP_ACTIVE,
  TOGGLE_REALTIME_MUTE,
  IGNORE,
}

internal enum class T3VoicePendingControlDecision {
  IGNORE,
  CANCEL,
  NOT_APPLICABLE,
}

internal object T3VoiceControlPolicy {
  fun pendingStartDecision(
    command: T3VoiceControlCommand,
    phase: T3VoiceRuntimePhase,
    attemptActive: Boolean,
  ): T3VoicePendingControlDecision {
    if (!attemptActive || phase != T3VoiceRuntimePhase.IDLE) {
      return T3VoicePendingControlDecision.NOT_APPLICABLE
    }
    return when (command) {
      T3VoiceControlCommand.PRIMARY,
      T3VoiceControlCommand.TOGGLE_MUTE,
      -> T3VoicePendingControlDecision.IGNORE
      T3VoiceControlCommand.STOP -> T3VoicePendingControlDecision.CANCEL
    }
  }

  fun decide(
    command: T3VoiceControlCommand,
    phase: T3VoiceRuntimePhase,
    controllerAttached: Boolean,
    nativeRealtimeAvailable: Boolean = false,
    nativeThreadAvailable: Boolean = false,
    readinessMode: T3VoiceReadinessMode = T3VoiceReadinessMode.REALTIME,
  ): T3VoiceControlDecision =
    when (command) {
      T3VoiceControlCommand.STOP ->
        if (phase == T3VoiceRuntimePhase.IDLE || phase == T3VoiceRuntimePhase.INACTIVE) {
          T3VoiceControlDecision.IGNORE
        } else {
          T3VoiceControlDecision.STOP_ACTIVE
        }
      T3VoiceControlCommand.TOGGLE_MUTE ->
        if (phase == T3VoiceRuntimePhase.REALTIME) {
          T3VoiceControlDecision.TOGGLE_REALTIME_MUTE
        } else {
          T3VoiceControlDecision.IGNORE
        }
      T3VoiceControlCommand.PRIMARY ->
        if (phase == T3VoiceRuntimePhase.IDLE && nativeRealtimeAvailable) {
          T3VoiceControlDecision.START_NATIVE_REALTIME
        } else if (phase == T3VoiceRuntimePhase.IDLE && nativeThreadAvailable) {
          T3VoiceControlDecision.START_NATIVE_THREAD
        } else if (
          phase == T3VoiceRuntimePhase.IDLE &&
            readinessMode == T3VoiceReadinessMode.THREAD &&
            controllerAttached
        ) {
          T3VoiceControlDecision.REQUEST_CONTROLLER_START
        } else if (phase != T3VoiceRuntimePhase.IDLE && phase != T3VoiceRuntimePhase.INACTIVE) {
          T3VoiceControlDecision.STOP_ACTIVE
        } else {
          T3VoiceControlDecision.IGNORE
        }
    }

  fun mediaButtonCommand(
    action: Int,
    repeatCount: Int,
    keyCode: Int,
  ): T3VoiceControlCommand? {
    if (action != KeyEvent.ACTION_DOWN || repeatCount != 0) return null
    return when (keyCode) {
      KeyEvent.KEYCODE_MEDIA_PLAY,
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      KeyEvent.KEYCODE_HEADSETHOOK,
      -> T3VoiceControlCommand.PRIMARY
      KeyEvent.KEYCODE_MEDIA_PAUSE,
      KeyEvent.KEYCODE_MEDIA_STOP,
      -> T3VoiceControlCommand.STOP
      else -> null
    }
  }

  fun consumesMediaButton(keyCode: Int): Boolean =
    keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
      keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
      keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
      keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE ||
      keyCode == KeyEvent.KEYCODE_MEDIA_STOP
}
