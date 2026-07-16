package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeSpeechDisposition

internal object VoiceRuntimeExecutionReducer {
  fun reduce(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent,
  ): VoiceRuntimeExecutionTransition =
    when (event) {
      is VoiceRuntimeExecutionEvent.AuthorityValidated -> validateAuthority(current, event)
      is VoiceRuntimeExecutionEvent.AuthorityLost -> loseAuthority(current, event.readinessGeneration)
      is VoiceRuntimeExecutionEvent.TargetReplaced ->
        loseAuthority(current, event.readinessGeneration)
      is VoiceRuntimeExecutionEvent.StartRealtime -> startRealtime(current, event)
      is VoiceRuntimeExecutionEvent.RealtimeConnected -> connectRealtime(current, event)
      is VoiceRuntimeExecutionEvent.StartRecording -> startRecording(current, event)
      is VoiceRuntimeExecutionEvent.RecordingFinalized -> finalizeRecording(current, event)
      is VoiceRuntimeExecutionEvent.UploadStarted -> beginUpload(current, event)
      is VoiceRuntimeExecutionEvent.ServerEvent -> applyServerEvent(current, event)
      is VoiceRuntimeExecutionEvent.PlaybackStarted -> startPlayback(current, event)
      is VoiceRuntimeExecutionEvent.PlaybackDrained -> drainPlayback(current, event)
      is VoiceRuntimeExecutionEvent.PlaybackFailed -> failPlayback(current, event)
      VoiceRuntimeExecutionEvent.NetworkRetry -> VoiceRuntimeExecutionRecovery.networkRetry(current)
      VoiceRuntimeExecutionEvent.ProcessRestored -> VoiceRuntimeExecutionRecovery.restoreProcess(current)
      VoiceRuntimeExecutionEvent.RearmGuardElapsed -> rearm(current)
      VoiceRuntimeExecutionEvent.Stop -> stop(current)
    }

  private fun validateAuthority(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.AuthorityValidated,
  ): VoiceRuntimeExecutionTransition {
    require(event.runtimeId.isNotBlank() && event.runtimeId.length <= 128)
    require(event.readinessGeneration > 0)
    if (event.readinessGeneration < current.readinessGeneration) return unchanged(current)
    if (
      event.readinessGeneration == current.readinessGeneration &&
        current.phase != VoiceRuntimePhase.LOCKED
    ) {
      require(current.runtimeId == event.runtimeId && current.mode == event.mode) {
        "A readiness generation cannot change identity."
      }
      return VoiceRuntimeExecutionTransition(current.copy(autoRearm = event.autoRearm))
    }
    if (
      current.phase != VoiceRuntimePhase.LOCKED &&
        current.runtimeId == event.runtimeId &&
        current.mode == event.mode
    ) {
      return VoiceRuntimeExecutionTransition(
        current.copy(
          readinessGeneration = event.readinessGeneration,
          autoRearm = event.autoRearm,
        ),
      )
    }
    val commands =
      if (current.phase == VoiceRuntimePhase.LOCKED) emptyList() else shutdownCommands(current)
    return VoiceRuntimeExecutionTransition(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = event.runtimeId,
        readinessGeneration = event.readinessGeneration,
        mode = event.mode,
        phase = VoiceRuntimePhase.IDLE,
        autoRearm = event.autoRearm,
      ),
      commands,
    )
  }

  private fun loseAuthority(
    current: VoiceRuntimeExecutionSnapshot,
    generation: Long,
  ): VoiceRuntimeExecutionTransition {
    if (generation < current.readinessGeneration) return unchanged(current)
    val commands = shutdownCommands(current)
    return VoiceRuntimeExecutionTransition(VoiceRuntimeExecutionSnapshot(), commands)
  }

  private fun shutdownCommands(
    current: VoiceRuntimeExecutionSnapshot,
  ): List<VoiceRuntimeCommand> {
    val commands = mutableListOf<VoiceRuntimeCommand>()
    when (current.phase) {
      VoiceRuntimePhase.REALTIME_STARTING,
      VoiceRuntimePhase.REALTIME_ACTIVE,
      -> commands += VoiceRuntimeCommand.CLOSE_REALTIME
      VoiceRuntimePhase.RECORDING -> commands += VoiceRuntimeCommand.CANCEL_RECORDING
      VoiceRuntimePhase.PLAYING -> commands += VoiceRuntimeCommand.CANCEL_PLAYBACK
      else -> Unit
    }
    if (current.operationId !== null && current.mode == VoiceRuntimeExecutionMode.THREAD) {
      commands +=
        if (current.dispatchAcknowledged) {
          VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION
        } else {
          VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION
        }
    }
    if (
      current.recordingId !== null && current.phase != VoiceRuntimePhase.RECORDING
    ) {
      commands += VoiceRuntimeCommand.DELETE_RECORDING
    }
    return commands.distinct()
  }

  private fun startRealtime(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.StartRealtime,
  ): VoiceRuntimeExecutionTransition {
    requireReady(current, VoiceRuntimeExecutionMode.REALTIME)
    require(current.phase == VoiceRuntimePhase.IDLE)
    validateIdentifier(event.operationId)
    return VoiceRuntimeExecutionTransition(
      current.copy(
        phase = VoiceRuntimePhase.REALTIME_STARTING,
        operationId = event.operationId,
        operationGeneration = current.readinessGeneration,
        terminalSummary = null,
      ),
      listOf(VoiceRuntimeCommand.START_REALTIME),
    )
  }

  private fun connectRealtime(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.RealtimeConnected,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(current.phase == VoiceRuntimePhase.REALTIME_STARTING)
    return VoiceRuntimeExecutionTransition(current.copy(phase = VoiceRuntimePhase.REALTIME_ACTIVE))
  }

  private fun startRecording(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.StartRecording,
  ): VoiceRuntimeExecutionTransition {
    requireReady(current, VoiceRuntimeExecutionMode.THREAD)
    require(
      current.phase == VoiceRuntimePhase.IDLE ||
        current.phase == VoiceRuntimePhase.REARMING,
    )
    validateIdentifier(event.operationId)
    validateIdentifier(event.recordingId)
    return VoiceRuntimeExecutionTransition(
      current.copy(
        phase = VoiceRuntimePhase.RECORDING,
        operationId = event.operationId,
        operationGeneration = current.readinessGeneration,
        recordingId = event.recordingId,
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
        terminalSummary = null,
      ),
      listOf(VoiceRuntimeCommand.START_RECORDING),
    )
  }

  private fun finalizeRecording(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.RecordingFinalized,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId || event.recordingId != current.recordingId) {
      return unchanged(current)
    }
    require(current.phase == VoiceRuntimePhase.RECORDING)
    return VoiceRuntimeExecutionTransition(
      current.copy(phase = VoiceRuntimePhase.FINALIZED),
      listOf(VoiceRuntimeCommand.UPLOAD_RECORDING),
    )
  }

  private fun beginUpload(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.UploadStarted,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(current.phase == VoiceRuntimePhase.FINALIZED)
    return VoiceRuntimeExecutionTransition(current.copy(phase = VoiceRuntimePhase.UPLOADING))
  }

  private fun applyServerEvent(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.ServerEvent,
  ): VoiceRuntimeExecutionTransition {
    if (
      event.operationId != current.operationId ||
        event.operationGeneration != current.operationGeneration ||
        event.sequence <= current.eventCursor
    ) {
      return unchanged(current)
    }
    if (event.sequence != current.eventCursor + 1) {
      return VoiceRuntimeExecutionTransition(
        current,
        listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP),
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
        return VoiceRuntimeExecutionTransition(
          current,
          listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP),
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
    val commands = mutableListOf<VoiceRuntimeCommand>()
    if (segment !== null && segment > current.highestAdvertisedSpeechSegment) {
      commands += VoiceRuntimeCommand.FETCH_SPEECH_SEGMENT
    }
    next =
      when (event.phase) {
        VoiceRuntimeServerPhase.CREATED,
        VoiceRuntimeServerPhase.TRANSCRIBING,
        VoiceRuntimeServerPhase.DISPATCHING,
        -> next.copy(phase = VoiceRuntimePhase.TRANSCRIBING)
        VoiceRuntimeServerPhase.WAITING,
        VoiceRuntimeServerPhase.SPEAKING,
        -> next.copy(
          phase =
            if (current.phase == VoiceRuntimePhase.PLAYING) {
              VoiceRuntimePhase.PLAYING
            } else {
              VoiceRuntimePhase.WAITING
            },
        )
        VoiceRuntimeServerPhase.COMPLETED ->
          next.copy(
            responseTerminal = true,
            terminalSummary = VoiceRuntimeTerminalSummary.COMPLETED,
          )
        VoiceRuntimeServerPhase.ATTENTION_REQUIRED ->
          next.copy(
            phase = VoiceRuntimePhase.ATTENTION_REQUIRED,
            responseTerminal = true,
            terminalSummary = VoiceRuntimeTerminalSummary.ATTENTION_REQUIRED,
          )
        VoiceRuntimeServerPhase.CANCELLED ->
          next.copy(
            phase = VoiceRuntimePhase.FAILED,
            responseTerminal = true,
            terminalSummary = VoiceRuntimeTerminalSummary.CANCELLED,
          )
        VoiceRuntimeServerPhase.FAILED_RETRYABLE ->
          next.copy(
            phase = VoiceRuntimePhase.FAILED,
            responseTerminal = true,
            terminalSummary = VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
          )
        VoiceRuntimeServerPhase.FAILED_PERMANENT ->
          next.copy(
            phase = VoiceRuntimePhase.FAILED,
            responseTerminal = true,
            terminalSummary = VoiceRuntimeTerminalSummary.FAILED_PERMANENT,
          )
      }
    if (next.responseTerminal && next.noSpeech && !next.dispatchAcknowledged) {
      commands += VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION
      if (next.recordingId !== null) {
        commands += VoiceRuntimeCommand.DELETE_RECORDING
        next = next.copy(recordingId = null)
      }
    }
    if (next.speechFullyDrained() && next.phase != VoiceRuntimePhase.ATTENTION_REQUIRED) {
      next = next.copy(phase = VoiceRuntimePhase.PLAYBACK_DRAINED)
    }
    if (becameDispatched) {
      commands += VoiceRuntimeCommand.DELETE_RECORDING
    }
    return VoiceRuntimeExecutionTransition(next, commands.distinct())
  }

  private fun startPlayback(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.PlaybackStarted,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId) return unchanged(current)
    require(event.segmentIndex == current.playbackCursor + 1)
    require(event.segmentIndex <= current.highestAdvertisedSpeechSegment)
    require(
      current.phase == VoiceRuntimePhase.WAITING ||
        current.phase == VoiceRuntimePhase.PLAYING,
    )
    return VoiceRuntimeExecutionTransition(
      current.copy(
        phase = VoiceRuntimePhase.PLAYING,
        highestStartedSpeechSegment = event.segmentIndex,
      ),
    )
  }

  private fun drainPlayback(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.PlaybackDrained,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId || event.segmentIndex <= current.playbackCursor) {
      return unchanged(current)
    }
    require(current.phase == VoiceRuntimePhase.PLAYING)
    require(event.segmentIndex == current.playbackCursor + 1)
    require(event.segmentIndex <= current.highestAdvertisedSpeechSegment)
    val dispositions = current.speechSegmentDispositions +
      VoiceRuntimeSpeechDisposition(event.segmentIndex, "drained")
    var next = current.copy(
      phase = VoiceRuntimePhase.WAITING,
      playbackCursor = event.segmentIndex,
      highestDrainedSpeechSegment = event.segmentIndex,
      speechSegmentDispositions = dispositions,
    )
    val commands = mutableListOf<VoiceRuntimeCommand>()
    if (next.speechFullyDrained()) {
      next = next.copy(phase = VoiceRuntimePhase.PLAYBACK_DRAINED)
    }
    return VoiceRuntimeExecutionTransition(next, commands)
  }

  private fun failPlayback(
    current: VoiceRuntimeExecutionSnapshot,
    event: VoiceRuntimeExecutionEvent.PlaybackFailed,
  ): VoiceRuntimeExecutionTransition {
    if (event.operationId != current.operationId || event.segmentIndex <= current.playbackCursor) {
      return unchanged(current)
    }
    require(current.phase == VoiceRuntimePhase.PLAYING)
    require(event.segmentIndex == current.playbackCursor + 1)
    require(event.segmentIndex == current.highestStartedSpeechSegment)
    return VoiceRuntimeExecutionTransition(
      current.copy(
        phase = VoiceRuntimePhase.WAITING,
        playbackCursor = event.segmentIndex,
        speechSegmentDispositions = current.speechSegmentDispositions +
          VoiceRuntimeSpeechDisposition(event.segmentIndex, "failed"),
      ),
    )
  }

  private fun rearm(current: VoiceRuntimeExecutionSnapshot): VoiceRuntimeExecutionTransition {
    if (
      current.phase != VoiceRuntimePhase.PLAYBACK_DRAINED ||
        !current.autoRearm ||
        !current.speechFullyDrained()
    ) {
      return unchanged(current)
    }
    return VoiceRuntimeExecutionTransition(
      current.copy(
        phase = VoiceRuntimePhase.REARMING,
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
      ),
      listOf(VoiceRuntimeCommand.START_RECORDING),
    )
  }

  private fun stop(current: VoiceRuntimeExecutionSnapshot): VoiceRuntimeExecutionTransition {
    if (current.phase == VoiceRuntimePhase.LOCKED) return unchanged(current)
    val commands = mutableListOf<VoiceRuntimeCommand>()
    when (current.phase) {
      VoiceRuntimePhase.REALTIME_STARTING,
      VoiceRuntimePhase.REALTIME_ACTIVE,
      -> commands += VoiceRuntimeCommand.CLOSE_REALTIME
      VoiceRuntimePhase.RECORDING -> commands += VoiceRuntimeCommand.CANCEL_RECORDING
      VoiceRuntimePhase.PLAYING -> commands += VoiceRuntimeCommand.CANCEL_PLAYBACK
      else -> Unit
    }
    if (current.operationId !== null && current.mode == VoiceRuntimeExecutionMode.THREAD) {
      commands +=
        if (current.dispatchAcknowledged) {
          VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION
        } else {
          VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION
        }
    }
    if (
      current.recordingId !== null && current.phase != VoiceRuntimePhase.RECORDING
    ) {
      commands += VoiceRuntimeCommand.DELETE_RECORDING
    }
    return VoiceRuntimeExecutionTransition(
      current.copy(
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
        terminalSummary = VoiceRuntimeTerminalSummary.CANCELLED,
      ),
      commands.distinct(),
    )
  }

  private fun requireReady(current: VoiceRuntimeExecutionSnapshot, mode: VoiceRuntimeExecutionMode) {
    require(current.phase != VoiceRuntimePhase.LOCKED && current.mode == mode)
  }

  private fun validateIdentifier(value: String) {
    require(value.isNotBlank() && value.length <= 128) { "Invalid runtime voice identifier." }
  }

  private fun unchanged(current: VoiceRuntimeExecutionSnapshot) =
    VoiceRuntimeExecutionTransition(current)

  private const val MAXIMUM_SPEECH_SEGMENTS = 10_000
}
