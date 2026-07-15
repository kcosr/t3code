package expo.modules.t3voice

internal class VoiceRuntimeRealtimeHttpGateway(
  private val sessionCredential: (String) -> String,
  private val delegate: VoiceRuntimeRealtimeDelegate = VoiceRuntimeRealtimeDelegate(),
) : VoiceRuntimeRealtimeServer {
  override fun start(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    clientOperationId: String,
  ) = delegate.start(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    VoiceRuntimeRealtimeStartInput(fence.toTransport(), clientOperationId, authority.target),
  ).toRuntimeResult()

  override fun offer(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
    sdp: String,
  ) = delegate.offer(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    VoiceRuntimeRealtimeOfferInput(session.leaseFence(fence), clientOperationId, sdp),
  ).toRuntimeResult()

  override fun heartbeat(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
  ) = delegate.heartbeat(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    session.leaseFence(fence),
  ).toRuntimeResult()

  override fun actions(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    afterSequence: Long,
    waitMilliseconds: Long,
  ) = delegate.actions(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    VoiceRuntimeRealtimeActionsQuery(
      session.leaseFence(fence),
      afterSequence,
      waitMilliseconds,
    ),
  ).toRuntimeResult()

  override fun acknowledgeAction(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    action: VoiceRuntimeRealtimeAction,
    clientOperationId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): VoiceRuntimeRealtimeRemoteResult<VoiceRuntimeRealtimeActionAckResult> {
    val actionId = when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread -> action.actionId
      is VoiceRuntimeRealtimeAction.ConfirmationRequired -> action.actionId
      else -> return VoiceRuntimeRealtimeRemoteResult.Failure("unsupported-action-ack", false)
    }
    return delegate.acknowledgeAction(
      authority.environmentOrigin,
      sessionCredential(authority.environmentOrigin),
      session.state.sessionId,
      actionId,
      when (decision) {
        is VoiceRuntimeRealtimePresentationDecision.Navigate ->
          VoiceRuntimeRealtimeActionAckInput.NavigateThread(
            session.leaseFence(fence),
            clientOperationId,
            action.sequence,
            decision.outcome,
            decision.message,
          )
        is VoiceRuntimeRealtimePresentationDecision.Confirmation ->
          VoiceRuntimeRealtimeActionAckInput.ConfirmationRequired(
            session.leaseFence(fence),
            clientOperationId,
            action.sequence,
            decision.confirmationId,
            decision.decision,
          )
      },
    ).toRuntimeResult()
  }

  override fun updateFocus(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
    focus: VoiceRuntimeRealtimeFocus?,
  ) = delegate.updateFocus(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    VoiceRuntimeRealtimeFocusInput(
      session.leaseFence(fence),
      clientOperationId,
      focus,
    ),
  ).toRuntimeResult()

  override fun exchangeHandoff(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    action: VoiceRuntimeRealtimeAction.HandoffToThreadVoice,
    plan: VoiceRuntimeRealtimeHandoffPlan,
  ) = delegate.exchangeHandoff(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    action.actionId,
    VoiceRuntimeRealtimeHandoffExchangeInput(
      session.leaseFence(fence),
      plan.clientOperationId,
      action.sequence,
      fence.identity.generation + 1,
      plan.threadModeSessionId,
      plan.environmentId,
      plan.speechPreset,
      plan.endpointPolicy,
      plan.speechEnabled,
      plan.rearmGuardMs,
    ),
  ).toRuntimeResult()

  override fun commitHandoff(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    exchange: VoiceRuntimeRealtimeHandoffExchangeResult,
  ) = delegate.commitHandoff(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    exchange.actionId,
    VoiceRuntimeRealtimeHandoffCommitInput(
      session.leaseFence(fence),
      exchange.actionSequence,
      exchange.reservation.generation,
      exchange.reservation.modeSessionId,
    ),
  ).toRuntimeResult()

  override fun close(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: VoiceRuntimeRealtimeStartResult,
    clientOperationId: String,
  ) = delegate.close(
    authority.environmentOrigin,
    sessionCredential(authority.environmentOrigin),
    session.state.sessionId,
    VoiceRuntimeRealtimeCloseInput(session.leaseFence(fence), clientOperationId),
  ).toRuntimeResult()

  private fun VoiceRuntimeRealtimeFence.toTransport() = VoiceRealtimeTransportFence(
    identity.runtimeId,
    identity.runtimeInstanceId,
    identity.generation,
    modeSessionId,
  )

  private fun VoiceRuntimeRealtimeStartResult.leaseFence(fence: VoiceRuntimeRealtimeFence) =
    VoiceRuntimeRealtimeLeaseFence(fence.toTransport(), state.leaseGeneration)

  private fun <T> VoiceRuntimeRealtimeResult<T>.toRuntimeResult():
    VoiceRuntimeRealtimeRemoteResult<T> = when (this) {
    is VoiceRuntimeRealtimeResult.Success -> VoiceRuntimeRealtimeRemoteResult.Success(value)
    is VoiceRuntimeRealtimeResult.Failure -> VoiceRuntimeRealtimeRemoteResult.Failure(
      "http-${kind.name.lowercase().replace('_', '-')}",
      kind in setOf(
        VoiceRuntimeHttpFailureKind.RETRYABLE,
        VoiceRuntimeHttpFailureKind.CONFLICT,
        VoiceRuntimeHttpFailureKind.CANCELLED,
      ),
    )
  }
}
