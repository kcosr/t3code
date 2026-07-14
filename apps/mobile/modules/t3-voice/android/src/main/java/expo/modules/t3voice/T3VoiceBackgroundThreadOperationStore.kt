package expo.modules.t3voice

import android.content.Context
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.json.JSONObject

internal data class T3VoiceBackgroundThreadClaim(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val readinessGeneration: Long,
  val modeSessionId: String,
  val environmentOrigin: String,
  val projectId: String,
  val threadId: String,
  val clientOperationId: String,
  val submissionPolicy: String,
  val speechPlanId: String,
  val draftContext: VoiceRuntimeDraftContext?,
)

internal sealed interface T3VoiceBackgroundThreadOperationState {
  val claim: T3VoiceBackgroundThreadClaim

  data class Prepared(
    override val claim: T3VoiceBackgroundThreadClaim,
    val cancelRequested: Boolean = false,
  ) :
    T3VoiceBackgroundThreadOperationState

  data class Active(
    override val claim: T3VoiceBackgroundThreadClaim,
    val operationId: String,
    val expiresAtEpochMillis: Long,
    val token: String,
    val acknowledgedCursor: Long,
    val recording: T3VoiceRecordingResult? = null,
    val detached: Boolean = false,
    val cancelRequested: Boolean = false,
    val draftDispositionPending: Boolean = false,
    val draftConsumePending: Boolean = false,
    val snapshot: T3VoiceBackgroundSnapshot,
  ) : T3VoiceBackgroundThreadOperationState
}

internal sealed interface T3VoiceBackgroundThreadOperationLoadResult {
  data object Missing : T3VoiceBackgroundThreadOperationLoadResult
  data object Locked : T3VoiceBackgroundThreadOperationLoadResult
  data class Available(val state: T3VoiceBackgroundThreadOperationState) :
    T3VoiceBackgroundThreadOperationLoadResult
}

internal sealed interface T3VoiceBackgroundThreadOperationUpdateResult {
  data class Updated(val state: T3VoiceBackgroundThreadOperationState.Active) :
    T3VoiceBackgroundThreadOperationUpdateResult
  data object Missing : T3VoiceBackgroundThreadOperationUpdateResult
  data object Locked : T3VoiceBackgroundThreadOperationUpdateResult
  data object IdentityMismatch : T3VoiceBackgroundThreadOperationUpdateResult
}

internal class T3VoiceBackgroundThreadOperationStore(
  private val storage: T3VoiceBackgroundKeyValueStore,
  private val cipher: T3VoiceRuntimeGrantCipher,
) {
  constructor(context: Context) : this(
    T3VoiceBackgroundPreferences(context.applicationContext),
    T3VoiceAndroidKeystoreGrantCipher("t3.voice.background.thread-operation.v1"),
  )

  @Synchronized fun writePrepared(
    claim: T3VoiceBackgroundThreadClaim,
    cancelRequested: Boolean = false,
  ) {
    val existing = load()
    require(existing == T3VoiceBackgroundThreadOperationLoadResult.Missing ||
      (existing is T3VoiceBackgroundThreadOperationLoadResult.Available &&
        existing.state.claim == claim &&
        existing.state is T3VoiceBackgroundThreadOperationState.Prepared)) {
      "A different native thread operation is already claimed."
    }
    writeBase("prepared", claim, mapOf(KEY_CANCEL_REQUESTED to cancelRequested.toString()))
  }

  @Synchronized fun writeActive(state: T3VoiceBackgroundThreadOperationState.Active) {
    val loaded = load()
    require(loaded is T3VoiceBackgroundThreadOperationLoadResult.Available &&
      loaded.state.claim == state.claim) { "Native thread operation claim changed." }
    writeActiveUnchecked(state)
  }

  @Synchronized fun updateActive(
    expectedClientOperationId: String,
    transform: (T3VoiceBackgroundThreadOperationState.Active) ->
      T3VoiceBackgroundThreadOperationState.Active,
  ): T3VoiceBackgroundThreadOperationUpdateResult {
    val loaded = when (val result = load()) {
      T3VoiceBackgroundThreadOperationLoadResult.Missing ->
        return T3VoiceBackgroundThreadOperationUpdateResult.Missing
      T3VoiceBackgroundThreadOperationLoadResult.Locked ->
        return T3VoiceBackgroundThreadOperationUpdateResult.Locked
      is T3VoiceBackgroundThreadOperationLoadResult.Available -> result
    }
    val active = loaded.state as? T3VoiceBackgroundThreadOperationState.Active
      ?: return T3VoiceBackgroundThreadOperationUpdateResult.IdentityMismatch
    if (active.claim.clientOperationId != expectedClientOperationId) {
      return T3VoiceBackgroundThreadOperationUpdateResult.IdentityMismatch
    }
    val updated = transform(active)
    require(updated.claim == active.claim && updated.operationId == active.operationId) {
      "Native thread operation identity changed."
    }
    return try {
      writeActiveUnchecked(updated)
      T3VoiceBackgroundThreadOperationUpdateResult.Updated(updated)
    } catch (_: Throwable) {
      T3VoiceBackgroundThreadOperationUpdateResult.Locked
    }
  }

  @Synchronized fun prepareDraftDisposition(
    expectedClientOperationId: String,
    context: VoiceRuntimeDraftContext,
  ): T3VoiceBackgroundThreadOperationUpdateResult {
    val loaded = when (val result = load()) {
      T3VoiceBackgroundThreadOperationLoadResult.Missing ->
        return T3VoiceBackgroundThreadOperationUpdateResult.Missing
      T3VoiceBackgroundThreadOperationLoadResult.Locked ->
        return T3VoiceBackgroundThreadOperationUpdateResult.Locked
      is T3VoiceBackgroundThreadOperationLoadResult.Available -> result
    }
    val active = loaded.state as? T3VoiceBackgroundThreadOperationState.Active
      ?: return T3VoiceBackgroundThreadOperationUpdateResult.IdentityMismatch
    if (active.claim.clientOperationId != expectedClientOperationId ||
      active.claim.submissionPolicy != "auto-submit" || active.claim.draftContext != null ||
      context.projectId != active.claim.projectId || context.threadId != active.claim.threadId) {
      return T3VoiceBackgroundThreadOperationUpdateResult.IdentityMismatch
    }
    val updated = active.copy(
      claim = active.claim.copy(submissionPolicy = "draft", draftContext = context),
      draftDispositionPending = true,
    )
    return try {
      writeActiveUnchecked(updated)
      T3VoiceBackgroundThreadOperationUpdateResult.Updated(updated)
    } catch (_: Throwable) {
      T3VoiceBackgroundThreadOperationUpdateResult.Locked
    }
  }

  private fun writeActiveUnchecked(state: T3VoiceBackgroundThreadOperationState.Active) {
    require(state.token.isNotBlank() && state.token.none(Char::isWhitespace))
    require(state.acknowledgedCursor in 0..state.snapshot.eventCursor)
    val aad = metadataBytes(state)
    val encrypted = cipher.encrypt(state.token.toByteArray(), aad)
    writeBase("active", state.claim, mapOf(
      KEY_OPERATION to state.operationId,
      KEY_EXPIRES to state.expiresAtEpochMillis.toString(),
      KEY_ACKNOWLEDGED_CURSOR to state.acknowledgedCursor.toString(),
      KEY_RECORDING_ID to state.recording?.recordingId,
      KEY_RECORDING_URI to state.recording?.uri,
      KEY_RECORDING_DURATION to state.recording?.durationMs?.toString(),
      KEY_RECORDING_BYTES to state.recording?.byteLength?.toString(),
      KEY_DETACHED to state.detached.toString(),
      KEY_CANCEL_REQUESTED to state.cancelRequested.toString(),
      KEY_DRAFT_DISPOSITION_PENDING to state.draftDispositionPending.toString(),
      KEY_DRAFT_CONSUME_PENDING to state.draftConsumePending.toString(),
      KEY_SNAPSHOT to encodeSnapshot(state.snapshot),
      KEY_IV to Base64.getEncoder().encodeToString(encrypted.initializationVector),
      KEY_CIPHERTEXT to Base64.getEncoder().encodeToString(encrypted.ciphertext),
    ))
  }

  @Synchronized fun load(): T3VoiceBackgroundThreadOperationLoadResult {
    val phase = storage.getString(KEY_PHASE)
      ?: return if (ALL_KEYS.any { storage.getString(it) != null }) {
        T3VoiceBackgroundThreadOperationLoadResult.Locked
      } else T3VoiceBackgroundThreadOperationLoadResult.Missing
    return try {
      val claim = T3VoiceBackgroundThreadClaim(
        required(KEY_RUNTIME), required(KEY_RUNTIME_INSTANCE), required(KEY_GENERATION).toLong(),
        required(KEY_MODE_SESSION), required(KEY_ORIGIN), required(KEY_PROJECT),
        required(KEY_THREAD), required(KEY_CLIENT_OPERATION), required(KEY_SUBMISSION_POLICY),
        required(KEY_SPEECH_PLAN), draftContextOrNull(),
      )
      require(claim.submissionPolicy in setOf("auto-submit", "draft"))
      require((claim.submissionPolicy == "draft") == (claim.draftContext != null))
      val state = when (phase) {
        "prepared" -> {
          require((ACTIVE_KEYS - KEY_CANCEL_REQUESTED).all { storage.getString(it) == null })
          T3VoiceBackgroundThreadOperationState.Prepared(
            claim,
            required(KEY_CANCEL_REQUESTED).toBooleanStrict(),
          )
        }
        "active" -> {
          val unsigned = T3VoiceBackgroundThreadOperationState.Active(
            claim, required(KEY_OPERATION), required(KEY_EXPIRES).toLong(), "pending",
            required(KEY_ACKNOWLEDGED_CURSOR).toLong(),
            recordingOrNull(), required(KEY_DETACHED).toBooleanStrict(),
            required(KEY_CANCEL_REQUESTED).toBooleanStrict(),
            required(KEY_DRAFT_DISPOSITION_PENDING).toBooleanStrict(),
            required(KEY_DRAFT_CONSUME_PENDING).toBooleanStrict(),
            decodeSnapshot(required(KEY_SNAPSHOT)),
          )
          val token = cipher.decrypt(
            T3VoiceEncryptedGrant(
              Base64.getDecoder().decode(required(KEY_IV)),
              Base64.getDecoder().decode(required(KEY_CIPHERTEXT)),
            ), metadataBytes(unsigned),
          ).toString(StandardCharsets.UTF_8)
          unsigned.copy(token = token)
        }
        else -> error("Invalid native thread operation phase.")
      }
      T3VoiceBackgroundThreadOperationLoadResult.Available(state)
    } catch (_: Exception) {
      T3VoiceBackgroundThreadOperationLoadResult.Locked
    }
  }

  @Synchronized fun clear(expectedClientOperationId: String): Boolean {
    val loaded = load() as? T3VoiceBackgroundThreadOperationLoadResult.Available ?: return false
    if (loaded.state.claim.clientOperationId != expectedClientOperationId) return false
    check(storage.clear(ALL_KEYS)) { "Could not clear native thread operation." }
    return true
  }

  @Synchronized fun clearLockedAfterAuthorityRevocation(): Boolean {
    if (load() != T3VoiceBackgroundThreadOperationLoadResult.Locked) return false
    check(storage.clear(ALL_KEYS)) { "Could not clear locked native thread operation." }
    cipher.deleteKey()
    return true
  }

  private fun writeBase(phase: String, claim: T3VoiceBackgroundThreadClaim, extra: Map<String, String?>) {
    check(storage.put(mapOf(
      KEY_PHASE to phase, KEY_RUNTIME to claim.runtimeId,
      KEY_RUNTIME_INSTANCE to claim.runtimeInstanceId,
      KEY_GENERATION to claim.readinessGeneration.toString(),
      KEY_MODE_SESSION to claim.modeSessionId,
      KEY_ORIGIN to T3VoiceBackgroundOriginPolicy.normalize(claim.environmentOrigin),
      KEY_PROJECT to claim.projectId, KEY_THREAD to claim.threadId,
      KEY_CLIENT_OPERATION to claim.clientOperationId,
      KEY_SUBMISSION_POLICY to claim.submissionPolicy,
      KEY_SPEECH_PLAN to claim.speechPlanId,
      KEY_DRAFT_ENVIRONMENT to claim.draftContext?.environmentId,
      KEY_DRAFT_PROJECT to claim.draftContext?.projectId,
      KEY_DRAFT_THREAD to claim.draftContext?.threadId,
      KEY_DRAFT_COMPOSER_REVISION to claim.draftContext?.composerRevision,
    ) + ACTIVE_KEYS.associateWith { extra[it] })) { "Could not persist native thread operation." }
  }

  private fun metadataBytes(state: T3VoiceBackgroundThreadOperationState.Active): ByteArray =
    listOf("t3-voice-thread-operation-v1", state.claim.runtimeId,
      state.claim.runtimeInstanceId,
      state.claim.readinessGeneration.toString(),
      state.claim.modeSessionId,
      T3VoiceBackgroundOriginPolicy.normalize(state.claim.environmentOrigin),
      state.claim.projectId, state.claim.threadId, state.claim.clientOperationId,
      state.claim.submissionPolicy, state.claim.speechPlanId,
      state.claim.draftContext?.environmentId.orEmpty(),
      state.claim.draftContext?.projectId.orEmpty(),
      state.claim.draftContext?.threadId.orEmpty(),
      state.claim.draftContext?.composerRevision.orEmpty(),
      state.operationId, state.expiresAtEpochMillis.toString(),
      state.acknowledgedCursor.toString(),
      state.recording?.recordingId.orEmpty(), state.recording?.uri.orEmpty(),
      state.recording?.durationMs?.toString().orEmpty(),
      state.recording?.byteLength?.toString().orEmpty(),
      state.detached.toString(),
      state.cancelRequested.toString(),
      state.draftDispositionPending.toString(),
      state.draftConsumePending.toString(),
      encodeSnapshot(state.snapshot),
    ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)

  private fun recordingOrNull(): T3VoiceRecordingResult? {
    val values = listOf(KEY_RECORDING_ID, KEY_RECORDING_URI, KEY_RECORDING_DURATION, KEY_RECORDING_BYTES)
      .map(storage::getString)
    if (values.all { it == null }) return null
    require(values.all { it != null })
    return T3VoiceRecordingResult(values[0]!!, values[1]!!, values[2]!!.toLong(), values[3]!!.toLong())
  }

  private fun draftContextOrNull(): VoiceRuntimeDraftContext? {
    val values = listOf(
      KEY_DRAFT_ENVIRONMENT, KEY_DRAFT_PROJECT, KEY_DRAFT_THREAD, KEY_DRAFT_COMPOSER_REVISION,
    ).map(storage::getString)
    if (values.all { it == null }) return null
    require(values.all { !it.isNullOrBlank() })
    return VoiceRuntimeDraftContext(values[0]!!, values[1]!!, values[2]!!, values[3]!!)
  }

  private fun encodeSnapshot(snapshot: T3VoiceBackgroundSnapshot): String = JSONObject()
    .put("runtimeId", snapshot.runtimeId ?: JSONObject.NULL).put("readinessGeneration", snapshot.readinessGeneration)
    .put("mode", snapshot.mode?.name ?: JSONObject.NULL).put("phase", snapshot.phase.name)
    .put("operationId", snapshot.operationId ?: JSONObject.NULL)
    .put("operationGeneration", snapshot.operationGeneration ?: JSONObject.NULL)
    .put("recordingId", snapshot.recordingId ?: JSONObject.NULL).put("dispatchAcknowledged", snapshot.dispatchAcknowledged)
    .put("eventCursor", snapshot.eventCursor).put("playbackCursor", snapshot.playbackCursor)
    .put("highestAdvertisedSpeechSegment", snapshot.highestAdvertisedSpeechSegment)
    .put("finalSpeechSegment", snapshot.finalSpeechSegment ?: JSONObject.NULL).put("speechTerminal", snapshot.speechTerminal)
    .put("noSpeech", snapshot.noSpeech).put("responseTerminal", snapshot.responseTerminal)
    .put("autoRearm", snapshot.autoRearm).put("messageId", snapshot.messageId ?: JSONObject.NULL)
    .put("turnId", snapshot.turnId ?: JSONObject.NULL)
    .put("terminalSummary", snapshot.terminalSummary?.name ?: JSONObject.NULL).toString()

  private fun decodeSnapshot(value: String): T3VoiceBackgroundSnapshot {
    val json = JSONObject(value)
    require(json.keys().asSequence().toSet() == SNAPSHOT_FIELDS)
    fun nullableString(key: String) = if (json.isNull(key)) null else json.getString(key)
    fun nullableInt(key: String) = if (json.isNull(key)) null else json.getInt(key)
    fun nullableLong(key: String) = if (json.isNull(key)) null else json.getLong(key)
    return T3VoiceBackgroundSnapshot(
      nullableString("runtimeId"), json.getLong("readinessGeneration"),
      nullableString("mode")?.let(T3VoiceBackgroundMode::valueOf),
      T3VoiceBackgroundPhase.valueOf(json.getString("phase")), nullableString("operationId"),
      nullableLong("operationGeneration"), nullableString("recordingId"),
      json.getBoolean("dispatchAcknowledged"), json.getLong("eventCursor"),
      json.getInt("playbackCursor"), json.getInt("highestAdvertisedSpeechSegment"),
      nullableInt("finalSpeechSegment"), json.getBoolean("speechTerminal"),
      json.getBoolean("noSpeech"), json.getBoolean("responseTerminal"),
      json.getBoolean("autoRearm"), nullableString("messageId"), nullableString("turnId"),
      nullableString("terminalSummary")?.let(T3VoiceBackgroundTerminalSummary::valueOf),
    )
  }

  private fun required(key: String) = checkNotNull(storage.getString(key))

  private companion object {
    const val KEY_PHASE = "thread_operation_phase"
    const val KEY_RUNTIME = "thread_operation_runtime"
    const val KEY_RUNTIME_INSTANCE = "thread_operation_runtime_instance"
    const val KEY_GENERATION = "thread_operation_generation"
    const val KEY_MODE_SESSION = "thread_operation_mode_session"
    const val KEY_ORIGIN = "thread_operation_origin"
    const val KEY_PROJECT = "thread_operation_project"
    const val KEY_THREAD = "thread_operation_thread"
    const val KEY_CLIENT_OPERATION = "thread_operation_client_id"
    const val KEY_SUBMISSION_POLICY = "thread_operation_submission_policy"
    const val KEY_SPEECH_PLAN = "thread_operation_speech_plan"
    const val KEY_DRAFT_ENVIRONMENT = "thread_operation_draft_environment"
    const val KEY_DRAFT_PROJECT = "thread_operation_draft_project"
    const val KEY_DRAFT_THREAD = "thread_operation_draft_thread"
    const val KEY_DRAFT_COMPOSER_REVISION = "thread_operation_draft_composer_revision"
    const val KEY_OPERATION = "thread_operation_id"
    const val KEY_EXPIRES = "thread_operation_expires"
    const val KEY_ACKNOWLEDGED_CURSOR = "thread_operation_acknowledged_cursor"
    const val KEY_RECORDING_ID = "thread_operation_recording_id"
    const val KEY_RECORDING_URI = "thread_operation_recording_uri"
    const val KEY_RECORDING_DURATION = "thread_operation_recording_duration"
    const val KEY_RECORDING_BYTES = "thread_operation_recording_bytes"
    const val KEY_IV = "thread_operation_iv"
    const val KEY_CIPHERTEXT = "thread_operation_ciphertext"
    const val KEY_DETACHED = "thread_operation_detached"
    const val KEY_CANCEL_REQUESTED = "thread_operation_cancel_requested"
    const val KEY_DRAFT_DISPOSITION_PENDING = "thread_operation_draft_disposition_pending"
    const val KEY_DRAFT_CONSUME_PENDING = "thread_operation_draft_consume_pending"
    const val KEY_SNAPSHOT = "thread_operation_snapshot"
    val ACTIVE_KEYS =
      setOf(
        KEY_OPERATION, KEY_EXPIRES, KEY_ACKNOWLEDGED_CURSOR, KEY_RECORDING_ID, KEY_RECORDING_URI,
        KEY_RECORDING_DURATION, KEY_RECORDING_BYTES, KEY_IV, KEY_CIPHERTEXT, KEY_DETACHED,
        KEY_CANCEL_REQUESTED, KEY_SNAPSHOT, KEY_DRAFT_DISPOSITION_PENDING,
        KEY_DRAFT_CONSUME_PENDING,
      )
    val ALL_KEYS = ACTIVE_KEYS + setOf(KEY_PHASE, KEY_RUNTIME, KEY_GENERATION, KEY_ORIGIN,
      KEY_RUNTIME_INSTANCE, KEY_MODE_SESSION, KEY_PROJECT, KEY_THREAD, KEY_CLIENT_OPERATION,
      KEY_SUBMISSION_POLICY, KEY_SPEECH_PLAN, KEY_DRAFT_ENVIRONMENT, KEY_DRAFT_PROJECT,
      KEY_DRAFT_THREAD, KEY_DRAFT_COMPOSER_REVISION)
    val SNAPSHOT_FIELDS = setOf("runtimeId", "readinessGeneration", "mode", "phase", "operationId",
      "operationGeneration", "recordingId", "dispatchAcknowledged", "eventCursor",
      "playbackCursor", "highestAdvertisedSpeechSegment", "finalSpeechSegment", "speechTerminal",
      "noSpeech", "responseTerminal", "autoRearm", "messageId", "turnId", "terminalSummary")
  }
}
