package expo.modules.t3voice

/** Strict conversion from the Expo/JavaScript bridge shape into native runtime commands. */
internal object T3VoiceRuntimeBridgeInput {
  fun startRealtime(input: Map<String, Any?>): T3VoiceRuntimeCommand.StartRealtime {
    input.requireExactBridgeKeys("startRealtime", setOf("target", "session"))
    return T3VoiceRuntimeCommand.StartRealtime(
      target = realtimeTarget(input.requireBridgeObject("target")),
      session = nativeSession(input.requireBridgeObject("session")),
    )
  }

  fun startThread(input: Map<String, Any?>): T3VoiceRuntimeCommand.StartThread {
    input.requireExactBridgeKeys("startThread", setOf("input", "session"))
    val start = threadStart(input.requireBridgeObject("input"))
    return T3VoiceRuntimeCommand.StartThread(
      target = start.target,
      settings = start.settings,
      session = nativeSession(input.requireBridgeObject("session")),
    )
  }

  fun switchRealtimeToThread(input: Map<String, Any?>): T3VoiceRuntimeCommand.SwitchRealtimeToThread {
    val start = threadStart(input)
    return T3VoiceRuntimeCommand.SwitchRealtimeToThread(start.target, start.settings)
  }

  fun realtimeContext(input: Map<String, Any?>): T3VoiceRealtimeContext {
    input.requireExactBridgeKeys("Realtime context", setOf("focus", "threadSwitch"))
    return T3VoiceRealtimeContext(
      focus = input.optionalBridgeObject("focus")?.let(::realtimeFocus),
      threadSwitch = input.optionalBridgeObject("threadSwitch")?.let(::threadStart),
    )
  }

  fun updateThreadReviewTranscript(
    input: Map<String, Any?>,
  ): T3VoiceRuntimeCommand.UpdateThreadReviewTranscript {
    input.requireExactBridgeKeys(
      "Thread review transcript update",
      setOf("expectedGeneration", "expectedReviewId", "transcript"),
    )
    return T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(
      expectedGeneration = input.requireBridgeLong("expectedGeneration"),
      expectedReviewId = input.requireBridgeLong("expectedReviewId"),
      transcript =
        input.requireBridgeString(
          "transcript",
          T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS,
        ),
    )
  }

  fun submitThreadTranscript(
    input: Map<String, Any?>,
  ): T3VoiceRuntimeCommand.SubmitThreadTranscript {
    input.requireExactBridgeKeys(
      "Thread transcript submission",
      setOf("expectedGeneration", "expectedReviewId", "transcript"),
    )
    return T3VoiceRuntimeCommand.SubmitThreadTranscript(
      expectedGeneration = input.requireBridgeLong("expectedGeneration"),
      expectedReviewId = input.requireBridgeLong("expectedReviewId"),
      transcript =
        input.requireBridgeText(
          "transcript",
          T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS,
        ),
    )
  }

  private fun realtimeTarget(input: Map<String, Any?>): T3VoiceRealtimeTarget {
    input.requireExactBridgeKeys(
      "Realtime target",
      setOf("environmentId", "conversation", "focus", "threadSwitch"),
    )
    return T3VoiceRealtimeTarget(
      environmentId = input.requireBridgeIdentifier("environmentId"),
      conversation = conversation(input.requireBridgeObject("conversation")),
      focus = input.optionalBridgeObject("focus")?.let(::realtimeFocus),
      threadSwitch = input.optionalBridgeObject("threadSwitch")?.let(::threadStart),
    )
  }

  private fun conversation(input: Map<String, Any?>): T3VoiceConversationSelection =
    when (input.requireBridgeText("type")) {
      "new" -> {
        input.requireAllowedBridgeKeys(
          "new conversation",
          required = setOf("type", "retention"),
          allowed = setOf("type", "retention", "title"),
        )
        T3VoiceConversationSelection.New(
          retention =
            when (input.requireBridgeText("retention")) {
              "ephemeral" -> T3VoiceConversationRetention.EPHEMERAL
              "durable" -> T3VoiceConversationRetention.DURABLE
              else -> error("retention must be ephemeral or durable.")
            },
          title =
            if (input.containsKey("title")) {
              input.requireBridgeText("title", MAXIMUM_CONVERSATION_TITLE_LENGTH)
            } else {
              null
            },
        )
      }
      "continue" -> {
        input.requireExactBridgeKeys(
          "continued conversation",
          setOf("type", "conversationId", "takeover"),
        )
        T3VoiceConversationSelection.Continue(
          conversationId = input.requireBridgeIdentifier("conversationId"),
          takeover = input.requireBridgeBoolean("takeover"),
        )
      }
      else -> error("conversation.type must be new or continue.")
    }

  private fun realtimeFocus(input: Map<String, Any?>): T3VoiceRealtimeFocus {
    input.requireExactBridgeKeys("Realtime focus", setOf("projectId", "threadId"))
    return T3VoiceRealtimeFocus(
      projectId = input.requireBridgeIdentifier("projectId"),
      threadId = input.requireBridgeIdentifier("threadId"),
    )
  }

  private fun threadStart(input: Map<String, Any?>): T3VoiceThreadStart {
    input.requireExactBridgeKeys("Thread input", setOf("target", "settings"))
    return T3VoiceThreadStart(
      target = threadTarget(input.requireBridgeObject("target")),
      settings = threadSettings(input.requireBridgeObject("settings")),
    )
  }

  private fun threadTarget(input: Map<String, Any?>): T3VoiceThreadTarget {
    input.requireExactBridgeKeys(
      "Thread target",
      setOf(
        "environmentId",
        "projectId",
        "threadId",
        "modelSelection",
        "runtimeMode",
        "interactionMode",
      ),
    )
    return T3VoiceThreadTarget(
      environmentId = input.requireBridgeIdentifier("environmentId"),
      projectId = input.requireBridgeIdentifier("projectId"),
      threadId = input.requireBridgeIdentifier("threadId"),
      modelSelection = modelSelection(input.requireBridgeObject("modelSelection")),
      runtimeMode =
        when (input.requireBridgeText("runtimeMode")) {
          "approval-required" -> T3VoiceThreadRuntimeMode.APPROVAL_REQUIRED
          "auto-accept-edits" -> T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS
          "full-access" -> T3VoiceThreadRuntimeMode.FULL_ACCESS
          else -> error("runtimeMode is invalid.")
        },
      interactionMode =
        when (input.requireBridgeText("interactionMode")) {
          "default" -> T3VoiceThreadInteractionMode.DEFAULT
          "plan" -> T3VoiceThreadInteractionMode.PLAN
          else -> error("interactionMode must be default or plan.")
        },
    )
  }

  private fun modelSelection(input: Map<String, Any?>): T3VoiceModelSelection {
    input.requireAllowedBridgeKeys(
      "Thread model selection",
      required = setOf("instanceId", "model"),
      allowed = setOf("instanceId", "model", "options"),
    )
    return T3VoiceModelSelection(
      instanceId = input.requireBridgeIdentifier("instanceId"),
      model = input.requireBridgeText("model"),
      options =
        input.optionalBridgeObjectList("options")?.map { option ->
          option.requireExactBridgeKeys("Thread model option", setOf("id", "value"))
          T3VoiceModelOption(
            id = option.requireBridgeText("id"),
            value =
              when (val value = option["value"]) {
                is String -> T3VoiceModelOptionValue.StringValue(value)
                is Boolean -> T3VoiceModelOptionValue.BooleanValue(value)
                else -> error("Thread model option value must be a string or boolean.")
              },
          )
        },
    )
  }

  private fun threadSettings(input: Map<String, Any?>): T3VoiceThreadSettings {
    input.requireExactBridgeKeys(
      "Thread settings",
      setOf(
        "submission",
        "playResponses",
        "autoRearm",
        "endpointDetection",
        "rearmDelayMs",
        "transcriptionTimeoutMs",
        "submissionTimeoutMs",
        "responseTimeoutMs",
      ),
    )
    val endpoint = input.requireBridgeObject("endpointDetection")
    endpoint.requireExactBridgeKeys(
      "Thread endpoint detection",
      setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs"),
    )
    return T3VoiceThreadSettings(
      submissionPolicy =
        when (input.requireBridgeText("submission")) {
          "review" -> T3VoiceThreadSubmissionPolicy.REVIEW
          "auto-submit" -> T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT
          else -> error("submission must be review or auto-submit.")
        },
      playResponses = input.requireBridgeBoolean("playResponses"),
      autoRearm = input.requireBridgeBoolean("autoRearm"),
      endpointDetection =
        T3VoiceThreadEndpointDetection(
          endSilenceMs = endpoint.requireBridgeLong("endSilenceMs"),
          noSpeechTimeoutMs = endpoint.optionalBridgeLong("noSpeechTimeoutMs"),
          maximumUtteranceMs = endpoint.requireBridgeLong("maximumUtteranceMs"),
        ),
      rearmDelayMs = input.requireBridgeLong("rearmDelayMs"),
      transcriptionTimeoutMs = input.requireBridgeLong("transcriptionTimeoutMs"),
      submissionTimeoutMs = input.requireBridgeLong("submissionTimeoutMs"),
      responseTimeoutMs = input.requireBridgeLong("responseTimeoutMs"),
    )
  }

  private fun nativeSession(input: Map<String, Any?>): T3VoiceNativeSessionConfig {
    input.requireExactBridgeKeys("native session", setOf("baseUrl", "accessToken", "expiresAt"))
    return T3VoiceNativeSessionConfig(
      baseUrl = input.requireBridgeText("baseUrl", MAXIMUM_BASE_URL_LENGTH),
      accessToken = input.requireBridgeText("accessToken", MAXIMUM_ACCESS_TOKEN_LENGTH),
      expiresAt = input.requireBridgeText("expiresAt", MAXIMUM_EXPIRATION_LENGTH),
    )
  }

  private const val MAXIMUM_CONVERSATION_TITLE_LENGTH = 256
  private const val MAXIMUM_BASE_URL_LENGTH = 4_096
  private const val MAXIMUM_ACCESS_TOKEN_LENGTH = 16_384
  private const val MAXIMUM_EXPIRATION_LENGTH = 128
}
