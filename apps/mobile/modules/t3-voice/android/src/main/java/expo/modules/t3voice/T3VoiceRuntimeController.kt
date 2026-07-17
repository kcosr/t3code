package expo.modules.t3voice

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Starts and stops concrete media/network work for [T3VoiceRuntimeController].
 *
 * Methods admit or schedule work and must return promptly. Completion is reported back through
 * [T3VoiceRuntimeController.onCallback]. The service must not acquire recorder, peer, or foreground
 * ownership before the matching driver method is called: the controller has already reserved the
 * operation at that point.
 */
internal interface T3VoiceRuntimeDriver {
  fun startRealtime(
    generation: Long,
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  )

  fun closeRealtime(generation: Long, preserveSessionForThread: Boolean)

  fun cancelRealtimeToThreadSwitch(generation: Long)

  fun setRealtimeMuted(generation: Long, muted: Boolean)

  fun setRealtimeAudioRoute(generation: Long, routeId: String)

  /** Retains notification switch context and schedules the server focus update. */
  fun updateRealtimeContext(generation: Long, context: T3VoiceRealtimeContext)

  fun decideRealtimeConfirmation(
    generation: Long,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  )

  fun startInitialThread(
    generation: Long,
    start: T3VoiceThreadStart,
    session: T3VoiceNativeSessionConfig,
  )

  fun startThreadAfterRealtime(generation: Long, start: T3VoiceThreadStart)

  fun rearmThreadRecording(generation: Long)

  /** Enqueues the focus update without waiting for its network round trip. */
  fun admitRealtimeFocusUpdate(generation: Long, focus: T3VoiceRealtimeFocus)

  /** Enqueues the server acknowledgement after focus-update admission. */
  fun acknowledgeRealtimeClientAction(
    generation: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  )

  fun finishThreadRecording(generation: Long)

  fun uploadAndTranscribeThreadRecording(generation: Long)

  fun submitThreadTranscript(generation: Long, transcript: String)

  fun waitForThreadResponse(generation: Long)

  fun startThreadPlayback(generation: Long)

  fun scheduleThreadRearm(generation: Long, delayMs: Long)

  fun stopThread(generation: Long)

  /** Best-effort synchronous local cleanup before a failure snapshot is exposed. */
  /** Returns true when an exact native owner will report asynchronous release quiescence. */
  fun releaseAll(generation: Long): Boolean
}

/**
 * One process-local, serialized voice-mode state machine.
 *
 * There is deliberately no persistent state. Constructing a controller always creates an Idle
 * runtime at generation zero. The service passes commands from React, notification actions, and
 * MediaSession actions to the same [dispatch] method. Native completion callbacks use
 * [onCallback], with the generation supplied to the driver, so callbacks from old operations are
 * ignored.
 */
internal class T3VoiceRuntimeController(
  private val driver: T3VoiceRuntimeDriver,
) {
  private sealed interface PendingInitialStart {
    val generation: Long

    data class Realtime(
      override val generation: Long,
      val target: T3VoiceRealtimeTarget,
      val session: T3VoiceNativeSessionConfig,
    ) : PendingInitialStart

    data class Thread(
      override val generation: Long,
      val start: T3VoiceThreadStart,
      val session: T3VoiceNativeSessionConfig,
    ) : PendingInitialStart
  }

  private val lock = Any()
  private var pendingInitialStart: PendingInitialStart? = null
  private var failedReleasePending = false
  private var failedStopRequested = false

  @Volatile
  private var current =
    T3VoiceControllerSnapshot(
      state = T3VoiceControllerState.Idle,
      generation = 0,
      sequence = 0,
    )
  private val mutableSnapshots = MutableStateFlow(current)

  val snapshots: StateFlow<T3VoiceControllerSnapshot> = mutableSnapshots.asStateFlow()

  fun snapshot(): T3VoiceControllerSnapshot = current

  /**
   * Activates a previously admitted initial start after the service has acquired started-service
   * and foreground ownership. A delayed activation for a replaced generation is ignored.
   */
  fun activateInitialStart(generation: Long): Boolean =
    synchronized(lock) {
      val pending = pendingInitialStart?.takeIf { it.generation == generation }
        ?: return@synchronized false
      pendingInitialStart = null
      when (pending) {
        is PendingInitialStart.Realtime ->
          runDriver(T3VoiceOperation.REALTIME) {
            driver.startRealtime(generation, pending.target, pending.session)
          }
        is PendingInitialStart.Thread ->
          runDriver(T3VoiceOperation.THREAD) {
            driver.startInitialThread(generation, pending.start, pending.session)
          }
      }
      true
    }

  fun dispatch(command: T3VoiceRuntimeCommand): T3VoiceCommandResult =
    synchronized(lock) {
      when (command) {
        is T3VoiceRuntimeCommand.StartRealtime -> startRealtime(command.target, command.session)
        is T3VoiceRuntimeCommand.StartThread ->
          startThread(command.target, command.settings, command.session)
        is T3VoiceRuntimeCommand.SwitchRealtimeToThread ->
          switchToThread(command.target, command.settings)
        is T3VoiceRuntimeCommand.SetRealtimeMuted -> setRealtimeMuted(command.muted)
        is T3VoiceRuntimeCommand.SetRealtimeAudioRoute ->
          setRealtimeAudioRoute(command.routeId)
        is T3VoiceRuntimeCommand.UpdateRealtimeContext ->
          updateRealtimeContext(command.context)
        is T3VoiceRuntimeCommand.DecideRealtimeConfirmation ->
          decideRealtimeConfirmation(command.confirmationId, command.decision)
        is T3VoiceRuntimeCommand.CompleteRealtimeClientAction ->
          completeRealtimeClientAction(
            command.actionId,
            command.outcome,
            command.message,
          )
        T3VoiceRuntimeCommand.FinishThreadUtterance -> finishThreadUtterance()
        is T3VoiceRuntimeCommand.UpdateThreadReviewTranscript ->
          updateThreadReviewTranscript(
            command.expectedGeneration,
            command.expectedReviewId,
            command.transcript,
          )
        is T3VoiceRuntimeCommand.SubmitThreadTranscript ->
          submitThreadTranscript(
            command.expectedGeneration,
            command.expectedReviewId,
            command.transcript,
          )
        T3VoiceRuntimeCommand.Stop -> stop()
      }
    }

  fun onCallback(generation: Long, callback: T3VoiceRuntimeCallback): Boolean =
    synchronized(lock) {
      if (generation != current.generation) return@synchronized false
      when (callback) {
        T3VoiceRuntimeCallback.RealtimeConnected -> realtimeConnected()
        T3VoiceRuntimeCallback.RealtimeClosed -> realtimeClosed()
        T3VoiceRuntimeCallback.NativeReleaseQuiesced -> nativeReleaseQuiesced()
        is T3VoiceRuntimeCallback.RealtimeClientActionReceived ->
          realtimeClientActionReceived(callback.action)
        is T3VoiceRuntimeCallback.RealtimeClientActionResolved ->
          realtimeClientActionResolved(callback.actionId)
        is T3VoiceRuntimeCallback.RealtimeAudioRoutesChanged ->
          realtimeAudioRoutesChanged(callback.routes)
        is T3VoiceRuntimeCallback.RealtimeTranscriptChanged ->
          realtimeTranscriptChanged(callback.transcript)
        is T3VoiceRuntimeCallback.RealtimeConfirmationReceived ->
          realtimeConfirmationReceived(callback.confirmation)
        is T3VoiceRuntimeCallback.RealtimeConfirmationResolved ->
          realtimeConfirmationResolved(callback.confirmationId)
        T3VoiceRuntimeCallback.ThreadRecordingStarted -> threadRecordingStarted()
        T3VoiceRuntimeCallback.ThreadEndpointDetected -> threadEndpointDetected()
        T3VoiceRuntimeCallback.ThreadNoSpeechDetected -> threadNoSpeechDetected()
        T3VoiceRuntimeCallback.ThreadRecordingFinalized -> threadRecordingFinalized()
        is T3VoiceRuntimeCallback.ThreadTranscriptReady ->
          threadTranscriptReady(callback.transcript)
        T3VoiceRuntimeCallback.ThreadSubmitted -> threadSubmitted()
        is T3VoiceRuntimeCallback.ThreadResponseReady ->
          threadResponseReady(callback.hasPlayback)
        is T3VoiceRuntimeCallback.ThreadAttentionChanged ->
          threadAttentionChanged(callback.attention)
        T3VoiceRuntimeCallback.ThreadPlaybackFinished -> threadPlaybackFinished()
        T3VoiceRuntimeCallback.ThreadRearmReady -> threadRearmReady()
        T3VoiceRuntimeCallback.ThreadStopped -> threadStopped()
        is T3VoiceRuntimeCallback.Failed -> fail(callback.failure, callback.releasePending)
      }
    }

  private fun startRealtime(
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ): T3VoiceCommandResult {
    val state = current.state
    if (state is T3VoiceControllerState.Realtime && state.target == target) {
      return duplicate()
    }
    if (state !is T3VoiceControllerState.Idle) return rejected(T3VoiceCommandRejection.BUSY)

    begin(
      T3VoiceControllerState.Realtime(
        stage = T3VoiceRealtimeStage.STARTING,
        target = target,
        muted = false,
        pendingClientActions = emptyList(),
        audioRoutes = emptyList(),
        transcript = emptyList(),
        pendingConfirmations = emptyList(),
      ),
    )
    pendingInitialStart = PendingInitialStart.Realtime(current.generation, target, session)
    return applied()
  }

  private fun startThread(
    target: T3VoiceThreadTarget,
    settings: T3VoiceThreadSettings,
    session: T3VoiceNativeSessionConfig,
  ): T3VoiceCommandResult {
    val state = current.state
    val requested = T3VoiceThreadStart(target, settings)
    if (
      (state is T3VoiceControllerState.Thread &&
        state.target == target &&
        state.settings == settings) ||
        (state is T3VoiceControllerState.SwitchingToThread && state.threadStart == requested)
    ) {
      return duplicate()
    }
    if (state !is T3VoiceControllerState.Idle) return rejected(T3VoiceCommandRejection.BUSY)

    begin(
      T3VoiceControllerState.Thread(
        T3VoiceThreadStage.STARTING,
        target,
        settings,
        transcript = null,
        attention = null,
      ),
    )
    pendingInitialStart = PendingInitialStart.Thread(current.generation, requested, session)
    return applied()
  }

  private fun switchToThread(
    target: T3VoiceThreadTarget,
    settings: T3VoiceThreadSettings,
  ): T3VoiceCommandResult {
    val requested = T3VoiceThreadStart(target, settings)
    return when (val state = current.state) {
      is T3VoiceControllerState.Realtime -> {
        if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
          return rejected(T3VoiceCommandRejection.INVALID_STATE)
        }
        if (state.target.environmentId != target.environmentId) {
          return rejected(T3VoiceCommandRejection.INVALID_STATE)
        }
        update(
          T3VoiceControllerState.SwitchingToThread(
            stage = T3VoiceSwitchStage.CLOSING_REALTIME,
            realtimeTarget = state.target,
            threadStart = requested,
          ),
        )
        runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
          driver.closeRealtime(current.generation, preserveSessionForThread = true)
        }
        applied()
      }
      is T3VoiceControllerState.SwitchingToThread ->
        if (state.threadStart == requested) duplicate() else rejected(T3VoiceCommandRejection.BUSY)
      is T3VoiceControllerState.Thread ->
        if (state.target == target && state.settings == settings) {
          duplicate()
        } else {
          rejected(T3VoiceCommandRejection.BUSY)
        }
      else -> rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
  }

  private fun setRealtimeMuted(muted: Boolean): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    if (state.muted == muted) return duplicate()

    update(state.copy(muted = muted))
    runDriver(T3VoiceOperation.REALTIME) { driver.setRealtimeMuted(current.generation, muted) }
    return applied()
  }

  private fun setRealtimeAudioRoute(routeId: String): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    val selected = state.audioRoutes.firstOrNull { it.id == routeId }
      ?: return rejected(T3VoiceCommandRejection.UNKNOWN_AUDIO_ROUTE)
    if (selected.selected) return duplicate()
    update(
      state.copy(
        audioRoutes = state.audioRoutes.map { it.copy(selected = it.id == routeId) },
      ),
    )
    runDriver(T3VoiceOperation.REALTIME) {
      driver.setRealtimeAudioRoute(current.generation, routeId)
    }
    return applied()
  }

  private fun updateRealtimeContext(context: T3VoiceRealtimeContext): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    if (state.target.focus == context.focus && state.target.threadSwitch == context.threadSwitch) {
      return duplicate()
    }
    update(
      state.copy(
        target =
          state.target.copy(
            focus = context.focus,
            threadSwitch = context.threadSwitch,
          ),
      ),
    )
    runDriver(T3VoiceOperation.REALTIME) {
      driver.updateRealtimeContext(current.generation, context)
    }
    return applied()
  }

  private fun decideRealtimeConfirmation(
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  ): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    if (state.pendingConfirmations.none { it.confirmationId == confirmationId }) return duplicate()
    update(
      state.copy(
        pendingConfirmations =
          state.pendingConfirmations.filterNot { it.confirmationId == confirmationId },
      ),
    )
    runDriver(T3VoiceOperation.REALTIME) {
      driver.decideRealtimeConfirmation(current.generation, confirmationId, decision)
    }
    return applied()
  }

  private fun completeRealtimeClientAction(
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    val action = state.pendingClientActions.firstOrNull { it.actionId == actionId }
      ?: return duplicate()
    val focus = T3VoiceRealtimeFocus(action.projectId, action.threadId)
    update(
      state.copy(
        target =
          if (outcome == T3VoiceClientActionOutcome.SUCCEEDED) {
            state.target.copy(
              focus = focus,
              threadSwitch =
                state.target.threadSwitch?.takeIf {
                  it.target.projectId == focus.projectId && it.target.threadId == focus.threadId
                },
            )
          } else {
            state.target
          },
        pendingClientActions = state.pendingClientActions.filterNot { it.actionId == actionId },
      ),
    )
    runDriver(T3VoiceOperation.REALTIME) {
      if (outcome == T3VoiceClientActionOutcome.SUCCEEDED) {
        driver.admitRealtimeFocusUpdate(current.generation, focus)
      }
      driver.acknowledgeRealtimeClientAction(
        current.generation,
        actionId,
        outcome,
        message,
      )
    }
    return applied()
  }

  private fun finishThreadUtterance(): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Thread
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceThreadStage.RECORDING) return duplicate()

    update(state.copy(stage = T3VoiceThreadStage.FINALIZING))
    runDriver(T3VoiceOperation.THREAD) { driver.finishThreadRecording(current.generation) }
    return applied()
  }

  private fun updateThreadReviewTranscript(
    expectedGeneration: Long,
    expectedReviewId: Long,
    transcript: String,
  ): T3VoiceCommandResult {
    if (expectedGeneration != current.generation) {
      return rejected(T3VoiceCommandRejection.STALE_GENERATION)
    }
    val state = current.state as? T3VoiceControllerState.Thread
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceThreadStage.REVIEWING) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    if (expectedReviewId != state.reviewId) {
      return rejected(T3VoiceCommandRejection.STALE_REVIEW)
    }
    if (state.transcript == transcript) return duplicate()
    update(state.copy(transcript = transcript))
    return applied()
  }

  private fun submitThreadTranscript(
    expectedGeneration: Long,
    expectedReviewId: Long,
    transcript: String,
  ): T3VoiceCommandResult {
    if (expectedGeneration != current.generation) {
      return rejected(T3VoiceCommandRejection.STALE_GENERATION)
    }
    val state = current.state as? T3VoiceControllerState.Thread
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    return when (state.stage) {
      T3VoiceThreadStage.REVIEWING -> {
        if (expectedReviewId != state.reviewId) {
          return rejected(T3VoiceCommandRejection.STALE_REVIEW)
        }
        update(state.copy(stage = T3VoiceThreadStage.SUBMITTING, transcript = transcript))
        runDriver(T3VoiceOperation.THREAD) {
          driver.submitThreadTranscript(current.generation, transcript)
        }
        applied()
      }
      T3VoiceThreadStage.SUBMITTING,
      T3VoiceThreadStage.WAITING,
      T3VoiceThreadStage.PLAYING,
      T3VoiceThreadStage.REARMING,
      T3VoiceThreadStage.STOPPING,
      -> {
        if (expectedReviewId != state.reviewId) {
          rejected(T3VoiceCommandRejection.STALE_REVIEW)
        } else {
          duplicate()
        }
      }
      T3VoiceThreadStage.STARTING,
      T3VoiceThreadStage.RECORDING,
      T3VoiceThreadStage.FINALIZING,
      T3VoiceThreadStage.UPLOADING,
      -> rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
  }

  private fun stop(): T3VoiceCommandResult {
    when (val state = current.state) {
      T3VoiceControllerState.Idle -> return duplicate()
      is T3VoiceControllerState.Failed -> {
        pendingInitialStart = null
        runCatching { driver.releaseAll(current.generation) }
        if (failedReleasePending) {
          if (failedStopRequested) return duplicate()
          failedStopRequested = true
          update(state)
          return applied()
        }
        failedStopRequested = false
        update(T3VoiceControllerState.Idle)
      }
      is T3VoiceControllerState.Realtime -> {
        if (state.stage == T3VoiceRealtimeStage.STOPPING) return duplicate()
        if (state.stage == T3VoiceRealtimeStage.STARTING && clearPendingInitialStart()) {
          update(T3VoiceControllerState.Idle)
          return applied()
        }
        update(state.copy(stage = T3VoiceRealtimeStage.STOPPING))
        runDriver(T3VoiceOperation.REALTIME) {
          driver.closeRealtime(current.generation, preserveSessionForThread = false)
        }
      }
      is T3VoiceControllerState.SwitchingToThread ->
        when (state.stage) {
          T3VoiceSwitchStage.CLOSING_REALTIME -> {
            update(
              T3VoiceControllerState.Realtime(
                stage = T3VoiceRealtimeStage.STOPPING,
                target = state.realtimeTarget,
                muted = false,
                pendingClientActions = emptyList(),
                audioRoutes = emptyList(),
                transcript = emptyList(),
                pendingConfirmations = emptyList(),
              ),
            )
            runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
              driver.cancelRealtimeToThreadSwitch(current.generation)
            }
          }
          T3VoiceSwitchStage.STARTING_RECORDER -> {
            update(
              T3VoiceControllerState.Thread(
                T3VoiceThreadStage.STOPPING,
                state.threadStart.target,
                state.threadStart.settings,
                transcript = null,
                attention = null,
              ),
            )
            runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
              driver.stopThread(current.generation)
            }
          }
        }
      is T3VoiceControllerState.Thread -> {
        if (state.stage == T3VoiceThreadStage.STOPPING) return duplicate()
        if (state.stage == T3VoiceThreadStage.STARTING && clearPendingInitialStart()) {
          update(T3VoiceControllerState.Idle)
          return applied()
        }
        update(state.copy(stage = T3VoiceThreadStage.STOPPING))
        runDriver(T3VoiceOperation.THREAD) { driver.stopThread(current.generation) }
      }
    }
    return applied()
  }

  private fun realtimeConnected(): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage != T3VoiceRealtimeStage.STARTING) return false
    update(state.copy(stage = T3VoiceRealtimeStage.CONNECTED))
    return true
  }

  private fun realtimeClosed(): Boolean {
    return when (val state = current.state) {
      is T3VoiceControllerState.Realtime -> {
        if (state.stage != T3VoiceRealtimeStage.STOPPING) return false
        update(T3VoiceControllerState.Idle)
        true
      }
      is T3VoiceControllerState.SwitchingToThread -> {
        if (state.stage != T3VoiceSwitchStage.CLOSING_REALTIME) return false
        advanceGeneration(state.copy(stage = T3VoiceSwitchStage.STARTING_RECORDER))
        runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
          driver.startThreadAfterRealtime(current.generation, state.threadStart)
        }
        true
      }
      else -> false
    }
  }

  private fun nativeReleaseQuiesced(): Boolean {
    val state = current.state as? T3VoiceControllerState.Failed ?: return false
    if (!failedReleasePending) return false
    failedReleasePending = false
    if (failedStopRequested) {
      failedStopRequested = false
      update(T3VoiceControllerState.Idle)
    }
    return true
  }

  private fun threadRecordingStarted(): Boolean {
    return when (val state = current.state) {
      is T3VoiceControllerState.SwitchingToThread -> {
        if (state.stage != T3VoiceSwitchStage.STARTING_RECORDER) return false
        update(
          T3VoiceControllerState.Thread(
            T3VoiceThreadStage.RECORDING,
            state.threadStart.target,
            state.threadStart.settings,
            transcript = null,
            attention = null,
          ),
        )
        true
      }
      is T3VoiceControllerState.Thread -> {
        if (state.stage != T3VoiceThreadStage.STARTING) return false
        update(state.copy(stage = T3VoiceThreadStage.RECORDING))
        true
      }
      else -> false
    }
  }

  private fun realtimeClientActionReceived(action: T3VoiceRealtimeClientAction): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) return false
    if (state.pendingClientActions.any { it.actionId == action.actionId }) return false
    if (
      state.pendingClientActions.size >=
        T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CLIENT_ACTIONS
    ) {
      fail(
        T3VoiceOperation.REALTIME,
        T3VoiceFailure(
          code = "realtime-client-action-overflow",
          message = "Realtime sent too many pending client actions.",
          recoverable = true,
        ),
      )
      return true
    }
    update(state.copy(pendingClientActions = state.pendingClientActions + action))
    return true
  }

  private fun realtimeClientActionResolved(actionId: String): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.pendingClientActions.none { it.actionId == actionId }) return false
    update(
      state.copy(
        pendingClientActions = state.pendingClientActions.filterNot { it.actionId == actionId },
      ),
    )
    return true
  }

  private fun realtimeAudioRoutesChanged(routes: List<T3VoiceAudioRoute>): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage == T3VoiceRealtimeStage.STOPPING || state.audioRoutes == routes) return false
    update(state.copy(audioRoutes = routes))
    return true
  }

  private fun realtimeTranscriptChanged(
    transcript: List<T3VoiceRealtimeTranscriptTurn>,
  ): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage == T3VoiceRealtimeStage.STOPPING || state.transcript == transcript) return false
    update(state.copy(transcript = transcript))
    return true
  }

  private fun realtimeConfirmationReceived(
    confirmation: T3VoiceRealtimeConfirmation,
  ): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage == T3VoiceRealtimeStage.STOPPING) return false
    if (state.pendingConfirmations.any { it.confirmationId == confirmation.confirmationId }) {
      return false
    }
    if (
      state.pendingConfirmations.size >=
        T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CONFIRMATIONS
    ) {
      fail(
        T3VoiceOperation.REALTIME,
        T3VoiceFailure(
          code = "realtime-confirmation-overflow",
          message = "Realtime sent too many pending confirmations.",
          recoverable = true,
        ),
      )
      return true
    }
    update(state.copy(pendingConfirmations = state.pendingConfirmations + confirmation))
    return true
  }

  private fun realtimeConfirmationResolved(confirmationId: String): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.pendingConfirmations.none { it.confirmationId == confirmationId }) return false
    update(
      state.copy(
        pendingConfirmations =
          state.pendingConfirmations.filterNot { it.confirmationId == confirmationId },
      ),
    )
    return true
  }

  private fun threadEndpointDetected(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.RECORDING) return false
    update(state.copy(stage = T3VoiceThreadStage.FINALIZING))
    runDriver(T3VoiceOperation.THREAD) { driver.finishThreadRecording(current.generation) }
    return true
  }

  private fun threadNoSpeechDetected(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.RECORDING) return false
    if (!state.settings.autoRearm) {
      fail(
        T3VoiceOperation.THREAD,
        T3VoiceFailure(
          code = "no-speech",
          message = "No speech was detected.",
          recoverable = true,
        ),
      )
      return true
    }
    scheduleThreadRearm(state)
    return true
  }

  private fun threadRecordingFinalized(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.FINALIZING) return false
    update(state.copy(stage = T3VoiceThreadStage.UPLOADING))
    runDriver(T3VoiceOperation.THREAD) {
      driver.uploadAndTranscribeThreadRecording(current.generation)
    }
    return true
  }

  private fun threadTranscriptReady(transcript: String): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.UPLOADING) return false
    if (state.settings.submissionPolicy == T3VoiceThreadSubmissionPolicy.REVIEW) {
      val reviewId = current.sequence + 1
      update(
        state.copy(
          stage = T3VoiceThreadStage.REVIEWING,
          transcript = transcript,
          reviewId = reviewId,
        ),
      )
      return true
    }
    update(state.copy(stage = T3VoiceThreadStage.SUBMITTING, transcript = transcript))
    runDriver(T3VoiceOperation.THREAD) {
      driver.submitThreadTranscript(current.generation, transcript)
    }
    return true
  }

  private fun threadSubmitted(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.SUBMITTING) return false
    update(state.copy(stage = T3VoiceThreadStage.WAITING))
    runDriver(T3VoiceOperation.THREAD) { driver.waitForThreadResponse(current.generation) }
    return true
  }

  private fun threadResponseReady(hasPlayback: Boolean): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.WAITING) return false
    val readyState = state.copy(attention = null)
    if (hasPlayback && state.settings.playResponses) {
      update(readyState.copy(stage = T3VoiceThreadStage.PLAYING))
      runDriver(T3VoiceOperation.THREAD) { driver.startThreadPlayback(current.generation) }
    } else {
      completeThreadCycle(readyState)
    }
    return true
  }

  private fun threadAttentionChanged(attention: T3VoiceThreadAttention?): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.WAITING || state.attention == attention) return false
    update(state.copy(attention = attention))
    return true
  }

  private fun threadPlaybackFinished(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.PLAYING) return false
    completeThreadCycle(state)
    return true
  }

  private fun threadRearmReady(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.REARMING) return false
    update(
      state.copy(
        stage = T3VoiceThreadStage.STARTING,
        transcript = null,
        attention = null,
        reviewId = null,
      ),
    )
    runDriver(T3VoiceOperation.THREAD) {
      driver.rearmThreadRecording(current.generation)
    }
    return true
  }

  private fun completeThreadCycle(state: T3VoiceControllerState.Thread) {
    if (state.settings.autoRearm) {
      scheduleThreadRearm(state)
    } else {
      update(state.copy(stage = T3VoiceThreadStage.STOPPING))
      runDriver(T3VoiceOperation.THREAD) { driver.stopThread(current.generation) }
    }
  }

  private fun scheduleThreadRearm(state: T3VoiceControllerState.Thread) {
    update(state.copy(stage = T3VoiceThreadStage.REARMING))
    runDriver(T3VoiceOperation.THREAD) {
      driver.scheduleThreadRearm(current.generation, state.settings.rearmDelayMs)
    }
  }

  private fun threadStopped(): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    if (state.stage != T3VoiceThreadStage.STOPPING) return false
    update(T3VoiceControllerState.Idle)
    return true
  }

  private fun fail(failure: T3VoiceFailure, releasePending: Boolean): Boolean {
    val state = current.state
    val operation = state.activeOperation() ?: return false
    val stopAlreadyRequested =
      state is T3VoiceControllerState.Realtime &&
        state.stage == T3VoiceRealtimeStage.STOPPING
    fail(operation, failure, releasePending, stopAlreadyRequested)
    return true
  }

  private fun begin(state: T3VoiceControllerState) {
    failedReleasePending = false
    failedStopRequested = false
    publish(
      T3VoiceControllerSnapshot(
        state = state,
        generation = current.generation + 1,
        sequence = current.sequence + 1,
      ),
    )
  }

  private fun advanceGeneration(state: T3VoiceControllerState) {
    publish(
      current.copy(
        state = state,
        generation = current.generation + 1,
        sequence = current.sequence + 1,
      ),
    )
  }

  private fun update(state: T3VoiceControllerState) {
    publish(current.copy(state = state, sequence = current.sequence + 1))
  }

  private fun publish(snapshot: T3VoiceControllerSnapshot) {
    current = snapshot
    mutableSnapshots.value = snapshot
  }

  private inline fun runDriver(operation: T3VoiceOperation, action: () -> Unit) {
    try {
      action()
    } catch (_: Throwable) {
      fail(
        operation,
        T3VoiceFailure(
          code = "native-operation-failed",
          message = "The native voice operation failed.",
          recoverable = true,
        ),
      )
    }
  }

  private fun fail(
    operation: T3VoiceOperation,
    failure: T3VoiceFailure,
    releasePending: Boolean = false,
    stopAlreadyRequested: Boolean = false,
  ) {
    pendingInitialStart = null
    val driverReleasePending =
      runCatching { driver.releaseAll(current.generation) }.getOrDefault(false)
    failedReleasePending = releasePending || driverReleasePending
    failedStopRequested = failedReleasePending && stopAlreadyRequested
    update(T3VoiceControllerState.Failed(operation, failure))
  }

  private fun applied() = T3VoiceCommandResult(T3VoiceCommandOutcome.APPLIED, current)

  private fun duplicate() = T3VoiceCommandResult(T3VoiceCommandOutcome.DUPLICATE, current)

  private fun rejected(rejection: T3VoiceCommandRejection) =
    T3VoiceCommandResult(T3VoiceCommandOutcome.REJECTED, current, rejection)

  private fun clearPendingInitialStart(): Boolean {
    if (pendingInitialStart?.generation != current.generation) return false
    pendingInitialStart = null
    return true
  }

  private fun T3VoiceControllerState.activeOperation(): T3VoiceOperation? =
    when (this) {
      T3VoiceControllerState.Idle -> null
      is T3VoiceControllerState.Realtime -> T3VoiceOperation.REALTIME
      is T3VoiceControllerState.SwitchingToThread -> T3VoiceOperation.SWITCHING_TO_THREAD
      is T3VoiceControllerState.Thread -> T3VoiceOperation.THREAD
      is T3VoiceControllerState.Failed -> null
    }
}
