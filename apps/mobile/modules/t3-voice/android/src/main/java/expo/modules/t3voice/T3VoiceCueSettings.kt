package expo.modules.t3voice

import android.content.Context

internal data class T3VoiceCueSettings(
  val enabled: Boolean = true,
  /** Leading silence (ms) before Ready/Ended tones. Clamped to 0..2000. */
  val startupPreRollMs: Int = DEFAULT_STARTUP_PRE_ROLL_MS,
  val generation: Long = 0,
) {
  init {
    require(startupPreRollMs in STARTUP_PRE_ROLL_MIN_MS..STARTUP_PRE_ROLL_MAX_MS) {
      "startupPreRollMs must be between $STARTUP_PRE_ROLL_MIN_MS and $STARTUP_PRE_ROLL_MAX_MS."
    }
  }

  companion object {
    const val STARTUP_PRE_ROLL_MIN_MS = 0
    const val STARTUP_PRE_ROLL_MAX_MS = 2_000
    const val DEFAULT_STARTUP_PRE_ROLL_MS = 768
  }
}

internal class T3VoiceCueSettingsStore(context: Context) {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  fun read(): T3VoiceCueSettings =
    T3VoiceCueSettings(
      enabled = preferences.getBoolean(KEY_ENABLED, true),
      startupPreRollMs =
        preferences
          .getInt(KEY_STARTUP_PRE_ROLL_MS, T3VoiceCueSettings.DEFAULT_STARTUP_PRE_ROLL_MS)
          .coerceIn(
            T3VoiceCueSettings.STARTUP_PRE_ROLL_MIN_MS,
            T3VoiceCueSettings.STARTUP_PRE_ROLL_MAX_MS,
          ),
      generation = preferences.getLong(KEY_GENERATION, 0),
    )

  fun writeEnabled(enabled: Boolean): T3VoiceCueSettings {
    val current = read()
    if (current.enabled == enabled) return current
    return write(current.copy(enabled = enabled, generation = current.generation + 1))
  }

  fun writeStartupPreRollMs(startupPreRollMs: Int): T3VoiceCueSettings {
    val clamped =
      startupPreRollMs.coerceIn(
        T3VoiceCueSettings.STARTUP_PRE_ROLL_MIN_MS,
        T3VoiceCueSettings.STARTUP_PRE_ROLL_MAX_MS,
      )
    val current = read()
    if (current.startupPreRollMs == clamped) return current
    return write(current.copy(startupPreRollMs = clamped, generation = current.generation + 1))
  }

  private fun write(next: T3VoiceCueSettings): T3VoiceCueSettings {
    check(
      preferences.edit()
        .putBoolean(KEY_ENABLED, next.enabled)
        .putInt(KEY_STARTUP_PRE_ROLL_MS, next.startupPreRollMs)
        .putLong(KEY_GENERATION, next.generation)
        .commit(),
    ) { "Could not persist voice cue settings." }
    return next
  }

  private companion object {
    const val PREFERENCES_NAME = "t3_voice_cue_settings"
    const val KEY_ENABLED = "enabled"
    const val KEY_STARTUP_PRE_ROLL_MS = "startup_pre_roll_ms"
    const val KEY_GENERATION = "generation"
  }
}
