package expo.modules.t3voice

import android.content.Context
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject

internal data class VoiceRuntimeThreadReceipt(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val turnClientOperationId: String,
  val turnOperationId: String?,
  val environmentId: String,
  val projectId: String,
  val threadId: String,
  val userMessageId: String?,
  val turnId: String?,
  val assistantMessageIds: List<String>,
  val speechPlanId: String?,
  val highestAdvertisedSegment: Int?,
  val highestStartedSegment: Int?,
  val highestDrainedSegment: Int?,
  val segmentDispositions: List<VoiceRuntimeSpeechDisposition>,
  val speechTerminal: String?,
  val terminalOutcome: String?,
  val createdAtEpochMillis: Long,
  val expiresAtEpochMillis: Long,
)

internal interface VoiceRuntimeJournalRepository {
  fun publishReceipt(receipt: VoiceRuntimeThreadReceipt)
  fun receipts(runtimeId: String, generation: Long, nowEpochMillis: Long): List<VoiceRuntimeThreadReceipt>
  fun acknowledgeReceipt(key: VoiceRuntimeRetainedRecordKey.ThreadReceipt): Boolean
  fun publishAction(action: VoiceRuntimePresentationAction)
  fun removeAction(actionId: String)
  fun actions(nowEpochMillis: Long): List<VoiceRuntimePresentationAction>
}

internal class VoiceRuntimeDurableJournalRepository(
  private val storage: VoiceRuntimeKeyValueStore,
  private val now: () -> Long = System::currentTimeMillis,
  private val receiptCapacity: Int = MAXIMUM_RECEIPTS,
  private val actionCapacity: Int = MAXIMUM_ACTIONS,
) : VoiceRuntimeJournalRepository {
  constructor(context: Context) : this(VoiceRuntimePreferences(context.applicationContext))

  init {
    require(receiptCapacity > 0)
    require(actionCapacity > 0)
  }

  @Synchronized
  override fun publishReceipt(receipt: VoiceRuntimeThreadReceipt) {
    val current = receiptValues().filter { it.expiresAtEpochMillis > now() }
    val existing = current.firstOrNull {
      it.identity == receipt.identity &&
        it.modeSessionId == receipt.modeSessionId &&
        it.turnClientOperationId == receipt.turnClientOperationId
    }
    val stable = existing?.let { receipt.copy(createdAtEpochMillis = it.createdAtEpochMillis) } ?: receipt
    if (existing == null && current.size >= receiptCapacity) {
      throw VoiceRuntimeRetentionCapacityException("thread receipt", receiptCapacity)
    }
    val values = current.filterNot {
      it.identity == stable.identity &&
        it.modeSessionId == stable.modeSessionId &&
        it.turnClientOperationId == stable.turnClientOperationId
    }.plus(stable)
      .sortedWith(compareBy({ it.expiresAtEpochMillis }, { it.turnClientOperationId }))
    write(KEY_RECEIPTS, JSONArray().also { array -> values.forEach { array.put(receiptJson(it)) } })
  }

  @Synchronized
  override fun receipts(
    runtimeId: String,
    generation: Long,
    nowEpochMillis: Long,
  ): List<VoiceRuntimeThreadReceipt> {
    val current = receiptValues()
    val live = current.filter { it.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) {
      write(KEY_RECEIPTS, JSONArray().also { array -> live.forEach { array.put(receiptJson(it)) } })
    }
    return live.filter { it.identity.runtimeId == runtimeId && it.identity.generation == generation }
  }

  @Synchronized
  override fun acknowledgeReceipt(key: VoiceRuntimeRetainedRecordKey.ThreadReceipt): Boolean {
    val current = receiptValues()
    val values = current.filterNot { it.matches(key) }
    if (values.size == current.size) return false
    write(KEY_RECEIPTS, JSONArray().also { array -> values.forEach { array.put(receiptJson(it)) } })
    return true
  }

  @Synchronized
  override fun publishAction(action: VoiceRuntimePresentationAction) {
    val current = actionValues().filter { it.expiresAtEpochMillis > now() }
    if (current.none { it.actionId == action.actionId } && current.size >= actionCapacity) {
      throw VoiceRuntimeRetentionCapacityException("presentation action", actionCapacity)
    }
    val values = current.filter { it.actionId != action.actionId }
      .plus(action)
      .sortedWith(compareBy({ it.expiresAtEpochMillis }, { it.actionId }))
    write(KEY_ACTIONS, JSONArray().also { array -> values.forEach { array.put(actionJson(it)) } })
  }

  @Synchronized
  override fun removeAction(actionId: String) {
    val values = actionValues().filterNot { it.actionId == actionId }
    write(KEY_ACTIONS, JSONArray().also { array -> values.forEach { array.put(actionJson(it)) } })
  }

  @Synchronized
  override fun actions(nowEpochMillis: Long): List<VoiceRuntimePresentationAction> {
    val current = actionValues()
    val live = current.filter { it.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) {
      write(KEY_ACTIONS, JSONArray().also { array -> live.forEach { array.put(actionJson(it)) } })
    }
    return live
  }

  private fun receiptValues(): List<VoiceRuntimeThreadReceipt> =
    array(KEY_RECEIPTS, receiptCapacity) { receipt(it) }
  private fun actionValues(): List<VoiceRuntimePresentationAction> =
    array(KEY_ACTIONS, actionCapacity) { action(it) }

  private fun <T> array(key: String, capacity: Int, decode: (JSONObject) -> T): List<T> {
    val raw = storage.getString(key) ?: return emptyList()
    return try {
      val values = JSONArray(raw)
      require(values.length() <= capacity)
      buildList(values.length()) {
        for (index in 0 until values.length()) add(decode(values.getJSONObject(index)))
      }
    } catch (cause: Throwable) {
      throw VoiceRuntimeDurableStateCorruptionException(
        "Voice runtime journal state is unreadable.",
        cause,
      )
    }
  }

  private fun write(key: String, value: JSONArray) {
    check(storage.put(mapOf(key to value.toString()))) { "Could not persist voice runtime journal." }
  }

  private fun receiptJson(value: VoiceRuntimeThreadReceipt) = JSONObject()
    .put("runtimeId", value.identity.runtimeId)
    .put("runtimeInstanceId", value.identity.runtimeInstanceId)
    .put("runtimeGeneration", value.identity.generation)
    .put("modeSessionId", value.modeSessionId)
    .put("turnClientOperationId", value.turnClientOperationId)
    .put("turnOperationId", value.turnOperationId ?: JSONObject.NULL)
    .put("environmentId", value.environmentId)
    .put("projectId", value.projectId)
    .put("threadId", value.threadId)
    .put("userMessageId", value.userMessageId ?: JSONObject.NULL)
    .put("turnId", value.turnId ?: JSONObject.NULL)
    .put("assistantMessageIds", JSONArray(value.assistantMessageIds))
    .put("speechPlanId", value.speechPlanId ?: JSONObject.NULL)
    .put("highestAdvertisedSegment", value.highestAdvertisedSegment ?: JSONObject.NULL)
    .put("highestStartedSegment", value.highestStartedSegment ?: JSONObject.NULL)
    .put("highestDrainedSegment", value.highestDrainedSegment ?: JSONObject.NULL)
    .put("segmentDispositions", JSONArray().also { array ->
      value.segmentDispositions.forEach { array.put(JSONObject()
        .put("segmentIndex", it.segmentIndex).put("disposition", it.disposition)) }
    })
    .put("speechTerminal", value.speechTerminal ?: JSONObject.NULL)
    .put("terminalOutcome", value.terminalOutcome ?: JSONObject.NULL)
    .put("createdAt", Instant.ofEpochMilli(value.createdAtEpochMillis).toString())
    .put("expiresAt", Instant.ofEpochMilli(value.expiresAtEpochMillis).toString())

  private fun receipt(value: JSONObject): VoiceRuntimeThreadReceipt {
    require(value.keys().asSequence().toSet() == RECEIPT_FIELDS)
    fun nullableString(key: String) = if (value.isNull(key)) null else value.getString(key)
    fun nullableInt(key: String) = if (value.isNull(key)) null else value.getInt(key)
    val messages = value.getJSONArray("assistantMessageIds")
    val dispositions = value.getJSONArray("segmentDispositions")
    return VoiceRuntimeThreadReceipt(
      VoiceRuntimeIdentity(
        value.getString("runtimeId"), value.getString("runtimeInstanceId"),
        value.getLong("runtimeGeneration"),
      ),
      value.getString("modeSessionId"), value.getString("turnClientOperationId"),
      nullableString("turnOperationId"), value.getString("environmentId"),
      value.getString("projectId"), value.getString("threadId"),
      nullableString("userMessageId"), nullableString("turnId"),
      buildList(messages.length()) { for (index in 0 until messages.length()) add(messages.getString(index)) },
      nullableString("speechPlanId"), nullableInt("highestAdvertisedSegment"),
      nullableInt("highestStartedSegment"), nullableInt("highestDrainedSegment"),
      buildList(dispositions.length()) {
        for (index in 0 until dispositions.length()) {
          val item = dispositions.getJSONObject(index)
          require(item.keys().asSequence().toSet() == setOf("segmentIndex", "disposition"))
          add(VoiceRuntimeSpeechDisposition(item.getInt("segmentIndex"), item.getString("disposition")))
        }
      },
      nullableString("speechTerminal"), nullableString("terminalOutcome"),
      Instant.parse(value.getString("createdAt")).toEpochMilli(),
      Instant.parse(value.getString("expiresAt")).toEpochMilli(),
    )
  }

  private fun actionJson(value: VoiceRuntimePresentationAction): JSONObject = when (value) {
    is VoiceRuntimePresentationAction.NavigateThread -> JSONObject()
      .put("action", "navigate-thread")
      .put("actionId", value.actionId)
      .put("projectId", value.projectId)
      .put("threadId", value.threadId)
      .put("expiresAt", Instant.ofEpochMilli(value.expiresAtEpochMillis).toString())
    is VoiceRuntimePresentationAction.ReviewDraft -> JSONObject()
      .put("action", "review-draft")
      .put("actionId", value.actionId)
      .put("artifact", draftHandleJson(value.artifact))
      .put("expiresAt", Instant.ofEpochMilli(value.expiresAtEpochMillis).toString())
    is VoiceRuntimePresentationAction.RealtimeConfirmationRequired -> JSONObject()
      .put("action", "realtime-confirmation-required")
      .put("actionId", value.actionId)
      .put("confirmationId", value.confirmationId)
      .put("toolCallId", value.toolCallId)
      .put("tool", value.tool)
      .put("summary", value.summary)
      .put("expiresAt", Instant.ofEpochMilli(value.expiresAtEpochMillis).toString())
  }

  private fun action(value: JSONObject): VoiceRuntimePresentationAction {
    return when (value.getString("action")) {
      "navigate-thread" -> {
        require(value.keys().asSequence().toSet() == NAVIGATE_ACTION_FIELDS)
        VoiceRuntimePresentationAction.NavigateThread(
          value.getString("actionId"),
          value.getString("projectId"),
          value.getString("threadId"),
          Instant.parse(value.getString("expiresAt")).toEpochMilli(),
        )
      }
      "review-draft" -> {
        require(value.keys().asSequence().toSet() == REVIEW_DRAFT_ACTION_FIELDS)
        VoiceRuntimePresentationAction.ReviewDraft(
          value.getString("actionId"),
          draftHandle(value.getJSONObject("artifact")),
          Instant.parse(value.getString("expiresAt")).toEpochMilli(),
        )
      }
      "realtime-confirmation-required" -> {
        require(value.keys().asSequence().toSet() == CONFIRMATION_ACTION_FIELDS)
        VoiceRuntimePresentationAction.RealtimeConfirmationRequired(
          value.getString("actionId"),
          value.getString("confirmationId"),
          value.getString("toolCallId"),
          value.getString("tool"),
          value.getString("summary"),
          Instant.parse(value.getString("expiresAt")).toEpochMilli(),
        )
      }
      else -> error("Unsupported durable presentation action.")
    }
  }

  private fun VoiceRuntimeThreadReceipt.matches(
    key: VoiceRuntimeRetainedRecordKey.ThreadReceipt,
  ): Boolean = identity == key.identity && modeSessionId == key.modeSessionId &&
    turnClientOperationId == key.turnClientOperationId

  private fun draftHandleJson(value: VoiceRuntimeDraftHandle) = JSONObject()
    .put("artifactId", value.artifactId)
    .put("runtimeId", value.identity.runtimeId)
    .put("runtimeInstanceId", value.identity.runtimeInstanceId)
    .put("generation", value.identity.generation)
    .put("modeSessionId", value.modeSessionId)
    .put("turnClientOperationId", value.turnClientOperationId)
    .put("environmentId", value.target.environmentId)
    .put("projectId", value.target.projectId)
    .put("threadId", value.target.threadId)
    .put("composerRevision", value.target.composerRevision)
    .put("expiresAt", value.expiresAtEpochMillis)

  private fun draftHandle(value: JSONObject): VoiceRuntimeDraftHandle = VoiceRuntimeDraftHandle(
    value.getString("artifactId"),
    VoiceRuntimeIdentity(
      value.getString("runtimeId"), value.getString("runtimeInstanceId"), value.getLong("generation"),
    ),
    value.getString("modeSessionId"), value.getString("turnClientOperationId"),
    VoiceRuntimeDraftContext(
      value.getString("environmentId"), value.getString("projectId"),
      value.getString("threadId"), value.getString("composerRevision"),
    ),
    value.getLong("expiresAt"),
  )

  private companion object {
    const val KEY_RECEIPTS = "voice_runtime_thread_receipts"
    const val KEY_ACTIONS = "voice_runtime_presentation_actions"
    const val MAXIMUM_RECEIPTS = 256
    const val MAXIMUM_ACTIONS = 64
    val RECEIPT_FIELDS = setOf(
      "runtimeId", "runtimeInstanceId", "runtimeGeneration", "modeSessionId",
      "turnClientOperationId", "turnOperationId", "environmentId", "projectId", "threadId",
      "userMessageId", "turnId", "assistantMessageIds", "speechPlanId",
      "highestAdvertisedSegment", "highestStartedSegment", "highestDrainedSegment",
      "segmentDispositions", "speechTerminal", "terminalOutcome", "createdAt", "expiresAt",
    )
    val NAVIGATE_ACTION_FIELDS = setOf(
      "action", "actionId", "projectId", "threadId", "expiresAt",
    )
    val REVIEW_DRAFT_ACTION_FIELDS = setOf("action", "actionId", "artifact", "expiresAt")
    val CONFIRMATION_ACTION_FIELDS = setOf(
      "action", "actionId", "confirmationId", "toolCallId", "tool", "summary", "expiresAt",
    )
  }
}

internal class VoiceRuntimeMemoryJournalRepository(
  private val now: () -> Long = System::currentTimeMillis,
) : VoiceRuntimeJournalRepository {
  private val receiptValues = linkedMapOf<String, VoiceRuntimeThreadReceipt>()
  private val actionValues = linkedMapOf<String, VoiceRuntimePresentationAction>()
  override fun publishReceipt(receipt: VoiceRuntimeThreadReceipt) {
    receiptValues[
      "${receipt.identity.runtimeId}:${receipt.identity.runtimeInstanceId}:" +
        "${receipt.identity.generation}:${receipt.modeSessionId}:${receipt.turnClientOperationId}"
    ] = receipt
  }
  override fun receipts(runtimeId: String, generation: Long, nowEpochMillis: Long) =
    receiptValues.values.filter {
      it.identity.runtimeId == runtimeId && it.identity.generation == generation &&
        it.expiresAtEpochMillis > nowEpochMillis
    }
  override fun acknowledgeReceipt(key: VoiceRuntimeRetainedRecordKey.ThreadReceipt): Boolean =
    receiptValues.entries.removeAll { it.value.identity == key.identity &&
      it.value.modeSessionId == key.modeSessionId &&
      it.value.turnClientOperationId == key.turnClientOperationId }
  override fun publishAction(action: VoiceRuntimePresentationAction) {
    actionValues.entries.removeAll { it.value.expiresAtEpochMillis <= now() }
    actionValues[action.actionId] = action
  }
  override fun removeAction(actionId: String) { actionValues.remove(actionId) }
  override fun actions(nowEpochMillis: Long) =
    actionValues.values.filter { it.expiresAtEpochMillis > nowEpochMillis }
}
