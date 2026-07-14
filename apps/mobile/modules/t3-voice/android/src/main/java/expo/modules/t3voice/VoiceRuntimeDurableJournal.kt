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

internal data class VoiceRuntimeReceiptRetentionKey(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val turnClientOperationId: String,
)

internal data class VoiceRuntimePresentationRetentionKey(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val actionId: String,
)

internal data class VoiceRuntimeRetainedPresentationAction(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val action: VoiceRuntimePresentationAction,
) {
  val key = VoiceRuntimePresentationRetentionKey(identity, modeSessionId, action.actionId)
}

internal enum class VoiceRuntimeRetentionAdmission {
  AVAILABLE,
  EXISTING,
  FULL,
  UNAVAILABLE,
}

internal enum class VoiceRuntimeRetentionWriteResult {
  INSERTED,
  UPDATED,
  FULL,
  UNAVAILABLE,
}

internal enum class VoiceRuntimeRetentionRemovalResult {
  REMOVED,
  MISSING,
  UNAVAILABLE,
}

internal data class VoiceRuntimeRetentionScopeResult(
  val receiptsRetired: Int,
  val actionsRetired: Int,
  val actionsRebound: Int,
)

internal sealed interface VoiceRuntimeRetentionScope {
  val environmentId: String

  data class Thread(
    override val environmentId: String,
  ) : VoiceRuntimeRetentionScope

  data class Realtime(
    override val environmentId: String,
  ) : VoiceRuntimeRetentionScope
}

internal data class VoiceRuntimeRetentionCheckpoint(
  val receipts: List<VoiceRuntimeThreadReceipt>,
  val actions: List<VoiceRuntimeRetainedPresentationAction>,
)

internal interface VoiceRuntimeJournalRepository {
  fun receiptAdmission(
    key: VoiceRuntimeReceiptRetentionKey,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionAdmission
  fun publishReceipt(receipt: VoiceRuntimeThreadReceipt): VoiceRuntimeRetentionWriteResult
  fun receipts(
    identity: VoiceRuntimeIdentity,
    environmentId: String,
    nowEpochMillis: Long,
  ): List<VoiceRuntimeThreadReceipt>
  fun receipt(
    key: VoiceRuntimeRetainedRecordKey.ThreadReceipt,
    nowEpochMillis: Long,
  ): VoiceRuntimeThreadReceipt?
  fun acknowledgeReceipt(key: VoiceRuntimeRetainedRecordKey.ThreadReceipt): Boolean
  fun actionAdmission(
    key: VoiceRuntimePresentationRetentionKey,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionAdmission
  fun actionCapacity(nowEpochMillis: Long): VoiceRuntimeRetentionAdmission
  fun publishAction(
    action: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionWriteResult
  fun retractAction(
    expected: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionRemovalResult
  fun removeAction(key: VoiceRuntimePresentationRetentionKey): VoiceRuntimeRetentionRemovalResult
  fun actions(nowEpochMillis: Long): List<VoiceRuntimeRetainedPresentationAction>
  fun activateScope(
    identity: VoiceRuntimeIdentity,
    scope: VoiceRuntimeRetentionScope,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionScopeResult?
  fun checkpoint(): VoiceRuntimeRetentionCheckpoint?
  fun restore(checkpoint: VoiceRuntimeRetentionCheckpoint): Boolean
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
    migrateLegacyPresentationActions()
  }

  private fun migrateLegacyPresentationActions() {
    if (storage.getString(KEY_ACTION_SCHEMA) == ACTION_SCHEMA_VERSION) return
    val raw = storage.getString(KEY_ACTIONS)
    if (raw != null) {
      val values = runCatching { JSONArray(raw) }.getOrNull() ?: return
      val entries = buildList(values.length()) {
        repeat(values.length()) { add(values.optJSONObject(it) ?: return) }
      }
      val fenceFields = setOf(
        "runtimeId",
        "runtimeInstanceId",
        "runtimeGeneration",
        "modeSessionId",
      )
      val current = entries.all { value -> fenceFields.all(value::has) }
      val legacy = entries.all { value ->
        fenceFields.none(value::has) && value.optString("action") in setOf(
          "navigate-thread",
          "review-draft",
          "realtime-confirmation-required",
        )
      }
      if (!current && !legacy) return
      if (current) {
        check(storage.put(mapOf(KEY_ACTION_SCHEMA to ACTION_SCHEMA_VERSION))) {
          "Could not mark fenced voice presentation actions."
        }
        return
      }
    }
    check(storage.put(mapOf(
      KEY_ACTIONS to null,
      KEY_ACTION_SCHEMA to ACTION_SCHEMA_VERSION,
    ))) { "Could not retire unfenced voice presentation actions." }
  }

  @Synchronized
  override fun receiptAdmission(
    key: VoiceRuntimeReceiptRetentionKey,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionAdmission = runCatching {
    val current = receiptValues().filter { it.expiresAtEpochMillis > nowEpochMillis }
    when {
      current.any { it.retentionKey() == key } -> VoiceRuntimeRetentionAdmission.EXISTING
      current.size >= receiptCapacity -> VoiceRuntimeRetentionAdmission.FULL
      else -> VoiceRuntimeRetentionAdmission.AVAILABLE
    }
  }.getOrDefault(VoiceRuntimeRetentionAdmission.UNAVAILABLE)

  @Synchronized
  override fun publishReceipt(
    receipt: VoiceRuntimeThreadReceipt,
  ): VoiceRuntimeRetentionWriteResult = runCatching {
    val current = receiptValues().filter { it.expiresAtEpochMillis > now() }
    val key = receipt.retentionKey()
    val existing = current.firstOrNull {
      it.retentionKey() == key
    }
    val stable = existing?.let { receipt.copy(createdAtEpochMillis = it.createdAtEpochMillis) } ?: receipt
    if (existing == null && current.size >= receiptCapacity) {
      return@runCatching VoiceRuntimeRetentionWriteResult.FULL
    }
    val values = current.filterNot {
      it.retentionKey() == key
    }.plus(stable)
      .sortedWith(compareBy({ it.expiresAtEpochMillis }, { it.turnClientOperationId }))
    write(KEY_RECEIPTS, JSONArray().also { array -> values.forEach { array.put(receiptJson(it)) } })
    if (existing == null) VoiceRuntimeRetentionWriteResult.INSERTED
    else VoiceRuntimeRetentionWriteResult.UPDATED
  }.getOrDefault(VoiceRuntimeRetentionWriteResult.UNAVAILABLE)

  @Synchronized
  override fun receipts(
    identity: VoiceRuntimeIdentity,
    environmentId: String,
    nowEpochMillis: Long,
  ): List<VoiceRuntimeThreadReceipt> {
    val current = receiptValues()
    val live = current.filter { it.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) {
      write(KEY_RECEIPTS, JSONArray().also { array -> live.forEach { array.put(receiptJson(it)) } })
    }
    return live.filter {
      it.identity.runtimeId == identity.runtimeId &&
        it.identity.generation <= identity.generation &&
        it.environmentId == environmentId
    }
  }

  @Synchronized
  override fun receipt(
    key: VoiceRuntimeRetainedRecordKey.ThreadReceipt,
    nowEpochMillis: Long,
  ): VoiceRuntimeThreadReceipt? {
    val current = receiptValues()
    val live = current.filter { it.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) {
      write(KEY_RECEIPTS, JSONArray().also { array -> live.forEach { array.put(receiptJson(it)) } })
    }
    return live.firstOrNull { it.matches(key) }
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
  override fun actionAdmission(
    key: VoiceRuntimePresentationRetentionKey,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionAdmission = runCatching {
    val current = actionValues().filter { it.action.expiresAtEpochMillis > nowEpochMillis }
    when {
      current.any { it.key == key } -> VoiceRuntimeRetentionAdmission.EXISTING
      current.size >= actionCapacity -> VoiceRuntimeRetentionAdmission.FULL
      else -> VoiceRuntimeRetentionAdmission.AVAILABLE
    }
  }.getOrDefault(VoiceRuntimeRetentionAdmission.UNAVAILABLE)

  @Synchronized
  override fun actionCapacity(
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionAdmission = runCatching {
    val liveCount = actionValues().count { it.action.expiresAtEpochMillis > nowEpochMillis }
    if (liveCount >= actionCapacity) VoiceRuntimeRetentionAdmission.FULL
    else VoiceRuntimeRetentionAdmission.AVAILABLE
  }.getOrDefault(VoiceRuntimeRetentionAdmission.UNAVAILABLE)

  @Synchronized
  override fun publishAction(
    action: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionWriteResult = runCatching {
    val current = actionValues().filter { it.expiresAtEpochMillis > now() }
    val existing = current.firstOrNull { it.key == action.key }
    if (existing == null && current.size >= actionCapacity) {
      return@runCatching VoiceRuntimeRetentionWriteResult.FULL
    }
    val values = current.filter { it.key != action.key }
      .plus(action)
      .sortedWith(compareBy({ it.action.expiresAtEpochMillis }, { it.action.actionId }))
    write(KEY_ACTIONS, JSONArray().also { array -> values.forEach { array.put(actionJson(it)) } })
    if (existing == null) VoiceRuntimeRetentionWriteResult.INSERTED
    else VoiceRuntimeRetentionWriteResult.UPDATED
  }.getOrDefault(VoiceRuntimeRetentionWriteResult.UNAVAILABLE)

  @Synchronized
  override fun retractAction(
    expected: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionRemovalResult = runCatching {
    val current = actionValues()
    val installed = current.firstOrNull { it.key == expected.key }
      ?: return@runCatching VoiceRuntimeRetentionRemovalResult.MISSING
    if (installed != expected) return@runCatching VoiceRuntimeRetentionRemovalResult.MISSING
    val values = current.filterNot { it.key == expected.key }
    write(KEY_ACTIONS, JSONArray().also { array -> values.forEach { array.put(actionJson(it)) } })
    VoiceRuntimeRetentionRemovalResult.REMOVED
  }.getOrDefault(VoiceRuntimeRetentionRemovalResult.UNAVAILABLE)

  @Synchronized
  override fun removeAction(
    key: VoiceRuntimePresentationRetentionKey,
  ): VoiceRuntimeRetentionRemovalResult = runCatching {
    val current = actionValues()
    val values = current.filterNot { it.key == key }
    if (values.size == current.size) return@runCatching VoiceRuntimeRetentionRemovalResult.MISSING
    write(KEY_ACTIONS, JSONArray().also { array -> values.forEach { array.put(actionJson(it)) } })
    VoiceRuntimeRetentionRemovalResult.REMOVED
  }.getOrDefault(VoiceRuntimeRetentionRemovalResult.UNAVAILABLE)

  @Synchronized
  override fun actions(nowEpochMillis: Long): List<VoiceRuntimeRetainedPresentationAction> {
    val current = actionValues()
    val live = current.filter { it.action.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) {
      write(KEY_ACTIONS, JSONArray().also { array -> live.forEach { array.put(actionJson(it)) } })
    }
    return live
  }

  @Synchronized
  override fun activateScope(
    identity: VoiceRuntimeIdentity,
    scope: VoiceRuntimeRetentionScope,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionScopeResult? = runCatching {
    val currentReceipts = receiptValues().filter { it.expiresAtEpochMillis > nowEpochMillis }
    val receipts = currentReceipts.filter {
      it.identity.runtimeId == identity.runtimeId &&
        it.identity.generation <= identity.generation &&
        it.environmentId == scope.environmentId
    }
    val currentActions = actionValues().filter { it.action.expiresAtEpochMillis > nowEpochMillis }
    val scopedActions = scopeActions(currentActions, identity, scope)
    val actions = scopedActions.actions
    writeAll(receipts, actions)
    VoiceRuntimeRetentionScopeResult(
      receiptsRetired = currentReceipts.size - receipts.size,
      actionsRetired = currentActions.size - actions.size,
      actionsRebound = scopedActions.rebound,
    )
  }.getOrNull()

  @Synchronized
  override fun checkpoint(): VoiceRuntimeRetentionCheckpoint? = runCatching {
    VoiceRuntimeRetentionCheckpoint(receiptValues(), actionValues())
  }.getOrNull()

  @Synchronized
  override fun restore(checkpoint: VoiceRuntimeRetentionCheckpoint): Boolean = runCatching {
    require(checkpoint.receipts.size <= receiptCapacity)
    require(checkpoint.actions.size <= actionCapacity)
    writeAll(checkpoint.receipts, checkpoint.actions)
  }.isSuccess

  private fun receiptValues(): List<VoiceRuntimeThreadReceipt> =
    array(KEY_RECEIPTS, receiptCapacity) { receipt(it) }
  private fun actionValues(): List<VoiceRuntimeRetainedPresentationAction> =
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

  private fun writeAll(
    receipts: List<VoiceRuntimeThreadReceipt>,
    actions: List<VoiceRuntimeRetainedPresentationAction>,
  ) {
    check(storage.put(mapOf(
      KEY_RECEIPTS to JSONArray().also { array -> receipts.forEach { array.put(receiptJson(it)) } }
        .toString(),
      KEY_ACTIONS to JSONArray().also { array -> actions.forEach { array.put(actionJson(it)) } }
        .toString(),
    ))) { "Could not persist voice runtime retention scope." }
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

  private fun actionJson(value: VoiceRuntimeRetainedPresentationAction): JSONObject = when (val action = value.action) {
    is VoiceRuntimePresentationAction.NavigateThread -> JSONObject()
      .put("action", "navigate-thread")
      .putRetentionFence(value)
      .put("actionId", action.actionId)
      .put("projectId", action.projectId)
      .put("threadId", action.threadId)
      .put("expiresAt", Instant.ofEpochMilli(action.expiresAtEpochMillis).toString())
    is VoiceRuntimePresentationAction.ReviewDraft -> JSONObject()
      .put("action", "review-draft")
      .putRetentionFence(value)
      .put("actionId", action.actionId)
      .put("artifact", draftHandleJson(action.artifact))
      .put("expiresAt", Instant.ofEpochMilli(action.expiresAtEpochMillis).toString())
    is VoiceRuntimePresentationAction.RealtimeConfirmationRequired -> JSONObject()
      .put("action", "realtime-confirmation-required")
      .putRetentionFence(value)
      .put("actionId", action.actionId)
      .put("confirmationId", action.confirmationId)
      .put("toolCallId", action.toolCallId)
      .put("tool", action.tool)
      .put("summary", action.summary)
      .put("expiresAt", Instant.ofEpochMilli(action.expiresAtEpochMillis).toString())
  }

  private fun action(value: JSONObject): VoiceRuntimeRetainedPresentationAction {
    val identity = VoiceRuntimeIdentity(
      value.getString("runtimeId"),
      value.getString("runtimeInstanceId"),
      value.getLong("runtimeGeneration"),
    )
    val modeSessionId = value.getString("modeSessionId")
    val action = when (value.getString("action")) {
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
    return VoiceRuntimeRetainedPresentationAction(identity, modeSessionId, action)
  }

  private fun JSONObject.putRetentionFence(value: VoiceRuntimeRetainedPresentationAction) =
    put("runtimeId", value.identity.runtimeId)
      .put("runtimeInstanceId", value.identity.runtimeInstanceId)
      .put("runtimeGeneration", value.identity.generation)
      .put("modeSessionId", value.modeSessionId)

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
    const val KEY_ACTION_SCHEMA = "voice_runtime_presentation_actions_schema"
    const val ACTION_SCHEMA_VERSION = "identity-mode-v1"
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
      "action", "runtimeId", "runtimeInstanceId", "runtimeGeneration", "modeSessionId",
      "actionId", "projectId", "threadId", "expiresAt",
    )
    val REVIEW_DRAFT_ACTION_FIELDS = setOf(
      "action", "runtimeId", "runtimeInstanceId", "runtimeGeneration", "modeSessionId",
      "actionId", "artifact", "expiresAt",
    )
    val CONFIRMATION_ACTION_FIELDS = setOf(
      "action", "runtimeId", "runtimeInstanceId", "runtimeGeneration", "modeSessionId",
      "actionId", "confirmationId", "toolCallId", "tool", "summary", "expiresAt",
    )
  }
}

internal class VoiceRuntimeMemoryJournalRepository(
  private val now: () -> Long = System::currentTimeMillis,
  private val receiptCapacity: Int = 256,
  private val actionCapacity: Int = 64,
) : VoiceRuntimeJournalRepository {
  private val receiptValues = linkedMapOf<String, VoiceRuntimeThreadReceipt>()
  private val actionValues = linkedMapOf<VoiceRuntimePresentationRetentionKey, VoiceRuntimeRetainedPresentationAction>()
  override fun receiptAdmission(key: VoiceRuntimeReceiptRetentionKey, nowEpochMillis: Long) = when {
    receiptValues.values.any {
      it.expiresAtEpochMillis > nowEpochMillis && it.retentionKey() == key
    } -> VoiceRuntimeRetentionAdmission.EXISTING
    receiptValues.values.count { it.expiresAtEpochMillis > nowEpochMillis } >= receiptCapacity ->
      VoiceRuntimeRetentionAdmission.FULL
    else -> VoiceRuntimeRetentionAdmission.AVAILABLE
  }
  override fun publishReceipt(receipt: VoiceRuntimeThreadReceipt): VoiceRuntimeRetentionWriteResult {
    val existing = receiptValues.values.any { it.retentionKey() == receipt.retentionKey() }
    if (!existing && receiptAdmission(receipt.retentionKey(), now()) == VoiceRuntimeRetentionAdmission.FULL) {
      return VoiceRuntimeRetentionWriteResult.FULL
    }
    receiptValues[
      "${receipt.identity.runtimeId}:${receipt.identity.runtimeInstanceId}:" +
        "${receipt.identity.generation}:${receipt.modeSessionId}:${receipt.turnClientOperationId}"
    ] = receipt
    return if (existing) VoiceRuntimeRetentionWriteResult.UPDATED
    else VoiceRuntimeRetentionWriteResult.INSERTED
  }
  override fun receipts(
    identity: VoiceRuntimeIdentity,
    environmentId: String,
    nowEpochMillis: Long,
  ) =
    receiptValues.values.filter {
      it.identity.runtimeId == identity.runtimeId &&
        it.identity.generation <= identity.generation &&
        it.environmentId == environmentId && it.expiresAtEpochMillis > nowEpochMillis
    }
  override fun receipt(
    key: VoiceRuntimeRetainedRecordKey.ThreadReceipt,
    nowEpochMillis: Long,
  ) = receiptValues.values.firstOrNull { it.expiresAtEpochMillis > nowEpochMillis &&
    it.identity == key.identity && it.modeSessionId == key.modeSessionId &&
    it.turnClientOperationId == key.turnClientOperationId }
  override fun acknowledgeReceipt(key: VoiceRuntimeRetainedRecordKey.ThreadReceipt): Boolean =
    receiptValues.entries.removeAll { it.value.identity == key.identity &&
      it.value.modeSessionId == key.modeSessionId &&
      it.value.turnClientOperationId == key.turnClientOperationId }
  override fun actionAdmission(key: VoiceRuntimePresentationRetentionKey, nowEpochMillis: Long) = when {
    actionValues[key]?.action?.expiresAtEpochMillis?.let { it > nowEpochMillis } == true ->
      VoiceRuntimeRetentionAdmission.EXISTING
    actionValues.values.count { it.action.expiresAtEpochMillis > nowEpochMillis } >= actionCapacity ->
      VoiceRuntimeRetentionAdmission.FULL
    else -> VoiceRuntimeRetentionAdmission.AVAILABLE
  }
  override fun actionCapacity(nowEpochMillis: Long) =
    if (actionValues.values.count { it.action.expiresAtEpochMillis > nowEpochMillis } >= actionCapacity) {
      VoiceRuntimeRetentionAdmission.FULL
    } else {
      VoiceRuntimeRetentionAdmission.AVAILABLE
    }
  override fun publishAction(
    action: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionWriteResult {
    actionValues.entries.removeAll { it.value.action.expiresAtEpochMillis <= now() }
    val existing = action.key in actionValues
    if (!existing && actionValues.size >= actionCapacity) return VoiceRuntimeRetentionWriteResult.FULL
    actionValues[action.key] = action
    return if (existing) VoiceRuntimeRetentionWriteResult.UPDATED
    else VoiceRuntimeRetentionWriteResult.INSERTED
  }
  override fun retractAction(
    expected: VoiceRuntimeRetainedPresentationAction,
  ): VoiceRuntimeRetentionRemovalResult {
    if (actionValues[expected.key] != expected) return VoiceRuntimeRetentionRemovalResult.MISSING
    actionValues.remove(expected.key)
    return VoiceRuntimeRetentionRemovalResult.REMOVED
  }
  override fun removeAction(key: VoiceRuntimePresentationRetentionKey) =
    if (actionValues.remove(key) != null) VoiceRuntimeRetentionRemovalResult.REMOVED
    else VoiceRuntimeRetentionRemovalResult.MISSING
  override fun actions(nowEpochMillis: Long) =
    actionValues.values.filter { it.action.expiresAtEpochMillis > nowEpochMillis }
  override fun activateScope(
    identity: VoiceRuntimeIdentity,
    scope: VoiceRuntimeRetentionScope,
    nowEpochMillis: Long,
  ): VoiceRuntimeRetentionScopeResult {
    val currentReceipts = receiptValues.values.filter { it.expiresAtEpochMillis > nowEpochMillis }
    val receipts = currentReceipts.filter {
      it.identity.runtimeId == identity.runtimeId &&
        it.identity.generation <= identity.generation &&
        it.environmentId == scope.environmentId
    }
    val currentActions = actionValues.values.filter { it.action.expiresAtEpochMillis > nowEpochMillis }
    val scopedActions = scopeActions(currentActions, identity, scope)
    receiptValues.clear()
    receipts.forEach { receipt ->
      receiptValues[
        "${receipt.identity.runtimeId}:${receipt.identity.runtimeInstanceId}:" +
          "${receipt.identity.generation}:${receipt.modeSessionId}:${receipt.turnClientOperationId}"
      ] = receipt
    }
    actionValues.clear()
    scopedActions.actions.forEach { actionValues[it.key] = it }
    return VoiceRuntimeRetentionScopeResult(
      currentReceipts.size - receipts.size,
      currentActions.size - scopedActions.actions.size,
      scopedActions.rebound,
    )
  }
  override fun checkpoint() = VoiceRuntimeRetentionCheckpoint(
    receiptValues.values.toList(),
    actionValues.values.toList(),
  )
  override fun restore(checkpoint: VoiceRuntimeRetentionCheckpoint): Boolean {
    if (checkpoint.receipts.size > receiptCapacity || checkpoint.actions.size > actionCapacity) {
      return false
    }
    receiptValues.clear()
    checkpoint.receipts.forEach { receipt ->
      receiptValues[
        "${receipt.identity.runtimeId}:${receipt.identity.runtimeInstanceId}:" +
          "${receipt.identity.generation}:${receipt.modeSessionId}:${receipt.turnClientOperationId}"
      ] = receipt
    }
    actionValues.clear()
    checkpoint.actions.forEach { actionValues[it.key] = it }
    return true
  }
}

private fun VoiceRuntimeThreadReceipt.retentionKey() = VoiceRuntimeReceiptRetentionKey(
  identity,
  modeSessionId,
  turnClientOperationId,
)

private val VoiceRuntimeRetainedPresentationAction.expiresAtEpochMillis: Long
  get() = action.expiresAtEpochMillis

private fun VoiceRuntimeRetainedPresentationAction.rebind(
  identity: VoiceRuntimeIdentity,
): VoiceRuntimeRetainedPresentationAction {
  val reboundAction = when (val value = action) {
    is VoiceRuntimePresentationAction.ReviewDraft -> value.copy(
      artifact = value.artifact.copy(identity = identity),
    )
    else -> value
  }
  return copy(identity = identity, action = reboundAction)
}

private data class VoiceRuntimeScopedActions(
  val actions: List<VoiceRuntimeRetainedPresentationAction>,
  val rebound: Int,
)

private fun scopeActions(
  current: List<VoiceRuntimeRetainedPresentationAction>,
  identity: VoiceRuntimeIdentity,
  scope: VoiceRuntimeRetentionScope,
): VoiceRuntimeScopedActions {
  var rebound = 0
  val retainedByKey = linkedMapOf<
    VoiceRuntimePresentationRetentionKey,
    VoiceRuntimeRetainedPresentationAction
  >()
  current.forEach { retained ->
    val sameGeneration = retained.identity.runtimeId == identity.runtimeId &&
      retained.identity.generation == identity.generation
    val keep = sameGeneration && when (scope) {
      is VoiceRuntimeRetentionScope.Thread ->
        retained.action is VoiceRuntimePresentationAction.ReviewDraft
      is VoiceRuntimeRetentionScope.Realtime ->
        retained.action is VoiceRuntimePresentationAction.NavigateThread ||
          retained.action is VoiceRuntimePresentationAction.RealtimeConfirmationRequired
    }
    if (!keep) return@forEach
    val reboundAction = if (retained.identity == identity) retained else {
      rebound += 1
      retained.rebind(identity)
    }
    val existing = retainedByKey[reboundAction.key]
    require(existing == null || existing == reboundAction) {
      "Conflicting voice presentation actions cannot be rebound to one runtime fence."
    }
    retainedByKey[reboundAction.key] = reboundAction
  }
  return VoiceRuntimeScopedActions(retainedByKey.values.toList(), rebound)
}
