package expo.modules.t3voice.net

import expo.modules.t3voice.bridge.VoiceRuntimeBridge
import expo.modules.t3voice.kernel.VoiceRuntimeTarget

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class VoiceRuntimeThreadTurnCreateInput(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val generation: Long,
  val modeSessionId: String,
  val turnClientOperationId: String,
  val submissionPolicy: String,
  val speechPlanId: String,
  val target: VoiceRuntimeTarget.Thread,
)

internal data class VoiceRuntimeSpeechDisposition(
  val segmentIndex: Int,
  val disposition: String,
)

internal data class VoiceRuntimeThreadTurnSnapshot(
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
  val segmentDispositions: List<VoiceRuntimeSpeechDisposition>,
  val lastSequence: Long,
  val acknowledgedSequence: Long,
  val speechTerminal: String?,
  val dispatchAccepted: Boolean,
  val detachedAtEpochMillis: Long?,
  val operationTokenExpiresAtEpochMillis: Long,
  val retentionExpiresAtEpochMillis: Long,
)

internal data class VoiceRuntimeThreadTurnCreateResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
)

internal sealed interface VoiceRuntimeThreadTurnEvent {
  val sequence: Long

  data class Phase(
    override val sequence: Long,
    val phase: String,
  ) : VoiceRuntimeThreadTurnEvent

  data class DispatchCorrelation(
    override val sequence: Long,
    val commandId: String,
    val messageId: String,
    val turnId: String?,
  ) : VoiceRuntimeThreadTurnEvent

  data class AssistantMessageCorrelated(
    override val sequence: Long,
    val messageId: String,
  ) : VoiceRuntimeThreadTurnEvent

  data class SpeechReady(
    override val sequence: Long,
    val segmentIndex: Int,
    val finalSegment: Boolean,
  ) : VoiceRuntimeThreadTurnEvent

  data class SpeechTerminal(
    override val sequence: Long,
    val outcome: String,
  ) : VoiceRuntimeThreadTurnEvent

  data class AttentionRequired(
    override val sequence: Long,
    val attention: String,
  ) : VoiceRuntimeThreadTurnEvent

  data class Failure(
    override val sequence: Long,
    val code: String,
    val retryable: Boolean,
  ) : VoiceRuntimeThreadTurnEvent

  data class Terminal(
    override val sequence: Long,
    val outcome: String,
  ) : VoiceRuntimeThreadTurnEvent
}

internal data class VoiceRuntimeThreadTurnEventsResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
  val events: List<VoiceRuntimeThreadTurnEvent>,
)

internal data class VoiceRuntimeThreadTurnAudioResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
  val disposition: String,
)

internal data class VoiceRuntimeThreadTurnDispositionResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
)

internal data class VoiceRuntimeThreadTurnCancelResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
  val cancelled: Boolean,
)

internal data class VoiceRuntimeThreadDraft(
  val operationId: String,
  val transcript: String,
  val expiresAtEpochMillis: Long,
)

internal data class VoiceRuntimeThreadDraftConsumeResult(
  val snapshot: VoiceRuntimeThreadTurnSnapshot,
  val consumed: Boolean,
)

internal sealed interface VoiceRuntimeThreadTurnResult<out T> {
  data class Success<T>(val value: T) : VoiceRuntimeThreadTurnResult<T>

  data class Failure(
    val kind: VoiceRuntimeHttpFailureKind,
    val statusCode: Int?,
  ) : VoiceRuntimeThreadTurnResult<Nothing>
}

internal object VoiceRuntimeThreadTurnJson {
  fun encodeCreate(input: VoiceRuntimeThreadTurnCreateInput): ByteArray {
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
      .put("target", JSONObject(VoiceRuntimeBridge.canonicalThreadTargetIdentity(input.target)))
      .toString()
      .toByteArray(Charsets.UTF_8)
  }

  fun decodeCreate(bytes: ByteArray): VoiceRuntimeThreadTurnCreateResult {
    val root = objectFrom(bytes, setOf("snapshot"))
    return VoiceRuntimeThreadTurnCreateResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
    )
  }

  fun decodeAudio(bytes: ByteArray): VoiceRuntimeThreadTurnAudioResult {
    val root = objectFrom(bytes, setOf("snapshot", "disposition"))
    return VoiceRuntimeThreadTurnAudioResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      disposition = literal(root, "disposition", AUDIO_DISPOSITIONS),
    )
  }

  fun encodeDraftDisposition(): ByteArray = JSONObject()
    .put("submissionPolicy", "draft")
    .toString()
    .toByteArray(Charsets.UTF_8)

  fun decodeDisposition(bytes: ByteArray): VoiceRuntimeThreadTurnDispositionResult {
    val root = objectFrom(bytes, setOf("snapshot"))
    return VoiceRuntimeThreadTurnDispositionResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
    )
  }

  fun decodeEvents(bytes: ByteArray): VoiceRuntimeThreadTurnEventsResult {
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
    return VoiceRuntimeThreadTurnEventsResult(
      snapshot = snapshot,
      events = events,
    )
  }

  fun encodeAcknowledgement(
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<VoiceRuntimeSpeechDisposition>,
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

  fun decodeAcknowledgement(bytes: ByteArray): VoiceRuntimeThreadTurnSnapshot {
    val root = objectFrom(bytes, setOf("snapshot"))
    return snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS))
  }

  fun encodeCancel(): ByteArray =
    JSONObject().put("reason", "user-request").toString().toByteArray(Charsets.UTF_8)

  fun decodeCancel(bytes: ByteArray): VoiceRuntimeThreadTurnCancelResult {
    val root = objectFrom(bytes, setOf("snapshot", "cancelled"))
    return VoiceRuntimeThreadTurnCancelResult(
      snapshot = snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      cancelled = boolean(root, "cancelled"),
    )
  }

  fun decodeDraft(bytes: ByteArray): VoiceRuntimeThreadDraft {
    val root = objectFrom(bytes, setOf("operationId", "transcript", "expiresAt"))
    val transcript = string(root, "transcript", 128 * 1024)
    return VoiceRuntimeThreadDraft(
      identifier(root, "operationId", MAXIMUM_OPERATION_ID_LENGTH),
      transcript,
      instant(root, "expiresAt"),
    )
  }

  fun decodeDraftConsume(bytes: ByteArray): VoiceRuntimeThreadDraftConsumeResult {
    val root = objectFrom(bytes, setOf("snapshot", "consumed"))
    return VoiceRuntimeThreadDraftConsumeResult(
      snapshot(objectField(root, "snapshot", SNAPSHOT_FIELDS)),
      boolean(root, "consumed"),
    )
  }

  private fun snapshot(value: JSONObject): VoiceRuntimeThreadTurnSnapshot {
    value.requireExactFields(SNAPSHOT_FIELDS)
    val lastSequence = nonNegativeLong(value, "lastSequence")
    val acknowledgedSequence = nonNegativeLong(value, "acknowledgedSequence")
    require(acknowledgedSequence <= lastSequence) { "Invalid native thread turn cursor." }
    return VoiceRuntimeThreadTurnSnapshot(
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

  private fun event(value: JSONObject): VoiceRuntimeThreadTurnEvent {
    val type = string(value, "type", 64)
    val sequence = positiveLong(value, "sequence")
    instant(value, "occurredAt")
    return when (type) {
      "phase" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "phase")
        VoiceRuntimeThreadTurnEvent.Phase(sequence, literal(value, "phase", PHASES))
      }
      "dispatch-correlation" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("commandId", "messageId", "turnId"))
        VoiceRuntimeThreadTurnEvent.DispatchCorrelation(
          sequence,
          identifier(value, "commandId"),
          identifier(value, "messageId"),
          nullableIdentifier(value, "turnId"),
        )
      }
      "assistant-message-correlated" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "messageId")
        VoiceRuntimeThreadTurnEvent.AssistantMessageCorrelated(
          sequence,
          identifier(value, "messageId"),
        )
      }
      "speech-ready" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("segmentIndex", "finalSegment"))
        val segmentIndex = nonNegativeLong(value, "segmentIndex")
        require(segmentIndex <= Int.MAX_VALUE) { "Invalid speech segment index." }
        VoiceRuntimeThreadTurnEvent.SpeechReady(
          sequence,
          segmentIndex.toInt(),
          boolean(value, "finalSegment"),
        )
      }
      "speech-terminal" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "outcome")
        VoiceRuntimeThreadTurnEvent.SpeechTerminal(
          sequence,
          literal(value, "outcome", SPEECH_TERMINALS),
        )
      }
      "attention-required" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "attention")
        VoiceRuntimeThreadTurnEvent.AttentionRequired(
          sequence,
          literal(value, "attention", ATTENTION_TYPES),
        )
      }
      "failure" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + setOf("code", "retryable"))
        VoiceRuntimeThreadTurnEvent.Failure(
          sequence,
          literal(value, "code", FAILURE_CODES),
          boolean(value, "retryable"),
        )
      }
      "terminal" -> {
        value.requireExactFields(EVENT_BASE_FIELDS + "outcome")
        VoiceRuntimeThreadTurnEvent.Terminal(
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
  ): List<VoiceRuntimeSpeechDisposition> {
    val values = source.get(name)
    require(values is JSONArray && values.length() <= 512)
    return buildList(values.length()) {
      for (index in 0 until values.length()) {
        val value = values.get(index)
        require(value is JSONObject)
        value.requireExactFields(setOf("segmentIndex", "disposition"))
        add(VoiceRuntimeSpeechDisposition(
          nonNegativeLong(value, "segmentIndex").also { require(it <= Int.MAX_VALUE) }.toInt(),
          literal(value, "disposition", SEGMENT_DISPOSITIONS),
        ))
      }
    }
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

internal fun interface VoiceRuntimeThreadTurnHttp {
  fun execute(request: VoiceRuntimeHttpRequest): VoiceRuntimeHttpResult

  fun newCall(request: VoiceRuntimeHttpRequest): VoiceRuntimeThreadRawCall =
    object : VoiceRuntimeThreadRawCall {
      override fun execute() = this@VoiceRuntimeThreadTurnHttp.execute(request)
      override fun cancel() = Unit
    }
}

internal interface VoiceRuntimeThreadRawCall {
  fun execute(): VoiceRuntimeHttpResult
  fun executeStreaming(onChunk: (ByteArray) -> Unit): VoiceRuntimeHttpResult {
    val result = execute()
    if (result is VoiceRuntimeHttpResult.Success) {
      result.body.asList().chunked(STREAM_CHUNK_BYTES).forEach { bytes ->
        onChunk(bytes.toByteArray())
      }
      return result.copy(body = ByteArray(0))
    }
    return result
  }
  fun cancel()

  companion object {
    private const val STREAM_CHUNK_BYTES = 64 * 1_024
  }
}

internal interface VoiceRuntimeThreadCall<out T> {
  fun execute(): VoiceRuntimeThreadTurnResult<T>
  fun cancel()
}

internal class VoiceRuntimeThreadTurnDelegate(
  private val http: VoiceRuntimeThreadTurnHttp = productionHttp(),
) {
  fun newCreateCall(
    origin: String,
    sessionCredential: String,
    input: VoiceRuntimeThreadTurnCreateInput,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnCreateResult> =
    jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = "/api/voice/runtime/thread-turns",
        method = VoiceRuntimeHttpMethod.POST,
        sessionCredential = credential(sessionCredential),
        body = jsonBody(VoiceRuntimeThreadTurnJson.encodeCreate(input)),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      VoiceRuntimeThreadTurnJson::decodeCreate,
    )

  fun create(
    origin: String,
    sessionCredential: String,
    input: VoiceRuntimeThreadTurnCreateInput,
  ): VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnCreateResult> =
    newCreateCall(origin, sessionCredential, input).execute()

  fun newUploadAudioCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
    audio: VoiceRuntimeRequestBody,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnAudioResult> {
    require(audio.contentType == "audio/mp4") { "Native thread turn audio must be audio/mp4." }
    return jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = operationPath(operationId, "audio"),
        method = VoiceRuntimeHttpMethod.PUT,
        sessionCredential = credential(sessionCredential),
        body = audio,
        maximumRequestBytes = MAXIMUM_AUDIO_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      VoiceRuntimeThreadTurnJson::decodeAudio,
    )
  }

  fun newDraftDispositionCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnDispositionResult> =
    jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = operationPath(operationId, "disposition"),
        method = VoiceRuntimeHttpMethod.POST,
        sessionCredential = credential(sessionCredential),
        body = jsonBody(VoiceRuntimeThreadTurnJson.encodeDraftDisposition()),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      VoiceRuntimeThreadTurnJson::decodeDisposition,
    )

  fun uploadAudio(
    origin: String,
    sessionCredential: String,
    operationId: String,
    audio: VoiceRuntimeRequestBody,
  ): VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnAudioResult> {
    require(audio.contentType == "audio/mp4") { "Native thread turn audio must be audio/mp4." }
    return newUploadAudioCall(origin, sessionCredential, operationId, audio).execute()
  }

  fun newEventsCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
    afterSequence: Long,
    waitMilliseconds: Int,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnEventsResult> {
    require(afterSequence in 0..MAXIMUM_SAFE_INTEGER && waitMilliseconds in 0..30_000)
    return jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events"),
        method = VoiceRuntimeHttpMethod.GET,
        sessionCredential = credential(sessionCredential),
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
        queryParameters = mapOf(
          "afterSequence" to afterSequence.toString(),
          "waitMilliseconds" to waitMilliseconds.toString(),
        ),
      ),
      VoiceRuntimeThreadTurnJson::decodeEvents,
    )
  }

  fun events(
    origin: String,
    sessionCredential: String,
    operationId: String,
    afterSequence: Long,
    waitMilliseconds: Int,
  ): VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnEventsResult> {
    require(afterSequence in 0..MAXIMUM_SAFE_INTEGER && waitMilliseconds in 0..30_000)
    return newEventsCall(origin, sessionCredential, operationId, afterSequence, waitMilliseconds)
      .execute()
  }

  fun acknowledge(
    origin: String,
    sessionCredential: String,
    operationId: String,
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<VoiceRuntimeSpeechDisposition>,
  ): VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnSnapshot> =
    newAcknowledgeCall(
      origin,
      sessionCredential,
      operationId,
      sequence,
      speechPlanId,
      highestStartedSegment,
      highestDrainedSegment,
      segmentDispositions,
    ).execute()

  fun newAcknowledgeCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
    sequence: Long,
    speechPlanId: String,
    highestStartedSegment: Int?,
    highestDrainedSegment: Int?,
    segmentDispositions: List<VoiceRuntimeSpeechDisposition>,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnSnapshot> =
    jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = operationPath(operationId, "events/ack"),
        method = VoiceRuntimeHttpMethod.POST,
        sessionCredential = credential(sessionCredential),
        body = jsonBody(VoiceRuntimeThreadTurnJson.encodeAcknowledgement(
          sequence,
          speechPlanId,
          highestStartedSegment,
          highestDrainedSegment,
          segmentDispositions,
        )),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      VoiceRuntimeThreadTurnJson::decodeAcknowledgement,
    )

  fun speech(
    origin: String,
    sessionCredential: String,
    operationId: String,
    segmentIndex: Int,
  ): VoiceRuntimeThreadTurnResult<ByteArray> =
    newSpeechCall(origin, sessionCredential, operationId, segmentIndex).execute()

  fun newSpeechCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
    segmentIndex: Int,
  ): VoiceRuntimeThreadCall<ByteArray> {
    require(segmentIndex >= 0)
    return call(VoiceRuntimeHttpRequest(
      origin = origin,
      path = operationPath(operationId, "speech/$segmentIndex"),
      method = VoiceRuntimeHttpMethod.GET,
      sessionCredential = credential(sessionCredential),
      maximumResponseBytes = MAXIMUM_PCM_RESPONSE_BYTES,
    )) { response ->
      when (response) {
        is VoiceRuntimeHttpResult.Failure -> response.failure()
        is VoiceRuntimeHttpResult.Success -> try {
          require(response.contentType?.substringBefore(';')?.trim() == "audio/pcm")
          require(response.headers["x-t3-audio-format"] == PCM_FORMAT_HEADER)
          require(response.body.isNotEmpty() && response.body.size <= MAXIMUM_PCM_RESPONSE_BYTES &&
            response.body.size % 2 == 0)
          VoiceRuntimeThreadTurnResult.Success(response.body)
        } catch (_: RuntimeException) { permanentFailure() }
      }
    }
  }

  fun newSpeechStreamCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
    segmentIndex: Int,
    onChunk: (ByteArray) -> Unit,
  ): VoiceRuntimeThreadCall<Unit> {
    require(segmentIndex >= 0)
    val raw = http.newCall(VoiceRuntimeHttpRequest(
      origin = origin,
      path = operationPath(operationId, "speech/$segmentIndex"),
      method = VoiceRuntimeHttpMethod.GET,
      sessionCredential = credential(sessionCredential),
      maximumResponseBytes = MAXIMUM_PCM_RESPONSE_BYTES,
    ))
    return object : VoiceRuntimeThreadCall<Unit> {
      override fun execute(): VoiceRuntimeThreadTurnResult<Unit> {
        var totalBytes = 0L
        return when (val response = raw.executeStreaming { chunk ->
          require(chunk.isNotEmpty() && chunk.size % 2 == 0)
          totalBytes = Math.addExact(totalBytes, chunk.size.toLong())
          require(totalBytes <= MAXIMUM_PCM_RESPONSE_BYTES)
          onChunk(chunk)
        }) {
          is VoiceRuntimeHttpResult.Failure -> response.failure()
          is VoiceRuntimeHttpResult.Success -> try {
            require(response.contentType?.substringBefore(';')?.trim() == "audio/pcm")
            require(response.headers["x-t3-audio-format"] == PCM_FORMAT_HEADER)
            require(totalBytes > 0 && totalBytes % 2 == 0L)
            VoiceRuntimeThreadTurnResult.Success(Unit)
          } catch (_: RuntimeException) { permanentFailure() }
        }
      }

      override fun cancel() = raw.cancel()
    }
  }

  fun cancel(
    origin: String,
    sessionCredential: String,
    operationId: String,
  ): VoiceRuntimeThreadTurnResult<VoiceRuntimeThreadTurnCancelResult> =
    newCancelCall(origin, sessionCredential, operationId).execute()

  fun newCancelCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadTurnCancelResult> =
    jsonCall(
      VoiceRuntimeHttpRequest(
        origin = origin,
        path = operationPath(operationId, "cancel"),
        method = VoiceRuntimeHttpMethod.POST,
        sessionCredential = credential(sessionCredential),
        body = jsonBody(VoiceRuntimeThreadTurnJson.encodeCancel()),
        maximumRequestBytes = MAXIMUM_JSON_BYTES,
        maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
      ),
      VoiceRuntimeThreadTurnJson::decodeCancel,
    )

  fun newDraftCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadDraft> = jsonCall(
    VoiceRuntimeHttpRequest(
      origin = origin,
      path = operationPath(operationId, "draft"),
      method = VoiceRuntimeHttpMethod.GET,
      sessionCredential = credential(sessionCredential),
      maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
    ),
    VoiceRuntimeThreadTurnJson::decodeDraft,
  )

  fun newConsumeDraftCall(
    origin: String,
    sessionCredential: String,
    operationId: String,
  ): VoiceRuntimeThreadCall<VoiceRuntimeThreadDraftConsumeResult> = jsonCall(
    VoiceRuntimeHttpRequest(
      origin = origin,
      path = operationPath(operationId, "draft/consume"),
      method = VoiceRuntimeHttpMethod.POST,
      sessionCredential = credential(sessionCredential),
      body = jsonBody(JSONObject().toString().toByteArray(Charsets.UTF_8)),
      maximumRequestBytes = MAXIMUM_JSON_BYTES,
      maximumResponseBytes = MAXIMUM_JSON_RESPONSE_BYTES,
    ),
    VoiceRuntimeThreadTurnJson::decodeDraftConsume,
  )

  private fun <A> jsonCall(
    request: VoiceRuntimeHttpRequest,
    decode: (ByteArray) -> A,
  ): VoiceRuntimeThreadCall<A> = call(request) { response ->
    when (response) {
      is VoiceRuntimeHttpResult.Failure -> response.failure()
      is VoiceRuntimeHttpResult.Success -> try {
        require(response.contentType?.substringBefore(';')?.trim() == "application/json")
        VoiceRuntimeThreadTurnResult.Success(decode(response.body))
      } catch (_: RuntimeException) { permanentFailure() }
    }
  }

  private fun <A> call(
    request: VoiceRuntimeHttpRequest,
    transform: (VoiceRuntimeHttpResult) -> VoiceRuntimeThreadTurnResult<A>,
  ): VoiceRuntimeThreadCall<A> {
    val raw = http.newCall(request)
    return object : VoiceRuntimeThreadCall<A> {
      override fun execute() = transform(raw.execute())
      override fun cancel() = raw.cancel()
    }
  }

  private fun operationPath(operationId: String, suffix: String): String {
    require(operationId.matches(OPERATION_ID_PATTERN)) { "Invalid native thread operation ID." }
    require(suffix.matches(SUFFIX_PATTERN)) { "Invalid native thread operation path." }
    return "/api/voice/runtime/thread-turns/$operationId/$suffix"
  }

  private fun credential(value: String) = VoiceRuntimeSessionCredential(value)

  private fun jsonBody(bytes: ByteArray) =
    VoiceRuntimeByteArrayBody(bytes, "application/json")

  private fun VoiceRuntimeHttpResult.Failure.failure() =
    VoiceRuntimeThreadTurnResult.Failure(kind, statusCode)

  private fun permanentFailure() =
    VoiceRuntimeThreadTurnResult.Failure(
      VoiceRuntimeHttpFailureKind.PERMANENT,
      null,
    )

  private companion object {
    fun productionHttp(): VoiceRuntimeThreadTurnHttp {
      val transport = VoiceRuntimeHttpTransport()
      return object : VoiceRuntimeThreadTurnHttp {
        override fun execute(request: VoiceRuntimeHttpRequest) = transport.execute(request)
        override fun newCall(request: VoiceRuntimeHttpRequest): VoiceRuntimeThreadRawCall {
          val call = transport.newCall(request)
          return object : VoiceRuntimeThreadRawCall {
            override fun execute() = call.execute()
            override fun executeStreaming(onChunk: (ByteArray) -> Unit) =
              call.executeStreaming(onChunk)
            override fun cancel() = call.cancel()
          }
        }
      }
    }

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
