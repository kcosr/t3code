package expo.modules.t3voice

import android.content.Context

internal sealed interface T3VoiceBackgroundRealtimeCleanupLoadResult {
  data object Missing : T3VoiceBackgroundRealtimeCleanupLoadResult

  data class Available(val marker: T3VoiceBackgroundRealtimeCleanupMarker) :
    T3VoiceBackgroundRealtimeCleanupLoadResult

  data object Locked : T3VoiceBackgroundRealtimeCleanupLoadResult
}

internal class T3VoiceBackgroundRealtimeCleanupStore(
  private val storage: T3VoiceBackgroundKeyValueStore,
) {
  constructor(context: Context) : this(T3VoiceBackgroundPreferences(context.applicationContext))

  @Synchronized
  fun write(marker: T3VoiceBackgroundRealtimeCleanupMarker) {
    when (val existing = load()) {
      T3VoiceBackgroundRealtimeCleanupLoadResult.Missing -> Unit
      is T3VoiceBackgroundRealtimeCleanupLoadResult.Available ->
        require(existing.marker == marker) {
          "A different native Realtime cleanup is already pending."
        }
      T3VoiceBackgroundRealtimeCleanupLoadResult.Locked ->
        error("Native Realtime cleanup state is locked.")
    }
    check(
      storage.put(
        mapOf(
          KEY_RUNTIME_ID to marker.runtimeId,
          KEY_GENERATION to marker.readinessGeneration.toString(),
          KEY_ORIGIN to T3VoiceBackgroundOriginPolicy.normalize(marker.environmentOrigin),
          KEY_OPERATION_ID to marker.operationId,
          KEY_CONVERSATION_ID to marker.conversationId,
        ),
      ),
    ) { "Could not persist native Realtime cleanup state." }
  }

  @Synchronized
  fun load(): T3VoiceBackgroundRealtimeCleanupLoadResult {
    val values = ALL_KEYS.associateWith(storage::getString)
    if (values.values.all { it === null }) return T3VoiceBackgroundRealtimeCleanupLoadResult.Missing
    if (values.values.any { it === null }) return T3VoiceBackgroundRealtimeCleanupLoadResult.Locked
    return runCatching {
      T3VoiceBackgroundRealtimeCleanupLoadResult.Available(
        T3VoiceBackgroundRealtimeCleanupMarker(
          runtimeId = values.getValue(KEY_RUNTIME_ID)!!,
          readinessGeneration = values.getValue(KEY_GENERATION)!!.toLong(),
          environmentOrigin = values.getValue(KEY_ORIGIN)!!,
          operationId = values.getValue(KEY_OPERATION_ID)!!,
          conversationId = values.getValue(KEY_CONVERSATION_ID)!!,
        ),
      )
    }.getOrDefault(T3VoiceBackgroundRealtimeCleanupLoadResult.Locked)
  }

  @Synchronized
  fun clear(expected: T3VoiceBackgroundRealtimeCleanupMarker? = null): Boolean {
    if (expected !== null) {
      val loaded = load()
      if (loaded !is T3VoiceBackgroundRealtimeCleanupLoadResult.Available || loaded.marker != expected) {
        return false
      }
    }
    check(storage.clear(ALL_KEYS)) { "Could not clear native Realtime cleanup state." }
    return true
  }

  private companion object {
    const val KEY_RUNTIME_ID = "realtime_cleanup_runtime_id"
    const val KEY_GENERATION = "realtime_cleanup_generation"
    const val KEY_ORIGIN = "realtime_cleanup_origin"
    const val KEY_OPERATION_ID = "realtime_cleanup_operation_id"
    const val KEY_CONVERSATION_ID = "realtime_cleanup_conversation_id"
    val ALL_KEYS =
      setOf(KEY_RUNTIME_ID, KEY_GENERATION, KEY_ORIGIN, KEY_OPERATION_ID, KEY_CONVERSATION_ID)
  }
}
