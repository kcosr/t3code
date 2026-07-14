package expo.modules.t3voice

internal class VoiceRuntimeRealtimeHttpGateway(
  private val delegate: T3VoiceBackgroundRealtimeDelegate = T3VoiceBackgroundRealtimeDelegate(),
) : VoiceRuntimeRealtimeServer {
  override fun start(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    clientOperationId: String,
  ) = delegate.start(
    authority.environmentOrigin,
    authority.runtimeToken,
    T3VoiceBackgroundRealtimeStartInput(fence.toTransport(), clientOperationId),
  ).toRuntimeResult()

  override fun offer(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
    clientOperationId: String,
    sdp: String,
  ) = delegate.offer(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    T3VoiceBackgroundRealtimeOfferInput(session.leaseFence(fence), clientOperationId, sdp),
  ).toRuntimeResult()

  override fun heartbeat(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
  ) = delegate.heartbeat(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    session.leaseFence(fence),
  ).toRuntimeResult()

  override fun actions(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
    afterSequence: Long,
    waitMilliseconds: Long,
  ) = delegate.actions(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    T3VoiceBackgroundRealtimeActionsQuery(
      session.leaseFence(fence),
      afterSequence,
      waitMilliseconds,
    ),
  ).toRuntimeResult()

  override fun acknowledgeAction(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
    action: T3VoiceBackgroundRealtimeAction,
    clientOperationId: String,
    decision: VoiceRuntimeRealtimePresentationDecision,
  ): VoiceRuntimeRealtimeRemoteResult<T3VoiceBackgroundRealtimeActionAckResult> {
    val actionId = when (action) {
      is T3VoiceBackgroundRealtimeAction.NavigateThread -> action.actionId
      is T3VoiceBackgroundRealtimeAction.ConfirmationRequired -> action.actionId
      else -> return VoiceRuntimeRealtimeRemoteResult.Failure("unsupported-action-ack", false)
    }
    return delegate.acknowledgeAction(
      authority.environmentOrigin,
      session.controlGrant.token,
      session.state.sessionId,
      actionId,
      when (decision) {
        is VoiceRuntimeRealtimePresentationDecision.Navigate ->
          T3VoiceBackgroundRealtimeActionAckInput.NavigateThread(
            session.leaseFence(fence),
            clientOperationId,
            action.sequence,
            decision.outcome,
            decision.message,
          )
        is VoiceRuntimeRealtimePresentationDecision.Confirmation ->
          T3VoiceBackgroundRealtimeActionAckInput.ConfirmationRequired(
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
    session: T3VoiceBackgroundRealtimeStartResult,
    clientOperationId: String,
    focus: T3VoiceBackgroundRealtimeFocus?,
  ) = delegate.updateFocus(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    T3VoiceBackgroundRealtimeFocusInput(
      session.leaseFence(fence),
      clientOperationId,
      focus,
    ),
  ).toRuntimeResult()

  override fun exchangeHandoff(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
    action: T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice,
    plan: VoiceRuntimeRealtimeHandoffPlan,
  ) = delegate.exchangeHandoff(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    action.actionId,
    T3VoiceBackgroundRealtimeHandoffExchangeInput(
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

  override fun close(
    authority: VoiceRuntimeRealtimeAuthority,
    fence: VoiceRuntimeRealtimeFence,
    session: T3VoiceBackgroundRealtimeStartResult,
    clientOperationId: String,
  ) = delegate.close(
    authority.environmentOrigin,
    session.controlGrant.token,
    session.state.sessionId,
    T3VoiceBackgroundRealtimeCloseInput(session.leaseFence(fence), clientOperationId),
  ).toRuntimeResult()

  private fun VoiceRuntimeRealtimeFence.toTransport() = T3VoiceBackgroundRealtimeFence(
    identity.runtimeId,
    identity.runtimeInstanceId,
    identity.generation,
    modeSessionId,
  )

  private fun T3VoiceBackgroundRealtimeStartResult.leaseFence(fence: VoiceRuntimeRealtimeFence) =
    T3VoiceBackgroundRealtimeLeaseFence(fence.toTransport(), state.leaseGeneration)

  private fun <T> T3VoiceBackgroundRealtimeResult<T>.toRuntimeResult():
    VoiceRuntimeRealtimeRemoteResult<T> = when (this) {
    is T3VoiceBackgroundRealtimeResult.Success -> VoiceRuntimeRealtimeRemoteResult.Success(value)
    is T3VoiceBackgroundRealtimeResult.Failure -> VoiceRuntimeRealtimeRemoteResult.Failure(
      "http-${kind.name.lowercase().replace('_', '-')}",
      kind in setOf(
        T3VoiceBackgroundHttpFailureKind.RETRYABLE,
        T3VoiceBackgroundHttpFailureKind.CONFLICT,
        T3VoiceBackgroundHttpFailureKind.CANCELLED,
      ),
    )
  }
}
