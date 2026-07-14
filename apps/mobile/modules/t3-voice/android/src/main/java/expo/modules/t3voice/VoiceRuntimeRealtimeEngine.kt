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
  private val drainTimeoutMillis: Long = 2_500,
  private val terminalRetentionMillis: Long = 30L * 24 * 60 * 60 * 1_000,
) {
  private var checkpoint = repository.load()
  private var serverSession: VoiceRuntimeRealtimeStartResult? = null
  private val commands = VoiceRuntimeIdempotencyLedger<VoiceRuntimeRealtimeCommandResult>(256)

  init {
    require(drainTimeoutMillis > 0)
    require(terminalRetentionMillis > 0)
  }

  @Synchronized
  fun snapshot(): VoiceRuntimeRealtimeCheckpoint? = checkpoint

  @Synchronized
  fun start(
    commandId: String,
    fence: VoiceRuntimeRealtimeFence,
  ): VoiceRuntimeRealtimeCommandResult = commands.resolve(commandId, "start:$fence") {
    requireFence(fence)
    if (authority.expiresAtEpochMillis <= now()) {
      return@resolve VoiceRuntimeRealtimeCommandResult.Rejected("authority-expired")
    }
    val current = checkpoint
    if (current != null) {
      return@resolve if (current.fence == fence && !current.phase.isTerminal()) {
        VoiceRuntimeRealtimeCommandResult.Accepted(adopted = true)
      } else {
        VoiceRuntimeRealtimeCommandResult.Rejected("owner-conflict")
      }
    }
    update(
      VoiceRuntimeRealtimeCheckpoint(
        fence = fence,
        target = authority.target,
        rootCommandId = commandId,
        phase = VoiceRealtimePhase.PREPARING,
      ),
    )
    when (val result = server.start(authority, fence, commandId)) {
      is VoiceRuntimeRealtimeRemoteResult.Failure -> {
        fail(result.code)
        VoiceRuntimeRealtimeCommandResult.Rejected(result.code)
      }
      is VoiceRuntimeRealtimeRemoteResult.Success -> {
        if (!validStart(result.value, fence)) {
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
  }.let { (result, replayed) -> result.withReplay(replayed) }

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
    if (runCatching { requireActive(fence, sessionId) }.isFailure) return
    fail(failureCode)
  }

  @Synchronized
  fun heartbeat(fence: VoiceRuntimeRealtimeFence): Boolean {
    val current = requireActive(fence)
    val session = requireSession(current)
    return when (val result = server.heartbeat(authority, fence, session)) {
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

  @Synchronized
  fun pollActions(fence: VoiceRuntimeRealtimeFence, waitMilliseconds: Long = 25_000): Boolean {
    val current = requireActive(fence)
    if (current.pendingAction != null || current.phase in SHUTDOWN_PHASES) return true
    val session = requireSession(current)
    return when (
      val result = server.actions(
        authority,
        fence,
        session,
        current.lastActionSequence,
        waitMilliseconds,
      )
    ) {
      is VoiceRuntimeRealtimeRemoteResult.Failure -> false
      is VoiceRuntimeRealtimeRemoteResult.Success -> {
        val action = result.value.actions.firstOrNull {
          it.sequence > requireCheckpoint().lastActionSequence
        } ?: return true
        if (result.value.actions.zipWithNext().any { (left, right) -> left.sequence >= right.sequence }) {
          fail("action-order-invalid")
          return false
        }
        consumeAction(action)
      }
    }
  }

  @Synchronized
  fun acknowledgePresentationAction(
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    actionId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): Boolean {
    val current = requireActive(fence)
    val action = current.pendingAction ?: throw VoiceRuntimeFenceException("No presentation action is pending.")
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
    val session = requireSession(current)
    if (action is VoiceRuntimeRealtimeAction.NavigateThread &&
      (decision as VoiceRuntimeRealtimePresentationDecision.Navigate).outcome ==
        VoiceRuntimeRealtimeActionOutcome.SUCCEEDED) {
      val focused = server.updateFocus(
        authority,
        fence,
        session,
        "$commandId.focus",
        VoiceRuntimeRealtimeFocus(action.projectId, action.threadId),
      )
      if (focused !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    }
    val acknowledged = server.acknowledgeAction(
      authority,
      fence,
      session,
      action,
      commandId,
      decision,
    )
    if (acknowledged !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    update(current.copy(lastActionSequence = action.sequence, pendingAction = null))
    return true
  }

  @Synchronized
  fun updateFocus(
    fence: VoiceRuntimeRealtimeFence,
    commandId: String,
    focus: VoiceRuntimeRealtimeFocus?,
  ): Boolean {
    val current = requireActive(fence)
    return server.updateFocus(
      authority,
      fence,
      requireSession(current),
      commandId,
      focus,
    ) is VoiceRuntimeRealtimeRemoteResult.Success
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

  @Synchronized
  fun recoverInterrupted(currentIdentity: VoiceRuntimeIdentity): VoiceRuntimeRealtimeTerminalSummary? {
    val stale = checkpoint ?: return null
    if (stale.fence.identity == currentIdentity && stale.pendingHandoffExchange == null) return null
    val session = restoredSession(stale)
    peer.close(stale.fence.modeSessionId)
    val exchange = stale.pendingHandoffExchange
    val recovering = if (exchange == null) stale else stale.copy(
      phase = VoiceRealtimePhase.STOPPING,
      drainDeadlineAtEpochMillis = null,
    ).also(::update)
    val staleAuthority = authority.copy(identity = stale.fence.identity)
    val committed = exchange == null || (session != null &&
      server.commitHandoff(staleAuthority, stale.fence, session, exchange)
        is VoiceRuntimeRealtimeRemoteResult.Success)
    if (!committed) return null
    val cleaned = session != null && server.close(
      staleAuthority,
      stale.fence,
      session,
      "${stale.rootCommandId}.recover-close",
    ) is VoiceRuntimeRealtimeRemoteResult.Success
    val activated = committed && (exchange == null || handoff.activate(exchange))
    if (exchange != null && !activated) return null
    return terminal(
      recovering,
      if (exchange != null && activated) VoiceRuntimeRealtimeTerminalOutcome.COMPLETED
      else if (exchange != null) VoiceRuntimeRealtimeTerminalOutcome.FAILED
      else VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
      if (exchange != null && activated) "thread-handoff-recovered"
      else if (exchange != null) "handoff-activation-failed"
      else "process-restarted",
      !cleaned,
    )
  }

  private fun onOfferReady(
    fence: VoiceRuntimeRealtimeFence,
    sessionId: String,
    offer: String,
  ) {
    synchronized(this) {
      val current = runCatching { requireActive(fence, sessionId) }.getOrNull() ?: return
      if (current.phase != VoiceRealtimePhase.NEGOTIATING) return
      val session = requireSession(current)
      when (
        val result = server.offer(
          authority,
          fence,
          session,
          "${current.rootCommandId}.offer",
          offer,
        )
      ) {
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
      is VoiceRuntimeRealtimeAction.HandoffToThreadVoice -> consumeHandoff(current, action)
    }
  }

  private fun consumeHandoff(
    current: VoiceRuntimeRealtimeCheckpoint,
    action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
  ): Boolean {
    val session = requireSession(current)
    val plan = handoff.plan(current, action)
    val result = server.exchangeHandoff(authority, current.fence, session, action, plan)
    if (result !is VoiceRuntimeRealtimeRemoteResult.Success) return false
    if (result.value.projectId != action.projectId || result.value.threadId != action.threadId ||
      result.value.autoRearm != action.autoRearm ||
      result.value.transitionGrant.generation != current.fence.identity.generation + 1) {
      fail("handoff-response-mismatch")
      return false
    }
    if (!handoff.prepare(result.value)) {
      fail("handoff-admission-failed")
      return false
    }
    update(
      current.copy(
        lastActionSequence = action.sequence,
        pendingHandoffExchange = result.value,
      ),
    )
    beginShutdown(VoiceRuntimeRealtimeStopPolicy.DRAIN, "thread-handoff")
    return true
  }

  private fun beginShutdown(policy: VoiceRuntimeRealtimeStopPolicy, reason: String) {
    val current = requireCheckpoint()
    if (current.phase in SHUTDOWN_PHASES) return
    peer.setInputReady(current.fence.modeSessionId, false)
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
    synchronized(this) {
      val current = runCatching { requireActive(fence) }.getOrNull() ?: return
      update(current.copy(phase = VoiceRealtimePhase.STOPPING, drainDeadlineAtEpochMillis = null))
      peer.close(fence.modeSessionId)
      val session = requireSession(current)
      val finish = {
        synchronized(this) {
          val latest = checkpoint?.takeIf { it.fence == fence } ?: return@synchronized
          val exchange = latest.pendingHandoffExchange
          val committed = exchange == null || (
            server.commitHandoff(authority, fence, session, exchange)
              is VoiceRuntimeRealtimeRemoteResult.Success
          )
          if (!committed) return@synchronized
          val closed = server.close(
            authority,
            fence,
            session,
            "${current.rootCommandId}.close.$reason",
          ) is VoiceRuntimeRealtimeRemoteResult.Success
          val activated = exchange == null || handoff.activate(exchange)
          if (exchange != null && !activated) return@synchronized
          terminal(
            latest,
            if (activated && exchange != null) VoiceRuntimeRealtimeTerminalOutcome.COMPLETED
            else if (activated) VoiceRuntimeRealtimeTerminalOutcome.STOPPED
            else VoiceRuntimeRealtimeTerminalOutcome.FAILED,
            if (activated) reason
            else "handoff-activation-failed",
            !closed,
          )
        }
      }
      if (current.lastConnectedAtEpochMillis == null ||
        !cues.ended(fence.identity.generation, finish)) finish()
    }
  }

  private fun fail(code: String) {
    val current = checkpoint ?: return
    peer.setInputReady(current.fence.modeSessionId, false)
    peer.close(current.fence.modeSessionId)
    val session = restoredSession(current)
    val closed = session == null || server.close(
      authority,
      current.fence,
      session,
      "${current.rootCommandId}.close.failure",
    ) is VoiceRuntimeRealtimeRemoteResult.Success
    terminal(current.copy(phase = VoiceRealtimePhase.FAILED), VoiceRuntimeRealtimeTerminalOutcome.FAILED, code, !closed)
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
