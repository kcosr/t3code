package expo.modules.t3voice

internal object T3VoiceBackgroundRecovery {
  fun networkRetry(current: T3VoiceBackgroundSnapshot): T3VoiceBackgroundTransition =
    when {
      !current.dispatchAcknowledged &&
        current.recordingId !== null &&
        (current.phase == T3VoiceBackgroundPhase.UPLOADING ||
          current.phase == T3VoiceBackgroundPhase.FAILED) ->
        T3VoiceBackgroundTransition(
          current.copy(
            phase = T3VoiceBackgroundPhase.FINALIZED,
            responseTerminal = false,
            terminalSummary = null,
          ),
          listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING),
        )
      current.operationId !== null && current.eventCursor >= 0 ->
        T3VoiceBackgroundTransition(
          current,
          listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP),
        )
      else -> unchanged(current)
    }

  fun restoreProcess(current: T3VoiceBackgroundSnapshot): T3VoiceBackgroundTransition =
    when (current.phase) {
      T3VoiceBackgroundPhase.LOCKED,
      T3VoiceBackgroundPhase.IDLE,
      -> unchanged(current)
      T3VoiceBackgroundPhase.REALTIME_STARTING,
      T3VoiceBackgroundPhase.REALTIME_ACTIVE,
      ->
        T3VoiceBackgroundTransition(
          current.copy(
            phase = T3VoiceBackgroundPhase.IDLE,
            operationId = null,
            operationGeneration = null,
          ),
          listOf(T3VoiceBackgroundCommand.RESTART_REALTIME),
        )
      T3VoiceBackgroundPhase.RECORDING ->
        T3VoiceBackgroundTransition(
          idleAfterOperation(current, T3VoiceBackgroundTerminalSummary.CANCELLED),
          listOf(
            T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION,
            T3VoiceBackgroundCommand.DELETE_RECORDING,
          ),
        )
      T3VoiceBackgroundPhase.FINALIZED,
      T3VoiceBackgroundPhase.UPLOADING,
      T3VoiceBackgroundPhase.TRANSCRIBING,
      -> recoverThreadOperation(current)
      T3VoiceBackgroundPhase.WAITING,
      T3VoiceBackgroundPhase.PLAYING,
      T3VoiceBackgroundPhase.FAILED,
      -> recoverThreadOperation(current)
      T3VoiceBackgroundPhase.PLAYBACK_DRAINED ->
        T3VoiceBackgroundTransition(
          current,
          if (current.autoRearm) {
            listOf(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD)
          } else {
            emptyList()
          },
        )
      T3VoiceBackgroundPhase.REARMING ->
        T3VoiceBackgroundTransition(
          current,
          listOf(T3VoiceBackgroundCommand.START_RECORDING),
        )
      T3VoiceBackgroundPhase.ATTENTION_REQUIRED -> unchanged(current)
    }

  private fun recoverThreadOperation(
    current: T3VoiceBackgroundSnapshot,
  ): T3VoiceBackgroundTransition {
    if (!current.dispatchAcknowledged && current.recordingId !== null) {
      return T3VoiceBackgroundTransition(
        current.copy(
          phase = T3VoiceBackgroundPhase.FINALIZED,
          responseTerminal = false,
          terminalSummary = null,
        ),
        listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING),
      )
    }
    if (!current.dispatchAcknowledged) {
      return T3VoiceBackgroundTransition(
        idleAfterOperation(current, T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE),
        listOf(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION),
      )
    }
    val commands = mutableListOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP)
    var next = current
    if (current.phase == T3VoiceBackgroundPhase.PLAYING) {
      next = current.copy(phase = T3VoiceBackgroundPhase.WAITING)
      commands += T3VoiceBackgroundCommand.FETCH_SPEECH_SEGMENT
    }
    return T3VoiceBackgroundTransition(next, commands.distinct())
  }

  private fun unchanged(current: T3VoiceBackgroundSnapshot) =
    T3VoiceBackgroundTransition(current)
}

internal fun idleAfterOperation(
  snapshot: T3VoiceBackgroundSnapshot,
  summary: T3VoiceBackgroundTerminalSummary,
): T3VoiceBackgroundSnapshot =
  snapshot.copy(
    phase = T3VoiceBackgroundPhase.IDLE,
    operationId = null,
    operationGeneration = null,
    recordingId = null,
    dispatchAcknowledged = false,
    eventCursor = 0,
    playbackCursor = -1,
    highestAdvertisedSpeechSegment = -1,
    finalSpeechSegment = null,
    speechTerminal = false,
    noSpeech = false,
    responseTerminal = false,
    messageId = null,
    turnId = null,
    terminalSummary = summary,
  )
