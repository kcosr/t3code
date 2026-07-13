package expo.modules.t3voice

import android.content.Context

internal data class T3VoiceCueSettings(
  val enabled: Boolean = true,
  val generation: Long = 0,
)

internal class T3VoiceCueSettingsStore(context: Context) {
  private val preferences =
    context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

  fun read(): T3VoiceCueSettings =
    T3VoiceCueSettings(
      enabled = preferences.getBoolean(KEY_ENABLED, true),
      generation = preferences.getLong(KEY_GENERATION, 0),
    )

  fun write(enabled: Boolean): T3VoiceCueSettings {
    val current = read()
    if (current.enabled == enabled) return current
    val next = current.copy(enabled = enabled, generation = current.generation + 1)
    check(
      preferences.edit()
        .putBoolean(KEY_ENABLED, next.enabled)
        .putLong(KEY_GENERATION, next.generation)
        .commit(),
    ) { "Could not persist voice cue settings." }
    return next
  }

  private companion object {
    const val PREFERENCES_NAME = "t3_voice_cue_settings"
    const val KEY_ENABLED = "enabled"
    const val KEY_GENERATION = "generation"
  }
}
