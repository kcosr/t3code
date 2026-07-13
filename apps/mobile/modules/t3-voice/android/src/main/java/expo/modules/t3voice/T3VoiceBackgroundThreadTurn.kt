package expo.modules.t3voice

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class T3VoiceBackgroundThreadTurnCreateInput(
  val runtimeId: String,
  val generation: Long,
  val clientOperationId: String,
)

internal data class T3VoiceBackgroundThreadTurnSnapshot(
  val operationId: String,
  val runtimeId: String,
  val generation: Long,
  val projectId: String,
  val threadId: String,
  val speechPreset: String,
  val autoRearm: Boolean,
  val phase: String,
  val messageId: String?,
  val turnId: String?,
  val lastSequence: Long,
  val acknowledgedSequence: Long,
  val speechTerminal: String?,
  val dispatchAccepted: Boolean,
  val expiresAtEpochMillis: Long,
)

internal data class T3VoiceBackgroundThreadTurnGrant(
  val token: String,
  val expiresAtEpochMillis: Long,
)

internal data class T3VoiceBackgroundThreadTurnCreateResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val operationGrant: T3VoiceBackgroundThreadTurnGrant,
)

internal sealed interface T3VoiceBackgroundThreadTurnEvent {
  val sequence: Long

  data class Phase(
    override val sequence: Long,
    val phase: String,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class DispatchCorrelation(
    override val sequence: Long,
    val commandId: String,
    val messageId: String,
    val turnId: String?,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class SpeechReady(
    override val sequence: Long,
    val segmentIndex: Int,
    val finalSegment: Boolean,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class SpeechTerminal(
    override val sequence: Long,
    val outcome: String,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class AttentionRequired(
    override val sequence: Long,
    val attention: String,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class Failure(
    override val sequence: Long,
    val code: String,
    val retryable: Boolean,
  ) : T3VoiceBackgroundThreadTurnEvent

  data class Terminal(
    override val sequence: Long,
    val outcome: String,
  ) : T3VoiceBackgroundThreadTurnEvent
}

internal data class T3VoiceBackgroundThreadTurnEventsResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val events: List<T3VoiceBackgroundThreadTurnEvent>,
)

internal data class T3VoiceBackgroundThreadTurnAudioResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val disposition: String,
)

internal data class T3VoiceBackgroundThreadTurnCancelResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val cancelled: Boolean,
)

internal sealed interface T3VoiceBackgroundThreadTurnResult<out T> {
  data class Success<T>(val value: T) : T3VoiceBackgroundThreadTurnResult<T>

  data class Failure(
    val kind: T3VoiceBackgroundHttpFailureKind,
    val statusCode: Int?,
  ) : T3VoiceBackgroundThreadTurnResult<Nothing>
}

internal object T3VoiceBackgroundThreadTurnJson {
  fun encodeCreate(input: T3VoiceBackgroundThreadTurnCreateInput): ByteArray {
    requireIdentifier(input.runtimeId, "native runtime ID", MAXIMUM_RUNTIME_ID_LENGTH)
    require(input.generation in 1..MAXIMUM_SAFE_INTEGER) { "Invalid readiness generation." }
    requireIdentifier(input.clientOperationId, "client operation ID", MAXIMUM_CLIENT_OPERATION_ID_LENGTH)
    return JSONObject()
      .put("runtimeId", input.runtimeId)
      .put("generation", input.generation)
      .put("clientOperationId", input.clientOperationId)
      .toString()
      .toByteArray(Charsets.UTF_8)
  }

  fun decodeCreate(bytes: ByteArray): T3VoiceBackgroundThreadTurnCreateResult {
    val root = objectFrom(bytes, setOf("snapshot", "operationGrant"))
    val grant = objectField(root, "operationGrant", setOf("token", "expiresAt"))
    return T3VoiceBackgroundThreadTurnCreateResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      operationGrant =
        T3VoiceBackgroundThreadTurnGrant(
          token = token(grant, "token"),
          expiresAtEpochMillis = instant(grant, "expiresAt"),
        ),
    )
  }

  fun decodeAudio(bytes: ByteArray): T3VoiceBackgroundThreadTurnAudioResult {
    val root = objectFrom(bytes, setOf("snapshot", "disposition"))
    return T3VoiceBackgroundThreadTurnAudioResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      disposition = literal(root, "disposition", AUDIO_DISPOSITIONS),
    )
  }

  fun decodeEvents(bytes: ByteArray): T3VoiceBackgroundThreadTurnEventsResult {
    val root = objectFrom(bytes, setOf("snapshot", "events"))
    val values = root.get("events")
    require(values is JSONArray && values.length() <= MAXIMUM_EVENTS) {
      "Invalid native thread turn events."
    }
    val events =
      buildList(values.length()) {
        for (index in 0 until values.length()) {
          val event = values.get(index)
          require(event is JSONObject) { "Invalid native thread turn event." }
          add(event(event))
        }
      }
    require(events.zipWithNext().all { (left, right) -> left.sequence < right.sequence }) {
      "Native thread turn events are not ordered."
    }
    val snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS))
    require(events.all { it.sequence <= snapshot.lastSequence }) {
      "Native thread turn event exceeds the snapshot cursor."
    }
    return T3VoiceBackgroundThreadTurnEventsResult(
      snapshot = snapshot,
      events = events,
    )
  }

  fun encodeAcknowledgement(sequence: Long): ByteArray {
    require(sequence in 0..MAXIMUM_SAFE_INTEGER) { "Invalid acknowledged sequence." }
    return JSONObject().put("acknowledgedSequence", sequence).toString().toByteArray(Charsets.UTF_8)
  }

  fun decodeAcknowledgement(bytes: ByteArray): T3VoiceBackgroundThreadTurnSnapshot {
    val root = objectFrom(bytes, setOf("snapshot"))
    return snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS))
  }

  fun encodeCancel(): ByteArray =
    JSONObject().put("reason", "user-request").toString().toByteArray(Charsets.UTF_8)

  fun decodeCancel(bytes: ByteArray): T3VoiceBackgroundThreadTurnCancelResult {
    val root = objectFrom(bytes, setOf("snapshot", "cancelled"))
    return T3VoiceBackgroundThreadTurnCancelResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      cancelled = boolean(root, "cancelled"),
    )
  }

  private fun snapshot(value: JSONObject): T3VoiceBackgroundThreadTurnSnapshot {
    value.requireExactFields(SNAPSHOT_FIELDS)
    val lastSequence = nonNegativeLong(value, "lastSequence")
    val acknowledgedSequence = nonNegativeLong(value, "acknowledgedSequence")
    require(acknowledgedSequence <= lastSequence) { "Invalid native thread turn cursor." }
    return T3VoiceBackgroundThreadTurnSnapshot(
      operationId = identifier(value, "operationId", MAXIMUM_OPERATION_ID_LENGTH),
      runtimeId = identifier(value, "runtimeId", MAXIMUM_RUNTIME_ID_LENGTH),
      generation = positiveLong(value, "generation"),
      projectId = identifier(value, "projectId"),
      threadId = identifier(value, "threadId"),
      speechPreset = literal(value, "speechPreset", SPEECH_PRESETS),
      autoRearm = boolean(value, "autoRearm"),
      phase = literal(value, "phase", PHASES),
      messageId = nullableIdentifier(value, "messageId"),
      turnId = nullableIdentifier(value, "turnId"),
      lastSequence = lastSequence,
      acknowledgedSequence = acknowledgedSequence,
      speechTerminal = nullableLiteral(value, "speechTerminal", SPEECH_TERMINALS),
      dispatchAccepted = boolean(value, "dispatchAccepted"),
      expiresAtEpochMillis = instant(value, "expiresAt"),
    )
  }

  private fun event(value: JSONObject): T3VoiceBackgroundThreadTurnEvent {
    val type = string(value, "type", 64)
    val sequence = positiveLong(value, "sequence")
    instant(value, "occurredAt")
    return when (type) {
      "phase" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "phase")
        T3VoiceBackgroundThreadTurnEvent.Phase(sequence, literal(value, "phase", PHASES))
      }
      "dispatch-correlation" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("commandId", "messageId", "turnId"))
        T3VoiceBackgroundThreadTurnEvent.DispatchCorrelation(
          sequence,
          identifier(value, "commandId"),
          identifier(value, "messageId"),
          nullableIdentifier(value, "turnId"),
        )
      }
      "speech-ready" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("segmentIndex", "finalSegment"))
        val segmentIndex = nonNegativeLong(value, "segmentIndex")
        require(segmentIndex <= Int.MAX_VALUE) { "Invalid speech segment index." }
        T3VoiceBackgroundThreadTurnEvent.SpeechReady(
          sequence,
          segmentIndex.toInt(),
          boolean(value, "finalSegment"),
        )
      }
      "speech-terminal" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "outcome")
        T3VoiceBackgroundThreadTurnEvent.SpeechTerminal(
          sequence,
          literal(value, "outcome", SPEECH_TERMINALS),
        )
      }
      "attention-required" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "attention")
        T3VoiceBackgroundThreadTurnEvent.AttentionRequired(
          sequence,
          literal(value, "attention", ATTENTION_TYPES),
        )
      }
      "failure" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("code", "retryable"))
        T3VoiceBackgroundThreadTurnEvent.Failure(
          sequence,
          literal(value, "code", FAILURE_CODES),
          boolean(value, "retryable"),
        )
      }
      "terminal" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "outcome")
        T3VoiceBackgroundThreadTurnEvent.Terminal(
          sequence,
          literal(value, "outcome", TERMINAL_OUTCOMES),
        )
      }
      else -> throw IllegalArgumentException("Unknown native thread turn event.")
    }
  }

  private fun objectFrom(bytes: ByteArray, fields: Set<String>): JSONObject {
    require(bytes.isNotEmpty()) { "Empty native thread turn response." }
    return JSONObject(bytes.toString(Charsets.UTF_8)).requireExactFields(fields)
  }

  private fun objectField(source: JSONObject, name: String, fields: Set<String>): JSONObject {
    val value = source.get(name)
    require(value is JSONObject) { "Invalid native thread turn object field." }
    return value.requireExactFields(fields)
  }

  private fun JSONObject.requireExactFields(expected: Set<String>): JSONObject {
    require(keys().asSequence().toSet() == expected) { "Invalid native thread turn fields." }
    return this
  }

  private fun string(source: JSONObject, name: String, maximumLength: Int): String {
    val value = source.get(name)
    require(value is String && value.length <= maximumLength) {
      "Invalid native thread turn string field."
    }
    return value
  }

  private fun identifier(
    source: JSONObject,
    name: String,
    maximumLength: Int = MAXIMUM_IDENTIFIER_LENGTH,
  ): String = requireIdentifier(string(source, name, maximumLength), name, maximumLength)

  private fun nullableIdentifier(source: JSONObject, name: String): String? =
    if (source.isNull(name)) null else identifier(source, name)

  private fun literal(source: JSONObject, name: String, allowed: Set<String>): String =
    string(source, name, 64).also {
      require(it in allowed) { "Invalid native thread turn literal." }
    }

  private fun nullableLiteral(source: JSONObject, name: String, allowed: Set<String>): String? =
    if (source.isNull(name)) null else literal(source, name, allowed)

  private fun positiveLong(source: JSONObject, name: String): Long =
    exactLong(source, name).also { require(it > 0) { "Invalid positive integer field." } }

  private fun nonNegativeLong(source: JSONObject, name: String): Long =
    exactLong(source, name).also { require(it >= 0) { "Invalid non-negative integer field." } }

  private fun exactLong(source: JSONObject, name: String): Long {
    val value = source.get(name)
    require(value is Byte || value is Short || value is Int || value is Long) {
      "Invalid native thread turn integer field."
    }
    return (value as Number).toLong().also {
      require(it <= MAXIMUM_SAFE_INTEGER) { "Integer field exceeds the protocol limit." }
    }
  }

  private fun boolean(source: JSONObject, name: String): Boolean {
    val value = source.get(name)
    require(value is Boolean) { "Invalid native thread turn boolean field." }
    return value
  }

  private fun instant(source: JSONObject, name: String): Long =
    Instant.parse(string(source, name, 64)).toEpochMilli()

  private fun token(source: JSONObject, name: String): String =
    string(source, name, 128).also {
      require(it.isNotBlank() && it.none(Char::isWhitespace)) { "Invalid operation credential." }
    }

  private fun requireIdentifier(value: String, label: String, maximumLength: Int): String =
    value.also {
      require(it.length <= maximumLength && it.matches(IDENTIFIER_PATTERN)) { "Invalid $label." }
    }

  private val IDENTIFIER_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9:._~-]*$")
  private val SNAPSHOT_FIELDS =
    setOf(
      "operationId",
      "runtimeId",
      "generation",
      "projectId",
      "threadId",
      "speechPreset",
      "autoRearm",
      "phase",
      "messageId",
      "turnId",
      "lastSequence",
      "acknowledgedSequence",
      "speechTerminal",
      "dispatchAccepted",
      "expiresAt",
    )
  private val EVENT_BASE_FIELDS = setOf("type", "sequence", "occurredAt")
  private val PHASES =
    setOf(
      "created",
      "transcribing",
      "dispatching",
      "waiting",
      "speaking",
      "attention-required",
      "completed",
      "failed",
      "cancelled",
    )
  private val SPEECH_PRESETS = setOf("default", "warm")
  private val SPEECH_TERMINALS = setOf("completed", "no-speech", "failed")
  private val AUDIO_DISPOSITIONS = setOf("processing", "already-dispatched", "terminal")
  private val ATTENTION_TYPES = setOf("approval", "user-input")
  private val FAILURE_CODES =
    setOf(
      "audio-invalid",
      "transcription-failed",
      "dispatch-failed",
      "target-unavailable",
      "turn-failed",
      "speech-failed",
      "operation-expired",
    )
  private val TERMINAL_OUTCOMES = setOf("completed", "failed", "cancelled")
  private const val MAXIMUM_IDENTIFIER_LENGTH = 256
  private const val MAXIMUM_RUNTIME_ID_LENGTH = 128
  private const val MAXIMUM_OPERATION_ID_LENGTH = 192
  private const val MAXIMUM_CLIENT_OPERATION_ID_LENGTH = 128
  private const val MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L
  private const val MAXIMUM_EVENTS = 100
}

internal fun interface T3VoiceBackgroundThreadTurnHttp {
  fun execute(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpResult
}

internal class T3VoiceBackgroundThreadTurnDelegate(
  private val http: T3VoiceBackgroundThreadTurnHttp =
    T3VoiceBackgroundThreadTurnHttp(T3VoiceBackgroundHttpTransport()::execute),
) {
  fun create(
    origin: String,
    runtimeGrantToken: String,
    input: T3VoiceBackgroundThreadTurnCreateInput,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnCreateResult> =
    json(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = "/api/voice/native/thread-turns",
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(RUNTIME_AUTHORITY_HEADER, runtimeGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeCreate(input)),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeCreate,
    )

  fun uploadAudio(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    audio: T3VoiceBackgroundRequestBody,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnAudioResult> {
    require(audio.contentType == "audio/mp4") { "Native thread turn audio must be audio/mp4." }
    return json(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "audio"),
        method = T3VoiceBackgroundHttpMethod.PUT,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        body = audio,
        maximumRequestBytes = MAXIMUM_AUDIO_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeAudio,
    )
  }

  fun events(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    afterSequence: Long,
    waitMilliseconds: Int,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnEventsResult> {
    require(afterSequence in 0..MAXIMUM_SAFE_INTEGER && waitMilliseconds in 0..30_000)
    return json(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events"),
        method = T3VoiceBackgroundHttpMethod.GET,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
        queryParameters =
          mapOf(
            "afterSequence" to afterSequence.toString(),
            "waitMilliseconds" to waitMilliseconds.toString(),
          ),
      ),
      T3VoiceBackgroundThreadTurnJson::decodeEvents,
    )
  }

  fun acknowledge(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    sequence: Long,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnSnapshot> =
    json(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events/ack"),
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeAcknowledgement(sequence)),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeAcknowledgement,
    )

  fun speech(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    segmentIndex: Int,
  ): T3VoiceBackgroundThreadTurnResult<ByteArray> {
    require(segmentIndex >= 0)
    return when (
      val response =
        http.execute(
          T3VoiceBackgroundHttpRequest(
            origin = origin,
            path = operationPath(operationId, "speech/$segmentIndex"),
            method = T3VoiceBackgroundHttpMethod.GET,
            authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
            maximumResponseBytes = MAXIMUM_PCM_RESPONSE_BYTES,
          ),
        )
    ) {
      is T3VoiceBackgroundHttpResult.Failure -> response.failure()
      is T3VoiceBackgroundHttpResult.Success ->
        try {
          require(response.contentType?.substringBefore(';')?.trim() == "audio/pcm") {
            "Invalid native thread speech content type."
          }
          require(
            response.body.isNotEmpty() &&
              response.body.size <= MAXIMUM_PCM_RESPONSE_BYTES &&
              response.body.size % 2 == 0,
          ) {
            "Invalid native thread speech payload."
          }
          T3VoiceBackgroundThreadTurnResult.Success(response.body)
        } catch (_: RuntimeException) {
          permanentFailure()
        }
    }
  }

  fun cancel(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnCancelResult> =
    json(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "cancel"),
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeCancel()),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeCancel,
    )

  private fun <A> json(
    request: T3VoiceBackgroundHttpRequest,
    decode: (ByteArray) -> A,
  ): T3VoiceBackgroundThreadTurnResult<A> =
    when (val response = http.execute(request)) {
      is T3VoiceBackgroundHttpResult.Failure -> response.failure()
      is T3VoiceBackgroundHttpResult.Success ->
        try {
          require(response.contentType?.substringBefore(';')?.trim() == "application/json") {
            "Invalid native thread turn content type."
          }
          T3VoiceBackgroundThreadTurnResult.Success(decode(response.body))
        } catch (_: RuntimeException) {
          permanentFailure()
        }
    }

  private fun operationPath(operationId: String, suffix: String): String {
    require(operationId.matches(OPERATION_ID_PATTERN)) { "Invalid native thread operation ID." }
    require(suffix.matches(SUFFIX_PATTERN)) { "Invalid native thread operation path." }
    return "/api/voice/native/thread-turns/$operationId/$suffix"
  }

  private fun authority(name: String, token: String) = T3VoiceBackgroundAuthority(name, token)

  private fun jsonBody(bytes: ByteArray) =
    T3VoiceBackgroundByteArrayBody(bytes, "application/json")

  private fun T3VoiceBackgroundHttpResult.Failure.failure() =
    T3VoiceBackgroundThreadTurnResult.Failure(kind, statusCode)

  private fun permanentFailure() =
    T3VoiceBackgroundThreadTurnResult.Failure(
      T3VoiceBackgroundHttpFailureKind.PERMANENT,
      null,
    )

  private companion object {
    const val RUNTIME_AUTHORITY_HEADER = "x-t3-voice-runtime"
    const val OPERATION_AUTHORITY_HEADER = "x-t3-voice-operation"
    const val MAXIMUM_JSON_BYTES = 2_048L
    const val MAXIMUM_JSON_RESPONSE_BYTES = 256 * 1_024
    const val MAXIMUM_AUDIO_BYTES = 64L * 1_024L * 1_024L
    const val MAXIMUM_PCM_RESPONSE_BYTES = 16 * 1_024 * 1_024
    const val MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L
    val OPERATION_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9:._~-]{0,191}$")
    val SUFFIX_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$")
  }
}
