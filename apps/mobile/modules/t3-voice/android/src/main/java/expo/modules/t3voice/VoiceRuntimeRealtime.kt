package expo.modules.t3voice

import java.net.URLEncoder
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class VoiceRealtimeTransportFence(
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

internal data class VoiceRuntimeRealtimeLeaseFence(
  val runtime: VoiceRealtimeTransportFence,
  val leaseGeneration: Long,
) {
  init {
    require(leaseGeneration > 0) { "Invalid Realtime lease generation." }
  }
}

internal data class VoiceRuntimeRealtimeStartInput(
  val fence: VoiceRealtimeTransportFence,
  val clientOperationId: String,
  val target: VoiceRuntimeTarget.Realtime,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class VoiceRuntimeRealtimeSessionState(
  val sessionId: String,
  val conversationId: String,
  val phase: String,
  val leaseGeneration: Long,
  val sequence: Long,
)

internal data class VoiceRuntimeRealtimeStartResult(
  val state: VoiceRuntimeRealtimeSessionState,
  val signalingPath: String,
  val expiresAtEpochMillis: Long,
  val heartbeatIntervalSeconds: Long,
)

internal data class VoiceRuntimeRealtimeOfferInput(
  val fence: VoiceRuntimeRealtimeLeaseFence,
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

internal data class VoiceRuntimeRealtimeAnswer(
  val sessionId: String,
  val leaseGeneration: Long,
  val sdp: String,
  val replayed: Boolean,
)

internal data class VoiceRuntimeRealtimeHeartbeatResult(
  val state: VoiceRuntimeRealtimeSessionState,
  val disposition: String,
  val handoffPending: Boolean,
  val expiresAtEpochMillis: Long,
)

internal data class VoiceRuntimeRealtimeActionsQuery(
  val fence: VoiceRuntimeRealtimeLeaseFence,
  val afterSequence: Long,
  val waitMilliseconds: Long,
) {
  init {
    require(afterSequence >= 0) { "Invalid Realtime action cursor." }
    require(waitMilliseconds in 0..25_000) { "Invalid Realtime action wait." }
  }
}

internal sealed interface VoiceRuntimeRealtimeAction {
  val sequence: Long
  val occurredAtEpochMillis: Long

  data class NavigateThread(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val projectId: String,
    val threadId: String,
    val expiresAtEpochMillis: Long,
  ) : VoiceRuntimeRealtimeAction

  data class HandoffToThreadVoice(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val projectId: String,
    val threadId: String,
    val autoRearm: Boolean,
    val expiresAtEpochMillis: Long,
  ) : VoiceRuntimeRealtimeAction

  data class StopRealtimeVoice(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
  ) : VoiceRuntimeRealtimeAction

  data class ConfirmationRequired(
    override val sequence: Long,
    override val occurredAtEpochMillis: Long,
    val actionId: String,
    val confirmationId: String,
    val toolCallId: String,
    val tool: String,
    val summary: String,
    val expiresAtEpochMillis: Long,
  ) : VoiceRuntimeRealtimeAction
}

internal data class VoiceRuntimeRealtimeActionsResult(
  val state: VoiceRuntimeRealtimeSessionState,
  val actions: List<VoiceRuntimeRealtimeAction>,
)

internal enum class VoiceRuntimeRealtimeActionOutcome(val wireValue: String) {
  SUCCEEDED("succeeded"),
  FAILED("failed"),
}

internal sealed interface VoiceRuntimeRealtimeActionAckInput {
  val fence: VoiceRuntimeRealtimeLeaseFence
  val clientOperationId: String
  val actionSequence: Long

  data class NavigateThread(
    override val fence: VoiceRuntimeRealtimeLeaseFence,
    override val clientOperationId: String,
    override val actionSequence: Long,
    val outcome: VoiceRuntimeRealtimeActionOutcome,
    val message: String? = null,
  ) : VoiceRuntimeRealtimeActionAckInput {
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
    override val fence: VoiceRuntimeRealtimeLeaseFence,
    override val clientOperationId: String,
    override val actionSequence: Long,
    val confirmationId: String,
    val decision: String,
  ) : VoiceRuntimeRealtimeActionAckInput {
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

internal data class VoiceRuntimeRealtimeActionAckResult(
  val actionId: String,
  val actionSequence: Long,
  val outcome: VoiceRuntimeRealtimeActionOutcome,
  val replayed: Boolean,
)

internal data class VoiceRuntimeRealtimeFocus(
  val projectId: String,
  val threadId: String?,
) {
  init {
    requireIdentifier(projectId, "project ID")
    threadId?.let { requireIdentifier(it, "thread ID") }
  }
}

internal data class VoiceRuntimeRealtimeFocusInput(
  val fence: VoiceRuntimeRealtimeLeaseFence,
  val clientOperationId: String,
  val focus: VoiceRuntimeRealtimeFocus?,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class VoiceRuntimeRealtimeFocusResult(
  val state: VoiceRuntimeRealtimeSessionState,
  val focus: VoiceRuntimeRealtimeFocus?,
  val replayed: Boolean,
)

internal data class VoiceRuntimeRealtimeEndpointPolicy(
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

internal data class VoiceRuntimeRealtimeHandoffExchangeInput(
  val fence: VoiceRuntimeRealtimeLeaseFence,
  val clientOperationId: String,
  val actionSequence: Long,
  val nextGeneration: Long,
  val threadModeSessionId: String,
  val environmentId: String,
  val speechPreset: String,
  val endpointPolicy: VoiceRuntimeRealtimeEndpointPolicy,
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

internal data class VoiceRuntimeRealtimeThreadTarget(
  val environmentId: String,
  val projectId: String,
  val threadId: String,
  val speechPreset: String,
  val autoRearm: Boolean,
  val endpointPolicy: VoiceRuntimeRealtimeEndpointPolicy,
  val speechEnabled: Boolean,
  val rearmGuardMs: Long,
)

internal data class VoiceRuntimeRealtimeTransitionReservation(
  val generation: Long,
  val modeSessionId: String,
  val target: VoiceRuntimeRealtimeThreadTarget,
)

internal data class VoiceRuntimeRealtimeHandoffExchangeResult(
  val actionId: String,
  val actionSequence: Long,
  val projectId: String,
  val threadId: String,
  val autoRearm: Boolean,
  val reservation: VoiceRuntimeRealtimeTransitionReservation,
  val replayed: Boolean,
)

internal data class VoiceRuntimeRealtimeHandoffCommitInput(
  val fence: VoiceRuntimeRealtimeLeaseFence,
  val actionSequence: Long,
  val nextGeneration: Long,
  val threadModeSessionId: String,
) {
  init {
    require(actionSequence > 0) { "Invalid Realtime handoff action sequence." }
    require(nextGeneration == fence.runtime.generation + 1) { "Invalid handoff generation." }
    requireIdentifier(threadModeSessionId, "thread mode session ID")
  }
}

internal data class VoiceRuntimeRealtimeHandoffCommitResult(
  val actionId: String,
  val actionSequence: Long,
  val committed: Boolean,
  val replayed: Boolean,
)

internal data class VoiceRuntimeRealtimeCloseInput(
  val fence: VoiceRuntimeRealtimeLeaseFence,
  val clientOperationId: String,
) {
  init {
    requireIdentifier(clientOperationId, "client operation ID")
  }
}

internal data class VoiceRuntimeRealtimeCloseResult(
  val state: VoiceRuntimeRealtimeSessionState,
  val closed: Boolean,
  val replayed: Boolean,
)

internal sealed interface VoiceRuntimeRealtimeResult<out T> {
  data class Success<T>(val value: T) : VoiceRuntimeRealtimeResult<T>

  data class Failure(
    val kind: VoiceRuntimeHttpFailureKind,
    val statusCode: Int?,
  ) : VoiceRuntimeRealtimeResult<Nothing>
}

internal object VoiceRuntimeRealtimeJson {
  fun encodeStart(input: VoiceRuntimeRealtimeStartInput) =
    fencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("target", JSONObject(VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(input.target)))
      .bytes()

  fun decodeStart(bytes: ByteArray): VoiceRuntimeRealtimeStartResult {
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
    val heartbeatIntervalSeconds = positiveLongField(root, "heartbeatIntervalSeconds")
    return VoiceRuntimeRealtimeStartResult(
      state,
      signalingPath,
      instantField(root, "expiresAt"),
      heartbeatIntervalSeconds,
    )
  }

  fun encodeOffer(input: VoiceRuntimeRealtimeOfferInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("sdp", input.sdp)
      .bytes()

  fun decodeAnswer(bytes: ByteArray) =
    objectFrom(bytes, ANSWER_FIELDS).let {
      VoiceRuntimeRealtimeAnswer(
        sessionIdentifier(stringField(it, "sessionId", 128)),
        positiveLongField(it, "leaseGeneration"),
        stringField(it, "sdp", MAXIMUM_SDP_CHARACTERS).also { sdp ->
          require(sdp.isNotBlank()) { "Invalid Realtime SDP answer." }
        },
        booleanField(it, "replayed"),
      )
    }

  fun encodeHeartbeat(fence: VoiceRuntimeRealtimeLeaseFence) =
    leaseFencedObject(fence).bytes()

  fun decodeHeartbeat(bytes: ByteArray) =
    objectFrom(bytes, HEARTBEAT_RESULT_FIELDS).let {
      val disposition = stringField(it, "disposition", 32)
      require(disposition in HEARTBEAT_DISPOSITIONS) { "Invalid heartbeat disposition." }
      VoiceRuntimeRealtimeHeartbeatResult(
        parseState(objectField(it, "state")),
        disposition,
        booleanField(it, "handoffPending"),
        instantField(it, "expiresAt"),
      )
    }

  fun decodeActions(bytes: ByteArray): VoiceRuntimeRealtimeActionsResult {
    val root = objectFrom(bytes, ACTIONS_RESULT_FIELDS)
    val values = arrayField(root, "actions")
    require(values.length() <= MAXIMUM_ACTIONS) { "Too many Realtime actions." }
    val actions = (0 until values.length()).map { parseAction(values.getJSONObject(it)) }
    require(actions.zipWithNext().all { (left, right) -> left.sequence < right.sequence }) {
      "Realtime actions are not strictly ordered."
    }
    return VoiceRuntimeRealtimeActionsResult(parseState(objectField(root, "state")), actions)
  }

  fun encodeAck(input: VoiceRuntimeRealtimeActionAckInput): ByteArray =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("actionSequence", input.actionSequence)
      .apply {
        when (input) {
          is VoiceRuntimeRealtimeActionAckInput.NavigateThread -> {
            put("action", "navigate-thread")
            put("outcome", input.outcome.wireValue)
            input.message?.let { put("message", it) }
          }
          is VoiceRuntimeRealtimeActionAckInput.ConfirmationRequired -> {
            put("action", "confirmation-required")
            put("confirmationId", input.confirmationId)
            put("decision", input.decision)
          }
        }
      }
      .bytes()

  fun decodeAck(bytes: ByteArray): VoiceRuntimeRealtimeActionAckResult {
    val root = objectFrom(bytes, ACK_RESULT_FIELDS)
    return VoiceRuntimeRealtimeActionAckResult(
      identifierField(root, "actionId"),
      positiveLongField(root, "actionSequence"),
      outcomeField(root, "outcome"),
      booleanField(root, "replayed"),
    )
  }

  fun encodeFocus(input: VoiceRuntimeRealtimeFocusInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .put("focus", input.focus?.let(::focusObject) ?: JSONObject.NULL)
      .bytes()

  fun decodeFocus(bytes: ByteArray): VoiceRuntimeRealtimeFocusResult {
    val root = objectFrom(bytes, FOCUS_RESULT_FIELDS)
    return VoiceRuntimeRealtimeFocusResult(
      parseState(objectField(root, "state")),
      nullableFocusField(root, "focus"),
      booleanField(root, "replayed"),
    )
  }

  fun encodeHandoff(input: VoiceRuntimeRealtimeHandoffExchangeInput) =
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

  fun decodeHandoff(bytes: ByteArray): VoiceRuntimeRealtimeHandoffExchangeResult {
    val root = objectFrom(bytes, HANDOFF_RESULT_FIELDS)
    val reservation = objectField(root, "reservation").requireExactFields(TRANSITION_RESERVATION_FIELDS)
    val target = objectField(reservation, "target").requireExactFields(THREAD_TARGET_FIELDS)
    require(stringField(target, "mode", 32) == "thread") { "Invalid transition target mode." }
    val targetAutoRearm = booleanField(target, "autoRearm")
    val projectId = identifierField(root, "projectId")
    val threadId = identifierField(root, "threadId")
    require(identifierField(target, "projectId") == projectId) { "Handoff project mismatch." }
    require(identifierField(target, "threadId") == threadId) { "Handoff thread mismatch." }
    require(targetAutoRearm == booleanField(root, "autoRearm")) { "Handoff rearm mismatch." }
    val targetValue = VoiceRuntimeRealtimeThreadTarget(
      identifierField(target, "environmentId"),
      projectId,
      threadId,
      speechPresetField(target, "speechPreset"),
      targetAutoRearm,
      endpointPolicyField(target, "endpointPolicy"),
      booleanField(target, "speechEnabled"),
      rangedLongField(target, "rearmGuardMs", 0, 60_000),
    )
    return VoiceRuntimeRealtimeHandoffExchangeResult(
      identifierField(root, "actionId"),
      positiveLongField(root, "actionSequence"),
      projectId,
      threadId,
      targetAutoRearm,
      VoiceRuntimeRealtimeTransitionReservation(
        positiveLongField(reservation, "generation"),
        identifierField(reservation, "modeSessionId"),
        targetValue,
      ),
      booleanField(root, "replayed"),
    )
  }

  fun encodeHandoffCommit(input: VoiceRuntimeRealtimeHandoffCommitInput) =
    leaseFencedObject(input.fence)
      .put("actionSequence", input.actionSequence)
      .put("nextGeneration", input.nextGeneration)
      .put("threadModeSessionId", input.threadModeSessionId)
      .bytes()

  fun decodeHandoffCommit(bytes: ByteArray): VoiceRuntimeRealtimeHandoffCommitResult {
    val root = objectFrom(bytes, HANDOFF_COMMIT_RESULT_FIELDS)
    return VoiceRuntimeRealtimeHandoffCommitResult(
      identifierField(root, "actionId"),
      positiveLongField(root, "actionSequence"),
      booleanField(root, "committed").also { require(it) { "Handoff was not committed." } },
      booleanField(root, "replayed"),
    )
  }

  fun encodeClose(input: VoiceRuntimeRealtimeCloseInput) =
    leaseFencedObject(input.fence)
      .put("clientOperationId", input.clientOperationId)
      .bytes()

  fun decodeClose(bytes: ByteArray) =
    objectFrom(bytes, CLOSE_RESULT_FIELDS).let {
      VoiceRuntimeRealtimeCloseResult(
        parseState(objectField(it, "state")),
        booleanField(it, "closed"),
        booleanField(it, "replayed"),
      )
    }

  private fun parseAction(value: JSONObject): VoiceRuntimeRealtimeAction {
    val type = stringField(value, "type", 64)
    val sequence = positiveLongField(value, "sequence")
    val occurredAt = instantField(value, "occurredAt")
    return when (type) {
      "navigate-thread" -> {
        value.requireExactFields(NAVIGATE_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.NavigateThread(
          sequence, occurredAt, identifierField(value, "actionId"),
          identifierField(value, "projectId"), identifierField(value, "threadId"),
          instantField(value, "expiresAt"),
        )
      }
      "handoff-to-thread-voice" -> {
        value.requireExactFields(HANDOFF_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
          sequence, occurredAt, identifierField(value, "actionId"),
          identifierField(value, "projectId"), identifierField(value, "threadId"),
          booleanField(value, "autoRearm"), instantField(value, "expiresAt"),
        )
      }
      "stop-realtime-voice" -> {
        value.requireExactFields(STOP_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.StopRealtimeVoice(sequence, occurredAt)
      }
      "confirmation-required" -> {
        value.requireExactFields(CONFIRMATION_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.ConfirmationRequired(
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

  private fun parseState(value: JSONObject): VoiceRuntimeRealtimeSessionState {
    value.requireExactFields(SESSION_STATE_FIELDS)
    require(stringField(value, "mode", 64) == "realtime-agent") {
      "Unexpected Realtime session mode."
    }
    val phase = stringField(value, "phase", 64)
    require(phase in SESSION_PHASES) { "Invalid Realtime session phase." }
    return VoiceRuntimeRealtimeSessionState(
      sessionIdentifier(stringField(value, "sessionId", 128)),
      requireIdentifier(stringField(value, "conversationId", 1_024), "conversation ID", 1_024),
      phase,
      positiveLongField(value, "leaseGeneration"),
      nonNegativeLongField(value, "sequence"),
    )
  }

  private fun fencedObject(fence: VoiceRealtimeTransportFence) =
    JSONObject()
      .put("runtimeId", fence.runtimeId)
      .put("runtimeInstanceId", fence.runtimeInstanceId)
      .put("generation", fence.generation)
      .put("modeSessionId", fence.modeSessionId)

  private fun leaseFencedObject(fence: VoiceRuntimeRealtimeLeaseFence) =
    fencedObject(fence.runtime).put("leaseGeneration", fence.leaseGeneration)

  private fun focusObject(focus: VoiceRuntimeRealtimeFocus) =
    JSONObject().put("projectId", focus.projectId).put("threadId", focus.threadId ?: JSONObject.NULL)

  private fun endpointPolicyObject(policy: VoiceRuntimeRealtimeEndpointPolicy) =
    JSONObject()
      .put("endSilenceMs", policy.endSilenceMs)
      .put("noSpeechTimeoutMs", policy.noSpeechTimeoutMs ?: JSONObject.NULL)
      .put("maximumUtteranceMs", policy.maximumUtteranceMs)

  private fun nullableFocusField(source: JSONObject, name: String): VoiceRuntimeRealtimeFocus? {
    if (source.isNull(name)) return null
    val focus = objectField(source, name).requireExactFields(FOCUS_FIELDS)
    return VoiceRuntimeRealtimeFocus(
      identifierField(focus, "projectId"),
      if (focus.isNull("threadId")) null else identifierField(focus, "threadId"),
    )
  }

  private fun endpointPolicyField(source: JSONObject, name: String): VoiceRuntimeRealtimeEndpointPolicy {
    val policy = objectField(source, name).requireExactFields(ENDPOINT_POLICY_FIELDS)
    return VoiceRuntimeRealtimeEndpointPolicy(
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
  private fun outcomeField(source: JSONObject, name: String) =
    VoiceRuntimeRealtimeActionOutcome.entries.singleOrNull {
      it.wireValue == stringField(source, name, 32)
    } ?: throw IllegalArgumentException("Invalid Realtime action outcome.")
  private fun speechPresetField(source: JSONObject, name: String) =
    stringField(source, name, 32).also { require(it in SPEECH_PRESETS) { "Invalid speech preset." } }

  private val START_RESULT_FIELDS =
    setOf("state", "transport", "expiresAt", "heartbeatIntervalSeconds")
  private val SESSION_STATE_FIELDS =
    setOf("sessionId", "conversationId", "mode", "phase", "leaseGeneration", "sequence")
  private val TRANSPORT_FIELDS = setOf("kind", "signalingPath")
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
    setOf("actionId", "actionSequence", "projectId", "threadId", "autoRearm", "reservation", "replayed")
  private val HANDOFF_COMMIT_RESULT_FIELDS =
    setOf("actionId", "actionSequence", "committed", "replayed")
  private val TRANSITION_RESERVATION_FIELDS = setOf("generation", "modeSessionId", "target")
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

internal fun interface VoiceRuntimeRealtimeHttp {
  fun execute(request: VoiceRuntimeHttpRequest): VoiceRuntimeHttpResult
  fun newCall(request: VoiceRuntimeHttpRequest): VoiceRuntimeHttpCall? = null
}

internal class VoiceRuntimeRealtimeCall<T>(
  private val executeBlock: () -> VoiceRuntimeRealtimeResult<T>,
  private val cancelBlock: () -> Unit,
) {
  fun execute() = executeBlock()
  fun cancel() = cancelBlock()
}

internal class VoiceRuntimeRealtimeDelegate(
  private val http: VoiceRuntimeRealtimeHttp = productionHttp(),
) {
  fun start(origin: String, sessionCredential: String, input: VoiceRuntimeRealtimeStartInput) =
    newStartCall(origin, sessionCredential, input).execute()

  fun newStartCall(origin: String, sessionCredential: String, input: VoiceRuntimeRealtimeStartInput) =
    jsonCall(
      request(origin, BASE_PATH, VoiceRuntimeHttpMethod.POST, sessionCredential,
        VoiceRuntimeRealtimeJson.encodeStart(input), MAXIMUM_SMALL_BYTES),
      VoiceRuntimeRealtimeJson::decodeStart,
    )

  fun offer(origin: String, sessionCredential: String, sessionId: String, input: VoiceRuntimeRealtimeOfferInput) =
    newOfferCall(origin, sessionCredential, sessionId, input).execute()

  fun newOfferCall(origin: String, sessionCredential: String, sessionId: String, input: VoiceRuntimeRealtimeOfferInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "webrtc-offer"), VoiceRuntimeHttpMethod.POST,
        sessionCredential, VoiceRuntimeRealtimeJson.encodeOffer(input), MAXIMUM_SDP_BYTES),
      VoiceRuntimeRealtimeJson::decodeAnswer,
    ) { it.sessionId == sessionId && it.leaseGeneration == input.fence.leaseGeneration }

  fun heartbeat(origin: String, sessionCredential: String, sessionId: String, fence: VoiceRuntimeRealtimeLeaseFence) =
    jsonCall(
      request(origin, sessionPath(sessionId, "heartbeat"), VoiceRuntimeHttpMethod.POST,
        sessionCredential, VoiceRuntimeRealtimeJson.encodeHeartbeat(fence), MAXIMUM_SMALL_BYTES),
      VoiceRuntimeRealtimeJson::decodeHeartbeat,
    ) { matchesState(it.state, sessionId, fence) }.execute()

  fun actions(origin: String, sessionCredential: String, sessionId: String, query: VoiceRuntimeRealtimeActionsQuery) =
    jsonCall(
      VoiceRuntimeHttpRequest(
        origin, sessionPath(sessionId, "actions"), VoiceRuntimeHttpMethod.GET,
        VoiceRuntimeSessionCredential(sessionCredential), null, 0, MAXIMUM_ACTIONS_BYTES,
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
      VoiceRuntimeRealtimeJson::decodeActions,
    ) { matchesState(it.state, sessionId, query.fence) }.execute()

  fun acknowledgeAction(
    origin: String,
    sessionCredential: String,
    sessionId: String,
    actionId: String,
    input: VoiceRuntimeRealtimeActionAckInput,
  ) = jsonCall(
    request(origin, sessionPath(sessionId, "actions/${encodedSegment(actionId)}/ack"),
      VoiceRuntimeHttpMethod.POST, sessionCredential,
      VoiceRuntimeRealtimeJson.encodeAck(input), MAXIMUM_SMALL_BYTES),
    VoiceRuntimeRealtimeJson::decodeAck,
  ) {
    val expectedOutcome = when (input) {
      is VoiceRuntimeRealtimeActionAckInput.NavigateThread -> input.outcome
      is VoiceRuntimeRealtimeActionAckInput.ConfirmationRequired ->
        if (input.decision == "approve") VoiceRuntimeRealtimeActionOutcome.SUCCEEDED
        else VoiceRuntimeRealtimeActionOutcome.FAILED
    }
    it.actionId == actionId && it.actionSequence == input.actionSequence &&
      it.outcome == expectedOutcome
  }.execute()

  fun updateFocus(origin: String, sessionCredential: String, sessionId: String, input: VoiceRuntimeRealtimeFocusInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "focus"), VoiceRuntimeHttpMethod.PUT,
        sessionCredential, VoiceRuntimeRealtimeJson.encodeFocus(input), MAXIMUM_SMALL_BYTES),
      VoiceRuntimeRealtimeJson::decodeFocus,
    ) { matchesState(it.state, sessionId, input.fence) && it.focus == input.focus }.execute()

  fun exchangeHandoff(
    origin: String,
    sessionCredential: String,
    sessionId: String,
    actionId: String,
    input: VoiceRuntimeRealtimeHandoffExchangeInput,
  ) = jsonCall(
    request(origin, sessionPath(sessionId, "handoffs/${encodedSegment(actionId)}/exchange"),
      VoiceRuntimeHttpMethod.POST, sessionCredential,
      VoiceRuntimeRealtimeJson.encodeHandoff(input), MAXIMUM_SMALL_BYTES),
    VoiceRuntimeRealtimeJson::decodeHandoff,
  ) {
    it.actionId == actionId && it.actionSequence == input.actionSequence &&
      it.reservation.generation == input.nextGeneration &&
      it.reservation.modeSessionId == input.threadModeSessionId &&
      it.reservation.target.environmentId == input.environmentId &&
      it.reservation.target.speechPreset == input.speechPreset &&
      it.reservation.target.endpointPolicy == input.endpointPolicy &&
      it.reservation.target.speechEnabled == input.speechEnabled &&
      it.reservation.target.rearmGuardMs == input.rearmGuardMs
  }.execute()

  fun commitHandoff(
    origin: String,
    sessionCredential: String,
    sessionId: String,
    actionId: String,
    input: VoiceRuntimeRealtimeHandoffCommitInput,
  ) = jsonCall(
    request(origin, sessionPath(sessionId, "handoffs/${encodedSegment(actionId)}/commit"),
      VoiceRuntimeHttpMethod.POST, sessionCredential,
      VoiceRuntimeRealtimeJson.encodeHandoffCommit(input), MAXIMUM_SMALL_BYTES),
    VoiceRuntimeRealtimeJson::decodeHandoffCommit,
  ) {
    it.actionId == actionId && it.actionSequence == input.actionSequence && it.committed
  }.execute()

  fun close(origin: String, sessionCredential: String, sessionId: String, input: VoiceRuntimeRealtimeCloseInput) =
    jsonCall(
      request(origin, sessionPath(sessionId, "close"), VoiceRuntimeHttpMethod.POST,
        sessionCredential, VoiceRuntimeRealtimeJson.encodeClose(input), MAXIMUM_SMALL_BYTES),
      VoiceRuntimeRealtimeJson::decodeClose,
    ) { matchesState(it.state, sessionId, input.fence) }.execute()

  private fun request(
    origin: String,
    path: String,
    method: VoiceRuntimeHttpMethod,
    sessionCredential: String,
    body: ByteArray,
    maximumBytes: Int,
  ) = VoiceRuntimeHttpRequest(
    origin, path, method, VoiceRuntimeSessionCredential(sessionCredential),
    VoiceRuntimeByteArrayBody(body, "application/json"), maximumBytes.toLong(), maximumBytes,
  )

  private fun <T> jsonCall(
    request: VoiceRuntimeHttpRequest,
    decode: (ByteArray) -> T,
    validate: (T) -> Boolean = { true },
  ): VoiceRuntimeRealtimeCall<T> {
    val call = http.newCall(request)
    return VoiceRuntimeRealtimeCall(
      {
        executeJson(call?.execute() ?: http.execute(request), decode).validate(validate)
      },
      { call?.cancel() },
    )
  }

  private fun <T> executeJson(result: VoiceRuntimeHttpResult, decode: (ByteArray) -> T) =
    when (result) {
      is VoiceRuntimeHttpResult.Failure ->
        VoiceRuntimeRealtimeResult.Failure(result.kind, result.statusCode)
      is VoiceRuntimeHttpResult.Success -> try {
        require(result.contentType?.substringBefore(';')?.trim() == "application/json") {
          "Invalid Realtime response content type."
        }
        VoiceRuntimeRealtimeResult.Success(decode(result.body))
      } catch (_: Exception) {
        VoiceRuntimeRealtimeResult.Failure(VoiceRuntimeHttpFailureKind.PERMANENT, result.statusCode)
      }
    }

  private fun <T> VoiceRuntimeRealtimeResult<T>.validate(predicate: (T) -> Boolean) =
    when (this) {
      is VoiceRuntimeRealtimeResult.Failure -> this
      is VoiceRuntimeRealtimeResult.Success -> if (predicate(value)) this
      else VoiceRuntimeRealtimeResult.Failure(VoiceRuntimeHttpFailureKind.PERMANENT, null)
    }

  private companion object {
    fun productionHttp(): VoiceRuntimeRealtimeHttp {
      val transport = VoiceRuntimeHttpTransport()
      return object : VoiceRuntimeRealtimeHttp {
        override fun execute(request: VoiceRuntimeHttpRequest) = transport.execute(request)
        override fun newCall(request: VoiceRuntimeHttpRequest) = transport.newCall(request)
      }
    }
  }
}

private fun matchesState(
  state: VoiceRuntimeRealtimeSessionState,
  sessionId: String,
  fence: VoiceRuntimeRealtimeLeaseFence,
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
