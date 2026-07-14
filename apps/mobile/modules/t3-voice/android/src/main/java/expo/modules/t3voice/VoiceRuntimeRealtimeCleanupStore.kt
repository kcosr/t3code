package expo.modules.t3voice

import android.content.Context

internal sealed interface VoiceRuntimeRealtimeCleanupLoadResult {
  data object Missing : VoiceRuntimeRealtimeCleanupLoadResult

  data class Available(val marker: VoiceRuntimeRealtimeCleanupMarker) :
    VoiceRuntimeRealtimeCleanupLoadResult

  data object Locked : VoiceRuntimeRealtimeCleanupLoadResult
}

internal class VoiceRuntimeRealtimeCleanupStore(
  private val storage: VoiceRuntimeKeyValueStore,
) {
  constructor(context: Context) : this(VoiceRuntimePreferences(context.applicationContext))

  @Synchronized
  fun write(marker: VoiceRuntimeRealtimeCleanupMarker) {
    when (val existing = load()) {
      VoiceRuntimeRealtimeCleanupLoadResult.Missing -> Unit
      is VoiceRuntimeRealtimeCleanupLoadResult.Available ->
        require(existing.marker == marker) {
          "A different native Realtime cleanup is already pending."
        }
      VoiceRuntimeRealtimeCleanupLoadResult.Locked ->
        error("Native Realtime cleanup state is locked.")
    }
    check(
      storage.put(
        mapOf(
          KEY_RUNTIME_ID to marker.runtimeId,
          KEY_GENERATION to marker.readinessGeneration.toString(),
          KEY_ORIGIN to VoiceRuntimeOriginPolicy.normalize(marker.environmentOrigin),
          KEY_OPERATION_ID to marker.operationId,
          KEY_CONVERSATION_ID to marker.conversationId,
        ),
      ),
    ) { "Could not persist native Realtime cleanup state." }
  }

  @Synchronized
  fun load(): VoiceRuntimeRealtimeCleanupLoadResult {
    val values = ALL_KEYS.associateWith(storage::getString)
    if (values.values.all { it === null }) return VoiceRuntimeRealtimeCleanupLoadResult.Missing
    if (values.values.any { it === null }) return VoiceRuntimeRealtimeCleanupLoadResult.Locked
    return runCatching {
      VoiceRuntimeRealtimeCleanupLoadResult.Available(
        VoiceRuntimeRealtimeCleanupMarker(
          runtimeId = values.getValue(KEY_RUNTIME_ID)!!,
          readinessGeneration = values.getValue(KEY_GENERATION)!!.toLong(),
          environmentOrigin = values.getValue(KEY_ORIGIN)!!,
          operationId = values.getValue(KEY_OPERATION_ID)!!,
          conversationId = values.getValue(KEY_CONVERSATION_ID)!!,
        ),
      )
    }.getOrDefault(VoiceRuntimeRealtimeCleanupLoadResult.Locked)
  }

  @Synchronized
  fun clear(expected: VoiceRuntimeRealtimeCleanupMarker? = null): Boolean {
    if (expected !== null) {
      val loaded = load()
      if (loaded !is VoiceRuntimeRealtimeCleanupLoadResult.Available || loaded.marker != expected) {
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
