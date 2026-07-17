package expo.modules.t3voice

internal fun T3VoiceControllerSnapshot.toBridgeBody(): Map<String, Any?> {
  val identity =
    mapOf(
      "generation" to generation.toDouble(),
      "sequence" to sequence.toDouble(),
    )
  val stateBody =
    when (val state = state) {
      T3VoiceControllerState.Idle -> mapOf("mode" to "idle")
      is T3VoiceControllerState.Realtime ->
        mapOf(
          "mode" to "realtime",
          "phase" to state.stage.bridgeName(),
          "target" to state.target.toBridgeBody(),
          "muted" to state.muted,
          "audioRoutes" to state.audioRoutes.map(T3VoiceAudioRoute::toResultBody),
          "transcript" to state.transcript.map(T3VoiceRealtimeTranscriptTurn::toBridgeBody),
          "pendingConfirmations" to
            state.pendingConfirmations.map(T3VoiceRealtimeConfirmation::toBridgeBody),
          "pendingClientActions" to
            state.pendingClientActions.map(T3VoiceRealtimeClientAction::toBridgeBody),
        )
      is T3VoiceControllerState.SwitchingToThread ->
        mapOf(
          "mode" to "switching-to-thread",
          "phase" to state.stage.bridgeName(),
          "target" to state.threadStart.target.toBridgeBody(),
          "settings" to state.threadStart.settings.toBridgeBody(),
        )
      is T3VoiceControllerState.Thread ->
        mapOf(
          "mode" to "thread",
          "phase" to state.stage.bridgeName(),
          "target" to state.target.toBridgeBody(),
          "settings" to state.settings.toBridgeBody(),
          "transcript" to state.transcript,
          "attention" to state.attention?.bridgeName(),
          "reviewId" to state.reviewId?.toDouble(),
        )
      is T3VoiceControllerState.Failed ->
        mapOf(
          "mode" to "failed",
          "environmentId" to state.environmentId,
          "operation" to state.operation.bridgeName(),
          "failure" to
            mapOf(
              "code" to state.failure.code,
              "message" to state.failure.message,
              "retryable" to state.failure.recoverable,
            ),
        )
    }
  return identity + stateBody
}

private fun T3VoiceRealtimeTarget.toBridgeBody(): Map<String, Any?> =
  mapOf(
    "environmentId" to environmentId,
    "conversation" to conversation.toBridgeBody(),
    "focus" to focus?.toBridgeBody(),
    "threadSwitch" to threadSwitch?.toBridgeBody(),
  )

private fun T3VoiceConversationSelection.toBridgeBody(): Map<String, Any?> =
  when (this) {
    is T3VoiceConversationSelection.New ->
      buildMap {
        put("type", "new")
        put("retention", retention.name.lowercase())
        if (title != null) put("title", title)
      }
    is T3VoiceConversationSelection.Continue ->
      mapOf(
        "type" to "continue",
        "conversationId" to conversationId,
        "takeover" to takeover,
      )
  }

private fun T3VoiceRealtimeFocus.toBridgeBody(): Map<String, Any> =
  mapOf(
    "projectId" to projectId,
    "threadId" to threadId,
  )

private fun T3VoiceThreadStart.toBridgeBody(): Map<String, Any?> =
  mapOf(
    "target" to target.toBridgeBody(),
    "settings" to settings.toBridgeBody(),
  )

private fun T3VoiceThreadTarget.toBridgeBody(): Map<String, Any> =
  mapOf(
    "environmentId" to environmentId,
    "projectId" to projectId,
    "threadId" to threadId,
    "modelSelection" to modelSelection.toCanonicalWireBody(),
    "runtimeMode" to runtimeMode.bridgeName(),
    "interactionMode" to interactionMode.name.lowercase(),
  )

private fun T3VoiceThreadSettings.toBridgeBody(): Map<String, Any?> =
  mapOf(
    "submission" to submissionPolicy.bridgeName(),
    "playResponses" to playResponses,
    "autoRearm" to autoRearm,
    "endpointDetection" to
      mapOf(
        "endSilenceMs" to endpointDetection.endSilenceMs.toDouble(),
        "noSpeechTimeoutMs" to endpointDetection.noSpeechTimeoutMs?.toDouble(),
        "maximumUtteranceMs" to endpointDetection.maximumUtteranceMs.toDouble(),
      ),
    "rearmDelayMs" to rearmDelayMs.toDouble(),
    "transcriptionTimeoutMs" to transcriptionTimeoutMs.toDouble(),
    "submissionTimeoutMs" to submissionTimeoutMs.toDouble(),
    "responseTimeoutMs" to responseTimeoutMs.toDouble(),
  )

private fun T3VoiceRealtimeTranscriptTurn.toBridgeBody(): Map<String, Any> =
  mapOf(
    "role" to role.name.lowercase(),
    "text" to text,
  )

private fun T3VoiceRealtimeConfirmation.toBridgeBody(): Map<String, Any> =
  mapOf(
    "confirmationId" to confirmationId,
    "tool" to tool.name.lowercase(),
    "summary" to summary,
    "expiresAt" to expiresAt,
  )

private fun T3VoiceRealtimeClientAction.toBridgeBody(): Map<String, Any> =
  mapOf(
    "action" to "activate-thread",
    "actionId" to actionId,
    "projectId" to projectId,
    "threadId" to threadId,
    "expiresAt" to expiresAt,
  )

private fun T3VoiceRealtimeStage.bridgeName(): String = name.lowercase()

private fun T3VoiceSwitchStage.bridgeName(): String = name.lowercase().replace('_', '-')

private fun T3VoiceThreadStage.bridgeName(): String =
  when (this) {
    T3VoiceThreadStage.UPLOADING -> "transcribing"
    else -> name.lowercase()
  }

private fun T3VoiceThreadRuntimeMode.bridgeName(): String = name.lowercase().replace('_', '-')

private fun T3VoiceThreadSubmissionPolicy.bridgeName(): String =
  name.lowercase().replace('_', '-')

private fun T3VoiceThreadAttention.bridgeName(): String = name.lowercase().replace('_', '-')

private fun T3VoiceOperation.bridgeName(): String = name.lowercase().replace('_', '-')
