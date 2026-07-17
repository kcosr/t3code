package expo.modules.t3voice

/** Strict conversion from the Expo/JavaScript bridge shape into native runtime commands. */
internal object T3VoiceRuntimeBridgeInput {
  fun startRealtime(input: Map<String, Any?>): T3VoiceRuntimeCommand.StartRealtime {
    input.requireExactKeys("startRealtime", setOf("target", "session"))
    return T3VoiceRuntimeCommand.StartRealtime(
      target = realtimeTarget(input.requireObject("target")),
      session = nativeSession(input.requireObject("session")),
    )
  }

  fun startThread(input: Map<String, Any?>): T3VoiceRuntimeCommand.StartThread {
    input.requireExactKeys("startThread", setOf("input", "session"))
    val start = threadStart(input.requireObject("input"))
    return T3VoiceRuntimeCommand.StartThread(
      target = start.target,
      settings = start.settings,
      session = nativeSession(input.requireObject("session")),
    )
  }

  fun switchRealtimeToThread(input: Map<String, Any?>): T3VoiceRuntimeCommand.SwitchRealtimeToThread {
    val start = threadStart(input)
    return T3VoiceRuntimeCommand.SwitchRealtimeToThread(start.target, start.settings)
  }

  fun realtimeContext(input: Map<String, Any?>): T3VoiceRealtimeContext {
    input.requireExactKeys("Realtime context", setOf("focus", "threadSwitch"))
    return T3VoiceRealtimeContext(
      focus = input.optionalObject("focus")?.let(::realtimeFocus),
      threadSwitch = input.optionalObject("threadSwitch")?.let(::threadStart),
    )
  }

  fun updateThreadReviewTranscript(
    input: Map<String, Any?>,
  ): T3VoiceRuntimeCommand.UpdateThreadReviewTranscript {
    input.requireExactKeys(
      "Thread review transcript update",
      setOf("expectedGeneration", "expectedReviewId", "transcript"),
    )
    return T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(
      expectedGeneration = input.requireLong("expectedGeneration"),
      expectedReviewId = input.requireLong("expectedReviewId"),
      transcript =
        input.requireString(
          "transcript",
          T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS,
        ),
    )
  }

  fun submitThreadTranscript(
    input: Map<String, Any?>,
  ): T3VoiceRuntimeCommand.SubmitThreadTranscript {
    input.requireExactKeys(
      "Thread transcript submission",
      setOf("expectedGeneration", "expectedReviewId", "transcript"),
    )
    return T3VoiceRuntimeCommand.SubmitThreadTranscript(
      expectedGeneration = input.requireLong("expectedGeneration"),
      expectedReviewId = input.requireLong("expectedReviewId"),
      transcript =
        input.requireText(
          "transcript",
          T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS,
        ),
    )
  }

  private fun realtimeTarget(input: Map<String, Any?>): T3VoiceRealtimeTarget {
    input.requireExactKeys(
      "Realtime target",
      setOf("environmentId", "conversation", "focus", "threadSwitch"),
    )
    return T3VoiceRealtimeTarget(
      environmentId = input.requireIdentifier("environmentId"),
      conversation = conversation(input.requireObject("conversation")),
      focus = input.optionalObject("focus")?.let(::realtimeFocus),
      threadSwitch = input.optionalObject("threadSwitch")?.let(::threadStart),
    )
  }

  private fun conversation(input: Map<String, Any?>): T3VoiceConversationSelection =
    when (input.requireText("type")) {
      "new" -> {
        input.requireAllowedKeys(
          "new conversation",
          required = setOf("type", "retention"),
          allowed = setOf("type", "retention", "title"),
        )
        T3VoiceConversationSelection.New(
          retention =
            when (input.requireText("retention")) {
              "ephemeral" -> T3VoiceConversationRetention.EPHEMERAL
              "durable" -> T3VoiceConversationRetention.DURABLE
              else -> error("retention must be ephemeral or durable.")
            },
          title =
            if (input.containsKey("title")) {
              input.requireText("title", MAXIMUM_CONVERSATION_TITLE_LENGTH)
            } else {
              null
            },
        )
      }
      "continue" -> {
        input.requireExactKeys(
          "continued conversation",
          setOf("type", "conversationId", "takeover"),
        )
        T3VoiceConversationSelection.Continue(
          conversationId = input.requireIdentifier("conversationId"),
          takeover = input.requireBoolean("takeover"),
        )
      }
      else -> error("conversation.type must be new or continue.")
    }

  private fun realtimeFocus(input: Map<String, Any?>): T3VoiceRealtimeFocus {
    input.requireExactKeys("Realtime focus", setOf("projectId", "threadId"))
    return T3VoiceRealtimeFocus(
      projectId = input.requireIdentifier("projectId"),
      threadId = input.requireIdentifier("threadId"),
    )
  }

  private fun threadStart(input: Map<String, Any?>): T3VoiceThreadStart {
    input.requireExactKeys("Thread input", setOf("target", "settings"))
    return T3VoiceThreadStart(
      target = threadTarget(input.requireObject("target")),
      settings = threadSettings(input.requireObject("settings")),
    )
  }

  private fun threadTarget(input: Map<String, Any?>): T3VoiceThreadTarget {
    input.requireExactKeys(
      "Thread target",
      setOf("environmentId", "projectId", "threadId", "runtimeMode", "interactionMode"),
    )
    return T3VoiceThreadTarget(
      environmentId = input.requireIdentifier("environmentId"),
      projectId = input.requireIdentifier("projectId"),
      threadId = input.requireIdentifier("threadId"),
      runtimeMode =
        when (input.requireText("runtimeMode")) {
          "approval-required" -> T3VoiceThreadRuntimeMode.APPROVAL_REQUIRED
          "auto-accept-edits" -> T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS
          "full-access" -> T3VoiceThreadRuntimeMode.FULL_ACCESS
          else -> error("runtimeMode is invalid.")
        },
      interactionMode =
        when (input.requireText("interactionMode")) {
          "default" -> T3VoiceThreadInteractionMode.DEFAULT
          "plan" -> T3VoiceThreadInteractionMode.PLAN
          else -> error("interactionMode must be default or plan.")
        },
    )
  }

  private fun threadSettings(input: Map<String, Any?>): T3VoiceThreadSettings {
    input.requireExactKeys(
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
    val endpoint = input.requireObject("endpointDetection")
    endpoint.requireExactKeys(
      "Thread endpoint detection",
      setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs"),
    )
    return T3VoiceThreadSettings(
      submissionPolicy =
        when (input.requireText("submission")) {
          "review" -> T3VoiceThreadSubmissionPolicy.REVIEW
          "auto-submit" -> T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT
          else -> error("submission must be review or auto-submit.")
        },
      playResponses = input.requireBoolean("playResponses"),
      autoRearm = input.requireBoolean("autoRearm"),
      endpointDetection =
        T3VoiceThreadEndpointDetection(
          endSilenceMs = endpoint.requireLong("endSilenceMs"),
          noSpeechTimeoutMs = endpoint.optionalLong("noSpeechTimeoutMs"),
          maximumUtteranceMs = endpoint.requireLong("maximumUtteranceMs"),
        ),
      rearmDelayMs = input.requireLong("rearmDelayMs"),
      transcriptionTimeoutMs = input.requireLong("transcriptionTimeoutMs"),
      submissionTimeoutMs = input.requireLong("submissionTimeoutMs"),
      responseTimeoutMs = input.requireLong("responseTimeoutMs"),
    )
  }

  private fun nativeSession(input: Map<String, Any?>): T3VoiceNativeSessionConfig {
    input.requireExactKeys("native session", setOf("baseUrl", "accessToken", "expiresAt"))
    return T3VoiceNativeSessionConfig(
      baseUrl = input.requireText("baseUrl", MAXIMUM_BASE_URL_LENGTH),
      accessToken = input.requireText("accessToken", MAXIMUM_ACCESS_TOKEN_LENGTH),
      expiresAt = input.requireText("expiresAt", MAXIMUM_EXPIRATION_LENGTH),
    )
  }

  private fun Map<String, Any?>.requireObject(key: String): Map<String, Any?> =
    (this[key] as? Map<*, *>)?.toStringKeyMap(key) ?: error("$key must be an object.")

  private fun Map<String, Any?>.optionalObject(key: String): Map<String, Any?>? {
    val value = this[key] ?: return null
    return (value as? Map<*, *>)?.toStringKeyMap(key) ?: error("$key must be an object or null.")
  }

  private fun Map<*, *>.toStringKeyMap(name: String): Map<String, Any?> {
    check(keys.all { it is String }) { "$name must use string field names." }
    @Suppress("UNCHECKED_CAST")
    return this as Map<String, Any?>
  }

  private fun Map<String, Any?>.requireIdentifier(key: String): String =
    requireText(key, T3VoiceBridgeValidation.MAXIMUM_IDENTIFIER_LENGTH)

  private fun Map<String, Any?>.requireText(
    key: String,
    maximumLength: Int = MAXIMUM_BRIDGE_TEXT_LENGTH,
  ): String {
    val value = requireString(key, maximumLength)
    check(value.isNotBlank()) { "$key must be non-empty." }
    return value
  }

  private fun Map<String, Any?>.requireString(key: String, maximumLength: Int): String {
    val value = this[key] as? String ?: error("$key must be a string.")
    check(value.length <= maximumLength) { "$key is too long." }
    return value
  }

  private fun Map<String, Any?>.requireBoolean(key: String): Boolean =
    this[key] as? Boolean ?: error("$key must be a boolean.")

  private fun Map<String, Any?>.requireLong(key: String): Long =
    optionalLong(key) ?: error("$key must be an integer.")

  private fun Map<String, Any?>.optionalLong(key: String): Long? {
    val value = this[key] ?: return null
    val number = value as? Number ?: error("$key must be an integer or null.")
    val double = number.toDouble()
    val long = number.toLong()
    check(double.isFinite() && double == long.toDouble()) { "$key must be an integer." }
    return long
  }

  private fun Map<String, Any?>.requireExactKeys(name: String, expected: Set<String>) {
    check(keys == expected) {
      "$name fields must be exactly ${expected.sorted().joinToString()}."
    }
  }

  private fun Map<String, Any?>.requireAllowedKeys(
    name: String,
    required: Set<String>,
    allowed: Set<String>,
  ) {
    check(keys.containsAll(required) && allowed.containsAll(keys)) {
      "$name fields are invalid."
    }
  }

  private const val MAXIMUM_BRIDGE_TEXT_LENGTH = 16_384
  private const val MAXIMUM_CONVERSATION_TITLE_LENGTH = 256
  private const val MAXIMUM_BASE_URL_LENGTH = 4_096
  private const val MAXIMUM_ACCESS_TOKEN_LENGTH = 16_384
  private const val MAXIMUM_EXPIRATION_LENGTH = 128
}
