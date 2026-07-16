package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeSpeechDisposition

internal object VoiceRuntimeExecutionRecovery {
  fun networkRetry(current: VoiceRuntimeExecutionSnapshot): VoiceRuntimeExecutionTransition =
    when {
      !current.dispatchAcknowledged &&
        current.recordingId !== null &&
        (current.phase == VoiceRuntimePhase.UPLOADING ||
          current.phase == VoiceRuntimePhase.FAILED) ->
        VoiceRuntimeExecutionTransition(
          current.copy(
            phase = VoiceRuntimePhase.FINALIZED,
            responseTerminal = false,
            terminalSummary = null,
          ),
          listOf(VoiceRuntimeCommand.UPLOAD_RECORDING),
        )
      current.operationId !== null && current.eventCursor >= 0 ->
        VoiceRuntimeExecutionTransition(
          current,
          listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP),
        )
      else -> unchanged(current)
    }

  fun restoreProcess(current: VoiceRuntimeExecutionSnapshot): VoiceRuntimeExecutionTransition =
    when (current.phase) {
      VoiceRuntimePhase.LOCKED,
      VoiceRuntimePhase.IDLE,
      -> unchanged(current)
      VoiceRuntimePhase.REALTIME_STARTING,
      VoiceRuntimePhase.REALTIME_ACTIVE,
      ->
        VoiceRuntimeExecutionTransition(
          current.copy(
            phase = VoiceRuntimePhase.IDLE,
            operationId = null,
            operationGeneration = null,
          ),
          listOf(VoiceRuntimeCommand.RESTART_REALTIME),
        )
      VoiceRuntimePhase.RECORDING ->
        VoiceRuntimeExecutionTransition(
          idleAfterOperation(current, VoiceRuntimeTerminalSummary.CANCELLED),
          listOf(
            VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION,
            VoiceRuntimeCommand.DELETE_RECORDING,
          ),
        )
      VoiceRuntimePhase.FINALIZED,
      VoiceRuntimePhase.UPLOADING,
      VoiceRuntimePhase.TRANSCRIBING,
      -> recoverThreadOperation(current)
      VoiceRuntimePhase.WAITING,
      VoiceRuntimePhase.PLAYING,
      VoiceRuntimePhase.FAILED,
      -> recoverThreadOperation(current)
      VoiceRuntimePhase.PLAYBACK_DRAINED ->
        VoiceRuntimeExecutionTransition(
          current,
          if (current.autoRearm) {
            listOf(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD)
          } else {
            emptyList()
          },
        )
      VoiceRuntimePhase.REARMING ->
        VoiceRuntimeExecutionTransition(
          current,
          listOf(VoiceRuntimeCommand.START_RECORDING),
        )
      VoiceRuntimePhase.ATTENTION_REQUIRED -> unchanged(current)
    }

  private fun recoverThreadOperation(
    current: VoiceRuntimeExecutionSnapshot,
  ): VoiceRuntimeExecutionTransition {
    if (!current.dispatchAcknowledged && current.recordingId !== null) {
      return VoiceRuntimeExecutionTransition(
        current.copy(
          phase = VoiceRuntimePhase.FINALIZED,
          responseTerminal = false,
          terminalSummary = null,
        ),
        listOf(VoiceRuntimeCommand.UPLOAD_RECORDING),
      )
    }
    if (!current.dispatchAcknowledged) {
      return VoiceRuntimeExecutionTransition(
        idleAfterOperation(current, VoiceRuntimeTerminalSummary.FAILED_RETRYABLE),
        listOf(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION),
      )
    }
    val commands = mutableListOf(VoiceRuntimeCommand.FETCH_EVENT_GAP)
    var next = current
    if (current.phase == VoiceRuntimePhase.PLAYING) {
      val interruptedSegment = current.highestStartedSpeechSegment
      require(interruptedSegment == current.playbackCursor + 1)
      next = current.copy(
        phase = VoiceRuntimePhase.WAITING,
        playbackCursor = interruptedSegment,
        speechSegmentDispositions = current.speechSegmentDispositions +
          VoiceRuntimeSpeechDisposition(interruptedSegment, "interrupted"),
      )
      commands += VoiceRuntimeCommand.FETCH_SPEECH_SEGMENT
    }
    return VoiceRuntimeExecutionTransition(next, commands.distinct())
  }

  private fun unchanged(current: VoiceRuntimeExecutionSnapshot) =
    VoiceRuntimeExecutionTransition(current)
}

internal fun idleAfterOperation(
  snapshot: VoiceRuntimeExecutionSnapshot,
  summary: VoiceRuntimeTerminalSummary,
): VoiceRuntimeExecutionSnapshot =
  snapshot.copy(
    phase = VoiceRuntimePhase.IDLE,
    operationId = null,
    operationGeneration = null,
    recordingId = null,
    dispatchAcknowledged = false,
    eventCursor = 0,
    playbackCursor = -1,
    highestAdvertisedSpeechSegment = -1,
    highestStartedSpeechSegment = -1,
    highestDrainedSpeechSegment = -1,
    speechSegmentDispositions = emptyList(),
    finalSpeechSegment = null,
    speechTerminal = false,
    noSpeech = false,
    responseTerminal = false,
    messageId = null,
    turnId = null,
    terminalSummary = summary,
  )
