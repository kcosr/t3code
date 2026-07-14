package expo.modules.t3voice

import java.net.URLEncoder
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class T3VoiceBackgroundRealtimeFence(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val generation: Long,
  val modeSessionId: String,
) {
  init {
    requireIdentifier(runtimeId, "runtime ID")
    requireIdentifier(runtimeInstanceId, "runtime instance ID")
    require(generation > 0) { "Invalid runtime generation." }
    requireIdentifier(modeSessionId, "mode session ID")
  }
}

internal data class T3VoiceBackgroundRealtimeLeaseFence(
  val runtime: T3VoiceBackgroundRealtimeFence,
  val leaseGeneration: Long,
) {
  init {
    require(leaseGeneration > 0) { "Invalid Realtime lease generation." }
  }
}

internal data class T3VoiceBackgroundRealtimeStartInput(
  val fence: T3VoiceBackgroundRealtimeFence,
  val clientOperationId: String,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class T3VoiceBackgroundRealtimeSessionState(
  val sessionId: String,
  val conversationId: String,
  val phase: String,
  val leaseGeneration: Long,
  val sequence: Long,
)

internal data class T3VoiceBackgroundRealtimeControlGrant(
  val token: String,
  val expiresAtEpochMillis: Long,
  val heartbeatIntervalSeconds: Long,
  val failureGraceSeconds: Long,
)

internal data class T3VoiceBackgroundRealtimeStartResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val signalingPath: String,
  val expiresAtEpochMillis: Long,
  val controlGrant: T3VoiceBackgroundRealtimeControlGrant,
)

internal data class T3VoiceBackgroundRealtimeOfferInput(
  val fence: T3VoiceBackgroundRealtimeLeaseFence,
  val clientOperationId: String,
  val sdp: String,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
    require(sdp.isNotBlank() && sdp.length <= MAXIMUM_SDP_CHARACTERS) {
      "Invalid Realtime SDP."
    }
  }
}

internal data class T3VoiceBackgroundRealtimeAnswer(
  val sessionId: String,
  val leaseGeneration: Long,
  val sdp: String,
  val replayed: Boolean,
)

internal data class T3VoiceBackgroundRealtimeHeartbeatResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val disposition: String,
  val handoffPending: Boolean,
  val expiresAtEpochMillis: Long,
)

internal data class T3VoiceBackgroundRealtimeActionsQuery(
  val fence: T3VoiceBackgroundRealtimeLeaseFence,
  val afterSequence: Long,
  val waitMilliseconds: Long,
) {
  init {
    require(afterSequence >= 0) { "Invalid Realtime action cursor." }
    require(waitMilliseconds in 0..25_000) { "Invalid Realtime action wait." }
  }
}

internal sealed interface T3VoiceBackgroundRealtimeAction {
  val sequence: Long
  val occurredAtEpochMillis: Long

  data class NavigateThread(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val projectId: String,
    val threadId: String,
    val expiresAtEpochMillis: Long,
  ) : T3VoiceBackgroundRealtimeAction

  data class HandoffToThreadVoice(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val projectId: String,
    val threadId: String,
    val autoRearm: Boolean,
    val expiresAtEpochMillis: Long,
  ) : T3VoiceBackgroundRealtimeAction

  data class StopRealtimeVoice(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
  ) : T3VoiceBackgroundRealtimeAction

  data class ConfirmationRequired(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val confirmationId: String,
    val toolCallId: String,
    val tool: String,
    val summary: String,
    val expiresAtEpochMillis: Long,
  ) : T3VoiceBackgroundRealtimeAction
}

internal data class T3VoiceBackgroundRealtimeActionsResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val actions: List<T3VoiceBackgroundRealtimeAction>,
)

internal enum class T3VoiceBackgroundRealtimeActionOutcome(val wireValue: String) {
  SUCCEEDED("succeeded"),
  FAILED("failed"),
}

internal sealed interface T3VoiceBackgroundRealtimeActionAckInput {
  val fence: T3VoiceBackgroundRealtimeLeaseFence
  val clientOperationId: String
  val actionSequence: Long

  data class NavigateThread(
    override val fence: T3VoiceBackgroundRealtimeLeaseFence,
    override val clientOperationId: String,
    override val actionSequence: Long,
    val outcome: T3VoiceBackgroundRealtimeActionOutcome,
    val message: String? = null,
  ) : T3VoiceBackgroundRealtimeActionAckInput {
    init {
      validateAckBase(clientOperationId, actionSequence)
      message?.let {
        require(it.isNotBlank() && it.length <= MAXIMUM_ACTION_MESSAGE_CHARACTERS) {
          "Invalid Realtime action acknowledgement message."
        }
      }
    }
  }

  data class ConfirmationRequired(
    override val fence: T3VoiceBackgroundRealtimeLeaseFence,
    override val clientOperationId: String,
    override val actionSequence: Long,
    val confirmationId: String,
    val decision: String,
  ) : T3VoiceBackgroundRealtimeActionAckInput {
    init {
      validateAckBase(clientOperationId, actionSequence)
      requireIdentifier(confirmationId, "confirmation ID")
      require(decision in setOf("approve", "reject")) { "Invalid confirmation decision." }
    }
  }
}

private fun validateAckBase(clientOperationId: String, actionSequence: Long) {
  requireIdentifier(clientOperationId, "client operation ID")
  require(actionSequence > 0) { "Invalid Realtime action sequence." }
}

internal data class T3VoiceBackgroundRealtimeActionAckResult(
  val actionId: String,
  val actionSequence: Long,
  val outcome: T3VoiceBackgroundRealtimeActionOutcome,
  val replayed: Boolean,
)

internal data class T3VoiceBackgroundRealtimeFocus(
  val projectId: String,
  val threadId: String?,
) {
  init {
    requireIdentifier(projectId, "project ID")
    threadId?.let { requireIdentifier(it, "thread ID") }
  }
}

internal data class T3VoiceBackgroundRealtimeFocusInput(
  val fence: T3VoiceBackgroundRealtimeLeaseFence,
  val clientOperationId: String,
  val focus: T3VoiceBackgroundRealtimeFocus?,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class T3VoiceBackgroundRealtimeFocusResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val focus: T3VoiceBackgroundRealtimeFocus?,
  val replayed: Boolean,
)

internal data class T3VoiceBackgroundRealtimeEndpointPolicy(
  val endSilenceMs: Long,
  val noSpeechTimeoutMs: Long?,
  val maximumUtteranceMs: Long,
) {
  init {
    require(endSilenceMs in 100..30_000) { "Invalid end-silence duration." }
    require(noSpeechTimeoutMs == null || noSpeechTimeoutMs in 100..1_800_000) {
      "Invalid no-speech timeout."
    }
    require(maximumUtteranceMs in 1_000..3_600_000) { "Invalid maximum utterance duration." }
  }
}

internal data class T3VoiceBackgroundRealtimeHandoffExchangeInput(
  val fence: T3VoiceBackgroundRealtimeLeaseFence,
  val clientOperationId: String,
  val actionSequence: Long,
  val nextGeneration: Long,
  val threadModeSessionId: String,
  val environmentId: String,
  val speechPreset: String,
  val endpointPolicy: T3VoiceBackgroundRealtimeEndpointPolicy,
  val speechEnabled: Boolean,
  val rearmGuardMs: Long,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
    require(actionSequence > 0) { "Invalid Realtime handoff action sequence." }
    require(nextGeneration == fence.runtime.generation + 1) { "Invalid handoff generation." }
    requireIdentifier(threadModeSessionId, "thread mode session ID")
    requireIdentifier(environmentId, "environment ID")
    require(speechPreset in SPEECH_PRESETS) { "Invalid speech preset." }
    require(rearmGuardMs in 0..60_000) { "Invalid rearm guard duration." }
  }
}

internal data class T3VoiceBackgroundRealtimeThreadTarget(
  val environmentId: String,
  val projectId: String,
  val threadId: String,
  val speechPreset: String,
  val autoRearm: Boolean,
  val endpointPolicy: T3VoiceBackgroundRealtimeEndpointPolicy,
  val speechEnabled: Boolean,
  val rearmGuardMs: Long,
)

internal data class T3VoiceBackgroundRealtimeTransitionGrant(
  val token: String,
  val expiresAtEpochMillis: Long,
  val generation: Long,
  val modeSessionId: String,
  val target: T3VoiceBackgroundRealtimeThreadTarget,
)

internal data class T3VoiceBackgroundRealtimeHandoffExchangeResult(
  val actionId: String,
  val actionSequence: Long,
  val projectId: String,
  val threadId: String,
  val autoRearm: Boolean,
  val transitionGrant: T3VoiceBackgroundRealtimeTransitionGrant,
  val replayed: Boolean,
)

internal data class T3VoiceBackgroundRealtimeCloseInput(
  val fence: T3VoiceBackgroundRealtimeLeaseFence,
  val clientOperationId: String,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class T3VoiceBackgroundRealtimeCloseResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val closed: Boolean,
  val replayed: Boolean,
)

internal sealed interface T3VoiceBackgroundRealtimeResult<out T> {
  data class Success<T>(val value: T) : T3VoiceBackgroundRealtimeResult<T>

  data class Failure(
    val kind: T3VoiceBackgroundHttpFailureKind,
    val statusCode: Int?,
  ) : T3VoiceBackgroundRealtimeResult<Nothing>
}

internal object T3VoiceBackgroundRealtimeJson {
  fun encodeStart(input: T3VoiceBackgroundRealtimeStartInput) =
    fencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .bytes()

  fun decodeStart(bytes: ByteArray): T3VoiceBackgroundRealtimeStartResult {
    val root = objectFrom(bytes, START_RESULT_FIELDS)
    val state = parseState(objectField(root, "state"))
    val transport = objectField(root, "transport").requireExactFields(TRANSPORT_FIELDS)
    require(stringField(transport, "kind", 64) == "webrtc-sdp-v1") {
      "Unsupported Realtime transport."
    }
    val signalingPath = stringField(transport, "signalingPath", 512)
    require(signalingPath == sessionPath(state.sessionId, "webrtc-offer")) {
      "Unexpected Realtime signaling path."
    }
    val control = objectField(root, "controlGrant").requireExactFields(CONTROL_GRANT_FIELDS)
    require(stringField(control, "sessionId", 128) == state.sessionId) {
      "Realtime control grant session mismatch."
    }
    require(positiveLongField(control, "leaseGeneration") == state.leaseGeneration) {
      "Realtime control grant lease mismatch."
    }
    val heartbeatIntervalSeconds = positiveLongField(root, "heartbeatIntervalSeconds")
    require(positiveLongField(control, "heartbeatIntervalSeconds") == heartbeatIntervalSeconds) {
      "Realtime heartbeat interval mismatch."
    }
    return T3VoiceBackgroundRealtimeStartResult(
      state,
      signalingPath,
      instantField(root, "expiresAt"),
      T3VoiceBackgroundRealtimeControlGrant(
        boundedToken(stringField(control, "token", 128)),
        instantField(control, "expiresAt"),
        heartbeatIntervalSeconds,
        positiveLongField(control, "failureGraceSeconds"),
      ),
    )
  }

  fun encodeOffer(input: T3VoiceBackgroundRealtimeOfferInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("sdp", input.sdp)
      .bytes()

  fun decodeAnswer(bytes: ByteArray) =
    objectFrom(bytes, ANSWER_FIELDS).let {
      T3VoiceBackgroundRealtimeAnswer(
        sessionIdentifier(stringField(it, "sessionId", 128)),
        positiveLongField(it, "leaseGeneration"),
        stringField(it, "sdp", MAXIMUM_SDP_CHARACTERS).also { sdp ->
          require(sdp.isNotBlank()) { "Invalid Realtime SDP answer." }
        },
        booleanField(it, "replayed"),
      )
    }

  fun encodeHeartbeat(fence: T3VoiceBackgroundRealtimeLeaseFence) =
    leaseFencedObject(fence).bytes()

  fun decodeHeartbeat(bytes: ByteArray) =
    objectFrom(bytes, HEARTBEAT_RESULT_FIELDS).let {
      val disposition = stringField(it, "disposition", 32)
      require(disposition in HEARTBEAT_DISPOSITIONS) { "Invalid heartbeat disposition." }
      T3VoiceBackgroundRealtimeHeartbeatResult(
        parseState(objectField(it, "state")),
        disposition,
        booleanField(it, "handoffPending"),
        instantField(it, "expiresAt"),
      )
    }

  fun decodeActions(bytes: ByteArray): T3VoiceBackgroundRealtimeActionsResult {
    val root = objectFrom(bytes, ACTIONS_RESULT_FIELDS)
    val values = arrayField(root, "actions")
    require(values.length() <= MAXIMUM_ACTIONS) { "Too many Realtime actions." }
    val actions = (0 until values.length()).map { parseAction(values.getJSONObject(it)) }
    require(actions.zipWithNext().all { (left, right) -> left.sequence < right.sequence }) {
      "Realtime actions are not strictly ordered."
    }
    return T3VoiceBackgroundRealtimeActionsResult(parseState(objectField(root, "state")), actions)
  }

  fun encodeAck(input: T3VoiceBackgroundRealtimeActionAckInput): ByteArray =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("actionSequence", input.actionSequence)
      .apply {
        when (input) {
          is T3VoiceBackgroundRealtimeActionAckInput.NavigateThread -> {
            put("action", "navigate-thread")
            put("outcome", input.outcome.wireValue)
            input.message?.let { put("message", it) }
          }
          is T3VoiceBackgroundRealtimeActionAckInput.ConfirmationRequired -> {
            put("action", "confirmation-required")
            put("confirmationId", input.confirmationId)
            put("decision", input.decision)
          }
        }
      }
      .bytes()

  fun decodeAck(bytes: ByteArray): T3VoiceBackgroundRealtimeActionAckResult {
    val root = objectFrom(bytes, ACK_RESULT_FIELDS)
    return T3VoiceBackgroundRealtimeActionAckResult(
      identifierField(root, "actionId"),
      positiveLongField(root, "actionSequence"),
      outcomeField(root, "outcome"),
      booleanField(root, "replayed"),
    )
  }

  fun encodeFocus(input: T3VoiceBackgroundRealtimeFocusInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("focus", input.focus?.let(::focusObject) ?: JSONObject.NULL)
      .bytes()

  fun decodeFocus(bytes: ByteArray): T3VoiceBackgroundRealtimeFocusResult {
    val root = objectFrom(bytes, FOCUS_RESULT_FIELDS)
    return T3VoiceBackgroundRealtimeFocusResult(
      parseState(objectField(root, "state")),
      nullableFocusField(root, "focus"),
      booleanField(root, "replayed"),
    )
  }

  fun encodeHandoff(input: T3VoiceBackgroundRealtimeHandoffExchangeInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("actionSequence", input.actionSequence)
      .put("nextGeneration", input.nextGeneration)
      .put("threadModeSessionId", input.threadModeSessionId)
      .put("environmentId", input.environmentId)
      .put("speechPreset", input.speechPreset)
      .put("endpointPolicy", endpointPolicyObject(input.endpointPolicy))
      .put("speechEnabled", input.speechEnabled)
      .put("rearmGuardMs", input.rearmGuardMs)
      .bytes()

  fun decodeHandoff(bytes: ByteArray): T3VoiceBackgroundRealtimeHandoffExchangeResult {
    val root = objectFrom(bytes, HANDOFF_RESULT_FIELDS)
    val grant = objectField(root, "transitionGrant").requireExactFields(TRANSITION_GRANT_FIELDS)
    val target = objectField(grant, "target").requireExactFields(THREAD_TARGET_FIELDS)
    require(stringField(target, "mode", 32) == "thread") { "Invalid transition target mode." }
    val targetAutoRearm = booleanField(target, "autoRearm")
    val projectId = identifierField(root, "projectId")
    val threadId = identifierField(root, "threadId")
    require(identifierField(target, "projectId") == projectId) { "Handoff project mismatch." }
    require(identifierField(target, "threadId") == threadId) { "Handoff thread mismatch." }
    require(targetAutoRearm == booleanField(root, "autoRearm")) { "Handoff rearm mismatch." }
    val targetValue = T3VoiceBackgroundRealtimeThreadTarget(
      identifierField(target, "environmentId"),
      projectId,
      threadId,
      speechPresetField(target, "speechPreset"),
      targetAutoRearm,
      endpointPolicyField(target, "endpointPolicy"),
      booleanField(target, "speechEnabled"),
      rangedLongField(target, "rearmGuardMs", 0, 60_000),
    )
    return T3VoiceBackgroundRealtimeHandoffExchangeResult(
      identifierField(root, "actionId"),
      positiveLongField(root, "actionSequence"),
      projectId,
      threadId,
      targetAutoRearm,
      T3VoiceBackgroundRealtimeTransitionGrant(
        boundedToken(stringField(grant, "token", 128)),
        instantField(grant, "expiresAt"),
        positiveLongField(grant, "generation"),
        identifierField(grant, "modeSessionId"),
        targetValue,
      ),
      booleanField(root, "replayed"),
    )
  }

  fun encodeClose(input: T3VoiceBackgroundRealtimeCloseInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .bytes()

  fun decodeClose(bytes: ByteArray) =
    objectFrom(bytes, CLOSE_RESULT_FIELDS).let {
      T3VoiceBackgroundRealtimeCloseResult(
        parseState(objectField(it, "state")),
        booleanField(it, "closed"),
        booleanField(it, "replayed"),
      )
    }

  private fun parseAction(value: JSONObject): T3VoiceBackgroundRealtimeAction {
    val type = stringField(value, "type", 64)
    val sequence = positiveLongField(value, "sequence")
    val occurredAt = instantField(value, "occurredAt")
    return when (type) {
      "navigate-thread" -> {
        value.requireExactFields(NAVIGATE_ACTION_FIELDS)
        T3VoiceBackgroundRealtimeAction.NavigateThread(
          sequence, occurredAt, identifierField(value, "actionId"),
          identifierField(value, "projectId"), identifierField(value, "threadId"),
          instantField(value, "expiresAt"),
        )
      }
      "handoff-to-thread-voice" -> {
        value.requireExactFields(HANDOFF_ACTION_FIELDS)
        T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice(
          sequence, occurredAt, identifierField(value, "actionId"),
          identifierField(value, "projectId"), identifierField(value, "threadId"),
          booleanField(value, "autoRearm"), instantField(value, "expiresAt"),
        )
      }
      "stop-realtime-voice" -> {
        value.requireExactFields(STOP_ACTION_FIELDS)
        T3VoiceBackgroundRealtimeAction.StopRealtimeVoice(sequence, occurredAt)
      }
      "confirmation-required" -> {
        value.requireExactFields(CONFIRMATION_ACTION_FIELDS)
        T3VoiceBackgroundRealtimeAction.ConfirmationRequired(
          sequence, occurredAt, identifierField(value, "actionId"),
          identifierField(value, "confirmationId"), identifierField(value, "toolCallId"),
          identifierField(value, "tool"),
          stringField(value, "summary", MAXIMUM_ACTION_MESSAGE_CHARACTERS).also {
            require(it.isNotBlank()) { "Invalid confirmation summary." }
          },
          instantField(value, "expiresAt"),
        )
      }
      else -> throw IllegalArgumentException("Unsupported Realtime action type.")
    }
  }

  private fun parseState(value: JSONObject): T3VoiceBackgroundRealtimeSessionState {
    value.requireExactFields(SESSION_STATE_FIELDS)
    require(stringField(value, "mode", 64) == "realtime-agent") {
      "Unexpected Realtime session mode."
    }
    val phase = stringField(value, "phase", 64)
    require(phase in SESSION_PHASES) { "Invalid Realtime session phase." }
    return T3VoiceBackgroundRealtimeSessionState(
      sessionIdentifier(stringField(value, "sessionId", 128)),
      requireIdentifier(stringField(value, "conversationId", 1_024), "conversation ID", 1_024),
      phase,
      positiveLongField(value, "leaseGeneration"),
      nonNegativeLongField(value, "sequence"),
    )
  }

  private fun fencedObject(fence: T3VoiceBackgroundRealtimeFence) =
    JSONObject()
      .put("runtimeId", fence.runtimeId)
      .put("runtimeInstanceId", fence.runtimeInstanceId)
      .put("generation", fence.generation)
      .put("modeSessionId", fence.modeSessionId)

  private fun leaseFencedObject(fence: T3VoiceBackgroundRealtimeLeaseFence) =
    fencedObject(fence.runtime).put("leaseGeneration", fence.leaseGeneration)

  private fun focusObject(focus: T3VoiceBackgroundRealtimeFocus) =
    JSONObject().put("projectId", focus.projectId).put("threadId", focus.threadId ?: JSONObject.NULL)

  private fun endpointPolicyObject(policy: T3VoiceBackgroundRealtimeEndpointPolicy) =
    JSONObject()
      .put("endSilenceMs", policy.endSilenceMs)
      .put("noSpeechTimeoutMs", policy.noSpeechTimeoutMs ?: JSONObject.NULL)
      .put("maximumUtteranceMs", policy.maximumUtteranceMs)

  private fun nullableFocusField(source: JSONObject, name: String): T3VoiceBackgroundRealtimeFocus? {
    if (source.isNull(name)) return null
    val focus = objectField(source, name).requireExactFields(FOCUS_FIELDS)
    return T3VoiceBackgroundRealtimeFocus(
      identifierField(focus, "projectId"),
      if (focus.isNull("threadId")) null else identifierField(focus, "threadId"),
    )
  }

  private fun endpointPolicyField(source: JSONObject, name: String): T3VoiceBackgroundRealtimeEndpointPolicy {
    val policy = objectField(source, name).requireExactFields(ENDPOINT_POLICY_FIELDS)
    return T3VoiceBackgroundRealtimeEndpointPolicy(
      rangedLongField(policy, "endSilenceMs", 100, 30_000),
      if (policy.isNull("noSpeechTimeoutMs")) null
      else rangedLongField(policy, "noSpeechTimeoutMs", 100, 1_800_000),
      rangedLongField(policy, "maximumUtteranceMs", 1_000, 3_600_000),
    )
  }

  private fun objectFrom(bytes: ByteArray, fields: Set<String>): JSONObject {
    require(bytes.isNotEmpty()) { "Empty Realtime response." }
    return JSONObject(bytes.toString(Charsets.UTF_8)).requireExactFields(fields)
  }

  private fun JSONObject.requireExactFields(expected: Set<String>): JSONObject {
    require(keys().asSequence().toSet() == expected) { "Invalid Realtime response fields." }
    return this
  }

  private fun JSONObject.bytes() = toString().toByteArray(Charsets.UTF_8)
  private fun objectField(source: JSONObject, name: String) =
    source.get(name).let { require(it is JSONObject) { "Invalid Realtime object field." }; it }
  private fun arrayField(source: JSONObject, name: String) =
    source.get(name).let { require(it is JSONArray) { "Invalid Realtime array field." }; it }
  private fun stringField(source: JSONObject, name: String, maximumLength: Int) =
    source.get(name).let {
      require(it is String && it.length <= maximumLength) { "Invalid Realtime string field." }
      it
    }
  private fun identifierField(source: JSONObject, name: String) =
    requireIdentifier(stringField(source, name, MAXIMUM_IDENTIFIER_CHARACTERS), name)
  private fun booleanField(source: JSONObject, name: String) =
    source.get(name).let { require(it is Boolean) { "Invalid Realtime boolean field." }; it }
  private fun exactLongField(source: JSONObject, name: String): Long {
    val value = source.get(name)
    require(value is Byte || value is Short || value is Int || value is Long) {
      "Invalid Realtime integer field."
    }
    return (value as Number).toLong()
  }
  private fun positiveLongField(source: JSONObject, name: String) =
    exactLongField(source, name).also { require(it > 0) { "Invalid positive integer field." } }
  private fun nonNegativeLongField(source: JSONObject, name: String) =
    exactLongField(source, name).also { require(it >= 0) { "Invalid non-negative integer field." } }
  private fun rangedLongField(source: JSONObject, name: String, minimum: Long, maximum: Long) =
    exactLongField(source, name).also { require(it in minimum..maximum) { "Invalid bounded integer field." } }
  private fun instantField(source: JSONObject, name: String) =
    Instant.parse(stringField(source, name, 64)).toEpochMilli()
  private fun sessionIdentifier(value: String) =
    requireIdentifier(value, "session ID").also {
      require(it.matches(SAFE_PATH_SEGMENT)) { "Invalid Realtime session ID." }
    }
  private fun boundedToken(token: String) = token.also {
    require(it.isNotBlank() && it.none(Char::isWhitespace)) { "Invalid Realtime control token." }
  }
  private fun outcomeField(source: JSONObject, name: String) =
    T3VoiceBackgroundRealtimeActionOutcome.entries.singleOrNull {
      it.wireValue == stringField(source, name, 32)
    } ?: throw IllegalArgumentException("Invalid Realtime action outcome.")
  private fun speechPresetField(source: JSONObject, name: String) =
    stringField(source, name, 32).also { require(it in SPEECH_PRESETS) { "Invalid speech preset." } }

  private val START_RESULT_FIELDS =
    setOf("state", "transport", "expiresAt", "heartbeatIntervalSeconds", "controlGrant")
  private val SESSION_STATE_FIELDS =
    setOf("sessionId", "conversationId", "mode", "phase", "leaseGeneration", "sequence")
  private val TRANSPORT_FIELDS = setOf("kind", "signalingPath")
  private val CONTROL_GRANT_FIELDS = setOf(
    "token", "sessionId", "leaseGeneration", "expiresAt", "heartbeatIntervalSeconds",
    "failureGraceSeconds",
  )
  private val ANSWER_FIELDS = setOf("sessionId", "leaseGeneration", "sdp", "replayed")
  private val HEARTBEAT_RESULT_FIELDS = setOf("state", "disposition", "handoffPending", "expiresAt")
  private val ACTIONS_RESULT_FIELDS = setOf("state", "actions")
  private val ACTION_BASE_FIELDS = setOf("sequence", "occurredAt", "type")
  private val NAVIGATE_ACTION_FIELDS = ACTION_BASE_FIELDS + setOf("actionId", "projectId", "threadId", "expiresAt")
  private val HANDOFF_ACTION_FIELDS = NAVIGATE_ACTION_FIELDS + setOf("autoRearm")
  private val STOP_ACTION_FIELDS = ACTION_BASE_FIELDS
  private val CONFIRMATION_ACTION_FIELDS =
    ACTION_BASE_FIELDS + setOf("actionId", "confirmationId", "toolCallId", "tool", "summary", "expiresAt")
  private val ACK_RESULT_FIELDS = setOf("actionId", "actionSequence", "outcome", "replayed")
  private val FOCUS_FIELDS = setOf("projectId", "threadId")
  private val FOCUS_RESULT_FIELDS = setOf("state", "focus", "replayed")
  private val HANDOFF_RESULT_FIELDS =
    setOf("actionId", "actionSequence", "projectId", "threadId", "autoRearm", "transitionGrant", "replayed")
  private val TRANSITION_GRANT_FIELDS = setOf("token", "expiresAt", "generation", "modeSessionId", "target")
  private val THREAD_TARGET_FIELDS =
    setOf("mode", "environmentId", "projectId", "threadId", "speechPreset", "autoRearm", "endpointPolicy", "speechEnabled", "rearmGuardMs")
  private val ENDPOINT_POLICY_FIELDS = setOf("endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs")
  private val CLOSE_RESULT_FIELDS = setOf("state", "closed", "replayed")
  private val HEARTBEAT_DISPOSITIONS = setOf("live", "terminal")
  private val SESSION_PHASES = setOf(
    "creating", "signaling", "connecting", "idle", "listening", "thinking", "speaking",
    "confirming", "reconnecting", "ending", "ended", "error",
  )
}

internal fun interface T3VoiceBackgroundRealtimeHttp {
  fun execute(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpResult
  fun newCall(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpCall? = null
}

internal class T3VoiceBackgroundRealtimeCall<T>(
  private val executeBlock: () -> T3VoiceBackgroundRealtimeResult<T>,
  private val cancelBlock: () -> Unit,
) {
  fun execute() = executeBlock()
  fun cancel() = cancelBlock()
}

internal class T3VoiceBackgroundRealtimeDelegate(
  private val http: T3VoiceBackgroundRealtimeHttp = productionHttp(),
) {
  fun start(origin: String, runtimeToken: String, input: T3VoiceBackgroundRealtimeStartInput) =
    newStartCall(origin, runtimeToken, input).execute()

  fun newStartCall(origin: String, runtimeToken: String, input: T3VoiceBackgroundRealtimeStartInput) =
    jsonCall(
      request(origin, BASE_PATH, T3VoiceBackgroundHttpMethod.POST, RUNTIME_HEADER, runtimeToken,
        T3VoiceBackgroundRealtimeJson.encodeStart(input), MAXIMUM_SMALL_BYTES),
      T3VoiceBackgroundRealtimeJson::decodeStart,
    )

  fun offer(origin: String, controlToken: String, sessionId: String, input: T3VoiceBackgroundRealtimeOfferInput) =
    newOfferCall(origin, controlToken, sessionId, input).execute()

  fun newOfferCall(origin: String, controlToken: String, sessionId: String, input: T3VoiceBackgroundRealtimeOfferInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "webrtc-offer"), T3VoiceBackgroundHttpMethod.POST,
        CONTROL_HEADER, controlToken, T3VoiceBackgroundRealtimeJson.encodeOffer(input), MAXIMUM_SDP_BYTES),
      T3VoiceBackgroundRealtimeJson::decodeAnswer,
    ) { it.sessionId == sessionId && it.leaseGeneration == input.fence.leaseGeneration }

  fun heartbeat(origin: String, controlToken: String, sessionId: String, fence: T3VoiceBackgroundRealtimeLeaseFence) =
    jsonCall(
      request(origin, sessionPath(sessionId, "heartbeat"), T3VoiceBackgroundHttpMethod.POST,
        CONTROL_HEADER, controlToken, T3VoiceBackgroundRealtimeJson.encodeHeartbeat(fence), MAXIMUM_SMALL_BYTES),
      T3VoiceBackgroundRealtimeJson::decodeHeartbeat,
    ) { matchesState(it.state, sessionId, fence) }.execute()

  fun actions(origin: String, controlToken: String, sessionId: String, query: T3VoiceBackgroundRealtimeActionsQuery) =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin, sessionPath(sessionId, "actions"), T3VoiceBackgroundHttpMethod.GET,
        T3VoiceBackgroundAuthority(CONTROL_HEADER, controlToken), null, 0, MAXIMUM_ACTIONS_BYTES,
        linkedMapOf(
          "runtimeId" to query.fence.runtime.runtimeId,
          "runtimeInstanceId" to query.fence.runtime.runtimeInstanceId,
          "generation" to query.fence.runtime.generation.toString(),
          "modeSessionId" to query.fence.runtime.modeSessionId,
          "leaseGeneration" to query.fence.leaseGeneration.toString(),
          "afterSequence" to query.afterSequence.toString(),
          "waitMilliseconds" to query.waitMilliseconds.toString(),
        ),
      ),
      T3VoiceBackgroundRealtimeJson::decodeActions,
    ) { matchesState(it.state, sessionId, query.fence) }.execute()

  fun acknowledgeAction(
    origin: String,
    controlToken: String,
    sessionId: String,
    actionId: String,
    input: T3VoiceBackgroundRealtimeActionAckInput,
  ) = jsonCall(
    request(origin, sessionPath(sessionId, "actions/${encodedSegment(actionId)}/ack"),
      T3VoiceBackgroundHttpMethod.POST, CONTROL_HEADER, controlToken,
      T3VoiceBackgroundRealtimeJson.encodeAck(input), MAXIMUM_SMALL_BYTES),
    T3VoiceBackgroundRealtimeJson::decodeAck,
  ) {
    val expectedOutcome = when (input) {
      is T3VoiceBackgroundRealtimeActionAckInput.NavigateThread -> input.outcome
      is T3VoiceBackgroundRealtimeActionAckInput.ConfirmationRequired ->
        if (input.decision == "approve") T3VoiceBackgroundRealtimeActionOutcome.SUCCEEDED
        else T3VoiceBackgroundRealtimeActionOutcome.FAILED
    }
    it.actionId == actionId && it.actionSequence == input.actionSequence &&
      it.outcome == expectedOutcome
  }.execute()

  fun updateFocus(origin: String, controlToken: String, sessionId: String, input: T3VoiceBackgroundRealtimeFocusInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "focus"), T3VoiceBackgroundHttpMethod.PUT,
        CONTROL_HEADER, controlToken, T3VoiceBackgroundRealtimeJson.encodeFocus(input), MAXIMUM_SMALL_BYTES),
      T3VoiceBackgroundRealtimeJson::decodeFocus,
    ) { matchesState(it.state, sessionId, input.fence) && it.focus == input.focus }.execute()

  fun exchangeHandoff(
    origin: String,
    controlToken: String,
    sessionId: String,
    actionId: String,
    input: T3VoiceBackgroundRealtimeHandoffExchangeInput,
  ) = jsonCall(
    request(origin, sessionPath(sessionId, "handoffs/${encodedSegment(actionId)}/exchange"),
      T3VoiceBackgroundHttpMethod.POST, CONTROL_HEADER, controlToken,
      T3VoiceBackgroundRealtimeJson.encodeHandoff(input), MAXIMUM_SMALL_BYTES),
    T3VoiceBackgroundRealtimeJson::decodeHandoff,
  ) {
    it.actionId == actionId && it.actionSequence == input.actionSequence &&
      it.transitionGrant.generation == input.nextGeneration &&
      it.transitionGrant.modeSessionId == input.threadModeSessionId &&
      it.transitionGrant.target.environmentId == input.environmentId &&
      it.transitionGrant.target.speechPreset == input.speechPreset &&
      it.transitionGrant.target.endpointPolicy == input.endpointPolicy &&
      it.transitionGrant.target.speechEnabled == input.speechEnabled &&
      it.transitionGrant.target.rearmGuardMs == input.rearmGuardMs
  }.execute()

  fun close(origin: String, controlToken: String, sessionId: String, input: T3VoiceBackgroundRealtimeCloseInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "close"), T3VoiceBackgroundHttpMethod.POST,
        CONTROL_HEADER, controlToken, T3VoiceBackgroundRealtimeJson.encodeClose(input), MAXIMUM_SMALL_BYTES),
      T3VoiceBackgroundRealtimeJson::decodeClose,
    ) { matchesState(it.state, sessionId, input.fence) }.execute()

  private fun request(
    origin: String,
    path: String,
    method: T3VoiceBackgroundHttpMethod,
    header: String,
    token: String,
    body: ByteArray,
    maximumBytes: Int,
  ) = T3VoiceBackgroundHttpRequest(
    origin, path, method, T3VoiceBackgroundAuthority(header, token),
    T3VoiceBackgroundByteArrayBody(body, "application/json"), maximumBytes.toLong(), maximumBytes,
  )

  private fun <T> jsonCall(
    request: T3VoiceBackgroundHttpRequest,
    decode: (ByteArray) -> T,
    validate: (T) -> Boolean = { true },
  ): T3VoiceBackgroundRealtimeCall<T> {
    val call = http.newCall(request)
    return T3VoiceBackgroundRealtimeCall(
      {
        executeJson(call?.execute() ?: http.execute(request), decode).validate(validate)
      },
      { call?.cancel() },
    )
  }

  private fun <T> executeJson(result: T3VoiceBackgroundHttpResult, decode: (ByteArray) -> T) =
    when (result) {
      is T3VoiceBackgroundHttpResult.Failure ->
        T3VoiceBackgroundRealtimeResult.Failure(result.kind, result.statusCode)
      is T3VoiceBackgroundHttpResult.Success -> try {
        require(result.contentType?.substringBefore(';')?.trim() == "application/json") {
          "Invalid Realtime response content type."
        }
        T3VoiceBackgroundRealtimeResult.Success(decode(result.body))
      } catch (_: Exception) {
        T3VoiceBackgroundRealtimeResult.Failure(T3VoiceBackgroundHttpFailureKind.PERMANENT, result.statusCode)
      }
    }

  private fun <T> T3VoiceBackgroundRealtimeResult<T>.validate(predicate: (T) -> Boolean) =
    when (this) {
      is T3VoiceBackgroundRealtimeResult.Failure -> this
      is T3VoiceBackgroundRealtimeResult.Success -> if (predicate(value)) this
      else T3VoiceBackgroundRealtimeResult.Failure(T3VoiceBackgroundHttpFailureKind.PERMANENT, null)
    }

  private companion object {
    fun productionHttp(): T3VoiceBackgroundRealtimeHttp {
      val transport = T3VoiceBackgroundHttpTransport()
      return object : T3VoiceBackgroundRealtimeHttp {
        override fun execute(request: T3VoiceBackgroundHttpRequest) = transport.execute(request)
        override fun newCall(request: T3VoiceBackgroundHttpRequest) = transport.newCall(request)
      }
    }
  }
}

private fun matchesState(
  state: T3VoiceBackgroundRealtimeSessionState,
  sessionId: String,
  fence: T3VoiceBackgroundRealtimeLeaseFence,
) = state.sessionId == sessionId && state.leaseGeneration == fence.leaseGeneration

private fun sessionPath(sessionId: String, suffix: String) =
  "$BASE_PATH/${requirePathSegment(sessionId, "session ID")}/$suffix"

private fun encodedSegment(value: String) =
  URLEncoder.encode(requireIdentifier(value, "path identifier"), Charsets.UTF_8.name()).replace("+", "%20")

private fun requirePathSegment(value: String, label: String) =
  requireIdentifier(value, label).also { require(it.matches(SAFE_PATH_SEGMENT)) { "Invalid $label." } }

private fun requireIdentifier(value: String, label: String, maximumLength: Int = MAXIMUM_IDENTIFIER_CHARACTERS) =
  value.also {
    require(it.length <= maximumLength && it.matches(IDENTIFIER_PATTERN)) { "Invalid $label." }
  }

private const val BASE_PATH = "/api/voice/runtime/realtime-sessions"
private const val RUNTIME_HEADER = "x-t3-voice-runtime"
private const val CONTROL_HEADER = "x-t3-voice-control"
private const val MAXIMUM_IDENTIFIER_CHARACTERS = 192
private const val MAXIMUM_ACTION_MESSAGE_CHARACTERS = 512
private const val MAXIMUM_SDP_CHARACTERS = 128 * 1_024
private const val MAXIMUM_SMALL_BYTES = 32 * 1_024
private const val MAXIMUM_SDP_BYTES = 256 * 1_024
private const val MAXIMUM_ACTIONS_BYTES = 256 * 1_024
private const val MAXIMUM_ACTIONS = 100
private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:~-]*$")
private val SAFE_PATH_SEGMENT = Regex("^[A-Za-z0-9._~-]{1,128}$")
private val SPEECH_PRESETS = setOf("default", "warm")
