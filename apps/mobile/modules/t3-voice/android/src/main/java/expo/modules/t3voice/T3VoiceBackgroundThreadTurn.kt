package expo.modules.t3voice

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class T3VoiceBackgroundThreadTurnCreateInput(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val generation: Long,
  val modeSessionId: String,
  val turnClientOperationId: String,
  val submissionPolicy: String,
  val speechPlanId: String,
)

internal data class T3VoiceBackgroundSpeechDisposition(
  val segmentIndex: Int,
  val disposition: String,
)

internal data class T3VoiceBackgroundThreadTurnSnapshot(
  val operationId: String,
  val runtimeId: String,
  val generation: Long,
  val runtimeInstanceId: String,
  val modeSessionId: String,
  val turnClientOperationId: String,
  val submissionPolicy: String,
  val speechPlanId: String,
  val projectId: String,
  val threadId: String,
  val speechPreset: String,
  val autoRearm: Boolean,
  val phase: String,
  val messageId: String?,
  val turnId: String?,
  val assistantMessageIds: List<String>,
  val highestAdvertisedSegment: Int?,
  val highestStartedSegment: Int?,
  val highestDrainedSegment: Int?,
  val segmentDispositions: List<T3VoiceBackgroundSpeechDisposition>,
  val lastSequence: Long,
  val acknowledgedSequence: Long,
  val speechTerminal: String?,
  val dispatchAccepted: Boolean,
  val detachedAtEpochMillis: Long?,
  val operationTokenExpiresAtEpochMillis: Long,
  val retentionExpiresAtEpochMillis: Long,
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

  data class AssistantMessageCorrelated(
    override val sequence: Long,
    val messageId: String,
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

internal data class T3VoiceBackgroundThreadTurnDispositionResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
)

internal data class T3VoiceBackgroundThreadTurnCancelResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val cancelled: Boolean,
)

internal data class T3VoiceBackgroundThreadDraft(
  val operationId: String,
  val transcript: String,
  val expiresAtEpochMillis: Long,
)

internal data class T3VoiceBackgroundThreadDraftConsumeResult(
  val snapshot: T3VoiceBackgroundThreadTurnSnapshot,
  val consumed: Boolean,
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
    requireIdentifier(input.runtimeInstanceId, "runtime instance ID", MAXIMUM_IDENTIFIER_LENGTH)
    require(input.generation in 1..MAXIMUM_SAFE_INTEGER) { "Invalid readiness generation." }
    requireIdentifier(input.modeSessionId, "mode session ID", MAXIMUM_IDENTIFIER_LENGTH)
    requireIdentifier(input.turnClientOperationId, "turn client operation ID", MAXIMUM_CLIENT_OPERATION_ID_LENGTH)
    require(input.submissionPolicy in SUBMISSION_POLICIES)
    requireIdentifier(input.speechPlanId, "speech plan ID", MAXIMUM_IDENTIFIER_LENGTH)
    return JSONObject()
      .put("runtimeId", input.runtimeId)
      .put("runtimeInstanceId", input.runtimeInstanceId)
      .put("generation", input.generation)
      .put("modeSessionId", input.modeSessionId)
      .put("turnClientOperationId", input.turnClientOperationId)
      .put("submissionPolicy", input.submissionPolicy)
      .put("speechPlanId", input.speechPlanId)
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

  fun encodeDraftDisposition(): ByteArray = JSONObject()
    .put("submissionPolicy", "draft")
    .toString()
    .toByteArray(Charsets.UTF_8)

  fun decodeDisposition(bytes: ByteArray): T3VoiceBackgroundThreadTurnDispositionResult {
    val root = objectFrom(bytes, setOf("snapshot"))
    return T3VoiceBackgroundThreadTurnDispositionResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
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

  fun encodeAcknowledgement(
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<T3VoiceBackgroundSpeechDisposition>,
  ): ByteArray {
    require(sequence in 0..MAXIMUM_SAFE_INTEGER) { "Invalid acknowledged sequence." }
    requireIdentifier(speechPlanId, "speech plan ID", MAXIMUM_IDENTIFIER_LENGTH)
    require(segmentDispositions.size <= 512)
    return JSONObject()
      .put("acknowledgedSequence", sequence)
      .put("speechPlanId", speechPlanId)
      .put("highestStartedSegment", highestStartedSegment ?: JSONObject.NULL)
      .put("highestDrainedSegment", highestDrainedSegment ?: JSONObject.NULL)
      .put("segmentDispositions", JSONArray().also { values ->
        segmentDispositions.forEach { disposition ->
          require(disposition.segmentIndex >= 0 && disposition.disposition in SEGMENT_DISPOSITIONS)
          values.put(JSONObject()
            .put("segmentIndex", disposition.segmentIndex)
            .put("disposition", disposition.disposition))
        }
      })
      .toString().toByteArray(Charsets.UTF_8)
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

  fun decodeDraft(bytes: ByteArray): T3VoiceBackgroundThreadDraft {
    val root = objectFrom(bytes, setOf("operationId", "transcript", "expiresAt"))
    val transcript = string(root, "transcript", 128 * 1024)
    return T3VoiceBackgroundThreadDraft(
      identifier(root, "operationId", MAXIMUM_OPERATION_ID_LENGTH),
      transcript,
      instant(root, "expiresAt"),
    )
  }

  fun decodeDraftConsume(bytes: ByteArray): T3VoiceBackgroundThreadDraftConsumeResult {
    val root = objectFrom(bytes, setOf("snapshot", "consumed"))
    return T3VoiceBackgroundThreadDraftConsumeResult(
      snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      boolean(root, "consumed"),
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
      runtimeInstanceId = identifier(value, "runtimeInstanceId"),
      modeSessionId = identifier(value, "modeSessionId"),
      turnClientOperationId = identifier(value, "turnClientOperationId"),
      submissionPolicy = literal(value, "submissionPolicy", SUBMISSION_POLICIES),
      speechPlanId = identifier(value, "speechPlanId"),
      projectId = identifier(value, "projectId"),
      threadId = identifier(value, "threadId"),
      speechPreset = literal(value, "speechPreset", SPEECH_PRESETS),
      autoRearm = boolean(value, "autoRearm"),
      phase = literal(value, "phase", PHASES),
      messageId = nullableIdentifier(value, "userMessageId"),
      turnId = nullableIdentifier(value, "turnId"),
      assistantMessageIds = identifierArray(value, "assistantMessageIds", 256),
      highestAdvertisedSegment = nullableNonNegativeInt(value, "highestAdvertisedSegment"),
      highestStartedSegment = nullableNonNegativeInt(value, "highestStartedSegment"),
      highestDrainedSegment = nullableNonNegativeInt(value, "highestDrainedSegment"),
      segmentDispositions = dispositionArray(value, "segmentDispositions"),
      lastSequence = lastSequence,
      acknowledgedSequence = acknowledgedSequence,
      speechTerminal = nullableLiteral(value, "speechTerminal", SPEECH_TERMINALS),
      dispatchAccepted = boolean(value, "dispatchAccepted"),
      detachedAtEpochMillis = nullableInstant(value, "detachedAt"),
      operationTokenExpiresAtEpochMillis = instant(value, "operationTokenExpiresAt"),
      retentionExpiresAtEpochMillis = instant(value, "retentionExpiresAt"),
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
      "assistant-message-correlated" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "messageId")
        T3VoiceBackgroundThreadTurnEvent.AssistantMessageCorrelated(
          sequence,
          identifier(value, "messageId"),
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

  private fun nullableInstant(source: JSONObject, name: String): Long? =
    if (source.isNull(name)) null else instant(source, name)

  private fun nullableNonNegativeInt(source: JSONObject, name: String): Int? =
    if (source.isNull(name)) null else nonNegativeLong(source, name).also {
      require(it <= Int.MAX_VALUE)
    }.toInt()

  private fun identifierArray(source: JSONObject, name: String, maximum: Int): List<String> {
    val values = source.get(name)
    require(values is JSONArray && values.length() <= maximum)
    return buildList(values.length()) {
      for (index in 0 until values.length()) {
        val value = values.get(index)
        require(value is String)
        add(requireIdentifier(value, name, MAXIMUM_IDENTIFIER_LENGTH))
      }
    }
  }

  private fun dispositionArray(
    source: JSONObject,
    name: String,
  ): List<T3VoiceBackgroundSpeechDisposition> {
    val values = source.get(name)
    require(values is JSONArray && values.length() <= 512)
    return buildList(values.length()) {
      for (index in 0 until values.length()) {
        val value = values.get(index)
        require(value is JSONObject)
        value.requireExactFields(setOf("segmentIndex", "disposition"))
        add(T3VoiceBackgroundSpeechDisposition(
          nonNegativeLong(value, "segmentIndex").also { require(it <= Int.MAX_VALUE) }.toInt(),
          literal(value, "disposition", SEGMENT_DISPOSITIONS),
        ))
      }
    }
  }

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
      "runtimeInstanceId",
      "generation",
      "modeSessionId",
      "turnClientOperationId",
      "submissionPolicy",
      "speechPlanId",
      "projectId",
      "threadId",
      "speechPreset",
      "autoRearm",
      "phase",
      "userMessageId",
      "turnId",
      "assistantMessageIds",
      "highestAdvertisedSegment",
      "highestStartedSegment",
      "highestDrainedSegment",
      "segmentDispositions",
      "lastSequence",
      "acknowledgedSequence",
      "speechTerminal",
      "dispatchAccepted",
      "detachedAt",
      "operationTokenExpiresAt",
      "retentionExpiresAt",
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
      "draft-ready",
      "completed",
      "failed",
      "cancelled",
    )
  private val SPEECH_PRESETS = setOf("default", "warm")
  private val SPEECH_TERMINALS = setOf("completed", "no-speech", "failed")
  private val AUDIO_DISPOSITIONS = setOf("processing", "already-dispatched", "terminal", "draft-ready")
  private val SUBMISSION_POLICIES = setOf("auto-submit", "draft")
  private val SEGMENT_DISPOSITIONS = setOf("drained", "interrupted", "skipped", "failed")
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

  fun newCall(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundThreadRawCall =
    object : T3VoiceBackgroundThreadRawCall {
      override fun execute() = this@T3VoiceBackgroundThreadTurnHttp.execute(request)
      override fun cancel() = Unit
    }
}

internal interface T3VoiceBackgroundThreadRawCall {
  fun execute(): T3VoiceBackgroundHttpResult
  fun cancel()
}

internal interface T3VoiceBackgroundThreadCall<out T> {
  fun execute(): T3VoiceBackgroundThreadTurnResult<T>
  fun cancel()
}

internal class T3VoiceBackgroundThreadTurnDelegate(
  private val http: T3VoiceBackgroundThreadTurnHttp = productionHttp(),
) {
  fun newCreateCall(
    origin: String,
    runtimeGrantToken: String,
    input: T3VoiceBackgroundThreadTurnCreateInput,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnCreateResult> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = "/api/voice/runtime/thread-turns",
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(RUNTIME_AUTHORITY_HEADER, runtimeGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeCreate(input)),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeCreate,
    )

  fun create(
    origin: String,
    runtimeGrantToken: String,
    input: T3VoiceBackgroundThreadTurnCreateInput,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnCreateResult> =
    newCreateCall(origin, runtimeGrantToken, input).execute()

  fun newUploadAudioCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    audio: T3VoiceBackgroundRequestBody,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnAudioResult> {
    require(audio.contentType == "audio/mp4") { "Native thread turn audio must be audio/mp4." }
    return jsonCall(
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

  fun newDraftDispositionCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnDispositionResult> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "disposition"),
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeDraftDisposition()),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      T3VoiceBackgroundThreadTurnJson::decodeDisposition,
    )

  fun uploadAudio(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    audio: T3VoiceBackgroundRequestBody,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnAudioResult> {
    require(audio.contentType == "audio/mp4") { "Native thread turn audio must be audio/mp4." }
    return newUploadAudioCall(origin, operationGrantToken, operationId, audio).execute()
  }

  fun newEventsCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    afterSequence: Long,
    waitMilliseconds: Int,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnEventsResult> {
    require(afterSequence in 0..MAXIMUM_SAFE_INTEGER && waitMilliseconds in 0..30_000)
    return jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events"),
        method = T3VoiceBackgroundHttpMethod.GET,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
        queryParameters = mapOf(
          "afterSequence" to afterSequence.toString(),
          "waitMilliseconds" to waitMilliseconds.toString(),
        ),
      ),
      T3VoiceBackgroundThreadTurnJson::decodeEvents,
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
    return newEventsCall(origin, operationGrantToken, operationId, afterSequence, waitMilliseconds)
      .execute()
  }

  fun acknowledge(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<T3VoiceBackgroundSpeechDisposition>,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnSnapshot> =
    newAcknowledgeCall(
      origin,
      operationGrantToken,
      operationId,
      sequence,
      speechPlanId,
      highestStartedSegment,
      highestDrainedSegment,
      segmentDispositions,
    ).execute()

  fun newAcknowledgeCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<T3VoiceBackgroundSpeechDisposition>,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnSnapshot> =
    jsonCall(
      T3VoiceBackgroundHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events/ack"),
        method = T3VoiceBackgroundHttpMethod.POST,
        authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
        body = jsonBody(T3VoiceBackgroundThreadTurnJson.encodeAcknowledgement(
          sequence,
          speechPlanId,
          highestStartedSegment,
          highestDrainedSegment,
          segmentDispositions,
        )),
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
  ): T3VoiceBackgroundThreadTurnResult<ByteArray> =
    newSpeechCall(origin, operationGrantToken, operationId, segmentIndex).execute()

  fun newSpeechCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
    segmentIndex: Int,
  ): T3VoiceBackgroundThreadCall<ByteArray> {
    require(segmentIndex >= 0)
    return call(T3VoiceBackgroundHttpRequest(
      origin = origin,
      path = operationPath(operationId, "speech/$segmentIndex"),
      method = T3VoiceBackgroundHttpMethod.GET,
      authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
      maximumResponseBytes = MAXIMUM_PCM_RESPONSE_BYTES,
    )) { response ->
      when (response) {
        is T3VoiceBackgroundHttpResult.Failure -> response.failure()
        is T3VoiceBackgroundHttpResult.Success -> try {
          require(response.contentType?.substringBefore(';')?.trim() == "audio/pcm")
          require(response.headers["x-t3-audio-format"] == PCM_FORMAT_HEADER)
          require(response.body.isNotEmpty() && response.body.size <= MAXIMUM_PCM_RESPONSE_BYTES &&
            response.body.size % 2 == 0)
          T3VoiceBackgroundThreadTurnResult.Success(response.body)
        } catch (_: RuntimeException) { permanentFailure() }
      }
    }
  }

  fun cancel(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadTurnResult<T3VoiceBackgroundThreadTurnCancelResult> =
    newCancelCall(origin, operationGrantToken, operationId).execute()

  fun newCancelCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadTurnCancelResult> =
    jsonCall(
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

  fun newDraftCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadDraft> = jsonCall(
    T3VoiceBackgroundHttpRequest(
      origin = origin,
      path = operationPath(operationId, "draft"),
      method = T3VoiceBackgroundHttpMethod.GET,
      authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
      maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
    ),
    T3VoiceBackgroundThreadTurnJson::decodeDraft,
  )

  fun newConsumeDraftCall(
    origin: String,
    operationGrantToken: String,
    operationId: String,
  ): T3VoiceBackgroundThreadCall<T3VoiceBackgroundThreadDraftConsumeResult> = jsonCall(
    T3VoiceBackgroundHttpRequest(
      origin = origin,
      path = operationPath(operationId, "draft/consume"),
      method = T3VoiceBackgroundHttpMethod.POST,
      authority = authority(OPERATION_AUTHORITY_HEADER, operationGrantToken),
      body = jsonBody(JSONObject().toString().toByteArray(Charsets.UTF_8)),
      maximumRequestBytes = MAXIMUM_JSON_BYTES,
      maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
    ),
    T3VoiceBackgroundThreadTurnJson::decodeDraftConsume,
  )

  private fun <A> jsonCall(
    request: T3VoiceBackgroundHttpRequest,
    decode: (ByteArray) -> A,
  ): T3VoiceBackgroundThreadCall<A> = call(request) { response ->
    when (response) {
      is T3VoiceBackgroundHttpResult.Failure -> response.failure()
      is T3VoiceBackgroundHttpResult.Success -> try {
        require(response.contentType?.substringBefore(';')?.trim() == "application/json")
        T3VoiceBackgroundThreadTurnResult.Success(decode(response.body))
      } catch (_: RuntimeException) { permanentFailure() }
    }
  }

  private fun <A> call(
    request: T3VoiceBackgroundHttpRequest,
    transform: (T3VoiceBackgroundHttpResult) -> T3VoiceBackgroundThreadTurnResult<A>,
  ): T3VoiceBackgroundThreadCall<A> {
    val raw = http.newCall(request)
    return object : T3VoiceBackgroundThreadCall<A> {
      override fun execute() = transform(raw.execute())
      override fun cancel() = raw.cancel()
    }
  }

  private fun operationPath(operationId: String, suffix: String): String {
    require(operationId.matches(OPERATION_ID_PATTERN)) { "Invalid native thread operation ID." }
    require(suffix.matches(SUFFIX_PATTERN)) { "Invalid native thread operation path." }
    return "/api/voice/runtime/thread-turns/$operationId/$suffix"
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
    fun productionHttp(): T3VoiceBackgroundThreadTurnHttp {
      val transport = T3VoiceBackgroundHttpTransport()
      return object : T3VoiceBackgroundThreadTurnHttp {
        override fun execute(request: T3VoiceBackgroundHttpRequest) = transport.execute(request)
        override fun newCall(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundThreadRawCall {
          val call = transport.newCall(request)
          return object : T3VoiceBackgroundThreadRawCall {
            override fun execute() = call.execute()
            override fun cancel() = call.cancel()
          }
        }
      }
    }

    const val RUNTIME_AUTHORITY_HEADER = "x-t3-voice-runtime"
    const val OPERATION_AUTHORITY_HEADER = "x-t3-voice-operation"
    const val MAXIMUM_JSON_BYTES = 2_048L
    const val MAXIMUM_JSON_RESPONSE_BYTES = 256 * 1_024
    const val MAXIMUM_AUDIO_BYTES = 64L * 1_024L * 1_024L
    const val MAXIMUM_PCM_RESPONSE_BYTES = 16 * 1_024 * 1_024
    const val MAXIMUM_SAFE_INTEGER = 9_007_199_254_740_991L
    const val PCM_FORMAT_HEADER = "s16le;rate=24000;channels=1"
    val OPERATION_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9:._~-]{0,191}$")
    val SUFFIX_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}$")
  }
}
