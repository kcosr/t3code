package expo.modules.t3voice

/** Strict conversion from the Expo/JavaScript bridge shape into native runtime commands. */
internal object T3VoiceRuntimeBridgeInput {
  fun startRealtime(input: Map<String, Any?>): T3VoiceRuntimeCommand.StartRealtime {
    val admission = realtimeAdmission(input, "startRealtime")
    return T3VoiceRuntimeCommand.StartRealtime(
      target = admission.target,
      session = admission.session,
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

  fun switchThreadToRealtime(input: Map<String, Any?>): T3VoiceRuntimeCommand.SwitchThreadToRealtime {
    val admission = realtimeAdmission(input, "switchThreadToRealtime")
    return T3VoiceRuntimeCommand.SwitchThreadToRealtime(
      target = admission.target,
      session = admission.session,
    )
  }

  private data class RealtimeAdmission(
    val target: T3VoiceRealtimeTarget,
    val session: T3VoiceNativeSessionConfig,
  )

  private fun realtimeAdmission(
    input: Map<String, Any?>,
    operation: String,
  ): RealtimeAdmission {
    input.requireExactBridgeKeys(operation, setOf("target", "session"))
    return RealtimeAdmission(
      target = realtimeTarget(input.requireBridgeObject("target")),
      session = nativeSession(input.requireBridgeObject("session")),
    )
  }

  fun realtimeContext(input: Map<String, Any?>): T3VoiceRealtimeContext {
    input.requireExactBridgeKeys("Realtime context", setOf("focus", "threadSettings"))
    return T3VoiceRealtimeContext(
      focus = input.optionalBridgeObject("focus")?.let(::realtimeFocus),
      threadSettings = input.optionalBridgeObject("threadSettings")?.let(::threadSettings),
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
      setOf("environmentId", "conversation", "focus", "threadSettings"),
    )
    return T3VoiceRealtimeTarget(
      environmentId = input.requireBridgeIdentifier("environmentId"),
      conversation = conversation(input.requireBridgeObject("conversation")),
      focus = input.optionalBridgeObject("focus")?.let(::realtimeFocus),
      threadSettings = input.optionalBridgeObject("threadSettings")?.let(::threadSettings),
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
    val parsed =
      T3VoiceThreadWireParser.target(
        T3VoiceBridgeWireObject(input),
        additionalFields = setOf("environmentId"),
      )
    return T3VoiceThreadTarget(
      environmentId = input.requireBridgeIdentifier("environmentId"),
      projectId = parsed.projectId,
      threadId = parsed.threadId,
      modelSelection = parsed.modelSelection,
      runtimeMode = parsed.runtimeMode,
      interactionMode = parsed.interactionMode,
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

/** Minimal object view shared by the Expo bridge and native HTTP wire decoders. */
internal interface T3VoiceWireObject {
  val fieldNames: Set<String>

  fun value(name: String): Any?

  fun requiredObject(name: String): T3VoiceWireObject

  fun optionalObjectList(name: String): List<T3VoiceWireObject>?
}

private class T3VoiceBridgeWireObject(
  private val input: Map<String, Any?>,
) : T3VoiceWireObject {
  override val fieldNames: Set<String>
    get() = input.keys

  override fun value(name: String): Any? = input[name]

  override fun requiredObject(name: String): T3VoiceWireObject =
    T3VoiceBridgeWireObject(input.requireBridgeObject(name))

  override fun optionalObjectList(name: String): List<T3VoiceWireObject>? =
    input.optionalBridgeObjectList(name)?.map(::T3VoiceBridgeWireObject)
}

internal data class T3VoiceParsedThreadTarget(
  val projectId: String,
  val threadId: String,
  val modelSelection: T3VoiceModelSelection,
  val runtimeMode: T3VoiceThreadRuntimeMode,
  val interactionMode: T3VoiceThreadInteractionMode,
)

/** Canonical parser for Thread target fields shared by both native ingress boundaries. */
internal object T3VoiceThreadWireParser {
  private val targetFields =
    setOf("projectId", "threadId", "modelSelection", "runtimeMode", "interactionMode")

  fun target(
    input: T3VoiceWireObject,
    additionalFields: Set<String> = emptySet(),
  ): T3VoiceParsedThreadTarget {
    input.requireExactFields("Thread target", targetFields + additionalFields)
    return T3VoiceParsedThreadTarget(
      projectId = input.requireIdentifier("projectId"),
      threadId = input.requireIdentifier("threadId"),
      modelSelection = modelSelection(input.requiredObject("modelSelection")),
      runtimeMode = runtimeMode(input.requireText("runtimeMode")),
      interactionMode = interactionMode(input.requireText("interactionMode")),
    )
  }

  private fun modelSelection(input: T3VoiceWireObject): T3VoiceModelSelection {
    input.requireAllowedFields(
      "Thread model selection",
      required = setOf("instanceId", "model"),
      allowed = setOf("instanceId", "model", "options"),
    )
    return T3VoiceModelSelection(
      instanceId = input.requireIdentifier("instanceId"),
      model = input.requireText("model"),
      options =
        input.optionalObjectList("options")?.map { option ->
          option.requireExactFields("Thread model option", setOf("id", "value"))
          T3VoiceModelOption(
            id = option.requireText("id"),
            value =
              when (val value = option.value("value")) {
                is String -> T3VoiceModelOptionValue.StringValue(value)
                is Boolean -> T3VoiceModelOptionValue.BooleanValue(value)
                else -> error("Thread model option value must be a string or boolean.")
              },
          )
        },
    )
  }

  private fun runtimeMode(value: String): T3VoiceThreadRuntimeMode =
    when (value) {
      "approval-required" -> T3VoiceThreadRuntimeMode.APPROVAL_REQUIRED
      "auto-accept-edits" -> T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS
      "full-access" -> T3VoiceThreadRuntimeMode.FULL_ACCESS
      else -> error("runtimeMode is invalid.")
    }

  private fun interactionMode(value: String): T3VoiceThreadInteractionMode =
    when (value) {
      "default" -> T3VoiceThreadInteractionMode.DEFAULT
      "plan" -> T3VoiceThreadInteractionMode.PLAN
      else -> error("interactionMode must be default or plan.")
    }
}

private fun T3VoiceWireObject.requireExactFields(name: String, expected: Set<String>) {
  check(fieldNames == expected) {
    "$name fields must be exactly ${expected.sorted().joinToString()}."
  }
}

private fun T3VoiceWireObject.requireAllowedFields(
  name: String,
  required: Set<String>,
  allowed: Set<String>,
) {
  check(fieldNames.containsAll(required) && allowed.containsAll(fieldNames)) {
    "$name fields are invalid."
  }
}

private fun T3VoiceWireObject.requireIdentifier(name: String): String =
  requireText(name, T3VoiceBridgeValidation.MAXIMUM_IDENTIFIER_LENGTH)

private fun T3VoiceWireObject.requireText(
  name: String,
  maximumLength: Int = T3VoiceBridgeValidation.MAXIMUM_BRIDGE_TEXT_LENGTH,
): String {
  val text = value(name) as? String ?: error("$name must be a string.")
  check(text.isNotBlank()) { "$name must be non-empty." }
  check(text.length <= maximumLength) { "$name is too long." }
  return text
}
