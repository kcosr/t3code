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
}

internal class T3VoiceReadinessStore(context: Context) {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

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
    preferences.edit()
      .putBoolean(KEY_ENABLED, config.enabled)
      .putString(KEY_MODE, config.mode.name)
      .putString(KEY_TARGET_ID, config.targetId)
      .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
      .putBoolean(KEY_AUTO_REARM, config.autoRearm)
      .putLong(KEY_GENERATION, config.generation)
      .apply()
  }

  fun pendingDisabled(): T3VoiceRuntimeEvent.ReadinessDisabled? {
    val generation = preferences.getLong(KEY_PENDING_DISABLED_GENERATION, -1)
    if (generation < 0) return null
    return T3VoiceRuntimeEvent.ReadinessDisabled(generation, "notification")
  }

  fun writeDisabledWithPending(config: T3VoiceReadinessConfig) {
    require(!config.enabled)
    preferences.edit()
      .putBoolean(KEY_ENABLED, false)
      .putString(KEY_MODE, config.mode.name)
      .putString(KEY_TARGET_ID, config.targetId)
      .putString(KEY_AUDIO_ROUTE_ID, config.audioRouteId)
      .putBoolean(KEY_AUTO_REARM, config.autoRearm)
      .putLong(KEY_GENERATION, config.generation)
      .putLong(KEY_PENDING_DISABLED_GENERATION, config.generation)
      .apply()
  }

  fun acknowledgePendingDisabled(generation: Long): Boolean {
    if (preferences.getLong(KEY_PENDING_DISABLED_GENERATION, -1) != generation) return false
    preferences.edit().remove(KEY_PENDING_DISABLED_GENERATION).apply()
    return true
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
  fun register(generation: Long) {
    if (controllerGeneration == generation) return
    controllerGeneration = generation
    mutablePending.value = null
  }

  @Synchronized
  fun unregister(generation: Long) {
    if (controllerGeneration == generation) {
      controllerGeneration = null
      mutablePending.value = null
    }
  }

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

  @Synchronized
  fun complete(commandId: String, generation: Long, outcome: String): Boolean {
    require(outcome == "success" || outcome == "failure")
    val pending = mutablePending.value ?: return false
    if (pending.commandId != commandId || pending.controllerGeneration != generation) return false
    mutablePending.value = null
    return true
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
    controllerAttached: Boolean,
  ): Int {
    var types = android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if (controllerAttached && config.microphonePermissionGranted) {
      types = types or android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    return types
  }

  fun operationServiceTypes(phase: T3VoiceRuntimePhase): Int =
    when (phase) {
      T3VoiceRuntimePhase.RECORDING ->
        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
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
  REQUEST_CONTROLLER_START,
  STOP_ACTIVE,
  TOGGLE_REALTIME_MUTE,
  IGNORE,
}

internal object T3VoiceControlPolicy {
  fun decide(
    command: T3VoiceControlCommand,
    phase: T3VoiceRuntimePhase,
    controllerAttached: Boolean,
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
        if (phase == T3VoiceRuntimePhase.IDLE && controllerAttached) {
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
}
