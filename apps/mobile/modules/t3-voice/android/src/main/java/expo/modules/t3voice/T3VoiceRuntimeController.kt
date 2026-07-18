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

  fun closeRealtime(
    generation: Long,
    policy: T3VoiceRealtimeClosePolicy,
  )

  fun cancelRealtimeToThreadSwitch(generation: Long)

  fun setRealtimeMuted(generation: Long, muted: Boolean)

  /** Schedules the server context update for the current Realtime session. */
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

  /** Cancels active Thread TTS without tearing down the session; session emits playback finished. */
  fun cancelThreadPlayback(generation: Long)

  fun scheduleThreadRearm(generation: Long, delayMs: Long)

  fun stopThread(generation: Long)

  /** Best-effort synchronous local cleanup before a failure snapshot is exposed. */
  /** Returns true when an exact native owner will report asynchronous release quiescence. */
  fun releaseAll(generation: Long): Boolean
}

internal enum class T3VoiceRealtimeClosePolicy {
  STOP_IMMEDIATELY,
  SWITCH_IMMEDIATELY,
  STOP_AFTER_PLAYOUT,
  SWITCH_AFTER_PLAYOUT,
  ;

  val preservesSessionForThread: Boolean
    get() = this == SWITCH_IMMEDIATELY || this == SWITCH_AFTER_PLAYOUT

  val drainsPlayout: Boolean
    get() = this == STOP_AFTER_PLAYOUT || this == SWITCH_AFTER_PLAYOUT
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
  private val terminalFailureSink: (T3VoiceControllerSnapshot) -> Unit = {},
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

  private data class PendingThreadToRealtime(
    val generation: Long,
    val session: T3VoiceNativeSessionConfig,
  )

  private val lock = Any()
  private var pendingInitialStart: PendingInitialStart? = null
  private var pendingThreadToRealtime: PendingThreadToRealtime? = null
  private var stopRequestedGeneration: Long? = null
  private var failedReleasePending = false
  private var failedReleaseUncertain = false
  private var failedStopRequested = false
  private var terminalCloseFailure: T3VoiceFailure? = null

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
        is T3VoiceRuntimeCommand.SwitchThreadToRealtime ->
          switchToRealtime(command.target, command.session)
        is T3VoiceRuntimeCommand.SetRealtimeMuted -> setRealtimeMuted(command.muted)
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
        T3VoiceRuntimeCommand.SkipThreadPlayback -> skipThreadPlayback()
        is T3VoiceRuntimeCommand.UpdateThreadPlayResponses ->
          updateThreadPlayResponses(command.expectedGeneration, command.playResponses)
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
        is T3VoiceRuntimeCallback.RealtimeTerminalActionReceived ->
          realtimeTerminalActionReceived(callback.action)
        is T3VoiceRuntimeCallback.RealtimeTranscriptChanged ->
          realtimeTranscriptChanged(callback.transcript)
        is T3VoiceRuntimeCallback.RealtimeConfirmationReceived ->
          realtimeConfirmationReceived(callback.confirmation)
        is T3VoiceRuntimeCallback.RealtimeConfirmationResolved ->
          realtimeConfirmationResolved(callback.confirmationId)
        T3VoiceRuntimeCallback.ThreadRecordingStarted -> threadRecordingStarted()
        T3VoiceRuntimeCallback.ThreadEndpointDetected -> threadEndpointDetected()
        T3VoiceRuntimeCallback.ThreadNoSpeechDetected -> threadNoSpeechDetected()
        is T3VoiceRuntimeCallback.ThreadCycleFailed -> threadCycleFailed(callback.failure)
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
      emptyRealtimeState(T3VoiceRealtimeStage.STARTING, target),
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
      emptyThreadState(T3VoiceThreadStage.STARTING, requested),
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
          driver.closeRealtime(
            current.generation,
            T3VoiceRealtimeClosePolicy.SWITCH_IMMEDIATELY,
          )
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

  private fun switchToRealtime(
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ): T3VoiceCommandResult {
    return when (val state = current.state) {
      is T3VoiceControllerState.Thread -> {
        if (state.target.environmentId != target.environmentId) {
          return rejected(T3VoiceCommandRejection.INVALID_STATE)
        }
        if (
          state.stage == T3VoiceThreadStage.STARTING &&
            replacePendingInitialThreadStart(target, session)
        ) {
          return applied()
        }
        val threadStart = T3VoiceThreadStart(state.target, state.settings)
        pendingThreadToRealtime =
          PendingThreadToRealtime(
            generation = current.generation,
            session = session,
          )
        stopRequestedGeneration = null
        val switching =
          T3VoiceControllerState.SwitchingToRealtime(
            threadStart = threadStart,
            realtimeTarget = target,
          )
        update(switching)
        if (state.stage != T3VoiceThreadStage.STOPPING) {
          runDriver(T3VoiceOperation.SWITCHING_TO_REALTIME) {
            driver.stopThread(current.generation)
          }
        }
        applied()
      }
      is T3VoiceControllerState.SwitchingToRealtime ->
        if (state.realtimeTarget == target) duplicate() else rejected(T3VoiceCommandRejection.BUSY)
      is T3VoiceControllerState.Realtime ->
        if (state.target == target) duplicate() else rejected(T3VoiceCommandRejection.BUSY)
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

  private fun updateRealtimeContext(context: T3VoiceRealtimeContext): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Realtime
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.stage != T3VoiceRealtimeStage.CONNECTED) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    if (state.target.focus == context.focus &&
      state.target.threadSettings == context.threadSettings
    ) {
      return duplicate()
    }
    update(
      state.copy(
        target =
          state.target.copy(
            focus = context.focus,
            threadSettings = context.threadSettings,
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
    if (state.stage == T3VoiceRealtimeStage.STOPPING) {
      return rejected(T3VoiceCommandRejection.INVALID_STATE)
    }
    val action = state.pendingClientActions.firstOrNull { it.actionId == actionId }
      ?: return duplicate()
    val focus = T3VoiceRealtimeFocus(action.projectId, action.threadId)
    val nextTarget =
      if (outcome == T3VoiceClientActionOutcome.SUCCEEDED) {
        state.target.copy(focus = focus)
      } else {
        state.target
      }
    update(
      state.copy(
        target = nextTarget,
        pendingClientActions = state.pendingClientActions.filterNot { it.actionId == actionId },
      ),
    )
    runDriver(T3VoiceOperation.REALTIME) {
      if (outcome == T3VoiceClientActionOutcome.SUCCEEDED) {
        driver.updateRealtimeContext(
          current.generation,
          T3VoiceRealtimeContext(nextTarget.focus, nextTarget.threadSettings),
        )
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

  /**
   * Asks the session to cancel TTS. Stage stays [T3VoiceThreadStage.PLAYING] until the session
   * reports [T3VoiceRuntimeCallback.ThreadPlaybackFinished], which reuses [completeThreadCycle].
   */
  private fun skipThreadPlayback(): T3VoiceCommandResult {
    val state = current.state as? T3VoiceControllerState.Thread
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    // Tolerate the race where natural finish lands microseconds before skip.
    if (state.stage != T3VoiceThreadStage.PLAYING) return duplicate()
    runDriver(T3VoiceOperation.THREAD) { driver.cancelThreadPlayback(current.generation) }
    return applied()
  }

  private fun updateThreadPlayResponses(
    expectedGeneration: Long,
    playResponses: Boolean,
  ): T3VoiceCommandResult {
    if (expectedGeneration != current.generation) {
      return rejected(T3VoiceCommandRejection.STALE_GENERATION)
    }
    val state = current.state as? T3VoiceControllerState.Thread
      ?: return rejected(T3VoiceCommandRejection.INVALID_STATE)
    if (state.settings.playResponses == playResponses) return duplicate()
    val next = state.copy(settings = state.settings.copy(playResponses = playResponses))
    update(next)
    // Disabling while audible: skip current speech (complete cycle). Waiting just updates
    // settings so the next response is not played.
    if (!playResponses && state.stage == T3VoiceThreadStage.PLAYING) {
      runDriver(T3VoiceOperation.THREAD) { driver.cancelThreadPlayback(current.generation) }
    }
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
        stopRequestedGeneration = current.generation
        val alreadyRequested = failedStopRequested
        if (failedReleasePending && !failedReleaseUncertain) {
          runCatching { driver.releaseAll(current.generation) }
          failedStopRequested = true
          update(state)
          return if (alreadyRequested) duplicate() else applied()
        }
        val release = runCatching { driver.releaseAll(current.generation) }
        if (release.getOrElse { true }) {
          failedReleasePending = true
          failedReleaseUncertain = release.isFailure
          failedStopRequested = true
          update(state)
          return if (alreadyRequested) duplicate() else applied()
        }
        failedReleasePending = false
        failedReleaseUncertain = false
        failedStopRequested = false
        stopRequestedGeneration = null
        update(T3VoiceControllerState.Idle)
      }
      is T3VoiceControllerState.Realtime -> {
        if (state.stage == T3VoiceRealtimeStage.STOPPING) {
          val alreadyRequested = stopRequestedGeneration == current.generation
          stopRequestedGeneration = current.generation
          if (alreadyRequested) return duplicate()
          runDriver(T3VoiceOperation.REALTIME) {
            driver.closeRealtime(
              current.generation,
              T3VoiceRealtimeClosePolicy.STOP_IMMEDIATELY,
            )
          }
          return applied()
        }
        if (state.stage == T3VoiceRealtimeStage.STARTING && clearPendingInitialStart()) {
          stopRequestedGeneration = null
          update(T3VoiceControllerState.Idle)
          return applied()
        }
        stopRequestedGeneration = current.generation
        update(state.copy(stage = T3VoiceRealtimeStage.STOPPING))
        runDriver(T3VoiceOperation.REALTIME) {
          driver.closeRealtime(
            current.generation,
            T3VoiceRealtimeClosePolicy.STOP_IMMEDIATELY,
          )
        }
      }
      is T3VoiceControllerState.SwitchingToThread ->
        when (state.stage) {
          T3VoiceSwitchStage.CLOSING_REALTIME -> {
            stopRequestedGeneration = current.generation
            update(
              emptyRealtimeState(T3VoiceRealtimeStage.STOPPING, state.realtimeTarget),
            )
            runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
              driver.cancelRealtimeToThreadSwitch(current.generation)
            }
          }
          T3VoiceSwitchStage.STARTING_RECORDER -> {
            stopRequestedGeneration = current.generation
            update(
              emptyThreadState(T3VoiceThreadStage.STOPPING, state.threadStart),
            )
            runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
              driver.stopThread(current.generation)
            }
          }
        }
      is T3VoiceControllerState.SwitchingToRealtime -> {
        pendingThreadToRealtime = null
        stopRequestedGeneration = current.generation
        update(
          emptyThreadState(T3VoiceThreadStage.STOPPING, state.threadStart),
        )
      }
      is T3VoiceControllerState.Thread -> {
        if (state.stage == T3VoiceThreadStage.STOPPING) {
          stopRequestedGeneration = current.generation
          return duplicate()
        }
        if (state.stage == T3VoiceThreadStage.STARTING && clearPendingInitialStart()) {
          stopRequestedGeneration = null
          update(T3VoiceControllerState.Idle)
          return applied()
        }
        stopRequestedGeneration = current.generation
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
        val failure = terminalCloseFailure.also { terminalCloseFailure = null }
        if (failure != null && stopRequestedGeneration != current.generation) {
          publishTerminalFailure(
            T3VoiceControllerState.Failed(
              environmentId = state.target.environmentId,
              operation = T3VoiceOperation.SWITCHING_TO_THREAD,
              failure = failure,
            ),
          )
          return true
        }
        stopRequestedGeneration = null
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
    failedReleaseUncertain = false
    failedStopRequested = false
    stopRequestedGeneration = null
    update(T3VoiceControllerState.Idle)
    return true
  }

  fun settleQuiescedFailure(generation: Long): Boolean =
    synchronized(lock) {
      if (generation != current.generation || current.state !is T3VoiceControllerState.Failed) {
        return@synchronized false
      }
      if (failedReleasePending || failedReleaseUncertain) return@synchronized false
      failedStopRequested = false
      stopRequestedGeneration = null
      update(T3VoiceControllerState.Idle)
      true
    }

  private fun threadRecordingStarted(): Boolean {
    return when (val state = current.state) {
      is T3VoiceControllerState.SwitchingToThread -> {
        if (state.stage != T3VoiceSwitchStage.STARTING_RECORDER) return false
        update(
          emptyThreadState(T3VoiceThreadStage.RECORDING, state.threadStart),
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
    if (state.stage == T3VoiceRealtimeStage.STOPPING) return false
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

  private fun realtimeTerminalActionReceived(action: T3VoiceRealtimeTerminalAction): Boolean {
    val state = current.state as? T3VoiceControllerState.Realtime ?: return false
    if (state.stage == T3VoiceRealtimeStage.STOPPING) return false
    when (action) {
      is T3VoiceRealtimeTerminalAction.StopRealtime -> {
        update(state.copy(stage = T3VoiceRealtimeStage.STOPPING))
        runDriver(T3VoiceOperation.REALTIME) {
          driver.closeRealtime(
            current.generation,
            T3VoiceRealtimeClosePolicy.STOP_AFTER_PLAYOUT,
          )
        }
      }
      is T3VoiceRealtimeTerminalAction.SwitchToThread -> {
        val settings = state.target.threadSettings
        if (settings == null) {
          terminalCloseFailure =
            T3VoiceFailure(
              code = "thread-settings-unavailable",
              message = "Thread voice settings are unavailable for this Realtime session.",
              recoverable = true,
            )
          update(state.copy(stage = T3VoiceRealtimeStage.STOPPING))
          runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
            driver.closeRealtime(
              current.generation,
              T3VoiceRealtimeClosePolicy.STOP_AFTER_PLAYOUT,
            )
          }
        } else {
          val threadStart =
            T3VoiceThreadStart(
              target = action.target.inEnvironment(state.target.environmentId),
              settings = settings,
            )
          update(
            T3VoiceControllerState.SwitchingToThread(
              stage = T3VoiceSwitchStage.CLOSING_REALTIME,
              realtimeTarget = state.target,
              threadStart = threadStart,
            ),
          )
          runDriver(T3VoiceOperation.SWITCHING_TO_THREAD) {
            driver.closeRealtime(
              current.generation,
              T3VoiceRealtimeClosePolicy.SWITCH_AFTER_PLAYOUT,
            )
          }
        }
      }
    }
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
    if (
      state.stage != T3VoiceThreadStage.RECORDING &&
      state.stage != T3VoiceThreadStage.FINALIZING &&
      state.stage != T3VoiceThreadStage.UPLOADING
    ) return false
    settleThreadCycle(state, cycleFailure = null)
    return true
  }

  private fun threadCycleFailed(failure: T3VoiceFailure): Boolean {
    val state = current.state as? T3VoiceControllerState.Thread ?: return false
    val safeStage =
      state.stage == T3VoiceThreadStage.STARTING ||
        state.stage == T3VoiceThreadStage.RECORDING ||
        state.stage == T3VoiceThreadStage.FINALIZING ||
        state.stage == T3VoiceThreadStage.UPLOADING
    if (!safeStage || !failure.recoverable) {
      fail(T3VoiceOperation.THREAD, failure)
      return true
    }
    settleThreadCycle(state, cycleFailure = failure)
    return true
  }

  private fun settleThreadCycle(
    state: T3VoiceControllerState.Thread,
    cycleFailure: T3VoiceFailure?,
  ) {
    val settled =
      state.copy(
        transcript = null,
        attention = null,
        reviewId = null,
        cycleFailure = cycleFailure,
      )
    if (state.settings.autoRearm) {
      scheduleThreadRearm(settled)
    } else {
      update(settled.copy(stage = T3VoiceThreadStage.STOPPING))
      runDriver(T3VoiceOperation.THREAD) { driver.stopThread(current.generation) }
    }
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
        cycleFailure = null,
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
    return when (val state = current.state) {
      is T3VoiceControllerState.Thread -> {
        if (state.stage != T3VoiceThreadStage.STOPPING) return false
        stopRequestedGeneration = null
        update(T3VoiceControllerState.Idle)
        true
      }
      is T3VoiceControllerState.SwitchingToRealtime -> {
        startRealtimeAfterThread(state)
        true
      }
      else -> false
    }
  }

  private fun startRealtimeAfterThread(state: T3VoiceControllerState.SwitchingToRealtime) {
    val pending =
      pendingThreadToRealtime?.takeIf { it.generation == current.generation }
        ?: error("The pending Realtime admission was lost during the Thread switch.")
    pendingThreadToRealtime = null
    advanceGeneration(emptyRealtimeState(T3VoiceRealtimeStage.STARTING, state.realtimeTarget))
    runDriver(T3VoiceOperation.SWITCHING_TO_REALTIME) {
      driver.startRealtime(current.generation, state.realtimeTarget, pending.session)
    }
  }

  private fun emptyRealtimeState(
    stage: T3VoiceRealtimeStage,
    target: T3VoiceRealtimeTarget,
  ) =
    T3VoiceControllerState.Realtime(
      stage = stage,
      target = target,
      muted = false,
      pendingClientActions = emptyList(),
      transcript = emptyList(),
      pendingConfirmations = emptyList(),
    )

  private fun emptyThreadState(
    stage: T3VoiceThreadStage,
    start: T3VoiceThreadStart,
  ) =
    T3VoiceControllerState.Thread(
      stage = stage,
      target = start.target,
      settings = start.settings,
      transcript = null,
      attention = null,
      cycleFailure = null,
    )

  private fun fail(failure: T3VoiceFailure, releasePending: Boolean): Boolean {
    val state = current.state
    val operation = state.activeOperation() ?: return false
    fail(operation, failure, releasePending)
    return true
  }

  private fun begin(state: T3VoiceControllerState) {
    pendingThreadToRealtime = null
    stopRequestedGeneration = null
    failedReleasePending = false
    failedReleaseUncertain = false
    failedStopRequested = false
    terminalCloseFailure = null
    publish(
      T3VoiceControllerSnapshot(
        state = state,
        generation = current.generation + 1,
        sequence = current.sequence + 1,
      ),
    )
  }

  private fun advanceGeneration(state: T3VoiceControllerState) {
    terminalCloseFailure = null
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
  ) {
    pendingInitialStart = null
    pendingThreadToRealtime = null
    terminalCloseFailure = null
    val failedEnvironmentId = checkNotNull(current.state.environmentId()) {
      "An active voice operation must retain its environment identity."
    }
    val stopAlreadyRequested = stopRequestedGeneration == current.generation
    // A thrown cleanup cannot prove that native ownership ended. Keep the generation fenced until
    // exact quiescence arrives or a later Stop successfully proves that no owner remains.
    val driverRelease = runCatching { driver.releaseAll(current.generation) }
    val driverReleasePending = driverRelease.getOrElse { true }
    failedReleasePending = releasePending || driverReleasePending
    failedReleaseUncertain = !releasePending && driverRelease.isFailure
    val failedState = T3VoiceControllerState.Failed(failedEnvironmentId, operation, failure)
    if (stopAlreadyRequested && !failedReleasePending) {
      emitTerminalFailure(failedState)
      stopRequestedGeneration = null
      failedStopRequested = false
      update(T3VoiceControllerState.Idle)
      return
    }
    failedStopRequested = failedReleasePending && stopAlreadyRequested
    publishTerminalFailure(failedState)
  }

  private fun publishTerminalFailure(state: T3VoiceControllerState.Failed) {
    val snapshot = current.copy(state = state, sequence = current.sequence + 1)
    runCatching { terminalFailureSink(snapshot) }
    publish(snapshot)
  }

  private fun emitTerminalFailure(state: T3VoiceControllerState.Failed) {
    runCatching {
      terminalFailureSink(current.copy(state = state, sequence = current.sequence + 1))
    }
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

  private fun replacePendingInitialThreadStart(
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ): Boolean {
    val pending = pendingInitialStart as? PendingInitialStart.Thread ?: return false
    if (pending.generation != current.generation) return false
    pendingInitialStart = PendingInitialStart.Realtime(current.generation, target, session)
    update(emptyRealtimeState(T3VoiceRealtimeStage.STARTING, target))
    return true
  }

  private fun T3VoiceControllerState.activeOperation(): T3VoiceOperation? =
    when (this) {
      T3VoiceControllerState.Idle -> null
      is T3VoiceControllerState.Realtime -> T3VoiceOperation.REALTIME
      is T3VoiceControllerState.SwitchingToThread -> T3VoiceOperation.SWITCHING_TO_THREAD
      is T3VoiceControllerState.SwitchingToRealtime -> T3VoiceOperation.SWITCHING_TO_REALTIME
      is T3VoiceControllerState.Thread -> T3VoiceOperation.THREAD
      is T3VoiceControllerState.Failed -> null
    }

  private fun T3VoiceControllerState.environmentId(): String? =
    when (this) {
      T3VoiceControllerState.Idle -> null
      is T3VoiceControllerState.Realtime -> target.environmentId
      is T3VoiceControllerState.SwitchingToThread -> realtimeTarget.environmentId
      is T3VoiceControllerState.SwitchingToRealtime -> realtimeTarget.environmentId
      is T3VoiceControllerState.Thread -> target.environmentId
      is T3VoiceControllerState.Failed -> environmentId
    }
}
