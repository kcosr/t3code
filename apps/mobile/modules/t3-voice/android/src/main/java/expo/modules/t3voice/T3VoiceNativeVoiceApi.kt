package expo.modules.t3voice

import java.math.BigDecimal
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.Locale
import org.json.JSONArray
import org.json.JSONObject

internal interface T3VoiceThreadSessionApi {
  fun createMediaTicket(
    calls: T3VoiceHttpCallRegistry,
    operation: T3VoiceMediaOperation,
    requestId: String,
  ): T3VoiceMediaTicket

  fun transcribe(
    calls: T3VoiceHttpCallRegistry,
    recording: T3VoiceRecordingResult,
    requestId: String,
    ticket: T3VoiceMediaTicket,
  ): String

  fun dispatchThreadTurn(
    calls: T3VoiceHttpCallRegistry,
    target: T3VoiceThreadTarget,
    transcript: String,
    commandId: String,
    messageId: String,
    createdAt: String,
  ): Long

  fun getMessageTurn(
    calls: T3VoiceHttpCallRegistry,
    threadId: String,
    messageId: String,
  ): T3VoiceMessageTurn

  fun synthesize(
    calls: T3VoiceHttpCallRegistry,
    ticket: T3VoiceMediaTicket,
    requestId: String,
    playbackId: String,
    segment: T3VoiceSpeechSegment,
    onPcm: T3VoiceHttpChunkCallback,
  ): Long
}

internal interface T3VoiceRealtimeSessionApi {
  fun createRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    target: T3VoiceRealtimeTarget,
    idempotencyKey: String,
  ): T3VoiceApiRealtimeSession

  fun offerRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    session: T3VoiceApiRealtimeSession,
    sdp: String,
  ): String

  fun heartbeatRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
  ): T3VoiceApiSessionState

  fun closeRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
  )

  fun updateRealtimeFocus(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    focus: T3VoiceRealtimeFocus?,
  ): T3VoiceApiSessionState

  fun acknowledgeRealtimeClientAction(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  )

  fun decideRealtimeConfirmation(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  )

  fun realtimeEvents(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    afterSequence: Long,
  ): T3VoiceApiRealtimeEvents
}

/** Exact Android wire adapter for the voice and orchestration HTTP contracts. */
internal class T3VoiceNativeVoiceApi(
  config: T3VoiceNativeSessionConfig,
  private val nowEpochMillis: () -> Long = T3VoiceTime::nowEpochMillis,
  transportFactory: (String, String) -> T3VoiceHttpTransport = { baseUrl, token ->
    T3VoiceHttpTransport(baseUrl, token)
  },
) : T3VoiceThreadSessionApi, T3VoiceRealtimeSessionApi {
  private val expiresAt =
    T3VoiceTime.parseIsoEpochMillis(config.expiresAt, "native session expiration")
  private val transport = transportFactory(config.baseUrl, config.accessToken)

  init {
    ensureCredentialValid()
  }

  override fun createMediaTicket(
    calls: T3VoiceHttpCallRegistry,
    operation: T3VoiceMediaOperation,
    requestId: String,
  ): T3VoiceMediaTicket {
    ensureCredentialValid()
    val response =
      calls.execute(
        transport.postJson(
          MEDIA_TICKET_PATH,
          JSONObject()
            .put("operation", operation.wireValue)
            .put("requestId", requireId(requestId, "requestId"))
            .toString(),
        ),
      ).jsonObject()
    require(response.requiredString("operation") == operation.wireValue) {
      "Voice media ticket operation did not match its request."
    }
    response.requiredTrimmedString("ticketId")
    return T3VoiceMediaTicket(
      token = response.requiredTrimmedString("token"),
      expiresAt = response.requiredIsoInstant("expiresAt"),
    )
  }

  override fun transcribe(
    calls: T3VoiceHttpCallRegistry,
    recording: T3VoiceRecordingResult,
    requestId: String,
    ticket: T3VoiceMediaTicket,
  ): String {
    ensureCredentialValid()
    ensureTicketValid(ticket)
    val metadata =
      JSONObject()
        .put("requestId", requireId(requestId, "requestId"))
        .put("format", "audio/mp4")
        .toString()
    val response =
      calls.execute(
        transport.uploadAudio(
          pathname = TRANSCRIPTION_PATH,
          fileUri = recording.uri,
          mimeType = "audio/mp4",
          mediaTicket = ticket.token,
          fields = mapOf("metadata" to metadata),
        ),
      ).body.utf8()

    var finalText: String? = null
    response.lineSequence().filter(String::isNotBlank).forEach { line ->
      val event = JSONObject(line)
      when (event.requiredString("type")) {
        "delta" -> {
          require(event.requiredString("requestId") == requestId) {
            "Voice transcription delta requestId did not match."
          }
          event.requiredTrimmedString("text")
        }
        "final" -> {
          val result = event.requiredObject("result")
          require(result.requiredString("requestId") == requestId) {
            "Voice transcription result requestId did not match."
          }
          check(finalText == null) { "Voice transcription returned duplicate final events." }
          finalText =
            result.requiredTrimmedString("text").also { text ->
              require(
                text.length <= T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS &&
                  text.toByteArray(Charsets.UTF_8).size <= MAXIMUM_TRANSCRIPT_BYTES
              ) { "Voice transcription final text exceeded its native runtime limit." }
            }
        }
        else -> error("Voice transcription returned an unknown event type.")
      }
    }
    return checkNotNull(finalText) { "Voice transcription returned no final event." }
  }

  override fun dispatchThreadTurn(
    calls: T3VoiceHttpCallRegistry,
    target: T3VoiceThreadTarget,
    transcript: String,
    commandId: String,
    messageId: String,
    createdAt: String,
  ): Long {
    ensureCredentialValid()
    require(transcript.isNotBlank()) { "Thread transcript must be non-empty." }
    val payload =
      JSONObject()
        .put("type", "thread.turn.start")
        .put("commandId", requireId(commandId, "commandId"))
        .put("threadId", requireId(target.threadId, "threadId"))
        .put(
          "message",
          JSONObject()
            .put("messageId", requireId(messageId, "messageId"))
            .put("role", "user")
            .put("text", transcript)
            .put("attachments", JSONArray()),
        )
        .put("modelSelection", JSONObject(target.modelSelection.toCanonicalWireBody()))
        .put("runtimeMode", target.runtimeMode.wireValue())
        .put("interactionMode", target.interactionMode.wireValue())
        .put("createdAt", requireIsoInstant(createdAt, "createdAt"))
    val response = calls.execute(transport.postJson(DISPATCH_PATH, payload.toString())).jsonObject()
    return response.requiredNonNegativeLong("sequence")
  }

  override fun getMessageTurn(
    calls: T3VoiceHttpCallRegistry,
    threadId: String,
    messageId: String,
  ): T3VoiceMessageTurn {
    ensureCredentialValid()
    val path =
      "/api/orchestration/threads/${threadId.pathSegment()}" +
        "/messages/${messageId.pathSegment()}/turn"
    val response = calls.execute(transport.getJson(path)).jsonObject()
    val returnedMessageId = response.requiredString("messageId")
    require(returnedMessageId == messageId) { "Thread outcome messageId did not match." }
    val state =
      when (response.requiredString("state")) {
        "pending" -> T3VoiceMessageTurnState.PENDING
        "running" -> T3VoiceMessageTurnState.RUNNING
        "approval-required" -> T3VoiceMessageTurnState.APPROVAL_REQUIRED
        "user-input-required" -> T3VoiceMessageTurnState.USER_INPUT_REQUIRED
        "completed" -> T3VoiceMessageTurnState.COMPLETED
        "interrupted" -> T3VoiceMessageTurnState.INTERRUPTED
        "failed" -> T3VoiceMessageTurnState.FAILED
        "ambiguous" -> T3VoiceMessageTurnState.AMBIGUOUS
        else -> error("Thread outcome returned an unknown state.")
      }
    val assistant =
      response.nullableObject("assistantMessage")?.let { message ->
        val text = message.requiredString("text")
        require(text.length <= MAXIMUM_ASSISTANT_RESPONSE_CHARS) {
          "Thread outcome assistant text exceeded its contract limit."
        }
        message.requiredBoolean("truncated")
        message.requiredIsoInstant("createdAt")
        message.requiredIsoInstant("updatedAt")
        T3VoiceAssistantMessage(
          messageId = message.requiredString("messageId"),
          text = text,
        )
      }
    return T3VoiceMessageTurn(
      messageId = returnedMessageId,
      state = state,
      turnId = response.nullableString("turnId"),
      assistantMessage = assistant,
    )
  }

  override fun synthesize(
    calls: T3VoiceHttpCallRegistry,
    ticket: T3VoiceMediaTicket,
    requestId: String,
    playbackId: String,
    segment: T3VoiceSpeechSegment,
    onPcm: T3VoiceHttpChunkCallback,
  ): Long {
    ensureCredentialValid()
    ensureTicketValid(ticket)
    val request =
      JSONObject()
        .put("requestId", requireId(requestId, "requestId"))
        .put("playbackId", requireId(playbackId, "playbackId"))
        .put("segmentIndex", segment.index)
        .put("finalSegment", segment.finalSegment)
        .put("text", segment.text)
        .put("preset", "default")
        .toString()
    val response =
      calls.execute(
        transport.streamPcm(
          pathname = SPEECH_PATH,
          json = request,
          mediaTicket = ticket.token,
          onChunk = onPcm,
        ),
      )
    require(response.headers["x-t3-audio-format"] == PCM_FORMAT) {
      "Voice speech response used an unsupported PCM format."
    }
    return response.receivedBytes
  }

  override fun createRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    target: T3VoiceRealtimeTarget,
    idempotencyKey: String,
  ): T3VoiceApiRealtimeSession {
    ensureCredentialValid()
    val payload =
      JSONObject()
        .put("mode", "realtime-agent")
        .put("conversation", target.conversation.toJson())
        .put(
          "media",
          JSONObject()
            .put("transports", JSONArray().put("webrtc-sdp-v1"))
            .put("audioFormats", JSONArray().put(PCM_MEDIA_TYPE))
            .put("supportsInputRouteSelection", true)
            .put("supportsOutputRouteSelection", true),
        )
        .put("idempotencyKey", requireId(idempotencyKey, "idempotencyKey"))
    target.focus?.let { focus ->
      payload.put("projectId", requireId(focus.projectId, "projectId"))
      payload.put("threadId", requireId(focus.threadId, "threadId"))
    }
    val response = calls.execute(transport.postJson(SESSION_PATH, payload.toString())).jsonObject()
    val transportJson = response.requiredObject("transport")
    require(transportJson.requiredString("kind") == "webrtc-sdp-v1") {
      "Realtime server returned an unsupported media transport."
    }
    return T3VoiceApiRealtimeSession(
      state = response.requiredObject("state").sessionState(),
      signalingPath = transportJson.requiredTrimmedString("signalingPath"),
      expiresAt = response.requiredIsoInstant("expiresAt"),
      heartbeatIntervalSeconds = response.requiredPositiveLong("heartbeatIntervalSeconds"),
    )
  }

  override fun offerRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    session: T3VoiceApiRealtimeSession,
    sdp: String,
  ): String {
    ensureCredentialValid()
    require(sdp.isNotBlank()) { "Realtime offer SDP must be non-empty." }
    val payload =
      JSONObject()
        .put("sessionId", session.state.sessionId)
        .put("leaseGeneration", session.state.leaseGeneration)
        .put("sdp", sdp)
        .toString()
    val answer =
      calls.execute(transport.postJson(session.signalingPath, payload)).jsonObject()
    require(answer.requiredString("sessionId") == session.state.sessionId) {
      "Realtime answer sessionId did not match."
    }
    require(answer.requiredPositiveLong("leaseGeneration") == session.state.leaseGeneration) {
      "Realtime answer lease generation did not match."
    }
    return t3VoiceValidatedSdp(answer.requiredString("sdp"))
  }

  override fun heartbeatRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
  ): T3VoiceApiSessionState =
    controlWithLease(calls, sessionId, "heartbeat", leaseGeneration)

  override fun closeRealtimeSession(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
  ) {
    ensureCredentialValid()
    val path = "/api/voice/sessions/${sessionId.pathSegment()}"
    val response =
      calls.execute(
        transport.deleteJson(
          pathname = path,
          json = JSONObject().put("leaseGeneration", leaseGeneration).toString(),
        ),
      ).jsonObject()
    require(response.requiredBoolean("closed")) { "Realtime session did not close." }
    response.requiredObject("state").sessionState(sessionId, leaseGeneration)
  }

  override fun updateRealtimeFocus(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    focus: T3VoiceRealtimeFocus?,
  ): T3VoiceApiSessionState {
    ensureCredentialValid()
    val payload = JSONObject().put("leaseGeneration", leaseGeneration)
    focus?.let {
      payload.put("projectId", requireId(it.projectId, "projectId"))
      payload.put("threadId", requireId(it.threadId, "threadId"))
    }
    val path = "/api/voice/sessions/${sessionId.pathSegment()}/focus"
    return calls.execute(transport.postJson(path, payload.toString())).jsonObject()
      .requiredObject("state")
      .sessionState(sessionId, leaseGeneration)
  }

  override fun acknowledgeRealtimeClientAction(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ) {
    ensureCredentialValid()
    val payload =
      JSONObject()
        .put("leaseGeneration", leaseGeneration)
        .put("outcome", outcome.wireValue())
    message?.let { payload.put("message", it) }
    val path =
      "/api/voice/sessions/${sessionId.pathSegment()}" +
        "/client-actions/${actionId.pathSegment()}/ack"
    val response = calls.execute(transport.postJson(path, payload.toString())).jsonObject()
    require(response.requiredString("actionId") == actionId) {
      "Realtime client-action acknowledgement did not match."
    }
    require(response.requiredString("outcome") == outcome.wireValue()) {
      "Realtime client-action outcome did not match."
    }
  }

  override fun decideRealtimeConfirmation(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  ) {
    ensureCredentialValid()
    val path =
      "/api/voice/sessions/${sessionId.pathSegment()}" +
        "/confirmations/${confirmationId.pathSegment()}"
    val response =
      calls.execute(
        transport.postJson(
          path,
          JSONObject().put("decision", decision.wireValue()).toString(),
        ),
      ).jsonObject()
    require(response.requiredString("confirmationId") == confirmationId) {
      "Realtime confirmation response did not match."
    }
  }

  override fun realtimeEvents(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    leaseGeneration: Long,
    afterSequence: Long,
  ): T3VoiceApiRealtimeEvents {
    ensureCredentialValid()
    require(afterSequence >= 0) { "Realtime event sequence must be non-negative." }
    val path = "/api/voice/sessions/${sessionId.pathSegment()}/events"
    val response =
      calls.execute(
        transport.getJson(
          path,
          mapOf(
            "afterSequence" to afterSequence.toString(),
            "waitMilliseconds" to EVENT_WAIT_MILLIS.toString(),
          ),
        ),
      ).jsonObject()
    val eventsJson = response.requiredArray("events")
    val events = ArrayList<T3VoiceApiRealtimeEvent>(eventsJson.length())
    for (index in 0 until eventsJson.length()) {
      events += eventsJson.requiredObject(index).realtimeEvent(sessionId, leaseGeneration)
    }
    return T3VoiceApiRealtimeEvents(
      state = response.requiredObject("state").sessionState(sessionId, leaseGeneration),
      events = events,
    )
  }

  private fun controlWithLease(
    calls: T3VoiceHttpCallRegistry,
    sessionId: String,
    action: String,
    leaseGeneration: Long,
  ): T3VoiceApiSessionState {
    ensureCredentialValid()
    val path = "/api/voice/sessions/${sessionId.pathSegment()}/$action"
    return calls.execute(
      transport.postJson(
        path,
        JSONObject().put("leaseGeneration", leaseGeneration).toString(),
      ),
    ).jsonObject().sessionState(sessionId, leaseGeneration)
  }

  private fun ensureCredentialValid() {
    if (nowEpochMillis() >= expiresAt) {
      throw T3VoiceNativeApiException(
        code = "native-session-expired",
        retryable = false,
        message = "The native voice session expired.",
      )
    }
  }

  private fun ensureTicketValid(ticket: T3VoiceMediaTicket) {
    val expiration = T3VoiceTime.parseIsoEpochMillis(ticket.expiresAt, "media ticket expiration")
    if (nowEpochMillis() >= expiration) {
      throw T3VoiceNativeApiException(
        code = "media-ticket-expired",
        retryable = true,
        message = "The voice media ticket expired.",
      )
    }
  }

  companion object {
    internal fun decodeError(body: ByteArray, contentType: String?): T3VoiceTypedServerError? {
      if (contentType?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT) != "application/json") {
        return null
      }
      return runCatching {
        val json = JSONObject(body.utf8())
        T3VoiceTypedServerError(
          code = json.optionalString("code"),
          reason = json.optionalString("reason"),
          retryable = json.optionalBoolean("retryable"),
          message = json.optionalString("message"),
        )
      }.getOrNull()
    }

    private const val MEDIA_TICKET_PATH = "/api/voice/media-tickets"
    private const val TRANSCRIPTION_PATH = "/api/voice/transcriptions"
    private const val SPEECH_PATH = "/api/voice/speech"
    private const val DISPATCH_PATH = "/api/orchestration/dispatch"
    private const val SESSION_PATH = "/api/voice/sessions"
    private const val EVENT_WAIT_MILLIS = 20_000
    private const val MAXIMUM_ASSISTANT_RESPONSE_CHARS = 32_000
    private const val MAXIMUM_TRANSCRIPT_BYTES = 64 * 1_024
    private const val PCM_MEDIA_TYPE = "audio/pcm;rate=24000;encoding=s16le;channels=1"
    private const val PCM_FORMAT = "s16le;rate=24000;channels=1"
  }
}

private fun T3VoiceConversationSelection.toJson(): JSONObject =
  when (this) {
    is T3VoiceConversationSelection.New ->
      JSONObject()
        .put("type", "new")
        .put("retention", retention.wireValue())
        .also { json -> title?.let { json.put("title", it) } }
    is T3VoiceConversationSelection.Continue ->
      JSONObject()
        .put("type", "continue")
        .put("conversationId", requireId(conversationId, "conversationId"))
        .put("takeover", takeover)
  }

private fun T3VoiceThreadRuntimeMode.wireValue(): String =
  when (this) {
    T3VoiceThreadRuntimeMode.APPROVAL_REQUIRED -> "approval-required"
    T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS -> "auto-accept-edits"
    T3VoiceThreadRuntimeMode.FULL_ACCESS -> "full-access"
  }

private fun T3VoiceThreadInteractionMode.wireValue(): String =
  when (this) {
    T3VoiceThreadInteractionMode.DEFAULT -> "default"
    T3VoiceThreadInteractionMode.PLAN -> "plan"
  }

private fun T3VoiceConversationRetention.wireValue(): String =
  when (this) {
    T3VoiceConversationRetention.EPHEMERAL -> "ephemeral"
    T3VoiceConversationRetention.DURABLE -> "durable"
  }

private fun T3VoiceClientActionOutcome.wireValue(): String =
  when (this) {
    T3VoiceClientActionOutcome.SUCCEEDED -> "succeeded"
    T3VoiceClientActionOutcome.FAILED -> "failed"
  }

private fun T3VoiceConfirmationDecision.wireValue(): String =
  when (this) {
    T3VoiceConfirmationDecision.APPROVE -> "approve"
    T3VoiceConfirmationDecision.REJECT -> "reject"
  }

private fun JSONObject.sessionState(
  expectedSessionId: String? = null,
  expectedLeaseGeneration: Long? = null,
): T3VoiceApiSessionState {
  require(requiredString("mode") == "realtime-agent") {
    "Realtime server state returned the wrong mode."
  }
  val phase = requiredString("phase")
  require(phase in SESSION_PHASES) { "Realtime server state returned an unknown phase." }
  val state = T3VoiceApiSessionState(
    sessionId = requiredTrimmedString("sessionId"),
    conversationId = requiredTrimmedString("conversationId"),
    phase = phase,
    leaseGeneration = requiredPositiveLong("leaseGeneration"),
    sequence = requiredNonNegativeLong("sequence"),
  )
  require(expectedSessionId == null || state.sessionId == expectedSessionId) {
    "Realtime server state sessionId did not match."
  }
  require(
    expectedLeaseGeneration == null || state.leaseGeneration == expectedLeaseGeneration
  ) { "Realtime server state lease generation did not match." }
  return state
}

private fun JSONObject.realtimeEvent(
  expectedSessionId: String,
  expectedLeaseGeneration: Long,
): T3VoiceApiRealtimeEvent {
  require(requiredString("sessionId") == expectedSessionId) {
    "Realtime event sessionId did not match."
  }
  require(requiredPositiveLong("leaseGeneration") == expectedLeaseGeneration) {
    "Realtime event lease generation did not match."
  }
  val sequence = requiredNonNegativeLong("sequence")
  requiredIsoInstant("occurredAt")
  return when (requiredString("type")) {
    "state" -> {
      val phase = requiredString("phase")
      require(phase in SESSION_PHASES) { "Realtime state event returned an unknown phase." }
      T3VoiceApiRealtimeEvent.State(sequence, phase)
    }
    "transcript" ->
      T3VoiceApiRealtimeEvent.Transcript(
        sequence = sequence,
        role =
          when (requiredString("role")) {
            "user" -> T3VoiceTranscriptRole.USER
            "assistant" -> T3VoiceTranscriptRole.ASSISTANT
            else -> error("Realtime transcript returned an unknown role.")
          },
        text =
          if (requiredBoolean("final")) {
            requiredTrimmedString("text")
          } else {
            requiredString("text")
          },
        final = requiredBoolean("final"),
      )
    "confirmation-required" ->
      T3VoiceApiRealtimeEvent.ConfirmationRequired(
        sequence,
        requiredString("toolCallId"),
        T3VoiceRealtimeConfirmation(
          confirmationId = requiredString("confirmationId"),
          tool = toolName(requiredString("tool")),
          summary = requiredTrimmedString("summary"),
          expiresAt = requiredIsoInstant("expiresAt"),
        ),
      )
    "client-action" -> {
      require(requiredString("action") == "activate-thread") {
        "Realtime client action was unsupported."
      }
      T3VoiceApiRealtimeEvent.ClientAction(
        sequence,
        T3VoiceRealtimeClientAction(
          actionId = requiredString("actionId"),
          projectId = requiredString("projectId"),
          threadId = requiredString("threadId"),
          expiresAt = requiredIsoInstant("expiresAt"),
        ),
      )
    }
    "lease-fenced" -> {
      requiredPositiveLong("replacementGeneration")
      T3VoiceApiRealtimeEvent.LeaseFenced(sequence)
    }
    "rotation-required" ->
      T3VoiceApiRealtimeEvent.RotationRequired(
        sequence,
        requiredString("reason").also {
          require(it in ROTATION_REASONS) { "Realtime rotation reason was unknown." }
        },
      )
    "error" ->
      T3VoiceApiRealtimeEvent.Error(
        sequence,
        requiredTrimmedString("reason"),
        requiredBoolean("recoverable"),
      )
    "tool" -> {
      val toolCallId = requiredString("toolCallId")
      toolName(requiredString("tool"))
      val outcome = requiredString("outcome")
      require(outcome in TOOL_OUTCOMES) { "Realtime tool event returned an unknown outcome." }
      T3VoiceApiRealtimeEvent.Tool(sequence, toolCallId, outcome)
    }
    else -> error("Realtime server returned an unknown event type.")
  }
}

private fun toolName(value: String): T3VoiceToolName =
  when (value) {
    "list_projects" -> T3VoiceToolName.LIST_PROJECTS
    "list_threads" -> T3VoiceToolName.LIST_THREADS
    "get_thread_status" -> T3VoiceToolName.GET_THREAD_STATUS
    "get_thread_messages" -> T3VoiceToolName.GET_THREAD_MESSAGES
    "wait_for_thread_turn" -> T3VoiceToolName.WAIT_FOR_THREAD_TURN
    "search_history" -> T3VoiceToolName.SEARCH_HISTORY
    "read_history" -> T3VoiceToolName.READ_HISTORY
    "activate_thread" -> T3VoiceToolName.ACTIVATE_THREAD
    "create_thread" -> T3VoiceToolName.CREATE_THREAD
    "send_thread_message" -> T3VoiceToolName.SEND_THREAD_MESSAGE
    "interrupt_thread" -> T3VoiceToolName.INTERRUPT_THREAD
    "archive_thread" -> T3VoiceToolName.ARCHIVE_THREAD
    else -> error("Realtime server returned an unknown tool name.")
  }

private val TOOL_OUTCOMES =
  setOf("pending-confirmation", "approved", "rejected", "expired", "succeeded", "failed")
private val ROTATION_REASONS =
  setOf("duration-limit", "context-limit", "configuration-changed")
private val SESSION_PHASES =
  setOf(
    "creating",
    "signaling",
    "connecting",
    "idle",
    "listening",
    "thinking",
    "speaking",
    "confirming",
    "reconnecting",
    "ending",
    "ended",
    "error",
  )

private fun JSONArray.requiredObject(index: Int): JSONObject =
  get(index) as? JSONObject ?: error("Expected JSON object at index $index.")

private fun JSONObject.requiredArray(name: String): JSONArray =
  get(name) as? JSONArray ?: error("Expected JSON array field $name.")

private fun JSONObject.requiredObject(name: String): JSONObject =
  get(name) as? JSONObject ?: error("Expected JSON object field $name.")

private fun JSONObject.nullableObject(name: String): JSONObject? =
  if (isNull(name)) null else requiredObject(name)

private fun JSONObject.requiredString(name: String): String =
  (get(name) as? String)?.takeIf(String::isNotEmpty)
    ?: error("Expected non-empty JSON string field $name.")

internal fun t3VoiceValidatedSdp(value: String): String =
  value.also { require(it.isNotBlank()) { "SDP must contain non-whitespace content." } }

private fun JSONObject.requiredTrimmedString(name: String): String =
  requiredString(name).also { require(it == it.trim()) { "JSON string field $name was not trimmed." } }

private fun JSONObject.nullableString(name: String): String? =
  if (isNull(name)) null else requiredString(name)

private fun JSONObject.optionalString(name: String): String? =
  if (!has(name) || isNull(name)) null else get(name) as? String

private fun JSONObject.optionalBoolean(name: String): Boolean? =
  if (!has(name) || isNull(name)) null else get(name) as? Boolean

private fun JSONObject.requiredBoolean(name: String): Boolean =
  get(name) as? Boolean ?: error("Expected JSON boolean field $name.")

private fun JSONObject.requiredPositiveLong(name: String): Long =
  t3VoiceExactJsonLong(get(name), name)?.takeIf { it > 0 }
    ?: error("Expected positive JSON integer field $name.")

private fun JSONObject.requiredNonNegativeLong(name: String): Long =
  t3VoiceExactJsonLong(get(name), name)?.takeIf { it >= 0 }
    ?: error("Expected non-negative JSON integer field $name.")

/** Mirrors the wire schema's finite, exact integer contract without lossy Number.toLong coercion. */
internal fun t3VoiceExactJsonLong(value: Any?, @Suppress("UNUSED_PARAMETER") name: String): Long? {
  val number = value as? Number ?: return null
  return runCatching {
    BigDecimal(number.toString()).toBigIntegerExact().longValueExact()
  }.getOrNull()
}

private fun JSONObject.requiredIsoInstant(name: String): String =
  requiredString(name).also { T3VoiceTime.parseIsoEpochMillis(it, name) }

private fun T3VoiceHttpResult.Success.jsonObject(): JSONObject = JSONObject(body.utf8())

private fun ByteArray.utf8(): String =
  Charsets.UTF_8.newDecoder()
    .onMalformedInput(CodingErrorAction.REPORT)
    .onUnmappableCharacter(CodingErrorAction.REPORT)
    .decode(ByteBuffer.wrap(this))
    .toString()

private fun String.pathSegment(): String = T3VoiceHttpPathSegment.encode(requireId(this, "id"))

private fun requireId(value: String, name: String): String =
  value.also { require(it.isNotEmpty() && it == it.trim()) { "$name must be non-empty and trimmed." } }

private fun requireIsoInstant(value: String, name: String): String =
  value.also { T3VoiceTime.parseIsoEpochMillis(it, name) }
