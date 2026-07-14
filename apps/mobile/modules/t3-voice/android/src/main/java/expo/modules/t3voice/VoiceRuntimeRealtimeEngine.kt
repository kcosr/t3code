package expo.modules.t3voice

internal data class VoiceRuntimeRealtimeAuthority(
  val identity: VoiceRuntimeIdentity,
  val target: VoiceRuntimeTarget.Realtime,
  val environmentOrigin: String,
  val runtimeToken: String,
  val expiresAtEpochMillis: Long,
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
  val controlGrant: VoiceRuntimeRealtimeControlGrant? = null,
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
    require((serverSessionId == null) == (controlGrant == null))
  }
}

internal interface VoiceRuntimeRealtimeCheckpointRepository {
  fun load(): VoiceRuntimeRealtimeCheckpoint?
  fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint)
  fun clear(fence: VoiceRuntimeRealtimeFence)
  fun publishTerminal(summary: VoiceRuntimeRealtimeTerminalSummary)
  fun terminals(nowEpochMillis: Long): List<VoiceRuntimeRealtimeTerminalSummary>
  fun acknowledgeTerminal(key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal): Boolean
}

internal class VoiceRuntimeMemoryRealtimeCheckpointRepository :
  VoiceRuntimeRealtimeCheckpointRepository {
  private var checkpoint: VoiceRuntimeRealtimeCheckpoint? = null
  private val terminalValues = mutableListOf<VoiceRuntimeRealtimeTerminalSummary>()

  override fun load() = checkpoint

  override fun save(checkpoint: VoiceRuntimeRealtimeCheckpoint) {
    this.checkpoint = checkpoint
  }

  override fun clear(fence: VoiceRuntimeRealtimeFence) {
    if (checkpoint?.fence == fence) checkpoint = null
  }

  override fun publishTerminal(summary: VoiceRuntimeRealtimeTerminalSummary) {
    terminalValues.removeAll {
      it.identity.runtimeId == summary.identity.runtimeId && it.modeSessionId == summary.modeSessionId
    }
    terminalValues += summary
  }

  override fun terminals(nowEpochMillis: Long): List<VoiceRuntimeRealtimeTerminalSummary> {
    terminalValues.removeAll { it.expiresAtEpochMillis <= nowEpochMillis }
    return terminalValues.toList()
  }

  override fun acknowledgeTerminal(key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal): Boolean =
    terminalValues.removeAll { it.identity == key.identity && it.modeSessionId == key.modeSessionId }
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

  fun activate(result: VoiceRuntimeRealtimeHandoffExchangeResult): Boolean
}

internal fun interface VoiceRuntimeRealtimePresentationSink {
  fun publish(action: VoiceRuntimeRealtimeAction)
}

internal fun interface VoiceRuntimeRealtimeStateSink {
  fun publish(checkpoint: VoiceRuntimeRealtimeCheckpoint?)
}

internal fun interface VoiceRuntimeRealtimeTerminalSink {
  fun publish(summary: VoiceRuntimeRealtimeTerminalSummary)
}

internal fun interface VoiceRuntimeRealtimeRemoteDispatcher {
  fun dispatch(block: () -> Unit)
}

internal class VoiceRuntimeRealtimeEngine(
  private val authority: VoiceRuntimeRealtimeAuthority,
  private val now: () -> Long,
  private val server: VoiceRuntimeRealtimeServer,
  private val peer: VoiceRuntimeRealtimePeer,
  private val cues: VoiceRuntimeRealtimeCues,
  private val handoff: VoiceRuntimeRealtimeHandoffCoordinator,
  private val presentation: VoiceRuntimeRealtimePresentationSink,
  private val repository: VoiceRuntimeRealtimeCheckpointRepository,
  private val stateSink: VoiceRuntimeRealtimeStateSink = VoiceRuntimeRealtimeStateSink {},
  private val terminalSink: VoiceRuntimeRealtimeTerminalSink = VoiceRuntimeRealtimeTerminalSink {},
  private val remoteDispatcher: VoiceRuntimeRealtimeRemoteDispatcher =
    VoiceRuntimeRealtimeRemoteDispatcher { it() },
  private val drainTimeoutMillis: Long = 2_500,
  private val terminalRetentionMillis: Long = 30L * 24 * 60 * 60 * 1_000,
) {
  @Volatile
  private var checkpoint = repository.load()
  private var serverSession: VoiceRuntimeRealtimeStartResult? = null
  private var pendingStart: PendingStart? = null
  private val commands = VoiceRuntimeIdempotencyLedger<VoiceRuntimeRealtimeCommandResult>(256)

  init {
    require(drainTimeoutMillis > 0)
    require(terminalRetentionMillis > 0)
  }

  fun snapshot(): VoiceRuntimeRealtimeCheckpoint? = checkpoint

  fun start(
    commandId: String,
    fence: VoiceRuntimeRealtimeFence,
  ): VoiceRuntimeRealtimeCommandResult {
    val fingerprint = "start:$fence"
    synchronized(this) {
      commands.replay(commandId, fingerprint)?.let { return it.withReplay(true) }
      requireFence(fence)
      pendingStart?.let { pending ->
        if (pending.commandId == commandId) {
          if (pending.fingerprint != fingerprint) throw VoiceRuntimeIdempotencyConflictException()
          return if (pending.cancelled) {
            VoiceRuntimeRealtimeCommandResult.Rejected("start-cancelled")
          } else {
            VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true)
          }
        }
        return recordCommand(
          commandId,
          fingerprint,
          VoiceRuntimeRealtimeCommandResult.Rejected("owner-conflict"),
        )
      }
      if (authority.expiresAtEpochMillis <= now()) {
        return recordCommand(
          commandId,
          fingerprint,
          VoiceRuntimeRealtimeCommandResult.Rejected("authority-expired"),
        )
      }
      val current = checkpoint
      if (current != null) {
        if (current.rootCommandId == commandId && current.fence != fence) {
          throw VoiceRuntimeIdempotencyConflictException()
        }
        if (current.rootCommandId == commandId && current.phase == VoiceRealtimePhase.PREPARING) {
          return VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true)
        }
        return recordCommand(
          commandId,
          fingerprint,
          if (current.fence == fence && !current.phase.isTerminal()) {
            VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true)
          } else {
            VoiceRuntimeRealtimeCommandResult.Rejected("owner-conflict")
          },
        )
      }
      update(
        VoiceRuntimeRealtimeCheckpoint(
          fence = fence,
          target = authority.target,
          rootCommandId = commandId,
          phase = VoiceRealtimePhase.PREPARING,
        ),
      )
      pendingStart = PendingStart(commandId, fingerprint, fence)
    }
    val remote = server.start(authority, fence, commandId)
    val outcome = synchronized(this) {
      val current = checkpoint?.takeIf {
        it.fence == fence && it.rootCommandId == commandId && it.phase == VoiceRealtimePhase.PREPARING
      }
      if (current == null) return@synchronized StartCompletion.Stale
      StartCompletion.Current(completeStartLocked(fence, remote))
    }
    var cleanupFailedSession: VoiceRuntimeRealtimeStartResult? = null
    if (outcome is StartCompletion.Stale && remote is VoiceRuntimeRealtimeRemoteResult.Success) {
      val closed = server.close(
        authority,
        fence,
        remote.value,
        "$commandId.close.cancelled",
      ) is VoiceRuntimeRealtimeRemoteResult.Success
      if (!closed) cleanupFailedSession = remote.value
    }
    val result = when (outcome) {
      is StartCompletion.Current -> outcome.result
      StartCompletion.Stale -> VoiceRuntimeRealtimeCommandResult.Rejected("start-cancelled")
    }
    return synchronized(this) {
      if (cleanupFailedSession != null) publishCancelledStartCleanupFailure(fence, cleanupFailedSession)
      pendingStart = null
      recordCommand(commandId, fingerprint, result)
    }
  }

  @Synchronized
  fun onPeerConnected(fence: VoiceRuntimeRealtimeFence, sessionId: String) {
    val current = requireActive(fence, sessionId)
    if (current.phase != VoiceRealtimePhase.NEGOTIATING) return
    update(current.copy(phase = VoiceRealtimePhase.CUEING))
    val completed = { completeReadyCue(fence, sessionId) }
    if (!cues.ready(fence.identity.generation, completed)) completed()
  }

  @Synchronized
  fun onPeerTerminated(
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    failureCode: String,
  ) {
    val current = runCatching { requireActive(fence, sessionId) }.getOrNull() ?: return
    if (current.phase in SHUTDOWN_PHASES) return
    fail(failureCode)
  }

  fun heartbeat(fence: VoiceRuntimeRealtimeFence): Boolean {
    val session = synchronized(this) {
      val current = requireActive(fence)
      requireSession(current)
    }
    val result = server.heartbeat(authority, fence, session)
    return synchronized(this) {
      val current = runCatching { requireActive(fence, session.state.sessionId) }
        .getOrNull() ?: return@synchronized false
      if (current.phase in SHUTDOWN_PHASES) return@synchronized false
      if (current.phase !in setOf(VoiceRealtimePhase.CONNECTED, VoiceRealtimePhase.RETRYING)) {
        return@synchronized false
      }
      when (result) {
        is VoiceRuntimeRealtimeRemoteResult.Failure -> {
          update(current.copy(phase = VoiceRealtimePhase.RETRYING))
          false
        }
        is VoiceRuntimeRealtimeRemoteResult.Success -> {
          if (result.value.disposition == "terminal") {
            beginShutdown(VoiceRuntimeRealtimeStopPolicy.IMMEDIATE, "remote-terminal")
          } else if (current.phase == VoiceRealtimePhase.RETRYING) {
            update(current.copy(phase = VoiceRealtimePhase.CONNECTED))
          }
          true
        }
      }
    }
  }

  fun pollActions(fence: VoiceRuntimeRealtimeFence, waitMilliseconds: Long = 25_000): Boolean {
    val request = synchronized(this) {
      val current = requireActive(fence)
      if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES) return true
      ActionPollRequest(requireSession(current), current.lastActionSequence)
    }
    val result = server.actions(
      authority,
      fence,
      request.session,
      request.afterSequence,
      waitMilliseconds,
    )
    val completion = synchronized(this) {
      val current = runCatching { requireActive(fence, request.session.state.sessionId) }
        .getOrNull() ?: return@synchronized ActionPollCompletion.Immediate(false)
      if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES) {
        return@synchronized ActionPollCompletion.Immediate(true)
      }
      when (result) {
        is VoiceRuntimeRealtimeRemoteResult.Failure -> ActionPollCompletion.Immediate(false)
        is VoiceRuntimeRealtimeRemoteResult.Success -> {
          val action = result.value.actions.firstOrNull {
            it.sequence > current.lastActionSequence
          } ?: return@synchronized ActionPollCompletion.Immediate(true)
          if (result.value.actions.zipWithNext().any { (left, right) -> left.sequence >= right.sequence }) {
            fail("action-order-invalid")
            return@synchronized ActionPollCompletion.Immediate(false)
          }
          if (action is VoiceRuntimeRealtimeAction.HandoffToThreadVoice) {
            ActionPollCompletion.Handoff(action)
          } else {
            ActionPollCompletion.Immediate(consumeAction(action))
          }
        }
      }
    }
    return when (completion) {
      is ActionPollCompletion.Immediate -> completion.result
      is ActionPollCompletion.Handoff -> consumeHandoff(fence, completion.action)
    }
  }

  fun acknowledgePresentationAction(
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    actionId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): Boolean {
    val request = synchronized(this) {
      val current = requireActive(fence)
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
      ActionAcknowledgementRequest(requireSession(current), action)
    }
    if (request.action is VoiceRuntimeRealtimeAction.NavigateThread &&
      (decision as VoiceRuntimeRealtimePresentationDecision.Navigate).outcome ==
        VoiceRuntimeRealtimeActionOutcome.SUCCEEDED) {
      val focused = server.updateFocus(
        authority,
        fence,
        request.session,
        "$commandId.focus",
        VoiceRuntimeRealtimeFocus(request.action.projectId, request.action.threadId),
      )
      if (focused !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    }
    val acknowledged = server.acknowledgeAction(
      authority,
      fence,
      request.session,
      request.action,
      commandId,
      decision,
    )
    if (acknowledged !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    return synchronized(this) {
      val current = runCatching { requireActive(fence, request.session.state.sessionId) }
        .getOrNull() ?: return@synchronized false
      if (current.phase in SHUTDOWN_PHASES || current.pendingAction != request.action) {
        return@synchronized false
      }
      update(current.copy(lastActionSequence = request.action.sequence, pendingAction = null))
      true
    }
  }

  fun updateFocus(
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    focus: VoiceRuntimeRealtimeFocus?,
  ): Boolean {
    val session = synchronized(this) {
      val current = requireActive(fence)
      requireSession(current)
    }
    val result = server.updateFocus(
      authority,
      fence,
      session,
      commandId,
      focus,
    )
    return synchronized(this) {
      val current = runCatching { requireActive(fence, session.state.sessionId) }
        .getOrNull() ?: return@synchronized false
      current.phase !in SHUTDOWN_PHASES && result is VoiceRuntimeRealtimeRemoteResult.Success
    }
  }

  @Synchronized
  fun setMuted(fence: VoiceRuntimeRealtimeFence, muted: Boolean): Boolean {
    val current = requireActive(fence)
    if (current.phase !in setOf(VoiceRealtimePhase.CUEING, VoiceRealtimePhase.CONNECTED)) return false
    if (!peer.setMuted(fence.modeSessionId, muted)) return false
    update(current.copy(muted = muted))
    return true
  }

  @Synchronized
  fun stop(
    commandId: String,
    fence: VoiceRuntimeRealtimeFence,
    policy: VoiceRuntimeRealtimeStopPolicy,
  ): VoiceRuntimeRealtimeCommandResult = commands.resolve(commandId, "stop:$fence:$policy") {
    requireActive(fence)
    beginShutdown(policy, "user-stop")
    VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
  }.let { (result, replayed) -> result.withReplay(replayed) }

  @Synchronized
  fun onDrainDeadline(fence: VoiceRuntimeRealtimeFence, observedAtEpochMillis: Long = now()): Boolean {
    val current = requireActive(fence)
    val deadline = current.drainDeadlineAtEpochMillis ?: return false
    if (current.phase != VoiceRealtimePhase.DRAINING || observedAtEpochMillis < deadline) return false
    finishShutdown(fence, if (current.pendingHandoffExchange == null) "agent-stop" else "thread-handoff")
    return true
  }

  fun recoverInterrupted(currentIdentity: VoiceRuntimeIdentity): VoiceRuntimeRealtimeTerminalSummary? {
    val request = synchronized(this) {
      val stale = checkpoint ?: return null
      if (stale.fence.identity == currentIdentity && stale.pendingHandoffExchange == null) return null
      val exchange = stale.pendingHandoffExchange
      val recovering = if (exchange == null) stale else stale.copy(
        phase = VoiceRealtimePhase.STOPPING,
        drainDeadlineAtEpochMillis = null,
      ).also(::update)
      RecoveryRequest(
        recovering,
        restoredSession(stale),
        exchange,
        authority.copy(identity = stale.fence.identity),
      )
    }
    peer.close(request.checkpoint.fence.modeSessionId)
    val committed = request.exchange == null || (request.session != null &&
      server.commitHandoff(
        request.authority,
        request.checkpoint.fence,
        request.session,
        request.exchange,
      )
        is VoiceRuntimeRealtimeRemoteResult.Success)
    if (!committed) return null
    val cleaned = request.session == null || server.close(
      request.authority,
      request.checkpoint.fence,
      request.session,
      "${request.checkpoint.rootCommandId}.recover-close",
    ) is VoiceRuntimeRealtimeRemoteResult.Success
    val activated = request.exchange == null || handoff.activate(request.exchange)
    if (request.exchange != null && !activated) return null
    return synchronized(this) {
      val latest = checkpoint?.takeIf { it.fence == request.checkpoint.fence } ?: return@synchronized null
      terminal(
        latest,
        if (request.exchange != null) VoiceRuntimeRealtimeTerminalOutcome.COMPLETED
        else VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
        if (request.exchange != null) "thread-handoff-recovered" else "process-restarted",
        !cleaned,
      )
    }
  }

  private fun completeStartLocked(
    fence: VoiceRuntimeRealtimeFence,
    result: VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeStartResult>,
  ): VoiceRuntimeRealtimeCommandResult = when (result) {
    is VoiceRuntimeRealtimeRemoteResult.Failure -> {
      fail(result.code)
      VoiceRuntimeRealtimeCommandResult.Rejected(result.code)
    }
    is VoiceRuntimeRealtimeRemoteResult.Success -> {
      if (!validStart(result.value, fence)) {
        serverSession = result.value
        update(
          requireCheckpoint().copy(
            serverSessionId = result.value.state.sessionId,
            leaseGeneration = result.value.state.leaseGeneration,
            controlGrant = result.value.controlGrant,
          ),
        )
        fail("invalid-start-response")
        VoiceRuntimeRealtimeCommandResult.Rejected("invalid-start-response")
      } else {
        serverSession = result.value
        update(
          requireCheckpoint().copy(
            phase = VoiceRealtimePhase.NEGOTIATING,
            serverSessionId = result.value.state.sessionId,
            leaseGeneration = result.value.state.leaseGeneration,
            controlGrant = result.value.controlGrant,
          ),
        )
        val accepted = peer.prepare(
          fence.modeSessionId,
          { offer -> onOfferReady(fence, result.value.state.sessionId, offer) },
          { code -> onPeerFailure(fence, result.value.state.sessionId, code) },
        )
        if (!accepted) {
          fail("peer-prepare-rejected")
          VoiceRuntimeRealtimeCommandResult.Rejected("peer-prepare-rejected")
        } else VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
      }
    }
  }

  private fun recordCommand(
    commandId: String,
    fingerprint: String,
    result: VoiceRuntimeRealtimeCommandResult,
  ): VoiceRuntimeRealtimeCommandResult {
    commands.record(commandId, fingerprint, result)
    return result
  }

  private fun onOfferReady(
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    offer: String,
  ) {
    val request = synchronized(this) {
      val current = runCatching { requireActive(fence, sessionId) }.getOrNull() ?: return
      if (current.phase != VoiceRealtimePhase.NEGOTIATING) return
      OfferRequest(requireSession(current), "${current.rootCommandId}.offer")
    }
    val result = server.offer(
      authority,
      fence,
      request.session,
      request.clientOperationId,
      offer,
    )
    synchronized(this) {
      val current = runCatching { requireActive(fence, sessionId) }.getOrNull()
        ?: return@synchronized
      if (current.phase != VoiceRealtimePhase.NEGOTIATING) return@synchronized
      when (result) {
        is VoiceRuntimeRealtimeRemoteResult.Failure -> fail(result.code)
        is VoiceRuntimeRealtimeRemoteResult.Success -> {
          if (!peer.applyAnswer(
              fence.modeSessionId,
              result.value.sdp,
              { code -> onPeerFailure(fence, sessionId, code) },
            )) {
            fail("peer-answer-rejected")
          }
        }
      }
    }
  }

  private fun onPeerFailure(fence: VoiceRuntimeRealtimeFence, sessionId: String, code: String) {
    synchronized(this) {
      if (runCatching { requireActive(fence, sessionId) }.isSuccess) fail(code)
    }
  }

  private fun completeReadyCue(fence: VoiceRuntimeRealtimeFence, sessionId: String) {
    synchronized(this) {
      val current = runCatching { requireActive(fence, sessionId) }.getOrNull() ?: return
      if (current.phase != VoiceRealtimePhase.CUEING) return
      if (!peer.setInputReady(fence.modeSessionId, true)) {
        fail("microphone-enable-failed")
        return
      }
      update(
        current.copy(
          phase = VoiceRealtimePhase.CONNECTED,
          lastConnectedAtEpochMillis = now(),
        ),
      )
    }
  }

  private fun consumeAction(action: VoiceRuntimeRealtimeAction): Boolean {
    val current = requireCheckpoint()
    return when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread,
      is VoiceRuntimeRealtimeAction.ConfirmationRequired,
      -> {
        update(current.copy(pendingAction = action))
        presentation.publish(action)
        true
      }
      is VoiceRuntimeRealtimeAction.StopRealtimeVoice -> {
        update(current.copy(lastActionSequence = action.sequence))
        beginShutdown(VoiceRuntimeRealtimeStopPolicy.DRAIN, "agent-stop")
        true
      }
      is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> error("Handoffs require remote coordination.")
    }
  }

  private fun consumeHandoff(
    fence: VoiceRuntimeRealtimeFence,
    action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
  ): Boolean {
    val request = synchronized(this) {
      val current = requireActive(fence)
      if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES ||
        action.sequence <= current.lastActionSequence) return false
      HandoffRequest(current, requireSession(current), handoff.plan(current, action))
    }
    val result = server.exchangeHandoff(authority, fence, request.session, action, request.plan)
    if (result !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    return synchronized(this) {
      val current = runCatching { requireActive(fence, request.session.state.sessionId) }
        .getOrNull() ?: return@synchronized false
      if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES ||
        current.lastActionSequence != request.checkpoint.lastActionSequence) {
        return@synchronized false
      }
      if (result.value.projectId != action.projectId || result.value.threadId != action.threadId ||
        result.value.autoRearm != action.autoRearm ||
        result.value.transitionGrant.generation != current.fence.identity.generation + 1) {
        fail("handoff-response-mismatch")
        return@synchronized false
      }
      if (!handoff.prepare(result.value)) {
        fail("handoff-admission-failed")
        return@synchronized false
      }
      update(
        current.copy(
          lastActionSequence = action.sequence,
          pendingHandoffExchange = result.value,
        ),
      )
      beginShutdown(VoiceRuntimeRealtimeStopPolicy.DRAIN, "thread-handoff")
      true
    }
  }

  private fun beginShutdown(policy: VoiceRuntimeRealtimeStopPolicy, reason: String) {
    val current = requireCheckpoint()
    if (current.phase in SHUTDOWN_PHASES) return
    peer.setInputReady(current.fence.modeSessionId, false)
    if (current.serverSessionId == null) {
      pendingStart?.takeIf {
        it.commandId == current.rootCommandId && it.fence == current.fence
      }?.cancelled = true
      peer.close(current.fence.modeSessionId)
      terminal(
        current.copy(phase = VoiceRealtimePhase.CANCELLED),
        VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
        reason,
        cleanupPending = false,
      )
      return
    }
    if (policy == VoiceRuntimeRealtimeStopPolicy.DRAIN) {
      update(
        current.copy(
          phase = VoiceRealtimePhase.DRAINING,
          drainDeadlineAtEpochMillis = now() + drainTimeoutMillis,
        ),
      )
      if (peer.drain(current.fence.modeSessionId) { finishShutdown(current.fence, reason) }) return
    }
    finishShutdown(current.fence, reason)
  }

  private fun finishShutdown(fence: VoiceRuntimeRealtimeFence, reason: String) {
    val request = synchronized(this) {
      val current = runCatching { requireActive(fence) }.getOrNull() ?: return
      if (current.phase == VoiceRealtimePhase.STOPPING) return
      update(current.copy(phase = VoiceRealtimePhase.STOPPING, drainDeadlineAtEpochMillis = null))
      peer.close(fence.modeSessionId)
      val session = requireSession(current)
      ShutdownRequest(fence, session, current.rootCommandId, reason)
    }
    val finish = { completeShutdown(request) }
    val cueStarted = synchronized(this) {
      val current = checkpoint?.takeIf { it.fence == fence } ?: return
      current.lastConnectedAtEpochMillis != null && cues.ended(fence.identity.generation, finish)
    }
    if (!cueStarted) finish()
  }

  private fun completeShutdown(request: ShutdownRequest) {
    val exchange = synchronized(this) {
      checkpoint?.takeIf {
        it.fence == request.fence && it.phase == VoiceRealtimePhase.STOPPING
      }?.pendingHandoffExchange ?: if (checkpoint?.fence == request.fence) null else return
    }
    val committed = exchange == null || (
      server.commitHandoff(authority, request.fence, request.session, exchange)
        is VoiceRuntimeRealtimeRemoteResult.Success
    )
    if (!committed) return
    val closed = server.close(
      authority,
      request.fence,
      request.session,
      "${request.rootCommandId}.close.${request.reason}",
    ) is VoiceRuntimeRealtimeRemoteResult.Success
    val activated = exchange == null || handoff.activate(exchange)
    if (exchange != null && !activated) return
    synchronized(this) {
      val latest = checkpoint?.takeIf {
        it.fence == request.fence && it.phase == VoiceRealtimePhase.STOPPING
      } ?: return
      terminal(
        latest,
        if (exchange != null) VoiceRuntimeRealtimeTerminalOutcome.COMPLETED
        else VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
        request.reason,
        !closed,
      )
    }
  }

  private fun fail(code: String) {
    val current = checkpoint ?: return
    if (current.phase in SHUTDOWN_PHASES) return
    peer.setInputReady(current.fence.modeSessionId, false)
    peer.close(current.fence.modeSessionId)
    val session = restoredSession(current)
    update(current.copy(phase = VoiceRealtimePhase.FAILED))
    remoteDispatcher.dispatch {
      val closed = session == null || server.close(
        authority,
        current.fence,
        session,
        "${current.rootCommandId}.close.failure",
      ) is VoiceRuntimeRealtimeRemoteResult.Success
      synchronized(this) {
        val latest = checkpoint?.takeIf {
          it.fence == current.fence && it.phase == VoiceRealtimePhase.FAILED
        } ?: return@synchronized
        terminal(
          latest,
          VoiceRuntimeRealtimeTerminalOutcome.FAILED,
          code,
          !closed,
        )
      }
    }
  }

  private fun terminal(
    current: VoiceRuntimeRealtimeCheckpoint,
    outcome: VoiceRuntimeRealtimeTerminalOutcome,
    reason: String,
    cleanupPending: Boolean,
  ): VoiceRuntimeRealtimeTerminalSummary {
    val summary = VoiceRuntimeRealtimeTerminalSummary(
      identity = current.fence.identity,
      modeSessionId = current.fence.modeSessionId,
      conversationId = current.target.conversationId,
      sessionId = current.serverSessionId,
      outcome = outcome,
      reason = reason,
      lastConnectedAtEpochMillis = current.lastConnectedAtEpochMillis,
      terminalAtEpochMillis = now(),
      serverCleanupPending = cleanupPending,
      expiresAtEpochMillis = now() + terminalRetentionMillis,
    )
    repository.publishTerminal(summary)
    runCatching { terminalSink.publish(summary) }
    repository.clear(current.fence)
    checkpoint = null
    serverSession = null
    stateSink.publish(null)
    return summary
  }

  private fun publishCancelledStartCleanupFailure(
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
  ) {
    val summary = VoiceRuntimeRealtimeTerminalSummary(
      identity = fence.identity,
      modeSessionId = fence.modeSessionId,
      conversationId = authority.target.conversationId,
      sessionId = session.state.sessionId,
      outcome = VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
      reason = "user-stop",
      lastConnectedAtEpochMillis = null,
      terminalAtEpochMillis = now(),
      serverCleanupPending = true,
      expiresAtEpochMillis = now() + terminalRetentionMillis,
    )
    repository.publishTerminal(summary)
    runCatching { terminalSink.publish(summary) }
  }

  private fun update(next: VoiceRuntimeRealtimeCheckpoint) {
    repository.save(next)
    checkpoint = next
    stateSink.publish(next)
  }

  private fun validStart(
    result: VoiceRuntimeRealtimeStartResult,
    fence: VoiceRuntimeRealtimeFence,
  ): Boolean = result.state.conversationId == authority.target.conversationId &&
    result.state.phase == "signaling" &&
    result.state.leaseGeneration > 0 &&
    result.controlGrant.expiresAtEpochMillis > now() &&
    result.expiresAtEpochMillis >= result.controlGrant.expiresAtEpochMillis &&
    fence.identity == authority.identity

  private fun restoredSession(current: VoiceRuntimeRealtimeCheckpoint): VoiceRuntimeRealtimeStartResult? {
    val sessionId = current.serverSessionId ?: return null
    val lease = current.leaseGeneration ?: return null
    val control = current.controlGrant ?: return null
    return VoiceRuntimeRealtimeStartResult(
      VoiceRuntimeRealtimeSessionState(
        sessionId,
        current.target.conversationId,
        "signaling",
        lease,
        current.lastActionSequence,
      ),
      "/api/voice/runtime/realtime-sessions/$sessionId/webrtc-offer",
      control.expiresAtEpochMillis,
      control,
    )
  }

  private fun requireSession(current: VoiceRuntimeRealtimeCheckpoint): VoiceRuntimeRealtimeStartResult =
    serverSession ?: restoredSession(current)
    ?: throw VoiceRuntimeFenceException("Realtime server session is unavailable.")

  private fun requireCheckpoint() = checkpoint
    ?: throw VoiceRuntimeFenceException("Realtime operation is not active.")

  private fun requireActive(
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String? = null,
  ): VoiceRuntimeRealtimeCheckpoint {
    requireFence(fence)
    val current = requireCheckpoint()
    if (current.fence != fence || (sessionId != null && current.serverSessionId != sessionId)) {
      throw VoiceRuntimeFenceException("Realtime callback fence is stale.")
    }
    return current
  }

  private fun requireFence(fence: VoiceRuntimeRealtimeFence) {
    if (fence.identity != authority.identity || fence.modeSessionId.isBlank()) {
      throw VoiceRuntimeFenceException("Realtime runtime fence is stale.")
    }
  }

  private fun VoiceRealtimePhase.isTerminal() = this in setOf(
    VoiceRealtimePhase.COMPLETED,
    VoiceRealtimePhase.FAILED,
    VoiceRealtimePhase.CANCELLED,
  )

  private companion object {
    sealed interface StartCompletion {
      data class Current(val result: VoiceRuntimeRealtimeCommandResult) : StartCompletion
      data object Stale : StartCompletion
    }

    data class PendingStart(
      val commandId: String,
      val fingerprint: String,
      val fence: VoiceRuntimeRealtimeFence,
      var cancelled: Boolean = false,
    )

    sealed interface ActionPollCompletion {
      data class Immediate(val result: Boolean) : ActionPollCompletion
      data class Handoff(val action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice) :
        ActionPollCompletion
    }

    data class ActionPollRequest(
      val session: VoiceRuntimeRealtimeStartResult,
      val afterSequence: Long,
    )

    data class ActionAcknowledgementRequest(
      val session: VoiceRuntimeRealtimeStartResult,
      val action: VoiceRuntimeRealtimeAction,
    )

    data class HandoffRequest(
      val checkpoint: VoiceRuntimeRealtimeCheckpoint,
      val session: VoiceRuntimeRealtimeStartResult,
      val plan: VoiceRuntimeRealtimeHandoffPlan,
    )

    data class OfferRequest(
      val session: VoiceRuntimeRealtimeStartResult,
      val clientOperationId: String,
    )

    data class ShutdownRequest(
      val fence: VoiceRuntimeRealtimeFence,
      val session: VoiceRuntimeRealtimeStartResult,
      val rootCommandId: String,
      val reason: String,
    )

    data class RecoveryRequest(
      val checkpoint: VoiceRuntimeRealtimeCheckpoint,
      val session: VoiceRuntimeRealtimeStartResult?,
      val exchange: VoiceRuntimeRealtimeHandoffExchangeResult?,
      val authority: VoiceRuntimeRealtimeAuthority,
    )

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
