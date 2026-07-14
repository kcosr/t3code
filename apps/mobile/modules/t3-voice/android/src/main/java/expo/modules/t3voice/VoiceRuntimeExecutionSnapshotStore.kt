package expo.modules.t3voice

import android.content.Context

internal class VoiceRuntimeExecutionSnapshotStore(
  private val storage: VoiceRuntimeKeyValueStore,
) {
  constructor(context: Context) : this(VoiceRuntimePreferences(context.applicationContext))

  @Synchronized
  fun write(snapshot: VoiceRuntimeExecutionSnapshot) {
    check(
      storage.put(
        mapOf(
          KEY_RUNTIME_ID to snapshot.runtimeId,
          KEY_GENERATION to snapshot.readinessGeneration.toString(),
          KEY_MODE to snapshot.mode?.name,
          KEY_PHASE to snapshot.phase.name,
          KEY_OPERATION_ID to snapshot.operationId,
          KEY_OPERATION_GENERATION to snapshot.operationGeneration?.toString(),
          KEY_RECORDING_ID to snapshot.recordingId,
          KEY_DISPATCH_ACKNOWLEDGED to snapshot.dispatchAcknowledged.toString(),
          KEY_EVENT_CURSOR to snapshot.eventCursor.toString(),
          KEY_PLAYBACK_CURSOR to snapshot.playbackCursor.toString(),
          KEY_HIGHEST_SPEECH_SEGMENT to snapshot.highestAdvertisedSpeechSegment.toString(),
          KEY_FINAL_SPEECH_SEGMENT to snapshot.finalSpeechSegment?.toString(),
          KEY_SPEECH_TERMINAL to snapshot.speechTerminal.toString(),
          KEY_NO_SPEECH to snapshot.noSpeech.toString(),
          KEY_RESPONSE_TERMINAL to snapshot.responseTerminal.toString(),
          KEY_AUTO_REARM to snapshot.autoRearm.toString(),
          KEY_MESSAGE_ID to snapshot.messageId,
          KEY_TURN_ID to snapshot.turnId,
          KEY_TERMINAL_SUMMARY to snapshot.terminalSummary?.name,
        ),
      ),
    ) { "Could not persist the runtime voice snapshot." }
  }

  @Synchronized
  fun read(): VoiceRuntimeExecutionSnapshot {
    val phase = storage.getString(KEY_PHASE) ?: return VoiceRuntimeExecutionSnapshot()
    return try {
      VoiceRuntimeExecutionSnapshot(
        runtimeId = storage.getString(KEY_RUNTIME_ID),
        readinessGeneration = required(KEY_GENERATION).toLong(),
        mode = storage.getString(KEY_MODE)?.let(VoiceRuntimeExecutionMode::valueOf),
        phase = VoiceRuntimePhase.valueOf(phase),
        operationId = storage.getString(KEY_OPERATION_ID),
        operationGeneration = storage.getString(KEY_OPERATION_GENERATION)?.toLong(),
        recordingId = storage.getString(KEY_RECORDING_ID),
        dispatchAcknowledged = requiredBoolean(KEY_DISPATCH_ACKNOWLEDGED),
        eventCursor = required(KEY_EVENT_CURSOR).toLong(),
        playbackCursor = required(KEY_PLAYBACK_CURSOR).toInt(),
        highestAdvertisedSpeechSegment = required(KEY_HIGHEST_SPEECH_SEGMENT).toInt(),
        finalSpeechSegment = storage.getString(KEY_FINAL_SPEECH_SEGMENT)?.toInt(),
        speechTerminal = requiredBoolean(KEY_SPEECH_TERMINAL),
        noSpeech = requiredBoolean(KEY_NO_SPEECH),
        responseTerminal = requiredBoolean(KEY_RESPONSE_TERMINAL),
        autoRearm = requiredBoolean(KEY_AUTO_REARM),
        messageId = storage.getString(KEY_MESSAGE_ID),
        turnId = storage.getString(KEY_TURN_ID),
        terminalSummary =
          storage.getString(KEY_TERMINAL_SUMMARY)?.let(VoiceRuntimeTerminalSummary::valueOf),
      )
    } catch (_: Exception) {
      clear()
      VoiceRuntimeExecutionSnapshot()
    }
  }

  @Synchronized
  fun clear() {
    check(storage.clear(ALL_KEYS)) { "Could not clear the runtime voice snapshot." }
  }

  private fun required(key: String): String =
    checkNotNull(storage.getString(key)) { "Missing runtime voice snapshot field." }

  private fun requiredBoolean(key: String): Boolean =
    when (val value = required(key)) {
      "true" -> true
      "false" -> false
      else -> error("Invalid runtime voice snapshot boolean: $value")
    }

  private companion object {
    const val KEY_RUNTIME_ID = "snapshot_runtime_id"
    const val KEY_GENERATION = "snapshot_generation"
    const val KEY_MODE = "snapshot_mode"
    const val KEY_PHASE = "snapshot_phase"
    const val KEY_OPERATION_ID = "snapshot_operation_id"
    const val KEY_OPERATION_GENERATION = "snapshot_operation_generation"
    const val KEY_RECORDING_ID = "snapshot_recording_id"
    const val KEY_DISPATCH_ACKNOWLEDGED = "snapshot_dispatch_acknowledged"
    const val KEY_EVENT_CURSOR = "snapshot_event_cursor"
    const val KEY_PLAYBACK_CURSOR = "snapshot_playback_cursor"
    const val KEY_HIGHEST_SPEECH_SEGMENT = "snapshot_highest_speech_segment"
    const val KEY_FINAL_SPEECH_SEGMENT = "snapshot_final_speech_segment"
    const val KEY_SPEECH_TERMINAL = "snapshot_speech_terminal"
    const val KEY_NO_SPEECH = "snapshot_no_speech"
    const val KEY_RESPONSE_TERMINAL = "snapshot_response_terminal"
    const val KEY_AUTO_REARM = "snapshot_auto_rearm"
    const val KEY_MESSAGE_ID = "snapshot_message_id"
    const val KEY_TURN_ID = "snapshot_turn_id"
    const val KEY_TERMINAL_SUMMARY = "snapshot_terminal_summary"
    val ALL_KEYS =
      setOf(
        KEY_RUNTIME_ID,
        KEY_GENERATION,
        KEY_MODE,
        KEY_PHASE,
        KEY_OPERATION_ID,
        KEY_OPERATION_GENERATION,
        KEY_RECORDING_ID,
        KEY_DISPATCH_ACKNOWLEDGED,
        KEY_EVENT_CURSOR,
        KEY_PLAYBACK_CURSOR,
        KEY_HIGHEST_SPEECH_SEGMENT,
        KEY_FINAL_SPEECH_SEGMENT,
        KEY_SPEECH_TERMINAL,
        KEY_NO_SPEECH,
        KEY_RESPONSE_TERMINAL,
        KEY_AUTO_REARM,
        KEY_MESSAGE_ID,
        KEY_TURN_ID,
        KEY_TERMINAL_SUMMARY,
      )
  }
}
