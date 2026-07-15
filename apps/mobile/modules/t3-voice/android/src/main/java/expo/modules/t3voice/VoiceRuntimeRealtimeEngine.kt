package expo.modules.t3voice

internal data class VoiceRuntimeRealtimeAuthority(
  val identity: VoiceRuntimeIdentity,
  val target: VoiceRuntimeTarget.Realtime,
  val environmentOrigin: String,
)

internal data class VoiceRuntimeRealtimeFence(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
)

internal sealed interface VoiceRuntimeNativeCommand {
  val commandId: String
  val identity: VoiceRuntimeIdentity
  val modeSessionId: String

  data class Thread(val command: VoiceRuntimeThreadCommand) : VoiceRuntimeNativeCommand {
    override val commandId get() = command.commandId
    override val identity get() = command.identity
    override val modeSessionId get() = command.modeSessionId
  }

  data class StartRealtime(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val interruptionPolicy: String,
  ) : VoiceRuntimeNativeCommand

  data class StopMode(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val policy: String,
  ) : VoiceRuntimeNativeCommand

  data class SetRealtimeMuted(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val muted: Boolean,
  ) : VoiceRuntimeNativeCommand

  data class UpdateRealtimeFocus(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val focus: VoiceRuntimeRealtimeFocus?,
  ) : VoiceRuntimeNativeCommand

  data class SetAudioRoute(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val inputRouteId: String?,
    val outputRouteId: String?,
  ) : VoiceRuntimeNativeCommand

  data class DecideRealtimeConfirmation(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val lease: VoiceRuntimeConsumerLease,
    val actionId: String,
    val confirmationId: String,
    val decision: String,
  ) : VoiceRuntimeNativeCommand
}

internal enum class VoiceRuntimeRealtimeStopPolicy { IMMEDIATE, DRAIN }

internal enum class VoiceRuntimeRealtimeTerminalOutcome {
  COMPLETED,
  STOPPED,
  INTERRUPTED,
  FAILED,
}

internal data class VoiceRuntimeRealtimeTerminalSummary(
  val identity: VoiceRuntimeIdentity,
  val modeSessionId: String,
  val environmentId: String,
  val conversationId: String,
  val sessionId: String?,
  val outcome: VoiceRuntimeRealtimeTerminalOutcome,
  val reason: String,
  val lastConnectedAtEpochMillis: Long?,
  val terminalAtEpochMillis: Long,
  val serverCleanupPending: Boolean,
  val expiresAtEpochMillis: Long,
)

internal data class VoiceRuntimeRealtimeCheckpoint(
  val fence: VoiceRuntimeRealtimeFence,
  val target: VoiceRuntimeTarget.Realtime,
  val rootCommandId: String,
  val phase: VoiceRealtimePhase,
  val serverSessionId: String? = null,
  val leaseGeneration: Long? = null,
  val expiresAtEpochMillis: Long? = null,
  val heartbeatIntervalSeconds: Long? = null,
  val lastActionSequence: Long = 0,
  val lastConnectedAtEpochMillis: Long? = null,
  val pendingAction: VoiceRuntimeRealtimeAction? = null,
  val pendingHandoffExchange: VoiceRuntimeRealtimeHandoffExchangeResult? = null,
  val drainDeadlineAtEpochMillis: Long? = null,
  val muted: Boolean = false,
) {
  init {
    require(lastActionSequence >= 0)
    require((serverSessionId == null) == (leaseGeneration == null))
    require((serverSessionId == null) == (expiresAtEpochMillis == null))
    require((serverSessionId == null) == (heartbeatIntervalSeconds == null))
  }
}

internal enum class VoiceRuntimeRealtimeFinalizationStage {
  HANDOFF_COMMIT_PENDING,
  HANDOFF_ACTIVATION_PENDING,
  SOURCE_CLOSE_PENDING,
}

internal enum class VoiceRuntimeRealtimeTerminalPublication {
  NONE,
  CLEANUP_PENDING,
  CLEANUP_COMPLETE,
}

internal data class VoiceRuntimeRealtimeFinalization(
  val fence: VoiceRuntimeRealtimeFence,
  val sourceTarget: VoiceRuntimeTarget.Realtime,
  val sourceEnvironmentOrigin: String,
  val rootCommandId: String,
  val session: VoiceRuntimeRealtimeStartResult,
  val closeOperationId: String,
  val outcome: VoiceRuntimeRealtimeTerminalOutcome,
  val reason: String,
  val lastConnectedAtEpochMillis: Long?,
  val handoffExchange: VoiceRuntimeRealtimeHandoffExchangeResult?,
  val stage: VoiceRuntimeRealtimeFinalizationStage,
  val attemptCount: Int = 0,
  val lastFailureCode: String? = null,
  val lastFailureRetryable: Boolean = true,
  val terminalPublication: VoiceRuntimeRealtimeTerminalPublication =
    VoiceRuntimeRealtimeTerminalPublication.NONE,
) {
  init {
    require(attemptCount >= 0)
    require(handoffExchange != null ||
      stage == VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING)
  }

  fun acceptsUpdate(next: VoiceRuntimeRealtimeFinalization): Boolean = copy(
    stage = next.stage,
    outcome = next.outcome,
    reason = next.reason,
    attemptCount = next.attemptCount,
    lastFailureCode = next.lastFailureCode,
    lastFailureRetryable = next.lastFailureRetryable,
    terminalPublication = next.terminalPublication,
  ) == next && next.stage.ordinal >= stage.ordinal && next.attemptCount >= attemptCount &&
    ((next.outcome == outcome && next.reason == reason) ||
      (stage != VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING &&
        next.stage == VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING &&
        next.outcome == VoiceRuntimeRealtimeTerminalOutcome.FAILED &&
        next.reason == next.lastFailureCode && !next.lastFailureRetryable))
}

internal sealed interface VoiceRuntimeRealtimeFinalizationResult {
  data object Idle : VoiceRuntimeRealtimeFinalizationResult
  data class Pending(
    val stage: VoiceRuntimeRealtimeFinalizationStage,
    val attemptCount: Int,
    val retryable: Boolean,
    val failureCode: String?,
  ) : VoiceRuntimeRealtimeFinalizationResult
  data class Completed(val summary: VoiceRuntimeRealtimeTerminalSummary) :
    VoiceRuntimeRealtimeFinalizationResult
}

internal interface VoiceRuntimeRealtimeCheckpointRepository {
  fun load(): VoiceRuntimeRealtimeCheckpoint?
  fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint)
  fun clear(fence: VoiceRuntimeRealtimeFence)
  fun loadFinalization(): VoiceRuntimeRealtimeFinalization?
  fun installFinalization(
    expectedCheckpoint: VoiceRuntimeRealtimeCheckpoint?,
    finalization: VoiceRuntimeRealtimeFinalization,
  )
  fun saveFinalization(finalization: VoiceRuntimeRealtimeFinalization)
  fun clearFinalization(fence: VoiceRuntimeRealtimeFence, sessionId: String)
  fun publishTerminal(summary: VoiceRuntimeRealtimeTerminalSummary)
  fun hasTerminalCapacity(fence: VoiceRuntimeRealtimeFence, nowEpochMillis: Long): Boolean
  fun terminals(nowEpochMillis: Long): List<VoiceRuntimeRealtimeTerminalSummary>
  fun acknowledgeTerminal(key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal): Boolean
}

internal class VoiceRuntimeMemoryRealtimeCheckpointRepository :
  VoiceRuntimeRealtimeCheckpointRepository {
  private var checkpoint: VoiceRuntimeRealtimeCheckpoint? = null
  private var finalization: VoiceRuntimeRealtimeFinalization? = null
  private val terminalValues = mutableListOf<VoiceRuntimeRealtimeTerminalSummary>()

  override fun load() = checkpoint

  override fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint) {
    this.checkpoint = checkpoint
  }

  override fun clear(fence: VoiceRuntimeRealtimeFence) {
    if (checkpoint?.fence == fence) checkpoint = null
  }

  override fun loadFinalization() = finalization

  override fun installFinalization(
    expectedCheckpoint: VoiceRuntimeRealtimeCheckpoint?,
    finalization: VoiceRuntimeRealtimeFinalization,
  ) {
    check(checkpoint == expectedCheckpoint) { "Realtime checkpoint changed before finalization." }
    check(this.finalization == null || this.finalization == finalization) {
      "A different Realtime finalization is already pending."
    }
    checkpoint = null
    this.finalization = finalization
  }

  override fun saveFinalization(finalization: VoiceRuntimeRealtimeFinalization) {
    val current = requireNotNull(this.finalization) { "Realtime finalization is unavailable." }
    require(current.fence == finalization.fence &&
      current.session.state.sessionId == finalization.session.state.sessionId) {
      "Realtime finalization fence changed."
    }
    require(current.acceptsUpdate(finalization)) {
      "Realtime finalization operation changed or regressed."
    }
    this.finalization = finalization
  }

  override fun clearFinalization(fence: VoiceRuntimeRealtimeFence, sessionId: String) {
    val current = finalization ?: return
    if (current.fence == fence && current.session.state.sessionId == sessionId) finalization = null
  }

  override fun publishTerminal(summary: VoiceRuntimeRealtimeTerminalSummary) {
    terminalValues.removeAll { it.expiresAtEpochMillis <= summary.terminalAtEpochMillis }
    terminalValues.removeAll {
      it.identity.runtimeId == summary.identity.runtimeId && it.modeSessionId == summary.modeSessionId
    }
    if (terminalValues.size >= MAXIMUM_TERMINALS) {
      throw VoiceRuntimeRetentionCapacityException("Realtime terminal", MAXIMUM_TERMINALS)
    }
    terminalValues += summary
  }

  override fun hasTerminalCapacity(
    fence: VoiceRuntimeRealtimeFence,
    nowEpochMillis: Long,
  ): Boolean {
    terminalValues.removeAll { it.expiresAtEpochMillis <= nowEpochMillis }
    return terminalValues.any {
      it.identity == fence.identity && it.modeSessionId == fence.modeSessionId
    } || terminalValues.size < MAXIMUM_TERMINALS
  }

  override fun terminals(nowEpochMillis: Long): List<VoiceRuntimeRealtimeTerminalSummary> {
    terminalValues.removeAll { it.expiresAtEpochMillis <= nowEpochMillis }
    return terminalValues.toList()
  }

  override fun acknowledgeTerminal(key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal): Boolean =
    terminalValues.removeAll { it.identity == key.identity && it.modeSessionId == key.modeSessionId }

  private companion object {
    const val MAXIMUM_TERMINALS = 64
  }
}

internal sealed interface VoiceRuntimeRealtimeRemoteResult<out T> {
  data class Success<T>(val value: T) : VoiceRuntimeRealtimeRemoteResult<T>
  data class Failure(val code: String, val retryable: Boolean) : VoiceRuntimeRealtimeRemoteResult<Nothing>
}

internal sealed interface VoiceRuntimeRealtimePresentationDecision {
  data class Navigate(
    val outcome: VoiceRuntimeRealtimeActionOutcome,
    val message: String?,
  ) : VoiceRuntimeRealtimePresentationDecision

  data class Confirmation(
    val confirmationId: String,
    val decision: String,
  ) : VoiceRuntimeRealtimePresentationDecision
}

internal interface VoiceRuntimeRealtimeServer {
  fun start(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    clientOperationId: String,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeStartResult>

  fun offer(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
    sdp: String,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeAnswer>

  fun heartbeat(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHeartbeatResult>

  fun actions(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    afterSequence: Long,
    waitMilliseconds: Long,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionsResult>

  fun acknowledgeAction(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    action: VoiceRuntimeRealtimeAction,
    clientOperationId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionAckResult>

  fun updateFocus(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
    focus: VoiceRuntimeRealtimeFocus?,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeFocusResult>

  fun exchangeHandoff(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
    plan: VoiceRuntimeRealtimeHandoffPlan,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHandoffExchangeResult>

  fun commitHandoff(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    exchange: VoiceRuntimeRealtimeHandoffExchangeResult,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHandoffCommitResult>

  fun close(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeCloseResult>
}

internal interface VoiceRuntimeRealtimePeer {
  fun prepare(
    modeSessionId: String,
    onOffer: (String) -> Unit,
    onFailure: (String) -> Unit,
  ): Boolean
  fun applyAnswer(modeSessionId: String, sdp: String, onFailure: (String) -> Unit): Boolean
  fun setInputReady(modeSessionId: String, ready: Boolean): Boolean
  fun setMuted(modeSessionId: String, muted: Boolean): Boolean
  fun drain(modeSessionId: String, onComplete: () -> Unit): Boolean
  fun close(modeSessionId: String)
}

internal interface VoiceRuntimeRealtimeCues {
  fun ready(generation: Long, onComplete: () -> Unit): Boolean
  fun ended(generation: Long, onComplete: () -> Unit): Boolean
}

internal data class VoiceRuntimeRealtimeHandoffPlan(
  val clientOperationId: String,
  val threadModeSessionId: String,
  val environmentId: String,
  val speechPreset: String,
  val endpointPolicy: VoiceRuntimeRealtimeEndpointPolicy,
  val speechEnabled: Boolean,
  val rearmGuardMs: Long,
)

internal interface VoiceRuntimeRealtimeHandoffCoordinator {
  fun plan(
    source: VoiceRuntimeRealtimeCheckpoint,
    action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
  ): VoiceRuntimeRealtimeHandoffPlan

  fun prepare(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean

  fun rollback(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean

  fun activate(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean
}

internal data class VoiceRuntimeRealtimePendingStart(
  val commandId: String,
  val fingerprint: String,
  val fence: VoiceRuntimeRealtimeFence,
  val cancelled: Boolean = false,
)

internal data class VoiceRuntimeRealtimeCommandLedger(
  val outcomes: Map<String, VoiceRuntimeStoredOutcome<VoiceRuntimeRealtimeCommandResult>> = emptyMap(),
) {
  fun replay(id: String, fingerprint: String): VoiceRuntimeRealtimeCommandResult? {
    val existing = outcomes[id] ?: return null
    if (existing.fingerprint != fingerprint) throw VoiceRuntimeIdempotencyConflictException()
    return existing.value
  }

  fun record(
    id: String,
    fingerprint: String,
    value: VoiceRuntimeRealtimeCommandResult,
  ): VoiceRuntimeRealtimeCommandLedger {
    val existing = outcomes[id]
    if (existing != null && existing.fingerprint != fingerprint) {
      throw VoiceRuntimeIdempotencyConflictException()
    }
    val next = LinkedHashMap(outcomes)
    next[id] = VoiceRuntimeStoredOutcome(fingerprint, value)
    while (next.size > COMMAND_CAPACITY) next.remove(next.keys.first())
    return copy(outcomes = next)
  }

  private companion object {
    const val COMMAND_CAPACITY = 256
  }
}

/** All Realtime facts read by reductions. Durable storage is a write-through sink only. */
internal data class VoiceRuntimeRealtimeState(
  val checkpoint: VoiceRuntimeRealtimeCheckpoint? = null,
  val serverSession: VoiceRuntimeRealtimeStartResult? = null,
  val pendingStart: VoiceRuntimeRealtimePendingStart? = null,
  val finalization: VoiceRuntimeRealtimeFinalization? = null,
  val finalizationInFlight: Boolean = false,
  val commands: VoiceRuntimeRealtimeCommandLedger = VoiceRuntimeRealtimeCommandLedger(),
  val terminals: List<VoiceRuntimeRealtimeTerminalSummary> = emptyList(),
  val pendingPresentation: VoiceRuntimeRealtimeAction? = null,
) {
  fun isOperational(): Boolean = checkpoint != null || finalization != null
}

internal sealed interface VoiceRuntimeRealtimePersistence {
  data class Batch(val operations: List<VoiceRuntimeRealtimePersistence>) :
    VoiceRuntimeRealtimePersistence
  data class SaveCheckpoint(val checkpoint: VoiceRuntimeRealtimeCheckpoint) :
    VoiceRuntimeRealtimePersistence
  data class ClearCheckpoint(val fence: VoiceRuntimeRealtimeFence) :
    VoiceRuntimeRealtimePersistence
  data class InstallFinalization(
    val expectedCheckpoint: VoiceRuntimeRealtimeCheckpoint?,
    val finalization: VoiceRuntimeRealtimeFinalization,
  ) : VoiceRuntimeRealtimePersistence
  data class SaveFinalization(val finalization: VoiceRuntimeRealtimeFinalization) :
    VoiceRuntimeRealtimePersistence
  data class ClearFinalization(val fence: VoiceRuntimeRealtimeFence, val sessionId: String) :
    VoiceRuntimeRealtimePersistence
  data class PublishTerminal(val summary: VoiceRuntimeRealtimeTerminalSummary) :
    VoiceRuntimeRealtimePersistence
}

internal sealed interface VoiceRuntimeRealtimeOutput {
  data class State(val checkpoint: VoiceRuntimeRealtimeCheckpoint?) : VoiceRuntimeRealtimeOutput
  data class FinalizationInstalled(val finalization: VoiceRuntimeRealtimeFinalization) :
    VoiceRuntimeRealtimeOutput
  data class Terminal(val summary: VoiceRuntimeRealtimeTerminalSummary) : VoiceRuntimeRealtimeOutput
  data class Finalization(val result: VoiceRuntimeRealtimeFinalizationResult) :
    VoiceRuntimeRealtimeOutput
  data object ReconcileForeground : VoiceRuntimeRealtimeOutput
}

internal data class VoiceRuntimeRealtimePendingAcknowledgement(
  val action: VoiceRuntimeRealtimeAction,
  val commandId: String,
  val decision: VoiceRuntimeRealtimePresentationDecision,
)

internal sealed interface VoiceRuntimeRealtimeEffect {
  data class Persist(
    val operation: VoiceRuntimeRealtimePersistence,
    val outputs: List<VoiceRuntimeRealtimeOutput> = emptyList(),
    val effects: List<VoiceRuntimeRealtimeEffect> = emptyList(),
  ) : VoiceRuntimeRealtimeEffect
  data class Start(val fence: VoiceRuntimeRealtimeFence, val commandId: String) :
    VoiceRuntimeRealtimeEffect
  data class PreparePeer(val fence: VoiceRuntimeRealtimeFence, val sessionId: String) :
    VoiceRuntimeRealtimeEffect
  data class Offer(
    val fence: VoiceRuntimeRealtimeFence,
    val session: VoiceRuntimeRealtimeStartResult,
    val operationId: String,
    val sdp: String,
  ) : VoiceRuntimeRealtimeEffect
  data class ApplyAnswer(val fence: VoiceRuntimeRealtimeFence, val sessionId: String, val sdp: String) :
    VoiceRuntimeRealtimeEffect
  data class SetInputReady(val fence: VoiceRuntimeRealtimeFence, val ready: Boolean) :
    VoiceRuntimeRealtimeEffect
  data class SetMuted(val fence: VoiceRuntimeRealtimeFence, val muted: Boolean) :
    VoiceRuntimeRealtimeEffect
  data class Drain(val fence: VoiceRuntimeRealtimeFence, val reason: String) :
    VoiceRuntimeRealtimeEffect
  data class ClosePeer(val fence: VoiceRuntimeRealtimeFence) : VoiceRuntimeRealtimeEffect
  data class CueReady(val fence: VoiceRuntimeRealtimeFence, val sessionId: String) :
    VoiceRuntimeRealtimeEffect
  data class CueEnded(val fence: VoiceRuntimeRealtimeFence, val reason: String) :
    VoiceRuntimeRealtimeEffect
  data class Heartbeat(
    val fence: VoiceRuntimeRealtimeFence,
    val session: VoiceRuntimeRealtimeStartResult,
  ) : VoiceRuntimeRealtimeEffect
  data class PollActions(
    val fence: VoiceRuntimeRealtimeFence,
    val session: VoiceRuntimeRealtimeStartResult,
    val afterSequence: Long,
    val waitMilliseconds: Long,
  ) : VoiceRuntimeRealtimeEffect
  data class PublishPresentation(
    val fence: VoiceRuntimeRealtimeFence,
    val action: VoiceRuntimeRealtimeAction,
  ) : VoiceRuntimeRealtimeEffect
  data class RetractPresentation(
    val fence: VoiceRuntimeRealtimeFence,
    val action: VoiceRuntimeRealtimeAction,
  ) : VoiceRuntimeRealtimeEffect
  data class UpdateFocus(
    val fence: VoiceRuntimeRealtimeFence,
    val session: VoiceRuntimeRealtimeStartResult,
    val commandId: String,
    val focus: VoiceRuntimeRealtimeFocus?,
    val thenAcknowledge: VoiceRuntimeRealtimePendingAcknowledgement? = null,
  ) : VoiceRuntimeRealtimeEffect
  data class AcknowledgeAction(
    val fence: VoiceRuntimeRealtimeFence,
    val session: VoiceRuntimeRealtimeStartResult,
    val action: VoiceRuntimeRealtimeAction,
    val commandId: String,
    val decision: VoiceRuntimeRealtimePresentationDecision,
  ) : VoiceRuntimeRealtimeEffect
  data class ExchangeHandoff(
    val fence: VoiceRuntimeRealtimeFence,
    val checkpoint: VoiceRuntimeRealtimeCheckpoint,
    val session: VoiceRuntimeRealtimeStartResult,
    val action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
    val plan: VoiceRuntimeRealtimeHandoffPlan,
  ) : VoiceRuntimeRealtimeEffect
  data class PrepareHandoff(
    val fence: VoiceRuntimeRealtimeFence,
    val checkpoint: VoiceRuntimeRealtimeCheckpoint,
    val action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
    val exchange: VoiceRuntimeRealtimeHandoffExchangeResult,
  ) : VoiceRuntimeRealtimeEffect
  data class RollbackHandoff(val exchange: VoiceRuntimeRealtimeHandoffExchangeResult) :
    VoiceRuntimeRealtimeEffect
  data class ActivateHandoff(val finalization: VoiceRuntimeRealtimeFinalization) :
    VoiceRuntimeRealtimeEffect
  data class CommitHandoff(val finalization: VoiceRuntimeRealtimeFinalization) :
    VoiceRuntimeRealtimeEffect
  data class CloseServer(val finalization: VoiceRuntimeRealtimeFinalization) :
    VoiceRuntimeRealtimeEffect
}

internal data class VoiceRuntimeRealtimeReduction<out T>(
  val state: VoiceRuntimeRealtimeState,
  val effects: List<VoiceRuntimeRealtimeEffect> = emptyList(),
  val outputs: List<VoiceRuntimeRealtimeOutput> = emptyList(),
  val result: T,
)

/** Pure kernel-thread sub-reducer. Every external interaction is returned as data. */
internal class VoiceRuntimeRealtimeReducer(
  internal val authority: VoiceRuntimeRealtimeAuthority,
  private val assertKernelThread: () -> Unit = {},
  private val drainTimeoutMillis: Long = 2_500,
  private val terminalRetentionMillis: Long = 30L * 24 * 60 * 60 * 1_000,
) {
  init {
    require(drainTimeoutMillis > 0)
    require(terminalRetentionMillis > 0)
  }

  fun admitStart(
    state: VoiceRuntimeRealtimeState,
    commandId: String,
    fence: VoiceRuntimeRealtimeFence,
    activationAdmission: Boolean,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeCommandResult> = kernel {
    val fingerprint = "start:$fence"
    state.commands.replay(commandId, fingerprint)?.let {
      return@kernel reduction(state, it.withReplay(true))
    }
    requireFence(fence)
    state.pendingStart?.let { pending ->
      if (pending.commandId == commandId) {
        if (pending.fingerprint != fingerprint) throw VoiceRuntimeIdempotencyConflictException()
        return@kernel reduction(
          state,
          if (pending.cancelled) VoiceRuntimeRealtimeCommandResult.Rejected("start-cancelled")
          else VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true),
        )
      }
      return@kernel recorded(state, commandId, fingerprint, rejected("owner-conflict"))
    }
    if (state.finalization != null) {
      return@kernel recorded(state, commandId, fingerprint, rejected("finalization-pending"))
    }
    state.checkpoint?.let { current ->
      if (current.rootCommandId == commandId && current.fence != fence) {
        throw VoiceRuntimeIdempotencyConflictException()
      }
      val result = if (current.fence == fence && !current.phase.isTerminal()) {
        VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true)
      } else rejected("owner-conflict")
      return@kernel if (current.rootCommandId == commandId &&
        current.phase == VoiceRealtimePhase.PREPARING) reduction(state, result)
      else recorded(state, commandId, fingerprint, result)
    }
    val terminals = pruneTerminals(state.terminals, nowEpochMillis)
    val hasTerminal = terminals.any { it.identity == fence.identity && it.modeSessionId == fence.modeSessionId }
    if (!hasTerminal && terminals.size >= MAXIMUM_TERMINALS) {
      return@kernel recorded(
        state.copy(terminals = terminals),
        commandId,
        fingerprint,
        rejected("realtime-terminal-retention-full"),
      )
    }
    if (!activationAdmission) {
      return@kernel recorded(state.copy(terminals = terminals), commandId, fingerprint, rejected("start-cancelled"))
    }
    val checkpoint = VoiceRuntimeRealtimeCheckpoint(
      fence = fence,
      target = authority.target,
      rootCommandId = commandId,
      phase = VoiceRealtimePhase.PREPARING,
    )
    val next = state.copy(
      checkpoint = checkpoint,
      pendingStart = VoiceRuntimeRealtimePendingStart(commandId, fingerprint, fence),
      terminals = terminals,
    )
    VoiceRuntimeRealtimeReduction(
      state = next,
      effects = listOf(persistCheckpoint(
        checkpoint,
        effects = listOf(VoiceRuntimeRealtimeEffect.Start(fence, commandId)),
      )),
      result = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false),
    )
  }

  fun acknowledgeTerminal(
    state: VoiceRuntimeRealtimeState,
    key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal,
    acknowledged: Boolean,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    if (!acknowledged) return@kernel reduction(state, false)
    reduction(
      state.copy(terminals = state.terminals.filterNot {
        it.identity == key.identity && it.modeSessionId == key.modeSessionId
      }),
      true,
    )
  }

  fun completeStart(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    remote: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeStartResult>,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeCommandResult> = kernel {
    val pending = state.pendingStart?.takeIf { it.commandId == commandId && it.fence == fence }
    val current = state.checkpoint?.takeIf {
      it.fence == fence && it.rootCommandId == commandId && it.phase == VoiceRealtimePhase.PREPARING
    }
    if (pending == null || current == null) {
      if (remote is VoiceRuntimeRealtimeRemoteResult.Success) {
        val finalization = cancelledStartFinalization(state, fence, commandId, remote.value)
        val next = state.copy(finalization = finalization, finalizationInFlight = true)
        return@kernel VoiceRuntimeRealtimeReduction(
          next,
          listOf(
            VoiceRuntimeRealtimeEffect.Persist(
              VoiceRuntimeRealtimePersistence.InstallFinalization(null, finalization),
              effects = listOf(finalizationEffect(finalization)),
            ),
          ),
          result = rejected("start-cancelled"),
        )
      }
      return@kernel reduction(state, rejected("start-cancelled"))
    }
    val fingerprint = pending.fingerprint
    when (remote) {
      is VoiceRuntimeRealtimeRemoteResult.Failure -> {
        val failed = failWithoutSession(state, current, remote.code, nowEpochMillis)
        recorded(failed.state.copy(pendingStart = null), commandId, fingerprint, rejected(remote.code), failed.effects)
      }
      is VoiceRuntimeRealtimeRemoteResult.Success -> {
        val session = remote.value
        if (!validStart(session, fence, nowEpochMillis)) {
          val hydrated = current.copy(
            serverSessionId = session.state.sessionId,
            leaseGeneration = session.state.leaseGeneration,
            expiresAtEpochMillis = session.expiresAtEpochMillis,
            heartbeatIntervalSeconds = session.heartbeatIntervalSeconds,
          )
          val failed = beginFailure(state.copy(checkpoint = hydrated, serverSession = session), "invalid-start-response", nowEpochMillis)
          recorded(failed.state.copy(pendingStart = null), commandId, fingerprint, rejected("invalid-start-response"), failed.effects)
        } else {
          val checkpoint = current.copy(
            phase = VoiceRealtimePhase.NEGOTIATING,
            serverSessionId = session.state.sessionId,
            leaseGeneration = session.state.leaseGeneration,
            expiresAtEpochMillis = session.expiresAtEpochMillis,
            heartbeatIntervalSeconds = session.heartbeatIntervalSeconds,
          )
          val result = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
          val next = state.copy(
            checkpoint = checkpoint,
            serverSession = session,
            pendingStart = null,
            commands = state.commands.record(commandId, fingerprint, result),
          )
          VoiceRuntimeRealtimeReduction(
            next,
            listOf(persistCheckpoint(
              checkpoint,
              effects = listOf(VoiceRuntimeRealtimeEffect.PreparePeer(
                fence,
                session.state.sessionId,
              )),
            )),
            result = result,
          )
        }
      }
    }
  }

  fun completePeerPrepare(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    accepted: Boolean,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    if (accepted) reduction(state, Unit)
    else beginFailureIfCurrent(state, fence, sessionId, "peer-prepare-rejected", nowEpochMillis)
  }

  fun onPeerOffer(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    sdp: String,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence, sessionId)
    if (current?.phase != VoiceRealtimePhase.NEGOTIATING) return@kernel reduction(state, Unit)
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(
        VoiceRuntimeRealtimeEffect.Offer(
          fence,
          requireSession(state, current),
          "${current.rootCommandId}.offer",
          sdp,
        ),
      ),
      result = Unit,
    )
  }

  fun completeOffer(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    remote: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeAnswer>,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence, sessionId)
    if (current?.phase != VoiceRealtimePhase.NEGOTIATING) return@kernel reduction(state, Unit)
    when (remote) {
      is VoiceRuntimeRealtimeRemoteResult.Failure -> beginFailure(state, remote.code, nowEpochMillis)
      is VoiceRuntimeRealtimeRemoteResult.Success -> VoiceRuntimeRealtimeReduction(
        state,
        listOf(VoiceRuntimeRealtimeEffect.ApplyAnswer(fence, sessionId, remote.value.sdp)),
        result = Unit,
      )
    }
  }

  fun completeApplyAnswer(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    accepted: Boolean,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    if (accepted) reduction(state, Unit)
    else beginFailureIfCurrent(state, fence, sessionId, "peer-answer-rejected", nowEpochMillis)
  }

  fun onPeerConnected(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence, sessionId)
    if (current?.phase != VoiceRealtimePhase.NEGOTIATING) return@kernel reduction(state, Unit)
    val next = current.copy(phase = VoiceRealtimePhase.CUEING)
    VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = next),
      listOf(
        persistCheckpoint(next),
        VoiceRuntimeRealtimeEffect.CueReady(fence, sessionId),
      ),
      result = Unit,
    )
  }

  fun completeReadyCue(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    @Suppress("UNUSED_PARAMETER") accepted: Boolean,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence, sessionId)
    if (current?.phase != VoiceRealtimePhase.CUEING) return@kernel reduction(state, Unit)
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.SetInputReady(fence, true)),
      result = Unit,
    )
  }

  fun completeInputReady(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    ready: Boolean,
    accepted: Boolean,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence) ?: return@kernel reduction(state, Unit)
    if (!accepted && ready) return@kernel beginFailure(state, "microphone-enable-failed", nowEpochMillis)
    if (!ready || current.phase != VoiceRealtimePhase.CUEING) return@kernel reduction(state, Unit)
    val next = current.copy(phase = VoiceRealtimePhase.CONNECTED, lastConnectedAtEpochMillis = nowEpochMillis)
    VoiceRuntimeRealtimeReduction(state.copy(checkpoint = next), listOf(persistCheckpoint(next)), result = Unit)
  }

  fun onPeerTerminated(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    failureCode: String,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence, sessionId) ?: return@kernel reduction(state, Unit)
    if (current.phase in SHUTDOWN_PHASES) reduction(state, Unit)
    else beginFailure(state, failureCode, nowEpochMillis)
  }

  fun heartbeat(state: VoiceRuntimeRealtimeState, fence: VoiceRuntimeRealtimeFence):
    VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    if (current.phase !in setOf(VoiceRealtimePhase.CONNECTED, VoiceRealtimePhase.RETRYING)) {
      return@kernel reduction(state, false)
    }
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.Heartbeat(fence, requireSession(state, current))),
      result = true,
    )
  }

  fun completeHeartbeat(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHeartbeatResult>,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, fence, sessionId) ?: return@kernel reduction(state, false)
    if (current.phase in SHUTDOWN_PHASES) return@kernel reduction(state, false)
    when (result) {
      is VoiceRuntimeRealtimeRemoteResult.Failure -> {
        val next = current.copy(phase = VoiceRealtimePhase.RETRYING)
        VoiceRuntimeRealtimeReduction(state.copy(checkpoint = next), listOf(persistCheckpoint(next)), result = false)
      }
      is VoiceRuntimeRealtimeRemoteResult.Success -> if (result.value.disposition == "terminal") {
        beginShutdown(state, VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, "remote-terminal", nowEpochMillis)
          .mapResult { true }
      } else {
        val next = if (current.phase == VoiceRealtimePhase.RETRYING) {
          current.copy(phase = VoiceRealtimePhase.CONNECTED)
        } else current
        if (next == current) reduction(state, true)
        else VoiceRuntimeRealtimeReduction(state.copy(checkpoint = next), listOf(persistCheckpoint(next)), result = true)
      }
    }
  }

  fun pollActions(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    waitMilliseconds: Long = 25_000,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES) return@kernel reduction(state, true)
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(
        VoiceRuntimeRealtimeEffect.PollActions(
          fence,
          requireSession(state, current),
          current.lastActionSequence,
          waitMilliseconds,
        ),
      ),
      result = true,
    )
  }

  fun completePollActions(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionsResult>,
    handoffPlan: VoiceRuntimeRealtimeHandoffPlan?,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, fence, sessionId) ?: return@kernel reduction(state, false)
    if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES) return@kernel reduction(state, true)
    if (result is VoiceRuntimeRealtimeRemoteResult.Failure) return@kernel reduction(state, false)
    result as VoiceRuntimeRealtimeRemoteResult.Success
    if (result.value.actions.zipWithNext().any { (left, right) -> left.sequence >= right.sequence }) {
      return@kernel beginFailure(state, "action-order-invalid", nowEpochMillis).mapResult { false }
    }
    val action = result.value.actions.firstOrNull { it.sequence > current.lastActionSequence }
      ?: return@kernel reduction(state, true)
    when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread,
      is VoiceRuntimeRealtimeAction.ConfirmationRequired,
      -> VoiceRuntimeRealtimeReduction(
        state.copy(pendingPresentation = action),
        listOf(VoiceRuntimeRealtimeEffect.PublishPresentation(fence, action)),
        result = true,
      )
      is VoiceRuntimeRealtimeAction.StopRealtimeVoice -> {
        val checkpoint = current.copy(lastActionSequence = action.sequence)
        beginShutdown(
          state.copy(checkpoint = checkpoint),
          VoiceRuntimeRealtimeStopPolicy.DRAIN,
          "agent-stop",
          nowEpochMillis,
        ).prepend(persistCheckpoint(checkpoint)).mapResult { true }
      }
      is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> {
        val plan = requireNotNull(handoffPlan) { "Handoff plan is required for a handoff action." }
        VoiceRuntimeRealtimeReduction(
          state,
          listOf(
            VoiceRuntimeRealtimeEffect.ExchangeHandoff(
              fence,
              current,
              requireSession(state, current),
              action,
              plan,
            ),
          ),
          result = true,
        )
      }
    }
  }

  fun completePresentationPublish(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    action: VoiceRuntimeRealtimeAction,
    result: VoiceRuntimeRetentionWriteResult,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    if (state.pendingPresentation != action) return@kernel VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.RetractPresentation(fence, action)),
      result = false,
    )
    val current = activeOrNull(state, fence)
    val retained = result == VoiceRuntimeRetentionWriteResult.INSERTED ||
      result == VoiceRuntimeRetentionWriteResult.UPDATED
    if (!retained || current == null || current.pendingAction != null ||
      current.phase in SHUTDOWN_PHASES || action.sequence <= current.lastActionSequence) {
      return@kernel VoiceRuntimeRealtimeReduction(
        state.copy(pendingPresentation = null),
        if (retained) listOf(VoiceRuntimeRealtimeEffect.RetractPresentation(fence, action)) else emptyList(),
        result = false,
      )
    }
    val next = current.copy(pendingAction = action)
    VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = next, pendingPresentation = null),
      listOf(persistCheckpoint(next)),
      result = true,
    )
  }

  fun updateFocus(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    focus: VoiceRuntimeRealtimeFocus?,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    if (current.phase in SHUTDOWN_PHASES) return@kernel reduction(state, false)
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(
        VoiceRuntimeRealtimeEffect.UpdateFocus(
          fence,
          requireSession(state, current),
          commandId,
          focus,
        ),
      ),
      result = true,
    )
  }

  fun acknowledgePresentationAction(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    actionId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    val action = current.pendingAction
      ?: throw VoiceRuntimeFenceException("No presentation action is pending.")
    val actualId = when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread -> action.actionId
      is VoiceRuntimeRealtimeAction.ConfirmationRequired -> action.actionId
      else -> throw VoiceRuntimeFenceException("Action is not presentation-owned.")
    }
    if (actualId != actionId) throw VoiceRuntimeFenceException("Presentation action is stale.")
    when {
      action is VoiceRuntimeRealtimeAction.NavigateThread &&
        decision !is VoiceRuntimeRealtimePresentationDecision.Navigate ->
        throw VoiceRuntimeFenceException("Realtime action decision kind does not match.")
      action is VoiceRuntimeRealtimeAction.ConfirmationRequired &&
        (decision !is VoiceRuntimeRealtimePresentationDecision.Confirmation ||
          decision.confirmationId != action.confirmationId) ->
        throw VoiceRuntimeFenceException("Realtime confirmation decision is stale.")
    }
    val pending = VoiceRuntimeRealtimePendingAcknowledgement(action, commandId, decision)
    val effect = if (action is VoiceRuntimeRealtimeAction.NavigateThread &&
      (decision as VoiceRuntimeRealtimePresentationDecision.Navigate).outcome ==
      VoiceRuntimeRealtimeActionOutcome.SUCCEEDED) {
      VoiceRuntimeRealtimeEffect.UpdateFocus(
        fence,
        requireSession(state, current),
        "$commandId.focus",
        VoiceRuntimeRealtimeFocus(action.projectId, action.threadId),
        pending,
      )
    } else VoiceRuntimeRealtimeEffect.AcknowledgeAction(
      fence,
      requireSession(state, current),
      action,
      commandId,
      decision,
    )
    VoiceRuntimeRealtimeReduction(state, listOf(effect), result = true)
  }

  fun completeFocus(
    state: VoiceRuntimeRealtimeState,
    effect: VoiceRuntimeRealtimeEffect.UpdateFocus,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeFocusResult>,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, effect.fence, effect.session.state.sessionId)
      ?: return@kernel reduction(state, false)
    if (current.phase in SHUTDOWN_PHASES || result !is VoiceRuntimeRealtimeRemoteResult.Success) {
      return@kernel reduction(state, false)
    }
    val pending = effect.thenAcknowledge ?: return@kernel reduction(state, true)
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(
        VoiceRuntimeRealtimeEffect.AcknowledgeAction(
          effect.fence,
          effect.session,
          pending.action,
          pending.commandId,
          pending.decision,
        ),
      ),
      result = true,
    )
  }

  fun completeAcknowledgement(
    state: VoiceRuntimeRealtimeState,
    effect: VoiceRuntimeRealtimeEffect.AcknowledgeAction,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionAckResult>,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, effect.fence, effect.session.state.sessionId)
      ?: return@kernel reduction(state, false)
    if (current.phase in SHUTDOWN_PHASES || current.pendingAction != effect.action ||
      result !is VoiceRuntimeRealtimeRemoteResult.Success) return@kernel reduction(state, false)
    val next = current.copy(lastActionSequence = effect.action.sequence, pendingAction = null)
    VoiceRuntimeRealtimeReduction(state.copy(checkpoint = next), listOf(persistCheckpoint(next)), result = true)
  }

  fun completeHandoffExchange(
    state: VoiceRuntimeRealtimeState,
    effect: VoiceRuntimeRealtimeEffect.ExchangeHandoff,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHandoffExchangeResult>,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, effect.fence, effect.session.state.sessionId)
      ?: return@kernel reduction(state, false)
    if (current != effect.checkpoint || result !is VoiceRuntimeRealtimeRemoteResult.Success) {
      return@kernel reduction(state, false)
    }
    val exchange = result.value
    if (exchange.projectId != effect.action.projectId || exchange.threadId != effect.action.threadId ||
      exchange.autoRearm != effect.action.autoRearm ||
      exchange.reservation.generation != current.fence.identity.generation + 1) {
      return@kernel beginFailure(state, "handoff-response-mismatch", nowEpochMillis).mapResult { false }
    }
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.PrepareHandoff(effect.fence, current, effect.action, exchange)),
      result = true,
    )
  }

  fun completeHandoffPrepare(
    state: VoiceRuntimeRealtimeState,
    effect: VoiceRuntimeRealtimeEffect.PrepareHandoff,
    prepared: Boolean,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = activeOrNull(state, effect.fence)
    if (!prepared) {
      return@kernel if (current == effect.checkpoint) {
        beginFailure(state, "handoff-admission-failed", nowEpochMillis).mapResult { false }
      } else reduction(state, false)
    }
    if (current != effect.checkpoint) return@kernel VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.RollbackHandoff(effect.exchange)),
      result = false,
    )
    val next = current.copy(
      lastActionSequence = effect.action.sequence,
      pendingHandoffExchange = effect.exchange,
    )
    beginShutdown(
      state.copy(checkpoint = next),
      VoiceRuntimeRealtimeStopPolicy.DRAIN,
      "thread-handoff",
      nowEpochMillis,
    ).prepend(persistCheckpoint(next)).mapResult { true }
  }

  fun setMuted(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    muted: Boolean,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    if (current.phase !in setOf(VoiceRealtimePhase.CUEING, VoiceRealtimePhase.CONNECTED)) {
      return@kernel reduction(state, false)
    }
    VoiceRuntimeRealtimeReduction(
      state,
      listOf(VoiceRuntimeRealtimeEffect.SetMuted(fence, muted)),
      result = true,
    )
  }

  fun completeSetMuted(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    muted: Boolean,
    accepted: Boolean,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel {
    val current = activeOrNull(state, fence) ?: return@kernel reduction(state, Unit)
    if (!accepted) return@kernel reduction(state, Unit)
    val next = current.copy(muted = muted)
    VoiceRuntimeRealtimeReduction(state.copy(checkpoint = next), listOf(persistCheckpoint(next)), result = Unit)
  }

  fun stop(
    state: VoiceRuntimeRealtimeState,
    commandId: String,
    fence: VoiceRuntimeRealtimeFence,
    policy: VoiceRuntimeRealtimeStopPolicy,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeCommandResult> = kernel {
    val fingerprint = "stop:$fence:$policy"
    state.commands.replay(commandId, fingerprint)?.let {
      return@kernel reduction(state, it.withReplay(true))
    }
    if (state.finalization?.fence == fence) {
      return@kernel recorded(
        state,
        commandId,
        fingerprint,
        VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true),
      )
    }
    requireActive(state, fence)
    val shutdown = beginShutdown(state, policy, "user-stop", nowEpochMillis)
    val result = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
    shutdown.mapState { it.copy(commands = it.commands.record(commandId, fingerprint, result)) }
      .mapResult { result }
  }

  fun onDrainDeadline(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    observedAtEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Boolean> = kernel {
    val current = requireActive(state, fence)
    val deadline = current.drainDeadlineAtEpochMillis ?: return@kernel reduction(state, false)
    if (current.phase != VoiceRealtimePhase.DRAINING || observedAtEpochMillis < deadline) {
      return@kernel reduction(state, false)
    }
    finishShutdown(
      state,
      fence,
      if (current.pendingHandoffExchange == null) "agent-stop" else "thread-handoff",
    ).mapResult { true }
  }

  fun completeDrain(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    reason: String,
    @Suppress("UNUSED_PARAMETER") accepted: Boolean,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel { finishShutdown(state, fence, reason) }

  fun completeEndedCue(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    reason: String,
    @Suppress("UNUSED_PARAMETER") accepted: Boolean,
  ): VoiceRuntimeRealtimeReduction<Unit> = kernel { installShutdownFinalization(state, fence, reason) }

  fun reconcileFinalization(
    state: VoiceRuntimeRealtimeState,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> = kernel {
    val current = state.finalization ?: return@kernel VoiceRuntimeRealtimeReduction(
      state,
      outputs = listOf(VoiceRuntimeRealtimeOutput.Finalization(VoiceRuntimeRealtimeFinalizationResult.Idle)),
      result = VoiceRuntimeRealtimeFinalizationResult.Idle,
    )
    if (state.finalizationInFlight) {
      val pending = pendingResult(current, current.lastFailureCode ?: "finalization-in-flight")
      return@kernel VoiceRuntimeRealtimeReduction(
        state,
        outputs = listOf(VoiceRuntimeRealtimeOutput.Finalization(pending)),
        result = pending,
      )
    }
    val pending = pendingResult(current, current.lastFailureCode)
    VoiceRuntimeRealtimeReduction(
      state.copy(finalizationInFlight = true),
      listOf(finalizationEffect(current)),
      result = pending,
    )
  }

  fun completeHandoffCommit(
    state: VoiceRuntimeRealtimeState,
    expected: VoiceRuntimeRealtimeFinalization,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeHandoffCommitResult>,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> = kernel {
    val current = matchingFinalization(state, expected) ?: return@kernel staleFinalization(state)
    if (result is VoiceRuntimeRealtimeRemoteResult.Failure) {
      if (!result.retryable) {
        val next = current.copy(
          stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
          outcome = VoiceRuntimeRealtimeTerminalOutcome.FAILED,
          reason = result.code,
          attemptCount = current.attemptCount + 1,
          lastFailureCode = result.code,
          lastFailureRetryable = false,
        )
        return@kernel advanceFinalization(state, next)
      }
      return@kernel finalizationFailure(state, current, result.code, true)
    }
    advanceFinalization(
      state,
      current.copy(
        stage = VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING,
        lastFailureCode = null,
        lastFailureRetryable = true,
      ),
    )
  }

  fun completeHandoffActivation(
    state: VoiceRuntimeRealtimeState,
    expected: VoiceRuntimeRealtimeFinalization,
    activated: Boolean,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> = kernel {
    val current = matchingFinalization(state, expected) ?: return@kernel staleFinalization(state)
    if (!activated) return@kernel finalizationFailure(state, current, "handoff-activation-failed", true)
    advanceFinalization(
      state,
      current.copy(
        stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
        lastFailureCode = null,
        lastFailureRetryable = true,
      ),
    )
  }

  fun completeSourceClose(
    state: VoiceRuntimeRealtimeState,
    expected: VoiceRuntimeRealtimeFinalization,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeCloseResult>,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> = kernel {
    val current = matchingFinalization(state, expected) ?: return@kernel staleFinalization(state)
    val cleanupPending = result is VoiceRuntimeRealtimeRemoteResult.Failure
    val failed = if (result is VoiceRuntimeRealtimeRemoteResult.Failure) current.copy(
      attemptCount = current.attemptCount + 1,
      lastFailureCode = result.code,
      lastFailureRetryable = result.retryable,
    ) else current
    val summary = terminalSummary(failed, cleanupPending, nowEpochMillis)
    val publication = if (cleanupPending) VoiceRuntimeRealtimeTerminalPublication.CLEANUP_PENDING
    else VoiceRuntimeRealtimeTerminalPublication.CLEANUP_COMPLETE
    val publish = failed.terminalPublication != publication
    if (cleanupPending && (result as VoiceRuntimeRealtimeRemoteResult.Failure).retryable) {
      val next = failed.copy(terminalPublication = publication)
      val pending = pendingResult(next, result.code)
      val outputs = listOfNotNull(
        VoiceRuntimeRealtimeOutput.State(null),
        if (publish) VoiceRuntimeRealtimeOutput.Terminal(summary) else null,
        VoiceRuntimeRealtimeOutput.Finalization(pending),
      )
      return@kernel VoiceRuntimeRealtimeReduction(
        state.copy(
          finalization = next,
          finalizationInFlight = false,
          terminals = if (publish) installTerminal(state.terminals, summary) else state.terminals,
        ),
        listOf(VoiceRuntimeRealtimeEffect.Persist(
          VoiceRuntimeRealtimePersistence.Batch(buildList {
            if (publish) add(VoiceRuntimeRealtimePersistence.PublishTerminal(summary))
            add(VoiceRuntimeRealtimePersistence.SaveFinalization(next))
          }),
          outputs,
        )),
        emptyList(),
        pending,
      )
    }
    val completed = VoiceRuntimeRealtimeFinalizationResult.Completed(summary)
    val outputs = listOfNotNull(
      VoiceRuntimeRealtimeOutput.State(null),
      if (publish) VoiceRuntimeRealtimeOutput.Terminal(summary) else null,
      VoiceRuntimeRealtimeOutput.Finalization(completed),
      VoiceRuntimeRealtimeOutput.ReconcileForeground,
    )
    VoiceRuntimeRealtimeReduction(
      state.copy(
        finalization = null,
        finalizationInFlight = false,
        terminals = if (publish) installTerminal(state.terminals, summary) else state.terminals,
      ),
      listOf(VoiceRuntimeRealtimeEffect.Persist(
        VoiceRuntimeRealtimePersistence.Batch(buildList {
          if (publish) add(VoiceRuntimeRealtimePersistence.PublishTerminal(summary))
          add(VoiceRuntimeRealtimePersistence.ClearFinalization(
            current.fence,
            current.session.state.sessionId,
          ))
        }),
        outputs,
      )),
      emptyList(),
      completed,
    )
  }

  fun recoverInterrupted(
    state: VoiceRuntimeRealtimeState,
    currentIdentity: VoiceRuntimeIdentity,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeTerminalSummary?> = kernel {
    if (state.finalization != null) {
      val reconciled = reconcileFinalization(state)
      return@kernel VoiceRuntimeRealtimeReduction(
        reconciled.state,
        reconciled.effects,
        reconciled.outputs,
        null,
      )
    }
    val stale = state.checkpoint ?: return@kernel reduction(state, null)
    if (stale.fence.identity == currentIdentity && stale.pendingHandoffExchange == null &&
      stale.phase !in SHUTDOWN_PHASES) return@kernel reduction(state, null)
    val stopping = stale.copy(phase = VoiceRealtimePhase.STOPPING, drainDeadlineAtEpochMillis = null)
    val session = restoredSession(stopping)
    if (session == null) {
      val terminal = terminalForCheckpoint(stopping, VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
        "process-restarted", false, nowEpochMillis)
      return@kernel VoiceRuntimeRealtimeReduction(
        state.copy(checkpoint = null, terminals = installTerminal(state.terminals, terminal)),
        listOf(
          VoiceRuntimeRealtimeEffect.ClosePeer(stopping.fence),
          terminalPersistence(terminal, stopping.fence),
        ),
        emptyList(),
        terminal,
      )
    }
    val finalization = newFinalization(
      stopping,
      session,
      if (stopping.pendingHandoffExchange == null) VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED
      else VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
      if (stopping.pendingHandoffExchange == null) "process-restarted" else "thread-handoff-recovered",
      "${stopping.rootCommandId}.recover-close",
    )
    VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = null, serverSession = null, finalization = finalization, finalizationInFlight = true),
      listOf(
        VoiceRuntimeRealtimeEffect.ClosePeer(stopping.fence),
        VoiceRuntimeRealtimeEffect.Persist(
          VoiceRuntimeRealtimePersistence.InstallFinalization(stale, finalization),
          listOf(VoiceRuntimeRealtimeOutput.FinalizationInstalled(finalization)),
          listOf(finalizationEffect(finalization)),
        ),
      ),
      result = null,
    )
  }

  private fun beginShutdown(
    state: VoiceRuntimeRealtimeState,
    policy: VoiceRuntimeRealtimeStopPolicy,
    reason: String,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> {
    val current = requireNotNull(state.checkpoint)
    if (current.phase in SHUTDOWN_PHASES) return reduction(state, Unit)
    if (current.serverSessionId == null) {
      val cancelled = current.copy(phase = VoiceRealtimePhase.CANCELLED)
      val terminal = terminalForCheckpoint(
        cancelled,
        VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
        reason,
        false,
        nowEpochMillis,
      )
      return VoiceRuntimeRealtimeReduction(
        state.copy(
          checkpoint = null,
          pendingStart = state.pendingStart?.copy(cancelled = true),
          terminals = installTerminal(state.terminals, terminal),
        ),
        listOf(
          VoiceRuntimeRealtimeEffect.SetInputReady(current.fence, false),
          VoiceRuntimeRealtimeEffect.ClosePeer(current.fence),
          terminalPersistence(terminal, current.fence),
        ),
        emptyList(),
        Unit,
      )
    }
    if (policy == VoiceRuntimeRealtimeStopPolicy.DRAIN) {
      val next = current.copy(
        phase = VoiceRealtimePhase.DRAINING,
        drainDeadlineAtEpochMillis = nowEpochMillis + drainTimeoutMillis,
      )
      return VoiceRuntimeRealtimeReduction(
        state.copy(checkpoint = next),
        listOf(
          VoiceRuntimeRealtimeEffect.SetInputReady(current.fence, false),
          persistCheckpoint(next),
          VoiceRuntimeRealtimeEffect.Drain(current.fence, reason),
        ),
        result = Unit,
      )
    }
    return finishShutdown(state, current.fence, reason).prepend(
      VoiceRuntimeRealtimeEffect.SetInputReady(current.fence, false),
    )
  }

  private fun finishShutdown(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    reason: String,
  ): VoiceRuntimeRealtimeReduction<Unit> {
    val current = activeOrNull(state, fence) ?: return reduction(state, Unit)
    if (current.phase == VoiceRealtimePhase.STOPPING) return reduction(state, Unit)
    val next = current.copy(phase = VoiceRealtimePhase.STOPPING, drainDeadlineAtEpochMillis = null)
    val effect = if (current.lastConnectedAtEpochMillis != null) {
      VoiceRuntimeRealtimeEffect.CueEnded(fence, reason)
    } else null
    return if (effect != null) VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = next),
      listOf(persistCheckpoint(next), VoiceRuntimeRealtimeEffect.ClosePeer(fence), effect),
      result = Unit,
    ) else installShutdownFinalization(state.copy(checkpoint = next), fence, reason)
      .prepend(persistCheckpoint(next), VoiceRuntimeRealtimeEffect.ClosePeer(fence))
  }

  private fun installShutdownFinalization(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    reason: String,
  ): VoiceRuntimeRealtimeReduction<Unit> {
    val current = activeOrNull(state, fence) ?: return reduction(state, Unit)
    if (current.phase != VoiceRealtimePhase.STOPPING) return reduction(state, Unit)
    val finalization = newFinalization(
      current,
      requireSession(state, current),
      if (current.pendingHandoffExchange != null) VoiceRuntimeRealtimeTerminalOutcome.COMPLETED
      else VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
      reason,
      "${current.rootCommandId}.close.$reason",
    )
    return VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = null, serverSession = null, finalization = finalization, finalizationInFlight = true),
      listOf(VoiceRuntimeRealtimeEffect.Persist(
        VoiceRuntimeRealtimePersistence.InstallFinalization(current, finalization),
        listOf(VoiceRuntimeRealtimeOutput.FinalizationInstalled(finalization)),
        listOf(finalizationEffect(finalization)),
      )),
      result = Unit,
    )
  }

  private fun beginFailure(
    state: VoiceRuntimeRealtimeState,
    code: String,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> {
    val current = state.checkpoint ?: return reduction(state, Unit)
    if (current.phase in SHUTDOWN_PHASES) return reduction(state, Unit)
    val session = state.serverSession ?: restoredSession(current)
    if (session == null) return failWithoutSession(state, current, code, nowEpochMillis)
    val failed = current.copy(phase = VoiceRealtimePhase.FAILED)
    val finalization = newFinalization(failed, session, VoiceRuntimeRealtimeTerminalOutcome.FAILED,
      code, "${current.rootCommandId}.close.failure")
    return VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = null, serverSession = null, finalization = finalization, finalizationInFlight = true),
      listOf(
        VoiceRuntimeRealtimeEffect.SetInputReady(current.fence, false),
        VoiceRuntimeRealtimeEffect.ClosePeer(current.fence),
        VoiceRuntimeRealtimeEffect.Persist(
          VoiceRuntimeRealtimePersistence.InstallFinalization(current, finalization),
          listOf(VoiceRuntimeRealtimeOutput.FinalizationInstalled(finalization)),
          listOf(finalizationEffect(finalization)),
        ),
      ),
      result = Unit,
    )
  }

  private fun beginFailureIfCurrent(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    code: String,
    nowEpochMillis: Long,
  ) = if (activeOrNull(state, fence, sessionId) == null) reduction(state, Unit)
  else beginFailure(state, code, nowEpochMillis)

  private fun failWithoutSession(
    state: VoiceRuntimeRealtimeState,
    current: VoiceRuntimeRealtimeCheckpoint,
    code: String,
    nowEpochMillis: Long,
  ): VoiceRuntimeRealtimeReduction<Unit> {
    val failed = current.copy(phase = VoiceRealtimePhase.FAILED)
    val terminal = terminalForCheckpoint(
      failed,
      VoiceRuntimeRealtimeTerminalOutcome.FAILED,
      code,
      false,
      nowEpochMillis,
    )
    return VoiceRuntimeRealtimeReduction(
      state.copy(checkpoint = null, serverSession = null, terminals = installTerminal(state.terminals, terminal)),
      listOf(
        VoiceRuntimeRealtimeEffect.SetInputReady(current.fence, false),
        VoiceRuntimeRealtimeEffect.ClosePeer(current.fence),
        terminalPersistence(terminal, current.fence),
      ),
      emptyList(),
      Unit,
    )
  }

  private fun advanceFinalization(
    state: VoiceRuntimeRealtimeState,
    next: VoiceRuntimeRealtimeFinalization,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> {
    val pending = pendingResult(next, next.lastFailureCode)
    return VoiceRuntimeRealtimeReduction(
      state.copy(finalization = next, finalizationInFlight = true),
      listOf(VoiceRuntimeRealtimeEffect.Persist(
        VoiceRuntimeRealtimePersistence.SaveFinalization(next),
        effects = listOf(finalizationEffect(next)),
      )),
      result = pending,
    )
  }

  private fun finalizationFailure(
    state: VoiceRuntimeRealtimeState,
    current: VoiceRuntimeRealtimeFinalization,
    code: String,
    retryable: Boolean,
  ): VoiceRuntimeRealtimeReduction<VoiceRuntimeRealtimeFinalizationResult> {
    val failed = current.copy(
      attemptCount = current.attemptCount + 1,
      lastFailureCode = code,
      lastFailureRetryable = retryable,
    )
    val pending = pendingResult(failed, code)
    return VoiceRuntimeRealtimeReduction(
      state.copy(finalization = failed, finalizationInFlight = false),
      listOf(VoiceRuntimeRealtimeEffect.Persist(
        VoiceRuntimeRealtimePersistence.SaveFinalization(failed),
        listOf(VoiceRuntimeRealtimeOutput.Finalization(pending)),
      )),
      emptyList(),
      pending,
    )
  }

  private fun staleFinalization(state: VoiceRuntimeRealtimeState) = VoiceRuntimeRealtimeReduction(
    state,
    result = VoiceRuntimeRealtimeFinalizationResult.Idle as VoiceRuntimeRealtimeFinalizationResult,
  )

  private fun matchingFinalization(
    state: VoiceRuntimeRealtimeState,
    expected: VoiceRuntimeRealtimeFinalization,
  ) = state.finalization?.takeIf {
    it.fence == expected.fence && it.session.state.sessionId == expected.session.state.sessionId &&
      it.stage == expected.stage
  }

  private fun finalizationEffect(finalization: VoiceRuntimeRealtimeFinalization) =
    when (finalization.stage) {
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING ->
        VoiceRuntimeRealtimeEffect.CommitHandoff(finalization)
      VoiceRuntimeRealtimeFinalizationStage.HANDOFF_ACTIVATION_PENDING ->
        VoiceRuntimeRealtimeEffect.ActivateHandoff(finalization)
      VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING ->
        VoiceRuntimeRealtimeEffect.CloseServer(finalization)
    }

  private fun pendingResult(finalization: VoiceRuntimeRealtimeFinalization, code: String?) =
    VoiceRuntimeRealtimeFinalizationResult.Pending(
      finalization.stage,
      finalization.attemptCount,
      finalization.lastFailureRetryable,
      code,
    )

  private fun newFinalization(
    current: VoiceRuntimeRealtimeCheckpoint,
    session: VoiceRuntimeRealtimeStartResult,
    outcome: VoiceRuntimeRealtimeTerminalOutcome,
    reason: String,
    closeOperationId: String,
  ) = VoiceRuntimeRealtimeFinalization(
    fence = current.fence,
    sourceTarget = current.target,
    sourceEnvironmentOrigin = authority.environmentOrigin,
    rootCommandId = current.rootCommandId,
    session = session,
    closeOperationId = closeOperationId,
    outcome = outcome,
    reason = reason,
    lastConnectedAtEpochMillis = current.lastConnectedAtEpochMillis,
    handoffExchange = current.pendingHandoffExchange,
    stage = if (current.pendingHandoffExchange == null) {
      VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING
    } else VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
  )

  private fun cancelledStartFinalization(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    rootCommandId: String,
    session: VoiceRuntimeRealtimeStartResult,
  ) = VoiceRuntimeRealtimeFinalization(
    fence = fence,
    sourceTarget = authority.target,
    sourceEnvironmentOrigin = authority.environmentOrigin,
    rootCommandId = rootCommandId,
    session = session,
    closeOperationId = "$rootCommandId.close.cancelled",
    outcome = VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
    reason = "user-stop",
    lastConnectedAtEpochMillis = null,
    handoffExchange = null,
    stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
    terminalPublication = state.terminals.firstOrNull {
      it.identity == fence.identity && it.modeSessionId == fence.modeSessionId
    }?.let {
      if (it.serverCleanupPending) VoiceRuntimeRealtimeTerminalPublication.CLEANUP_PENDING
      else VoiceRuntimeRealtimeTerminalPublication.CLEANUP_COMPLETE
    } ?: VoiceRuntimeRealtimeTerminalPublication.NONE,
  )

  private fun terminalSummary(
    finalization: VoiceRuntimeRealtimeFinalization,
    cleanupPending: Boolean,
    nowEpochMillis: Long,
  ) = VoiceRuntimeRealtimeTerminalSummary(
    identity = finalization.fence.identity,
    modeSessionId = finalization.fence.modeSessionId,
    environmentId = finalization.sourceTarget.environmentId,
    conversationId = finalization.sourceTarget.conversationId,
    sessionId = finalization.session.state.sessionId,
    outcome = finalization.outcome,
    reason = finalization.reason,
    lastConnectedAtEpochMillis = finalization.lastConnectedAtEpochMillis,
    terminalAtEpochMillis = nowEpochMillis,
    serverCleanupPending = cleanupPending,
    expiresAtEpochMillis = nowEpochMillis + terminalRetentionMillis,
  )

  private fun terminalForCheckpoint(
    checkpoint: VoiceRuntimeRealtimeCheckpoint,
    outcome: VoiceRuntimeRealtimeTerminalOutcome,
    reason: String,
    cleanupPending: Boolean,
    nowEpochMillis: Long,
  ) = VoiceRuntimeRealtimeTerminalSummary(
    identity = checkpoint.fence.identity,
    modeSessionId = checkpoint.fence.modeSessionId,
    environmentId = checkpoint.target.environmentId,
    conversationId = checkpoint.target.conversationId,
    sessionId = checkpoint.serverSessionId,
    outcome = outcome,
    reason = reason,
    lastConnectedAtEpochMillis = checkpoint.lastConnectedAtEpochMillis,
    terminalAtEpochMillis = nowEpochMillis,
    serverCleanupPending = cleanupPending,
    expiresAtEpochMillis = nowEpochMillis + terminalRetentionMillis,
  )

  private fun persistCheckpoint(
    checkpoint: VoiceRuntimeRealtimeCheckpoint,
    effects: List<VoiceRuntimeRealtimeEffect> = emptyList(),
  ) =
    VoiceRuntimeRealtimeEffect.Persist(
      VoiceRuntimeRealtimePersistence.SaveCheckpoint(checkpoint),
      listOf(VoiceRuntimeRealtimeOutput.State(checkpoint)),
      effects,
    )

  private fun terminalPersistence(
    summary: VoiceRuntimeRealtimeTerminalSummary,
    fence: VoiceRuntimeRealtimeFence,
  ) = VoiceRuntimeRealtimeEffect.Persist(
    VoiceRuntimeRealtimePersistence.Batch(listOf(
      VoiceRuntimeRealtimePersistence.PublishTerminal(summary),
      VoiceRuntimeRealtimePersistence.ClearCheckpoint(fence),
    )),
    listOf(
      VoiceRuntimeRealtimeOutput.Terminal(summary),
      VoiceRuntimeRealtimeOutput.State(null),
    ),
  )

  private fun installTerminal(
    terminals: List<VoiceRuntimeRealtimeTerminalSummary>,
    summary: VoiceRuntimeRealtimeTerminalSummary,
  ) = terminals.filter {
    it.expiresAtEpochMillis > summary.terminalAtEpochMillis &&
      !(it.identity.runtimeId == summary.identity.runtimeId && it.modeSessionId == summary.modeSessionId)
  } + summary

  private fun pruneTerminals(
    terminals: List<VoiceRuntimeRealtimeTerminalSummary>,
    nowEpochMillis: Long,
  ) = terminals.filter { it.expiresAtEpochMillis > nowEpochMillis }

  private fun requireSession(
    state: VoiceRuntimeRealtimeState,
    current: VoiceRuntimeRealtimeCheckpoint,
  ) = state.serverSession ?: restoredSession(current)
    ?: throw VoiceRuntimeFenceException("Realtime server session is unavailable.")

  private fun restoredSession(current: VoiceRuntimeRealtimeCheckpoint): VoiceRuntimeRealtimeStartResult? {
    val sessionId = current.serverSessionId ?: return null
    val lease = current.leaseGeneration ?: return null
    val expiresAt = current.expiresAtEpochMillis ?: return null
    val heartbeat = current.heartbeatIntervalSeconds ?: return null
    return VoiceRuntimeRealtimeStartResult(
      VoiceRuntimeRealtimeSessionState(
        sessionId,
        current.target.conversationId,
        "signaling",
        lease,
        current.lastActionSequence,
      ),
      "/api/voice/runtime/realtime-sessions/$sessionId/webrtc-offer",
      expiresAt,
      heartbeat,
    )
  }

  private fun validStart(
    result: VoiceRuntimeRealtimeStartResult,
    fence: VoiceRuntimeRealtimeFence,
    nowEpochMillis: Long,
  ) = result.state.conversationId == authority.target.conversationId &&
    result.state.phase == "signaling" && result.state.leaseGeneration > 0 &&
    result.expiresAtEpochMillis > nowEpochMillis && result.heartbeatIntervalSeconds > 0 &&
    fence.identity == authority.identity

  private fun requireActive(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String? = null,
  ): VoiceRuntimeRealtimeCheckpoint {
    requireFence(fence)
    return activeOrNull(state, fence, sessionId)
      ?: throw VoiceRuntimeFenceException("Realtime callback fence is stale.")
  }

  private fun activeOrNull(
    state: VoiceRuntimeRealtimeState,
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String? = null,
  ) = state.checkpoint?.takeIf {
    it.fence == fence && (sessionId == null || it.serverSessionId == sessionId)
  }

  private fun requireFence(fence: VoiceRuntimeRealtimeFence) {
    if (fence.identity != authority.identity || fence.modeSessionId.isBlank()) {
      throw VoiceRuntimeFenceException("Realtime runtime fence is stale.")
    }
  }

  private fun rejected(reason: String) = VoiceRuntimeRealtimeCommandResult.Rejected(reason)

  private fun <T> reduction(state: VoiceRuntimeRealtimeState, result: T) =
    VoiceRuntimeRealtimeReduction(state, result = result)

  private fun recorded(
    state: VoiceRuntimeRealtimeState,
    commandId: String,
    fingerprint: String,
    result: VoiceRuntimeRealtimeCommandResult,
    effects: List<VoiceRuntimeRealtimeEffect> = emptyList(),
  ) = VoiceRuntimeRealtimeReduction(
    state.copy(commands = state.commands.record(commandId, fingerprint, result)),
    effects,
    result = result,
  )

  private inline fun <T> kernel(block: () -> VoiceRuntimeRealtimeReduction<T>):
    VoiceRuntimeRealtimeReduction<T> {
    assertKernelThread()
    return block()
  }

  private fun VoiceRealtimePhase.isTerminal() = this in setOf(
    VoiceRealtimePhase.COMPLETED,
    VoiceRealtimePhase.FAILED,
    VoiceRealtimePhase.CANCELLED,
  )

  private fun <T, R> VoiceRuntimeRealtimeReduction<T>.mapResult(transform: (T) -> R) =
    VoiceRuntimeRealtimeReduction(state, effects, outputs, transform(result))

  private fun <T> VoiceRuntimeRealtimeReduction<T>.mapState(
    transform: (VoiceRuntimeRealtimeState) -> VoiceRuntimeRealtimeState,
  ) = copy(state = transform(state))

  private fun <T> VoiceRuntimeRealtimeReduction<T>.prepend(
    vararg effects: VoiceRuntimeRealtimeEffect,
  ) = copy(effects = effects.toList() + this.effects)

  private companion object {
    const val MAXIMUM_TERMINALS = 64
    val SHUTDOWN_PHASES = setOf(
      VoiceRealtimePhase.DRAINING,
      VoiceRealtimePhase.STOPPING,
      VoiceRealtimePhase.COMPLETED,
      VoiceRealtimePhase.FAILED,
      VoiceRealtimePhase.CANCELLED,
    )
  }
}

internal sealed interface VoiceRuntimeRealtimeCommandResult {
  data class Accepted(val adopted: Boolean, val replayed: Boolean = false) :
    VoiceRuntimeRealtimeCommandResult
  data class Rejected(val reason: String, val replayed: Boolean = false) :
    VoiceRuntimeRealtimeCommandResult

  fun withReplay(replayed: Boolean): VoiceRuntimeRealtimeCommandResult = when (this) {
    is Accepted -> copy(replayed = replayed)
    is Rejected -> copy(replayed = replayed)
  }
}
