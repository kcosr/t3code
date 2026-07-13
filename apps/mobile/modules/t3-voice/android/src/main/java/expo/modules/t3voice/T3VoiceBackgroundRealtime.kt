package expo.modules.t3voice

import java.time.Instant
import org.json.JSONObject

internal data class T3VoiceBackgroundRealtimeStartInput(
  val runtimeId: String,
  val generation: Long,
  val clientOperationId: String,
) {
  init {
    requireBoundedIdentifier(runtimeId, "native runtime ID")
    require(generation > 0) { "Invalid readiness generation." }
    requireBoundedIdentifier(clientOperationId, "client operation ID")
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

internal data class T3VoiceBackgroundRealtimeAnswer(
  val sessionId: String,
  val leaseGeneration: Long,
  val sdp: String,
)

internal data class T3VoiceBackgroundRealtimeCloseResult(
  val state: T3VoiceBackgroundRealtimeSessionState,
  val closed: Boolean,
)

internal sealed interface T3VoiceBackgroundRealtimeResult<out T> {
  data class Success<T>(val value: T) : T3VoiceBackgroundRealtimeResult<T>

  data class Failure(
    val kind: T3VoiceBackgroundHttpFailureKind,
    val statusCode: Int?,
  ) : T3VoiceBackgroundRealtimeResult<Nothing>
}

internal object T3VoiceBackgroundRealtimeJson {
  fun encodeStart(input: T3VoiceBackgroundRealtimeStartInput): ByteArray =
    JSONObject()
      .put("runtimeId", input.runtimeId)
      .put("generation", input.generation)
      .put("clientOperationId", input.clientOperationId)
      .toString()
      .toByteArray(Charsets.UTF_8)

  fun decodeStart(bytes: ByteArray): T3VoiceBackgroundRealtimeStartResult {
    val root = objectFrom(bytes, START_RESULT_FIELDS)
    val state = parseState(objectField(root, "state"))
    val transport = objectField(root, "transport").requireExactFields(TRANSPORT_FIELDS)
    require(stringField(transport, "kind", 64) == "webrtc-sdp-v1") {
      "Unsupported native Realtime transport."
    }
    val expectedSignalingPath =
      "/api/voice/native/realtime-sessions/${state.sessionId}/webrtc-offer"
    val signalingPath = stringField(transport, "signalingPath", 512)
    require(signalingPath == expectedSignalingPath) { "Unexpected native Realtime signaling path." }
    val control = objectField(root, "nativeControlGrant").requireExactFields(CONTROL_GRANT_FIELDS)
    require(stringField(control, "sessionId", 128) == state.sessionId) {
      "Native Realtime control grant session mismatch."
    }
    require(positiveLongField(control, "leaseGeneration") == state.leaseGeneration) {
      "Native Realtime control grant lease mismatch."
    }
    val heartbeatIntervalSeconds = positiveLongField(root, "heartbeatIntervalSeconds")
    require(positiveLongField(control, "heartbeatIntervalSeconds") == heartbeatIntervalSeconds) {
      "Native Realtime heartbeat interval mismatch."
    }
    return T3VoiceBackgroundRealtimeStartResult(
      state = state,
      signalingPath = signalingPath,
      expiresAtEpochMillis = instantField(root, "expiresAt"),
      controlGrant =
        T3VoiceBackgroundRealtimeControlGrant(
          token = boundedToken(stringField(control, "token", 128)),
          expiresAtEpochMillis = instantField(control, "expiresAt"),
          heartbeatIntervalSeconds = heartbeatIntervalSeconds,
          failureGraceSeconds = positiveLongField(control, "failureGraceSeconds"),
        ),
    )
  }

  fun encodeOffer(
    sessionId: String,
    leaseGeneration: Long,
    sdp: String,
  ): ByteArray {
    requireSessionIdentifier(sessionId)
    require(leaseGeneration > 0) { "Invalid native Realtime lease generation." }
    require(sdp.isNotBlank() && sdp.length <= MAXIMUM_SDP_CHARACTERS) {
      "Invalid native Realtime SDP."
    }
    return JSONObject()
      .put("sessionId", sessionId)
      .put("leaseGeneration", leaseGeneration)
      .put("sdp", sdp)
      .toString()
      .toByteArray(Charsets.UTF_8)
  }

  fun decodeAnswer(bytes: ByteArray): T3VoiceBackgroundRealtimeAnswer {
    val root = objectFrom(bytes, ANSWER_FIELDS)
    return T3VoiceBackgroundRealtimeAnswer(
      sessionId = requireSessionIdentifier(stringField(root, "sessionId", 128)),
      leaseGeneration = positiveLongField(root, "leaseGeneration"),
      sdp = stringField(root, "sdp", MAXIMUM_SDP_CHARACTERS).also {
        require(it.isNotBlank()) { "Invalid native Realtime SDP answer." }
      },
    )
  }

  fun encodeClose(leaseGeneration: Long): ByteArray {
    require(leaseGeneration > 0) { "Invalid native Realtime lease generation." }
    return JSONObject().put("leaseGeneration", leaseGeneration).toString().toByteArray(Charsets.UTF_8)
  }

  fun decodeClose(bytes: ByteArray): T3VoiceBackgroundRealtimeCloseResult {
    val root = objectFrom(bytes, CLOSE_RESULT_FIELDS)
    return T3VoiceBackgroundRealtimeCloseResult(
      state = parseState(objectField(root, "state")),
      closed = booleanField(root, "closed"),
    )
  }

  private fun parseState(value: JSONObject): T3VoiceBackgroundRealtimeSessionState {
    value.requireExactFields(SESSION_STATE_FIELDS)
    require(stringField(value, "mode", 64) == "realtime-agent") {
      "Unexpected native Realtime session mode."
    }
    val phase = stringField(value, "phase", 64)
    require(phase in SESSION_PHASES) { "Invalid native Realtime session phase." }
    return T3VoiceBackgroundRealtimeSessionState(
      sessionId = requireSessionIdentifier(stringField(value, "sessionId", 128)),
      conversationId =
        requireBoundedIdentifier(
          stringField(value, "conversationId", MAXIMUM_CONVERSATION_ID_CHARACTERS),
          "conversation ID",
          MAXIMUM_CONVERSATION_ID_CHARACTERS,
        ),
      phase = phase,
      leaseGeneration = positiveLongField(value, "leaseGeneration"),
      sequence = nonNegativeLongField(value, "sequence"),
    )
  }

  private fun objectFrom(bytes: ByteArray, fields: Set<String>): JSONObject {
    require(bytes.isNotEmpty()) { "Empty native Realtime response." }
    return JSONObject(bytes.toString(Charsets.UTF_8)).requireExactFields(fields)
  }

  private fun JSONObject.requireExactFields(expected: Set<String>): JSONObject {
    val observed = keys().asSequence().toSet()
    require(observed == expected) { "Invalid native Realtime response fields." }
    return this
  }

  private fun objectField(source: JSONObject, name: String): JSONObject {
    val value = source.get(name)
    require(value is JSONObject) { "Invalid native Realtime object field." }
    return value
  }

  private fun stringField(source: JSONObject, name: String, maximumLength: Int): String {
    val value = source.get(name)
    require(value is String && value.length <= maximumLength) {
      "Invalid native Realtime string field."
    }
    return value
  }

  private fun positiveLongField(source: JSONObject, name: String): Long =
    exactLongField(source, name).also { require(it > 0) { "Invalid positive integer field." } }

  private fun nonNegativeLongField(source: JSONObject, name: String): Long =
    exactLongField(source, name).also { require(it >= 0) { "Invalid non-negative integer field." } }

  private fun exactLongField(source: JSONObject, name: String): Long {
    val value = source.get(name)
    require(value is Byte || value is Short || value is Int || value is Long) {
      "Invalid native Realtime integer field."
    }
    return (value as Number).toLong()
  }

  private fun booleanField(source: JSONObject, name: String): Boolean {
    val value = source.get(name)
    require(value is Boolean) { "Invalid native Realtime boolean field." }
    return value
  }

  private fun instantField(source: JSONObject, name: String): Long =
    Instant.parse(stringField(source, name, 64)).toEpochMilli()

  private fun boundedToken(token: String): String =
    token.also {
      require(it.isNotBlank() && it.none(Char::isWhitespace)) {
        "Invalid native Realtime control token."
      }
    }

  private fun requireSessionIdentifier(value: String): String =
    requireBoundedIdentifier(value, "session ID").also {
      require(it.matches(SAFE_PATH_SEGMENT)) { "Invalid native Realtime session ID." }
    }

  private val START_RESULT_FIELDS =
    setOf("state", "transport", "expiresAt", "heartbeatIntervalSeconds", "nativeControlGrant")
  private val SESSION_STATE_FIELDS =
    setOf("sessionId", "conversationId", "mode", "phase", "leaseGeneration", "sequence")
  private val TRANSPORT_FIELDS = setOf("kind", "signalingPath")
  private val CONTROL_GRANT_FIELDS =
    setOf(
      "token",
      "sessionId",
      "leaseGeneration",
      "expiresAt",
      "heartbeatIntervalSeconds",
      "failureGraceSeconds",
    )
  private val ANSWER_FIELDS = setOf("sessionId", "leaseGeneration", "sdp")
  private val CLOSE_RESULT_FIELDS = setOf("state", "closed")
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
  private val SAFE_PATH_SEGMENT = Regex("^[A-Za-z0-9._~-]{1,128}$")
  private const val MAXIMUM_SDP_CHARACTERS = 128 * 1_024
  private const val MAXIMUM_CONVERSATION_ID_CHARACTERS = 1_024
}

internal fun interface T3VoiceBackgroundRealtimeHttp {
  fun execute(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpResult

  fun newCall(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpCall? = null
}

internal class T3VoiceBackgroundRealtimeCall<T>(
  private val executeBlock: () -> T3VoiceBackgroundRealtimeResult<T>,
  private val cancelBlock: () -> Unit,
) {
  fun execute(): T3VoiceBackgroundRealtimeResult<T> = executeBlock()

  fun cancel() = cancelBlock()
}

internal class T3VoiceBackgroundRealtimeDelegate(
  private val http: T3VoiceBackgroundRealtimeHttp =
    productionHttp(),
) {
  fun start(
    origin: String,
    runtimeGrantToken: String,
    input: T3VoiceBackgroundRealtimeStartInput,
  ): T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeStartResult> =
    newStartCall(origin, runtimeGrantToken, input).execute()

  fun newStartCall(
    origin: String,
    runtimeGrantToken: String,
    input: T3VoiceBackgroundRealtimeStartInput,
  ): T3VoiceBackgroundRealtimeCall<T3VoiceBackgroundRealtimeStartResult> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = "/api/voice/native/realtime-sessions",
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = T3VoiceBackgroundAuthority(RUNTIME_AUTHORITY_HEADER, runtimeGrantToken),
        body = jsonBody(T3VoiceBackgroundRealtimeJson.encodeStart(input)),
        maximumRequestBytes = MAXIMUM_START_REQUEST_BYTES,
        maximumResponseBytes = MAXIMUM_START_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundRealtimeJson::decodeStart,
    )

  fun offer(
    origin: String,
    controlGrantToken: String,
    start: T3VoiceBackgroundRealtimeStartResult,
    sdp: String,
  ): T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeAnswer> =
    newOfferCall(origin, controlGrantToken, start, sdp).execute()

  fun newOfferCall(
    origin: String,
    controlGrantToken: String,
    start: T3VoiceBackgroundRealtimeStartResult,
    sdp: String,
  ): T3VoiceBackgroundRealtimeCall<T3VoiceBackgroundRealtimeAnswer> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = start.signalingPath,
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = T3VoiceBackgroundAuthority(CONTROL_AUTHORITY_HEADER, controlGrantToken),
        body =
          jsonBody(
            T3VoiceBackgroundRealtimeJson.encodeOffer(
              start.state.sessionId,
              start.state.leaseGeneration,
              sdp,
            ),
          ),
        maximumRequestBytes = MAXIMUM_SIGNALING_BYTES,
        maximumResponseBytes = MAXIMUM_SIGNALING_BYTES.toInt(),
      ),
      T3VoiceBackgroundRealtimeJson::decodeAnswer,
      validate = { answer ->
      answer.sessionId == start.state.sessionId &&
        answer.leaseGeneration == start.state.leaseGeneration
      },
    )

  fun close(
    origin: String,
    controlGrantToken: String,
    start: T3VoiceBackgroundRealtimeStartResult,
  ): T3VoiceBackgroundRealtimeResult<T3VoiceBackgroundRealtimeCloseResult> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = "/api/voice/native/realtime-sessions/${start.state.sessionId}/close",
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = T3VoiceBackgroundAuthority(CONTROL_AUTHORITY_HEADER, controlGrantToken),
        body = jsonBody(T3VoiceBackgroundRealtimeJson.encodeClose(start.state.leaseGeneration)),
        maximumRequestBytes = MAXIMUM_CLOSE_BYTES,
        maximumResponseBytes = MAXIMUM_CLOSE_BYTES.toInt(),
      ),
      T3VoiceBackgroundRealtimeJson::decodeClose,
      validate = { result ->
      result.state.sessionId == start.state.sessionId &&
        result.state.leaseGeneration == start.state.leaseGeneration
      },
    ).execute()

  private fun <T> jsonCall(
    request: T3VoiceBackgroundHttpRequest,
    decode: (ByteArray) -> T,
    validate: (T) -> Boolean = { true },
  ): T3VoiceBackgroundRealtimeCall<T> {
    val nativeCall = http.newCall(request)
    return T3VoiceBackgroundRealtimeCall(
      executeBlock = {
        executeJsonResult(nativeCall?.execute() ?: http.execute(request), decode).validate(validate)
      },
      cancelBlock = { nativeCall?.cancel() },
    )
  }

  private fun <T> executeJsonResult(
    result: T3VoiceBackgroundHttpResult,
    decode: (ByteArray) -> T,
  ): T3VoiceBackgroundRealtimeResult<T> =
    when (result) {
      is T3VoiceBackgroundHttpResult.Failure ->
        T3VoiceBackgroundRealtimeResult.Failure(result.kind, result.statusCode)
      is T3VoiceBackgroundHttpResult.Success ->
        try {
          require(result.contentType?.substringBefore(';')?.trim() == "application/json") {
            "Invalid native Realtime response content type."
          }
          T3VoiceBackgroundRealtimeResult.Success(decode(result.body))
        } catch (_: Exception) {
          T3VoiceBackgroundRealtimeResult.Failure(
            T3VoiceBackgroundHttpFailureKind.PERMANENT,
            result.statusCode,
          )
        }
    }

  private companion object {
    fun productionHttp(): T3VoiceBackgroundRealtimeHttp {
      val transport = T3VoiceBackgroundHttpTransport()
      return object : T3VoiceBackgroundRealtimeHttp {
        override fun execute(request: T3VoiceBackgroundHttpRequest) = transport.execute(request)

        override fun newCall(request: T3VoiceBackgroundHttpRequest) = transport.newCall(request)
      }
    }

    const val RUNTIME_AUTHORITY_HEADER = "x-t3-voice-runtime"
    const val CONTROL_AUTHORITY_HEADER = "x-t3-voice-control"
    const val MAXIMUM_START_REQUEST_BYTES = 2_048L
    const val MAXIMUM_START_RESPONSE_BYTES = 16 * 1_024
    const val MAXIMUM_SIGNALING_BYTES = 128L * 1_024L
    const val MAXIMUM_CLOSE_BYTES = 16L * 1_024L
  }

  private fun <T> T3VoiceBackgroundRealtimeResult<T>.validate(
    predicate: (T) -> Boolean,
  ): T3VoiceBackgroundRealtimeResult<T> =
    when (this) {
      is T3VoiceBackgroundRealtimeResult.Failure -> this
      is T3VoiceBackgroundRealtimeResult.Success ->
        if (predicate(value)) this
        else T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT,
          null,
        )
    }

  private fun jsonBody(bytes: ByteArray) =
    T3VoiceBackgroundByteArrayBody(bytes, "application/json")

}

private fun requireBoundedIdentifier(
  value: String,
  label: String,
  maximumLength: Int = 128,
): String =
  value.also {
    require(
      it.length <= maximumLength &&
        it.matches(BOUNDED_IDENTIFIER_PATTERN),
    ) { "Invalid $label." }
  }

private val BOUNDED_IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._:~-]*$")
