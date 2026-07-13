package expo.modules.t3voice

internal object T3VoiceBackgroundReducer {
  fun reduce(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent,
  ): T3VoiceBackgroundTransition =
    when (event) {
      is T3VoiceBackgroundEvent.AuthorityValidated -> validateAuthority(current, event)
      is T3VoiceBackgroundEvent.AuthorityLost -> loseAuthority(current, event.readinessGeneration)
      is T3VoiceBackgroundEvent.TargetReplaced ->
        loseAuthority(current, event.readinessGeneration)
      is T3VoiceBackgroundEvent.StartRealtime -> startRealtime(current, event)
      is T3VoiceBackgroundEvent.RealtimeConnected -> connectRealtime(current, event)
      is T3VoiceBackgroundEvent.StartRecording -> startRecording(current, event)
      is T3VoiceBackgroundEvent.RecordingFinalized -> finalizeRecording(current, event)
      is T3VoiceBackgroundEvent.UploadStarted -> beginUpload(current, event)
      is T3VoiceBackgroundEvent.ServerEvent -> applyServerEvent(current, event)
      is T3VoiceBackgroundEvent.PlaybackStarted -> startPlayback(current, event)
      is T3VoiceBackgroundEvent.PlaybackDrained -> drainPlayback(current, event)
      T3VoiceBackgroundEvent.NetworkRetry -> T3VoiceBackgroundRecovery.networkRetry(current)
      T3VoiceBackgroundEvent.ProcessRestored -> T3VoiceBackgroundRecovery.restoreProcess(current)
      T3VoiceBackgroundEvent.RearmGuardElapsed -> rearm(current)
      T3VoiceBackgroundEvent.Stop -> stop(current)
    }

  private fun validateAuthority(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.AuthorityValidated,
  ): T3VoiceBackgroundTransition {
    require(event.runtimeId.isNotBlank() && event.runtimeId.length <= 128)
    require(event.readinessGeneration > 0)
    if (event.readinessGeneration < current.readinessGeneration) return unchanged(current)
    if (
      event.readinessGeneration == current.readinessGeneration &&
        current.phase != T3VoiceBackgroundPhase.LOCKED
    ) {
      require(current.runtimeId == event.runtimeId && current.mode == event.mode) {
        "A readiness generation cannot change identity."
      }
      return T3VoiceBackgroundTransition(current.copy(autoRearm = event.autoRearm))
    }
    if (
      current.phase != T3VoiceBackgroundPhase.LOCKED &&
        current.runtimeId == event.runtimeId &&
        current.mode == event.mode
    ) {
      return T3VoiceBackgroundTransition(
        current.copy(
          readinessGeneration = event.readinessGeneration,
          autoRearm = event.autoRearm,
        ),
      )
    }
    val commands =
      if (current.phase == T3VoiceBackgroundPhase.LOCKED) emptyList() else shutdownCommands(current)
    return T3VoiceBackgroundTransition(
      T3VoiceBackgroundSnapshot(
        runtimeId = event.runtimeId,
        readinessGeneration = event.readinessGeneration,
        mode = event.mode,
        phase = T3VoiceBackgroundPhase.IDLE,
        autoRearm = event.autoRearm,
      ),
      commands,
    )
  }

  private fun loseAuthority(
    current: T3VoiceBackgroundSnapshot,
    generation: Long,
  ): T3VoiceBackgroundTransition {
    if (generation < current.readinessGeneration) return unchanged(current)
    val commands = shutdownCommands(current)
    return T3VoiceBackgroundTransition(T3VoiceBackgroundSnapshot(), commands)
  }

  private fun shutdownCommands(
    current: T3VoiceBackgroundSnapshot,
  ): List<T3VoiceBackgroundCommand> {
    val commands = mutableListOf<T3VoiceBackgroundCommand>()
    when (current.phase) {
      T3VoiceBackgroundPhase.REALTIME_STARTING,
      T3VoiceBackgroundPhase.REALTIME_ACTIVE,
      -> commands += T3VoiceBackgroundCommand.CLOSE_REALTIME
      T3VoiceBackgroundPhase.RECORDING -> commands += T3VoiceBackgroundCommand.CANCEL_RECORDING
      T3VoiceBackgroundPhase.PLAYING -> commands += T3VoiceBackgroundCommand.CANCEL_PLAYBACK
      else -> Unit
    }
    if (current.operationId !== null && current.mode == T3VoiceBackgroundMode.THREAD) {
      commands +=
        if (current.dispatchAcknowledged) {
          T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION
        } else {
          T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION
        }
    }
    if (
      current.recordingId !== null && current.phase != T3VoiceBackgroundPhase.RECORDING
    ) {
      commands += T3VoiceBackgroundCommand.DELETE_RECORDING
    }
    return commands.distinct()
  }

  private fun startRealtime(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.StartRealtime,
  ): T3VoiceBackgroundTransition {
    requireReady(current, T3VoiceBackgroundMode.REALTIME)
    require(current.phase == T3VoiceBackgroundPhase.IDLE)
    validateIdentifier(event.operationId)
    return T3VoiceBackgroundTransition(
      current.copy(
        phase = T3VoiceBackgroundPhase.REALTIME_STARTING,
        operationId = event.operationId,
        operationGeneration = current.readinessGeneration,
        terminalSummary = null,
      ),
      listOf(T3VoiceBackgroundCommand.START_REALTIME),
    )
  }

  private fun connectRealtime(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.RealtimeConnected,
  ): T3VoiceBackgroundTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(current.phase == T3VoiceBackgroundPhase.REALTIME_STARTING)
    return T3VoiceBackgroundTransition(current.copy(phase = T3VoiceBackgroundPhase.REALTIME_ACTIVE))
  }

  private fun startRecording(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.StartRecording,
  ): T3VoiceBackgroundTransition {
    requireReady(current, T3VoiceBackgroundMode.THREAD)
    require(
      current.phase == T3VoiceBackgroundPhase.IDLE ||
        current.phase == T3VoiceBackgroundPhase.REARMING,
    )
    validateIdentifier(event.operationId)
    validateIdentifier(event.recordingId)
    return T3VoiceBackgroundTransition(
      current.copy(
        phase = T3VoiceBackgroundPhase.RECORDING,
        operationId = event.operationId,
        operationGeneration = current.readinessGeneration,
        recordingId = event.recordingId,
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
        terminalSummary = null,
      ),
      listOf(T3VoiceBackgroundCommand.START_RECORDING),
    )
  }

  private fun finalizeRecording(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.RecordingFinalized,
  ): T3VoiceBackgroundTransition {
    if (event.operationId != current.operationId || event.recordingId != current.recordingId) {
      return unchanged(current)
    }
    require(current.phase == T3VoiceBackgroundPhase.RECORDING)
    return T3VoiceBackgroundTransition(
      current.copy(phase = T3VoiceBackgroundPhase.FINALIZED),
      listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING),
    )
  }

  private fun beginUpload(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.UploadStarted,
  ): T3VoiceBackgroundTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(current.phase == T3VoiceBackgroundPhase.FINALIZED)
    return T3VoiceBackgroundTransition(current.copy(phase = T3VoiceBackgroundPhase.UPLOADING))
  }

  private fun applyServerEvent(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.ServerEvent,
  ): T3VoiceBackgroundTransition {
    if (
      event.operationId != current.operationId ||
        event.operationGeneration != current.operationGeneration ||
        event.sequence <= current.eventCursor
    ) {
      return unchanged(current)
    }
    if (event.sequence != current.eventCursor + 1) {
      return T3VoiceBackgroundTransition(
        current,
        listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP),
      )
    }
    event.messageId?.let(::validateIdentifier)
    event.turnId?.let(::validateIdentifier)
    val segment = event.speechSegmentIndex
    require(!current.speechTerminal || segment === null) {
      "Speech segments cannot arrive after terminal speech state."
    }
    require(!event.noSpeech || (event.speechTerminal && segment === null && !event.finalSpeechSegment)) {
      "No-speech events must explicitly terminate an empty speech stream."
    }
    require(!event.speechTerminal || event.noSpeech || event.finalSpeechSegment || current.finalSpeechSegment !== null) {
      "Terminal speech events require a final segment or no-speech marker."
    }
    if (segment !== null) {
      require(segment in 0..MAXIMUM_SPEECH_SEGMENTS)
      if (segment > current.highestAdvertisedSpeechSegment + 1) {
        return T3VoiceBackgroundTransition(
          current,
          listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP),
        )
      }
      require(!event.finalSpeechSegment || segment >= current.highestAdvertisedSpeechSegment)
    } else {
      require(!event.finalSpeechSegment)
    }
    val becameDispatched = event.dispatchAcknowledged && !current.dispatchAcknowledged
    var next =
      current.copy(
        eventCursor = event.sequence,
        dispatchAcknowledged = current.dispatchAcknowledged || event.dispatchAcknowledged,
        recordingId = if (becameDispatched) null else current.recordingId,
        messageId = event.messageId ?: current.messageId,
        turnId = event.turnId ?: current.turnId,
        highestAdvertisedSpeechSegment =
          maxOf(current.highestAdvertisedSpeechSegment, segment ?: -1),
        finalSpeechSegment =
          if (event.finalSpeechSegment) segment else current.finalSpeechSegment,
        speechTerminal = current.speechTerminal || event.speechTerminal,
        noSpeech = current.noSpeech || event.noSpeech,
      )
    val commands = mutableListOf<T3VoiceBackgroundCommand>()
    if (segment !== null && segment > current.highestAdvertisedSpeechSegment) {
      commands += T3VoiceBackgroundCommand.FETCH_SPEECH_SEGMENT
    }
    next =
      when (event.phase) {
        T3VoiceBackgroundServerPhase.CREATED,
        T3VoiceBackgroundServerPhase.TRANSCRIBING,
        T3VoiceBackgroundServerPhase.DISPATCHING,
        -> next.copy(phase = T3VoiceBackgroundPhase.TRANSCRIBING)
        T3VoiceBackgroundServerPhase.WAITING,
        T3VoiceBackgroundServerPhase.SPEAKING,
        -> next.copy(
          phase =
            if (current.phase == T3VoiceBackgroundPhase.PLAYING) {
              T3VoiceBackgroundPhase.PLAYING
            } else {
              T3VoiceBackgroundPhase.WAITING
            },
        )
        T3VoiceBackgroundServerPhase.COMPLETED ->
          next.copy(
            responseTerminal = true,
            terminalSummary = T3VoiceBackgroundTerminalSummary.COMPLETED,
          )
        T3VoiceBackgroundServerPhase.ATTENTION_REQUIRED ->
          next.copy(
            phase = T3VoiceBackgroundPhase.ATTENTION_REQUIRED,
            responseTerminal = true,
            terminalSummary = T3VoiceBackgroundTerminalSummary.ATTENTION_REQUIRED,
          )
        T3VoiceBackgroundServerPhase.CANCELLED ->
          next.copy(
            phase = T3VoiceBackgroundPhase.FAILED,
            responseTerminal = true,
            terminalSummary = T3VoiceBackgroundTerminalSummary.CANCELLED,
          )
        T3VoiceBackgroundServerPhase.FAILED_RETRYABLE ->
          next.copy(
            phase = T3VoiceBackgroundPhase.FAILED,
            responseTerminal = true,
            terminalSummary = T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
          )
        T3VoiceBackgroundServerPhase.FAILED_PERMANENT ->
          next.copy(
            phase = T3VoiceBackgroundPhase.FAILED,
            responseTerminal = true,
            terminalSummary = T3VoiceBackgroundTerminalSummary.FAILED_PERMANENT,
          )
      }
    if (next.responseTerminal && next.noSpeech && !next.dispatchAcknowledged) {
      commands += T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION
      if (next.recordingId !== null) {
        commands += T3VoiceBackgroundCommand.DELETE_RECORDING
        next = next.copy(recordingId = null)
      }
    }
    if (next.speechFullyDrained() && next.phase != T3VoiceBackgroundPhase.ATTENTION_REQUIRED) {
      next = next.copy(phase = T3VoiceBackgroundPhase.PLAYBACK_DRAINED)
    }
    if (becameDispatched) {
      commands += T3VoiceBackgroundCommand.DELETE_RECORDING
    }
    return T3VoiceBackgroundTransition(next, commands.distinct())
  }

  private fun startPlayback(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.PlaybackStarted,
  ): T3VoiceBackgroundTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(event.segmentIndex == current.playbackCursor + 1)
    require(event.segmentIndex <= current.highestAdvertisedSpeechSegment)
    require(
      current.phase == T3VoiceBackgroundPhase.WAITING ||
        current.phase == T3VoiceBackgroundPhase.PLAYING,
    )
    return T3VoiceBackgroundTransition(current.copy(phase = T3VoiceBackgroundPhase.PLAYING))
  }

  private fun drainPlayback(
    current: T3VoiceBackgroundSnapshot,
    event: T3VoiceBackgroundEvent.PlaybackDrained,
  ): T3VoiceBackgroundTransition {
    if (event.operationId != current.operationId || event.segmentIndex <= current.playbackCursor) {
      return unchanged(current)
    }
    require(current.phase == T3VoiceBackgroundPhase.PLAYING)
    require(event.segmentIndex == current.playbackCursor + 1)
    require(event.segmentIndex <= current.highestAdvertisedSpeechSegment)
    var next =
      current.copy(
        phase = T3VoiceBackgroundPhase.WAITING,
        playbackCursor = event.segmentIndex,
      )
    val commands = mutableListOf<T3VoiceBackgroundCommand>()
    if (next.speechFullyDrained()) {
      next = next.copy(phase = T3VoiceBackgroundPhase.PLAYBACK_DRAINED)
    }
    return T3VoiceBackgroundTransition(next, commands)
  }

  private fun rearm(current: T3VoiceBackgroundSnapshot): T3VoiceBackgroundTransition {
    if (
      current.phase != T3VoiceBackgroundPhase.PLAYBACK_DRAINED ||
        !current.autoRearm ||
        !current.speechFullyDrained()
    ) {
      return unchanged(current)
    }
    return T3VoiceBackgroundTransition(
      current.copy(
        phase = T3VoiceBackgroundPhase.REARMING,
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
      ),
      listOf(T3VoiceBackgroundCommand.START_RECORDING),
    )
  }

  private fun stop(current: T3VoiceBackgroundSnapshot): T3VoiceBackgroundTransition {
    if (current.phase == T3VoiceBackgroundPhase.LOCKED) return unchanged(current)
    val commands = mutableListOf<T3VoiceBackgroundCommand>()
    when (current.phase) {
      T3VoiceBackgroundPhase.REALTIME_STARTING,
      T3VoiceBackgroundPhase.REALTIME_ACTIVE,
      -> commands += T3VoiceBackgroundCommand.CLOSE_REALTIME
      T3VoiceBackgroundPhase.RECORDING -> commands += T3VoiceBackgroundCommand.CANCEL_RECORDING
      T3VoiceBackgroundPhase.PLAYING -> commands += T3VoiceBackgroundCommand.CANCEL_PLAYBACK
      else -> Unit
    }
    if (current.operationId !== null && current.mode == T3VoiceBackgroundMode.THREAD) {
      commands +=
        if (current.dispatchAcknowledged) {
          T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION
        } else {
          T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION
        }
    }
    if (
      current.recordingId !== null && current.phase != T3VoiceBackgroundPhase.RECORDING
    ) {
      commands += T3VoiceBackgroundCommand.DELETE_RECORDING
    }
    return T3VoiceBackgroundTransition(
      current.copy(
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
        terminalSummary = T3VoiceBackgroundTerminalSummary.CANCELLED,
      ),
      commands.distinct(),
    )
  }

  private fun requireReady(current: T3VoiceBackgroundSnapshot, mode: T3VoiceBackgroundMode) {
    require(current.phase != T3VoiceBackgroundPhase.LOCKED && current.mode == mode)
  }

  private fun validateIdentifier(value: String) {
    require(value.isNotBlank() && value.length <= 128) { "Invalid background voice identifier." }
  }

  private fun unchanged(current: T3VoiceBackgroundSnapshot) =
    T3VoiceBackgroundTransition(current)

  private const val MAXIMUM_SPEECH_SEGMENTS = 10_000
}
