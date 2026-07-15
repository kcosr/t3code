package expo.modules.t3voice

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal class VoiceRuntimeDurableRealtimeCheckpointRepository(
  private val storage: VoiceRuntimeKeyValueStore,
  private val terminalCapacity: Int = MAXIMUM_TERMINALS,
) : VoiceRuntimeRealtimeCheckpointRepository {
  constructor(context: Context) : this(
    VoiceRuntimePreferences(context.applicationContext),
  )

  init {
    require(terminalCapacity > 0)
  }

  @Synchronized
  override fun load(): VoiceRuntimeRealtimeCheckpoint? {
    val raw = storage.getString(KEY_CHECKPOINT) ?: return null
    return try {
      decodeCheckpoint(raw)
    } catch (cause: Throwable) {
      throw VoiceRuntimeDurableStateCorruptionException(
        "Realtime voice checkpoint is unreadable.",
        cause,
      )
    }
  }

  @Synchronized
  override fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint) {
    validateCheckpoint(checkpoint)
    check(storage.put(mapOf(KEY_CHECKPOINT to encodeCheckpointMetadata(checkpoint).toString()))) {
      "Could not persist Realtime voice checkpoint."
    }
  }

  @Synchronized
  override fun clear(fence: VoiceRuntimeRealtimeFence) {
    val current = load() ?: return
    if (current.fence != fence) return
    check(storage.clear(setOf(KEY_CHECKPOINT))) {
      "Could not clear Realtime voice checkpoint."
    }
  }

  @Synchronized
  override fun loadFinalization(): VoiceRuntimeRealtimeFinalization? {
    val raw = storage.getString(KEY_FINALIZATION) ?: return null
    return try {
      decodeFinalization(raw)
    } catch (cause: Throwable) {
      throw VoiceRuntimeDurableStateCorruptionException(
        "Realtime voice finalization is unreadable.",
        cause,
      )
    }
  }

  @Synchronized
  override fun installFinalization(
    expectedCheckpoint: VoiceRuntimeRealtimeCheckpoint?,
    finalization: VoiceRuntimeRealtimeFinalization,
  ) {
    validateFinalization(finalization)
    check(load() == expectedCheckpoint) { "Realtime checkpoint changed before finalization." }
    val existing = loadFinalization()
    check(existing == null || existing == finalization) {
      "A different Realtime finalization is already pending."
    }
    check(storage.put(mapOf(
      KEY_CHECKPOINT to null,
      KEY_FINALIZATION to encodeFinalization(finalization),
    ))) { "Could not atomically install Realtime finalization." }
  }

  @Synchronized
  override fun saveFinalization(finalization: VoiceRuntimeRealtimeFinalization) {
    validateFinalization(finalization)
    val current = requireNotNull(loadFinalization()) { "Realtime finalization is unavailable." }
    require(current.fence == finalization.fence &&
      current.session.state.sessionId == finalization.session.state.sessionId) {
      "Realtime finalization fence changed."
    }
    require(current.acceptsUpdate(finalization)) {
      "Realtime finalization operation changed or regressed."
    }
    check(storage.put(mapOf(KEY_FINALIZATION to encodeFinalization(finalization)))) {
      "Could not persist Realtime finalization."
    }
  }

  @Synchronized
  override fun clearFinalization(fence: VoiceRuntimeRealtimeFence, sessionId: String) {
    val current = loadFinalization() ?: return
    if (current.fence != fence || current.session.state.sessionId != sessionId) return
    check(storage.clear(setOf(KEY_FINALIZATION))) { "Could not clear Realtime finalization." }
  }

  @Synchronized
  override fun publishTerminal(summary: VoiceRuntimeRealtimeTerminalSummary) {
    validateTerminal(summary)
    val current = loadTerminals().filter {
      it.expiresAtEpochMillis > summary.terminalAtEpochMillis
    }
    val candidates = current.filterNot {
        it.identity == summary.identity && it.modeSessionId == summary.modeSessionId
      }
    if (candidates.size >= terminalCapacity) {
      throw VoiceRuntimeRetentionCapacityException("Realtime terminal", terminalCapacity)
    }
    val next = candidates
      .plus(summary)
      .sortedWith(
        compareBy<VoiceRuntimeRealtimeTerminalSummary>(
          { it.terminalAtEpochMillis },
          { it.identity.runtimeId },
          { it.modeSessionId },
        ),
      )
    writeTerminals(next)
  }

  @Synchronized
  override fun hasTerminalCapacity(
    fence: VoiceRuntimeRealtimeFence,
    nowEpochMillis: Long,
  ): Boolean {
    val live = terminals(nowEpochMillis)
    return live.any {
      it.identity == fence.identity && it.modeSessionId == fence.modeSessionId
    } || live.size < terminalCapacity
  }

  @Synchronized
  override fun terminals(nowEpochMillis: Long): List<VoiceRuntimeRealtimeTerminalSummary> {
    require(nowEpochMillis >= 0) { "Invalid terminal query time." }
    val current = loadTerminals()
    val live = current.filter { it.expiresAtEpochMillis > nowEpochMillis }
    if (live.size != current.size) writeTerminals(live)
    return live
  }

  @Synchronized
  override fun acknowledgeTerminal(
    key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal,
  ): Boolean {
    val current = loadTerminals()
    val next = current.filterNot {
      it.identity == key.identity && it.modeSessionId == key.modeSessionId
    }
    if (next.size == current.size) return false
    writeTerminals(next)
    return true
  }

  private fun decodeCheckpoint(raw: String): VoiceRuntimeRealtimeCheckpoint {
    val checkpoint = decodeCheckpointMetadata(raw)
    validateCheckpoint(checkpoint)
    return checkpoint
  }

  private fun encodeFinalization(finalization: VoiceRuntimeRealtimeFinalization): String =
    encodeFinalizationMetadata(finalization).toString()

  private fun decodeFinalization(raw: String): VoiceRuntimeRealtimeFinalization =
    decodeFinalizationMetadata(raw).also(::validateFinalization)

  private fun encodeFinalizationMetadata(
    finalization: VoiceRuntimeRealtimeFinalization,
  ): JSONObject = JSONObject()
    .put("version", VERSION)
    .put("fence", encodeFence(finalization.fence))
    .put("sourceTarget", encodeRealtimeTarget(finalization.sourceTarget))
    .put("sourceEnvironmentOrigin", finalization.sourceEnvironmentOrigin)
    .put("rootCommandId", finalization.rootCommandId)
    .put("session", encodeSession(finalization.session))
    .put("closeOperationId", finalization.closeOperationId)
    .put("outcome", finalization.outcome.name)
    .put("reason", finalization.reason)
    .put(
      "lastConnectedAtEpochMillis",
      finalization.lastConnectedAtEpochMillis ?: JSONObject.NULL,
    )
    .put(
      "handoffExchange",
      finalization.handoffExchange?.let(::encodeHandoffExchange) ?: JSONObject.NULL,
    )
    .put("stage", finalization.stage.name)
    .put("attemptCount", finalization.attemptCount)
    .put("lastFailureCode", finalization.lastFailureCode ?: JSONObject.NULL)
    .put("lastFailureRetryable", finalization.lastFailureRetryable)
    .put("terminalPublication", finalization.terminalPublication.name)

  private fun decodeFinalizationMetadata(raw: String): VoiceRuntimeRealtimeFinalization {
    val value = JSONObject(raw).requireExactFields(FINALIZATION_FIELDS)
    require(value.getString("version") == VERSION)
    return VoiceRuntimeRealtimeFinalization(
      fence = decodeFence(value.getJSONObject("fence")),
      sourceTarget = decodeRealtimeTarget(value.getJSONObject("sourceTarget")),
      sourceEnvironmentOrigin = value.getString("sourceEnvironmentOrigin"),
      rootCommandId = value.getString("rootCommandId"),
      session = decodeSession(value.getJSONObject("session")),
      closeOperationId = value.getString("closeOperationId"),
      outcome = VoiceRuntimeRealtimeTerminalOutcome.valueOf(value.getString("outcome")),
      reason = value.getString("reason"),
      lastConnectedAtEpochMillis = value.nullableLong("lastConnectedAtEpochMillis"),
      handoffExchange = value.nullableObject("handoffExchange")?.let(::decodeHandoffExchange),
      stage = VoiceRuntimeRealtimeFinalizationStage.valueOf(value.getString("stage")),
      attemptCount = value.exactInt("attemptCount"),
      lastFailureCode = value.nullableString("lastFailureCode"),
      lastFailureRetryable = value.exactBoolean("lastFailureRetryable"),
      terminalPublication = VoiceRuntimeRealtimeTerminalPublication.valueOf(
        value.getString("terminalPublication"),
      ),
    )
  }

  private fun encodeSession(session: VoiceRuntimeRealtimeStartResult): JSONObject = JSONObject()
    .put("state", JSONObject()
      .put("sessionId", session.state.sessionId)
      .put("conversationId", session.state.conversationId)
      .put("phase", session.state.phase)
      .put("leaseGeneration", session.state.leaseGeneration)
      .put("sequence", session.state.sequence))
    .put("signalingPath", session.signalingPath)
    .put("expiresAtEpochMillis", session.expiresAtEpochMillis)
    .put("heartbeatIntervalSeconds", session.heartbeatIntervalSeconds)

  private fun decodeSession(value: JSONObject): VoiceRuntimeRealtimeStartResult {
    value.requireExactFields(FINALIZATION_SESSION_FIELDS)
    val state = value.getJSONObject("state").requireExactFields(FINALIZATION_SESSION_STATE_FIELDS)
    return VoiceRuntimeRealtimeStartResult(
      VoiceRuntimeRealtimeSessionState(
        state.getString("sessionId"),
        state.getString("conversationId"),
        state.getString("phase"),
        state.exactLong("leaseGeneration"),
        state.exactLong("sequence"),
      ),
      value.getString("signalingPath"),
      value.exactLong("expiresAtEpochMillis"),
      value.exactLong("heartbeatIntervalSeconds"),
    )
  }

  private fun encodeCheckpointMetadata(checkpoint: VoiceRuntimeRealtimeCheckpoint): JSONObject =
    JSONObject()
      .put("version", VERSION)
      .put("fence", encodeFence(checkpoint.fence))
      .put("target", encodeRealtimeTarget(checkpoint.target))
      .put("rootCommandId", checkpoint.rootCommandId)
      .put("phase", checkpoint.phase.name)
      .put("serverSessionId", checkpoint.serverSessionId ?: JSONObject.NULL)
      .put("leaseGeneration", checkpoint.leaseGeneration ?: JSONObject.NULL)
      .put("expiresAtEpochMillis", checkpoint.expiresAtEpochMillis ?: JSONObject.NULL)
      .put(
        "heartbeatIntervalSeconds",
        checkpoint.heartbeatIntervalSeconds ?: JSONObject.NULL,
      )
      .put("lastActionSequence", checkpoint.lastActionSequence)
      .put("lastConnectedAtEpochMillis", checkpoint.lastConnectedAtEpochMillis ?: JSONObject.NULL)
      .put("pendingAction", checkpoint.pendingAction?.let(::encodeAction) ?: JSONObject.NULL)
      .put(
        "pendingHandoffExchange",
        checkpoint.pendingHandoffExchange?.let(::encodeHandoffExchange) ?: JSONObject.NULL,
      )
      .put("drainDeadlineAtEpochMillis", checkpoint.drainDeadlineAtEpochMillis ?: JSONObject.NULL)
      .put("muted", checkpoint.muted)

  private fun decodeCheckpointMetadata(raw: String): VoiceRuntimeRealtimeCheckpoint {
    val value = JSONObject(raw).requireExactFields(CHECKPOINT_FIELDS)
    require(value.getString("version") == VERSION)
    return VoiceRuntimeRealtimeCheckpoint(
      fence = decodeFence(value.getJSONObject("fence")),
      target = decodeRealtimeTarget(value.getJSONObject("target")),
      rootCommandId = value.getString("rootCommandId"),
      phase = VoiceRealtimePhase.valueOf(value.getString("phase")),
      serverSessionId = value.nullableString("serverSessionId"),
      leaseGeneration = value.nullableLong("leaseGeneration"),
      expiresAtEpochMillis = value.nullableLong("expiresAtEpochMillis"),
      heartbeatIntervalSeconds = value.nullableLong("heartbeatIntervalSeconds"),
      lastActionSequence = value.exactLong("lastActionSequence"),
      lastConnectedAtEpochMillis = value.nullableLong("lastConnectedAtEpochMillis"),
      pendingAction = value.nullableObject("pendingAction")?.let(::decodeAction),
      pendingHandoffExchange =
        value.nullableObject("pendingHandoffExchange")?.let(::decodeHandoffExchange),
      drainDeadlineAtEpochMillis = value.nullableLong("drainDeadlineAtEpochMillis"),
      muted = value.exactBoolean("muted"),
    )
  }

  private fun encodeFence(fence: VoiceRuntimeRealtimeFence): JSONObject = JSONObject()
    .put("runtimeId", fence.identity.runtimeId)
    .put("runtimeInstanceId", fence.identity.runtimeInstanceId)
    .put("generation", fence.identity.generation)
    .put("modeSessionId", fence.modeSessionId)

  private fun decodeFence(value: JSONObject): VoiceRuntimeRealtimeFence {
    value.requireExactFields(FENCE_FIELDS)
    return VoiceRuntimeRealtimeFence(
      VoiceRuntimeIdentity(
        value.getString("runtimeId"),
        value.getString("runtimeInstanceId"),
        value.exactLong("generation"),
      ),
      value.getString("modeSessionId"),
    )
  }

  private fun encodeRealtimeTarget(target: VoiceRuntimeTarget.Realtime): JSONObject = JSONObject()
    .put("environmentId", target.environmentId)
    .put("conversationId", target.conversationId)

  private fun decodeRealtimeTarget(value: JSONObject): VoiceRuntimeTarget.Realtime {
    value.requireExactFields(REALTIME_TARGET_FIELDS)
    return VoiceRuntimeTarget.Realtime(
      value.getString("environmentId"),
      value.getString("conversationId"),
    )
  }

  private fun encodeAction(action: VoiceRuntimeRealtimeAction): JSONObject = when (action) {
    is VoiceRuntimeRealtimeAction.NavigateThread -> JSONObject()
      .put("type", "navigate-thread")
      .put("sequence", action.sequence)
      .put("occurredAtEpochMillis", action.occurredAtEpochMillis)
      .put("actionId", action.actionId)
      .put("projectId", action.projectId)
      .put("threadId", action.threadId)
      .put("expiresAtEpochMillis", action.expiresAtEpochMillis)
    is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> JSONObject()
      .put("type", "handoff-to-thread-voice")
      .put("sequence", action.sequence)
      .put("occurredAtEpochMillis", action.occurredAtEpochMillis)
      .put("actionId", action.actionId)
      .put("projectId", action.projectId)
      .put("threadId", action.threadId)
      .put("autoRearm", action.autoRearm)
      .put("expiresAtEpochMillis", action.expiresAtEpochMillis)
    is VoiceRuntimeRealtimeAction.StopRealtimeVoice -> JSONObject()
      .put("type", "stop-realtime-voice")
      .put("sequence", action.sequence)
      .put("occurredAtEpochMillis", action.occurredAtEpochMillis)
    is VoiceRuntimeRealtimeAction.ConfirmationRequired -> JSONObject()
      .put("type", "confirmation-required")
      .put("sequence", action.sequence)
      .put("occurredAtEpochMillis", action.occurredAtEpochMillis)
      .put("actionId", action.actionId)
      .put("confirmationId", action.confirmationId)
      .put("toolCallId", action.toolCallId)
      .put("tool", action.tool)
      .put("summary", action.summary)
      .put("expiresAtEpochMillis", action.expiresAtEpochMillis)
  }

  private fun decodeAction(value: JSONObject): VoiceRuntimeRealtimeAction {
    val type = value.getString("type")
    return when (type) {
      "navigate-thread" -> {
        value.requireExactFields(NAVIGATE_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.NavigateThread(
          value.exactLong("sequence"),
          value.exactLong("occurredAtEpochMillis"),
          value.getString("actionId"),
          value.getString("projectId"),
          value.getString("threadId"),
          value.exactLong("expiresAtEpochMillis"),
        )
      }
      "handoff-to-thread-voice" -> {
        value.requireExactFields(HANDOFF_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
          value.exactLong("sequence"),
          value.exactLong("occurredAtEpochMillis"),
          value.getString("actionId"),
          value.getString("projectId"),
          value.getString("threadId"),
          value.exactBoolean("autoRearm"),
          value.exactLong("expiresAtEpochMillis"),
        )
      }
      "stop-realtime-voice" -> {
        value.requireExactFields(STOP_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.StopRealtimeVoice(
          value.exactLong("sequence"),
          value.exactLong("occurredAtEpochMillis"),
        )
      }
      "confirmation-required" -> {
        value.requireExactFields(CONFIRMATION_ACTION_FIELDS)
        VoiceRuntimeRealtimeAction.ConfirmationRequired(
          value.exactLong("sequence"),
          value.exactLong("occurredAtEpochMillis"),
          value.getString("actionId"),
          value.getString("confirmationId"),
          value.getString("toolCallId"),
          value.getString("tool"),
          value.getString("summary"),
          value.exactLong("expiresAtEpochMillis"),
        )
      }
      else -> error("Unknown persisted Realtime action type.")
    }
  }

  private fun encodeHandoffExchange(
    exchange: VoiceRuntimeRealtimeHandoffExchangeResult,
  ): JSONObject = JSONObject()
    .put("actionId", exchange.actionId)
    .put("actionSequence", exchange.actionSequence)
    .put("projectId", exchange.projectId)
    .put("threadId", exchange.threadId)
    .put("autoRearm", exchange.autoRearm)
    .put("reservation", encodeTransitionReservation(exchange.reservation))
    .put("replayed", exchange.replayed)

  private fun decodeHandoffExchange(
    value: JSONObject,
  ): VoiceRuntimeRealtimeHandoffExchangeResult {
    value.requireExactFields(HANDOFF_EXCHANGE_FIELDS)
    return VoiceRuntimeRealtimeHandoffExchangeResult(
      actionId = value.getString("actionId"),
      actionSequence = value.exactLong("actionSequence"),
      projectId = value.getString("projectId"),
      threadId = value.getString("threadId"),
      autoRearm = value.exactBoolean("autoRearm"),
      reservation = decodeTransitionReservation(value.getJSONObject("reservation")),
      replayed = value.exactBoolean("replayed"),
    )
  }

  private fun encodeTransitionReservation(
    reservation: VoiceRuntimeRealtimeTransitionReservation,
  ): JSONObject = JSONObject()
    .put("generation", reservation.generation)
    .put("modeSessionId", reservation.modeSessionId)
    .put("target", encodeThreadTarget(reservation.target))

  private fun decodeTransitionReservation(value: JSONObject): VoiceRuntimeRealtimeTransitionReservation {
    value.requireExactFields(TRANSITION_RESERVATION_FIELDS)
    return VoiceRuntimeRealtimeTransitionReservation(
      generation = value.exactLong("generation"),
      modeSessionId = value.getString("modeSessionId"),
      target = decodeThreadTarget(value.getJSONObject("target")),
    )
  }

  private fun encodeThreadTarget(target: VoiceRuntimeRealtimeThreadTarget): JSONObject =
    JSONObject()
      .put("environmentId", target.environmentId)
      .put("projectId", target.projectId)
      .put("threadId", target.threadId)
      .put("speechPreset", target.speechPreset)
      .put("autoRearm", target.autoRearm)
      .put("endpointPolicy", encodeEndpointPolicy(target.endpointPolicy))
      .put("speechEnabled", target.speechEnabled)
      .put("rearmGuardMs", target.rearmGuardMs)

  private fun decodeThreadTarget(value: JSONObject): VoiceRuntimeRealtimeThreadTarget {
    value.requireExactFields(THREAD_TARGET_FIELDS)
    return VoiceRuntimeRealtimeThreadTarget(
      environmentId = value.getString("environmentId"),
      projectId = value.getString("projectId"),
      threadId = value.getString("threadId"),
      speechPreset = value.getString("speechPreset"),
      autoRearm = value.exactBoolean("autoRearm"),
      endpointPolicy = decodeEndpointPolicy(value.getJSONObject("endpointPolicy")),
      speechEnabled = value.exactBoolean("speechEnabled"),
      rearmGuardMs = value.exactLong("rearmGuardMs"),
    )
  }

  private fun encodeEndpointPolicy(policy: VoiceRuntimeRealtimeEndpointPolicy): JSONObject =
    JSONObject()
      .put("endSilenceMs", policy.endSilenceMs)
      .put("noSpeechTimeoutMs", policy.noSpeechTimeoutMs ?: JSONObject.NULL)
      .put("maximumUtteranceMs", policy.maximumUtteranceMs)

  private fun decodeEndpointPolicy(value: JSONObject): VoiceRuntimeRealtimeEndpointPolicy {
    value.requireExactFields(ENDPOINT_POLICY_FIELDS)
    return VoiceRuntimeRealtimeEndpointPolicy(
      value.exactLong("endSilenceMs"),
      value.nullableLong("noSpeechTimeoutMs"),
      value.exactLong("maximumUtteranceMs"),
    )
  }

  private fun validateCheckpoint(checkpoint: VoiceRuntimeRealtimeCheckpoint) {
    validateIdentity(checkpoint.fence.identity)
    requireIdentifier(checkpoint.fence.modeSessionId, "mode session ID")
    requireIdentifier(checkpoint.target.environmentId, "environment ID")
    requireIdentifier(checkpoint.target.conversationId, "conversation ID")
    requireIdentifier(checkpoint.rootCommandId, "root command ID")
    require(checkpoint.lastActionSequence >= 0)
    checkpoint.lastConnectedAtEpochMillis?.let { require(it >= 0) }
    checkpoint.drainDeadlineAtEpochMillis?.let { require(it >= 0) }
    checkpoint.expiresAtEpochMillis?.let { require(it > 0) }
    checkpoint.heartbeatIntervalSeconds?.let { require(it > 0) }
    checkpoint.pendingAction?.let(::validateAction)
    checkpoint.pendingHandoffExchange?.let { exchange ->
      requireIdentifier(exchange.actionId, "handoff action ID")
      require(exchange.actionSequence > 0)
      requireIdentifier(exchange.projectId, "project ID")
      requireIdentifier(exchange.threadId, "thread ID")
      require(exchange.reservation.generation == checkpoint.fence.identity.generation + 1)
      requireIdentifier(exchange.reservation.modeSessionId, "thread mode session ID")
      validateThreadTarget(exchange.reservation.target)
      require(exchange.projectId == exchange.reservation.target.projectId)
      require(exchange.threadId == exchange.reservation.target.threadId)
      require(exchange.autoRearm == exchange.reservation.target.autoRearm)
    }
  }

  private fun validateFinalization(finalization: VoiceRuntimeRealtimeFinalization) {
    validateIdentity(finalization.fence.identity)
    requireIdentifier(finalization.fence.modeSessionId, "mode session ID")
    requireIdentifier(finalization.sourceTarget.environmentId, "environment ID")
    requireIdentifier(finalization.sourceTarget.conversationId, "conversation ID")
    require(VoiceRuntimeOriginPolicy.normalize(finalization.sourceEnvironmentOrigin) ==
      finalization.sourceEnvironmentOrigin) { "Realtime finalization origin is not canonical." }
    requireIdentifier(finalization.rootCommandId, "root command ID")
    requireIdentifier(finalization.closeOperationId, "close operation ID")
    require(finalization.reason.isNotBlank() && finalization.reason.length <= MAXIMUM_REASON_LENGTH)
    finalization.lastConnectedAtEpochMillis?.let { require(it >= 0) }
    require(finalization.attemptCount >= 0)
    finalization.lastFailureCode?.let {
      require(it.isNotBlank() && it.length <= MAXIMUM_REASON_LENGTH)
    }
    val session = finalization.session
    requireIdentifier(session.state.sessionId, "session ID")
    require(session.state.conversationId == finalization.sourceTarget.conversationId)
    require(session.state.phase.isNotBlank() && session.state.phase.length <= 64)
    require(session.state.leaseGeneration > 0)
    require(session.state.sequence >= 0)
    require(session.signalingPath.isNotBlank() &&
      session.signalingPath.length <= MAXIMUM_PATH_LENGTH)
    require(session.expiresAtEpochMillis > 0)
    require(session.heartbeatIntervalSeconds > 0)
    finalization.handoffExchange?.let { exchange ->
      requireIdentifier(exchange.actionId, "handoff action ID")
      require(exchange.actionSequence > 0)
      requireIdentifier(exchange.projectId, "project ID")
      requireIdentifier(exchange.threadId, "thread ID")
      require(exchange.reservation.generation == finalization.fence.identity.generation + 1)
      requireIdentifier(exchange.reservation.modeSessionId, "thread mode session ID")
      validateThreadTarget(exchange.reservation.target)
      require(exchange.reservation.target.environmentId == finalization.sourceTarget.environmentId)
      require(exchange.projectId == exchange.reservation.target.projectId)
      require(exchange.threadId == exchange.reservation.target.threadId)
      require(exchange.autoRearm == exchange.reservation.target.autoRearm)
    }
  }

  private fun validateAction(action: VoiceRuntimeRealtimeAction) {
    require(action.sequence > 0)
    require(action.occurredAtEpochMillis >= 0)
    when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread -> {
        requireIdentifier(action.actionId, "action ID")
        requireIdentifier(action.projectId, "project ID")
        requireIdentifier(action.threadId, "thread ID")
        require(action.expiresAtEpochMillis > 0)
      }
      is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> {
        requireIdentifier(action.actionId, "action ID")
        requireIdentifier(action.projectId, "project ID")
        requireIdentifier(action.threadId, "thread ID")
        require(action.expiresAtEpochMillis > 0)
      }
      is VoiceRuntimeRealtimeAction.StopRealtimeVoice -> Unit
      is VoiceRuntimeRealtimeAction.ConfirmationRequired -> {
        requireIdentifier(action.actionId, "action ID")
        requireIdentifier(action.confirmationId, "confirmation ID")
        requireIdentifier(action.toolCallId, "tool call ID")
        requireIdentifier(action.tool, "tool")
        require(action.summary.isNotBlank() && action.summary.length <= MAXIMUM_SUMMARY_LENGTH)
        require(action.expiresAtEpochMillis > 0)
      }
    }
  }

  private fun validateThreadTarget(target: VoiceRuntimeRealtimeThreadTarget) {
    requireIdentifier(target.environmentId, "environment ID")
    requireIdentifier(target.projectId, "project ID")
    requireIdentifier(target.threadId, "thread ID")
    require(target.speechPreset in setOf("default", "warm"))
    require(target.rearmGuardMs in 0..60_000)
  }

  private fun validateIdentity(identity: VoiceRuntimeIdentity) {
    requireIdentifier(identity.runtimeId, "runtime ID")
    requireIdentifier(identity.runtimeInstanceId, "runtime instance ID")
    require(identity.generation > 0)
  }

  private fun requireIdentifier(value: String, label: String) {
    require(value.isNotBlank() && value.length <= MAXIMUM_IDENTIFIER_LENGTH &&
      value.none { it == '\u0000' }) { "Invalid $label." }
  }

  private fun loadTerminals(): List<VoiceRuntimeRealtimeTerminalSummary> {
    val raw = storage.getString(KEY_TERMINALS) ?: return emptyList()
    return try {
      val root = JSONObject(raw).requireExactFields(TERMINAL_ROOT_FIELDS)
      require(root.getString("version") == VERSION)
      val entries = root.getJSONArray("entries")
      require(entries.length() <= terminalCapacity)
      buildList(entries.length()) {
        repeat(entries.length()) {
          add(decodeTerminal(entries.getJSONObject(it)).also(::validateTerminal))
        }
      }
    } catch (cause: Throwable) {
      throw VoiceRuntimeDurableStateCorruptionException(
        "Realtime voice terminal summaries are unreadable.",
        cause,
      )
    }
  }

  private fun writeTerminals(summaries: List<VoiceRuntimeRealtimeTerminalSummary>) {
    require(summaries.size <= terminalCapacity)
    val encoded = encodeTerminals(summaries)
    if (encoded == null) {
      check(storage.clear(setOf(KEY_TERMINALS))) {
        "Could not clear Realtime voice terminal summaries."
      }
      return
    }
    check(storage.put(mapOf(KEY_TERMINALS to encoded))) {
      "Could not persist Realtime voice terminal summaries."
    }
  }

  private fun encodeTerminals(summaries: List<VoiceRuntimeRealtimeTerminalSummary>): String? {
    require(summaries.size <= terminalCapacity)
    if (summaries.isEmpty()) return null
    val entries = JSONArray()
    summaries.forEach { entries.put(encodeTerminal(it)) }
    return JSONObject().put("version", VERSION).put("entries", entries).toString()
  }

  private fun encodeTerminal(summary: VoiceRuntimeRealtimeTerminalSummary): JSONObject = JSONObject()
    .put("runtimeId", summary.identity.runtimeId)
    .put("runtimeInstanceId", summary.identity.runtimeInstanceId)
    .put("generation", summary.identity.generation)
    .put("modeSessionId", summary.modeSessionId)
    .put("environmentId", summary.environmentId)
    .put("conversationId", summary.conversationId)
    .put("sessionId", summary.sessionId ?: JSONObject.NULL)
    .put("outcome", summary.outcome.name)
    .put("reason", summary.reason)
    .put(
      "lastConnectedAtEpochMillis",
      summary.lastConnectedAtEpochMillis ?: JSONObject.NULL,
    )
    .put("terminalAtEpochMillis", summary.terminalAtEpochMillis)
    .put("serverCleanupPending", summary.serverCleanupPending)
    .put("expiresAtEpochMillis", summary.expiresAtEpochMillis)

  private fun decodeTerminal(value: JSONObject): VoiceRuntimeRealtimeTerminalSummary {
    value.requireExactFields(TERMINAL_FIELDS)
    return VoiceRuntimeRealtimeTerminalSummary(
      identity = VoiceRuntimeIdentity(
        value.getString("runtimeId"),
        value.getString("runtimeInstanceId"),
        value.exactLong("generation"),
      ),
      modeSessionId = value.getString("modeSessionId"),
      environmentId = value.getString("environmentId"),
      conversationId = value.getString("conversationId"),
      sessionId = value.nullableString("sessionId"),
      outcome = VoiceRuntimeRealtimeTerminalOutcome.valueOf(value.getString("outcome")),
      reason = value.getString("reason"),
      lastConnectedAtEpochMillis = value.nullableLong("lastConnectedAtEpochMillis"),
      terminalAtEpochMillis = value.exactLong("terminalAtEpochMillis"),
      serverCleanupPending = value.exactBoolean("serverCleanupPending"),
      expiresAtEpochMillis = value.exactLong("expiresAtEpochMillis"),
    )
  }

  private fun validateTerminal(summary: VoiceRuntimeRealtimeTerminalSummary) {
    validateIdentity(summary.identity)
    requireIdentifier(summary.modeSessionId, "mode session ID")
    requireIdentifier(summary.environmentId, "environment ID")
    requireIdentifier(summary.conversationId, "conversation ID")
    summary.sessionId?.let { requireIdentifier(it, "session ID") }
    require(summary.reason.isNotBlank() && summary.reason.length <= MAXIMUM_REASON_LENGTH)
    summary.lastConnectedAtEpochMillis?.let { require(it >= 0) }
    require(summary.terminalAtEpochMillis >= 0)
    require(summary.expiresAtEpochMillis > summary.terminalAtEpochMillis)
  }

  private fun JSONObject.requireExactFields(fields: Set<String>): JSONObject = apply {
    require(keys().asSequence().toSet() == fields)
  }

  private fun JSONObject.nullableString(name: String): String? =
    if (isNull(name)) null else getString(name)

  private fun JSONObject.nullableLong(name: String): Long? =
    if (isNull(name)) null else exactLong(name)

  private fun JSONObject.nullableObject(name: String): JSONObject? =
    if (isNull(name)) null else getJSONObject(name)

  private fun JSONObject.exactLong(name: String): Long {
    val value = get(name)
    require(value is Byte || value is Short || value is Int || value is Long)
    return (value as Number).toLong()
  }

  private fun JSONObject.exactInt(name: String): Int {
    val value = get(name)
    require(value is Byte || value is Short || value is Int)
    return (value as Number).toInt()
  }

  private fun JSONObject.exactBoolean(name: String): Boolean =
    get(name).let { value -> require(value is Boolean); value }

  private companion object {
    const val VERSION = "t3-voice-runtime-realtime-checkpoint-v1"
    const val KEY_CHECKPOINT = "canonical_realtime_checkpoint_v1"
    const val KEY_FINALIZATION = "canonical_realtime_finalization_v1"
    const val KEY_TERMINALS = "canonical_realtime_terminals_v1"
    const val MAXIMUM_IDENTIFIER_LENGTH = 256
    const val MAXIMUM_SUMMARY_LENGTH = 4_096
    const val MAXIMUM_REASON_LENGTH = 256
    const val MAXIMUM_PATH_LENGTH = 2_048
    const val MAXIMUM_TERMINALS = 64
    val CHECKPOINT_FIELDS = setOf(
      "version", "fence", "target", "rootCommandId", "phase", "serverSessionId",
      "leaseGeneration", "expiresAtEpochMillis", "heartbeatIntervalSeconds", "lastActionSequence",
      "lastConnectedAtEpochMillis",
      "pendingAction", "pendingHandoffExchange", "drainDeadlineAtEpochMillis",
      "muted",
    )
    val FENCE_FIELDS = setOf("runtimeId", "runtimeInstanceId", "generation", "modeSessionId")
    val FINALIZATION_FIELDS = setOf(
      "version", "fence", "sourceTarget", "sourceEnvironmentOrigin",
      "rootCommandId", "session", "closeOperationId",
      "outcome", "reason", "lastConnectedAtEpochMillis", "handoffExchange", "stage",
      "attemptCount", "lastFailureCode", "lastFailureRetryable", "terminalPublication",
    )
    val FINALIZATION_SESSION_FIELDS = setOf(
      "state", "signalingPath", "expiresAtEpochMillis", "heartbeatIntervalSeconds",
    )
    val FINALIZATION_SESSION_STATE_FIELDS = setOf(
      "sessionId", "conversationId", "phase", "leaseGeneration", "sequence",
    )
    val REALTIME_TARGET_FIELDS = setOf("environmentId", "conversationId")
    val NAVIGATE_ACTION_FIELDS = setOf(
      "type", "sequence", "occurredAtEpochMillis", "actionId", "projectId", "threadId",
      "expiresAtEpochMillis",
    )
    val HANDOFF_ACTION_FIELDS = NAVIGATE_ACTION_FIELDS + "autoRearm"
    val STOP_ACTION_FIELDS = setOf("type", "sequence", "occurredAtEpochMillis")
    val CONFIRMATION_ACTION_FIELDS = setOf(
      "type", "sequence", "occurredAtEpochMillis", "actionId", "confirmationId",
      "toolCallId", "tool", "summary", "expiresAtEpochMillis",
    )
    val HANDOFF_EXCHANGE_FIELDS = setOf(
      "actionId", "actionSequence", "projectId", "threadId", "autoRearm",
      "reservation", "replayed",
    )
    val TRANSITION_RESERVATION_FIELDS = setOf("generation", "modeSessionId", "target")
    val THREAD_TARGET_FIELDS = setOf(
      "environmentId", "projectId", "threadId", "speechPreset", "autoRearm",
      "endpointPolicy", "speechEnabled", "rearmGuardMs",
    )
    val ENDPOINT_POLICY_FIELDS = setOf(
      "endSilenceMs", "noSpeechTimeoutMs", "maximumUtteranceMs",
    )
    val TERMINAL_ROOT_FIELDS = setOf("version", "entries")
    val TERMINAL_FIELDS = setOf(
      "runtimeId", "runtimeInstanceId", "generation", "modeSessionId", "environmentId",
      "conversationId",
      "sessionId", "outcome", "reason", "lastConnectedAtEpochMillis",
      "terminalAtEpochMillis", "serverCleanupPending", "expiresAtEpochMillis",
    )
  }

}
