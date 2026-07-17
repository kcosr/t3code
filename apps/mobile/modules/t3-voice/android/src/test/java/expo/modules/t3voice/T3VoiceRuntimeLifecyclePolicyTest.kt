package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRuntimeLifecyclePolicyTest {
  @Test
  fun foregroundAndWakeLockRemainOwnedAcrossThreadPipelineAndSwitch() {
    val threadStates =
      listOf(
        T3VoiceThreadStage.FINALIZING,
        T3VoiceThreadStage.UPLOADING,
        T3VoiceThreadStage.WAITING,
        T3VoiceThreadStage.PLAYING,
        T3VoiceThreadStage.REARMING,
      ).map { stage -> threadState(stage) }
    val switching =
      T3VoiceControllerState.SwitchingToThread(
        stage = T3VoiceSwitchStage.CLOSING_REALTIME,
        realtimeTarget = realtimeTarget,
        threadStart = T3VoiceThreadStart(threadTarget, settings),
      )

    (threadStates + switching).forEach { state ->
      assertTrue(T3VoiceRuntimeLifecyclePolicy.needsForeground(state))
      assertTrue(T3VoiceRuntimeLifecyclePolicy.shouldHoldWakeLock(state))
    }
  }

  @Test
  fun recorderFinalizationCannotReleaseForegroundDuringUploadOrWait() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    val session = nativeSession()
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)

    assertEquals(T3VoiceThreadStage.UPLOADING, controller.threadState().stage)
    assertTrue(controller.snapshot().state.needsForeground())

    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("hello"))
    val reviewId = checkNotNull(controller.threadState().reviewId)
    controller.dispatch(T3VoiceRuntimeCommand.SubmitThreadTranscript(1, reviewId, "hello"))
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted)

    assertEquals(T3VoiceThreadStage.WAITING, controller.threadState().stage)
    assertTrue(controller.snapshot().state.needsForeground())
  }

  @Test
  fun exactPeerCloseRetainsForegroundWhileStartingThreadRecorder() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, nativeSession()))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    controller.dispatch(T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, settings))
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed)

    val switching = controller.snapshot().state as T3VoiceControllerState.SwitchingToThread
    assertEquals(T3VoiceSwitchStage.STARTING_RECORDER, switching.stage)
    assertTrue(switching.needsForeground())

    controller.onCallback(2, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    assertEquals(T3VoiceThreadStage.RECORDING, controller.threadState().stage)
    assertTrue(controller.snapshot().state.needsForeground())
  }

  @Test
  fun failedSnapshotRetainsForegroundWithoutHoldingAWakeLockUntilExplicitStop() {
    val failed =
      T3VoiceControllerState.Failed(
        environmentId = "environment-a",
        operation = T3VoiceOperation.THREAD,
        failure = T3VoiceFailure("failed", "Voice stopped.", recoverable = true),
      )

    assertFalse(T3VoiceRuntimeLifecyclePolicy.needsForeground(T3VoiceControllerState.Idle))
    assertTrue(T3VoiceRuntimeLifecyclePolicy.needsForeground(failed))
    assertFalse(T3VoiceRuntimeLifecyclePolicy.shouldHoldWakeLock(failed))
    assertFalse(T3VoiceRuntimeAdmissionPolicy.canStartLegacy(failed))
    assertEquals(
      listOf(T3VoiceNotificationActionId.STOP),
      T3VoiceNotificationActions.forSnapshot(
        T3VoiceControllerSnapshot(failed, generation = 1, sequence = 4),
      ).map { it.id },
    )

    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, nativeSession()))
    controller.activateInitialStart(1)
    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.Failed(
        T3VoiceFailure("failed", "Voice stopped.", recoverable = true),
      ),
    )
    assertTrue(controller.snapshot().state.needsForeground())

    controller.dispatch(T3VoiceRuntimeCommand.Stop)
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(controller.snapshot().state.needsForeground())
  }

  @Test
  fun semanticAndLegacyMediaAdmissionAreMutuallyExclusive() {
    assertFalse(
      T3VoiceRuntimeAdmissionPolicy.canStartSemantic(
        hasLegacyMediaOwner = true,
      ),
    )
    assertFalse(T3VoiceRuntimeAdmissionPolicy.canStartLegacy(threadState(T3VoiceThreadStage.WAITING)))
    assertTrue(
      T3VoiceRuntimeAdmissionPolicy.canStartSemantic(
        hasLegacyMediaOwner = false,
      ),
    )
    assertTrue(T3VoiceRuntimeAdmissionPolicy.canStartLegacy(T3VoiceControllerState.Idle))
  }

  @Test
  fun delayedOldStartNeverStopsAServiceOwnedByANewerGeneration() {
    val newer =
      T3VoiceControllerSnapshot(
        state = realtimeState(T3VoiceRealtimeStage.STARTING),
        generation = 2,
        sequence = 4,
      )

    assertEquals(
      T3VoiceSemanticStartIntentDecision.IGNORE_STALE,
      T3VoiceSemanticStartIntentPolicy.decide(
        requestedGeneration = 1,
        snapshot = newer,
        serviceCompletelyIdle = false,
      ),
    )
    assertEquals(
      T3VoiceSemanticStartIntentDecision.ACTIVATE,
      T3VoiceSemanticStartIntentPolicy.decide(
        requestedGeneration = 2,
        snapshot = newer,
        serviceCompletelyIdle = false,
      ),
    )
  }

  @Test
  fun staleStartCanStopOnlyACompletelyIdleService() {
    val idle = T3VoiceControllerSnapshot(T3VoiceControllerState.Idle, 2, 5)

    assertEquals(
      T3VoiceSemanticStartIntentDecision.STOP_IDLE_SERVICE,
      T3VoiceSemanticStartIntentPolicy.decide(
        requestedGeneration = 1,
        snapshot = idle,
        serviceCompletelyIdle = true,
      ),
    )
    assertEquals(
      T3VoiceSemanticStartIntentDecision.IGNORE_STALE,
      T3VoiceSemanticStartIntentPolicy.decide(
        requestedGeneration = 1,
        snapshot = idle,
        serviceCompletelyIdle = false,
      ),
    )
  }

  @Test
  fun failedInitialForegroundPromotionStopsTheUnpromotedStartedService() {
    assertEquals(
      T3VoiceSemanticStartFailureDecision.STOP_UNPROMOTED_START,
      T3VoiceSemanticStartFailurePolicy.decide(foregroundAcquired = false),
    )
    assertEquals(
      T3VoiceSemanticStartFailureDecision.RETAIN_FOREGROUND_FAILURE,
      T3VoiceSemanticStartFailurePolicy.decide(foregroundAcquired = true),
    )
  }

  private fun threadState(stage: T3VoiceThreadStage) =
    T3VoiceControllerState.Thread(
      stage = stage,
      target = threadTarget,
      settings = settings,
      transcript = null,
      attention = null,
    )

  private fun realtimeState(stage: T3VoiceRealtimeStage) =
    T3VoiceControllerState.Realtime(
      stage = stage,
      target = realtimeTarget,
      muted = false,
      pendingClientActions = emptyList(),
      audioRoutes = emptyList(),
      transcript = emptyList(),
      pendingConfirmations = emptyList(),
    )

  private fun T3VoiceRuntimeController.threadState() =
    snapshot().state as T3VoiceControllerState.Thread

  private fun nativeSession() =
    T3VoiceNativeSessionConfig(
      baseUrl = "https://example.test/",
      accessToken = "test-token",
      expiresAt = "2099-01-01T00:00:00Z",
    )

  private val threadTarget =
    T3VoiceThreadTarget(
      environmentId = "environment-a",
      projectId = "project-a",
      threadId = "thread-a",
      modelSelection =
        T3VoiceModelSelection(
          instanceId = "codex",
          model = "gpt-5.4",
          options = null,
        ),
      runtimeMode = T3VoiceThreadRuntimeMode.FULL_ACCESS,
      interactionMode = T3VoiceThreadInteractionMode.DEFAULT,
    )
  private val settings =
    T3VoiceThreadSettings(
      submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW,
      playResponses = true,
      autoRearm = true,
      endpointDetection = T3VoiceThreadEndpointDetection(500, null, 30_000),
      rearmDelayMs = 250,
      transcriptionTimeoutMs = 10_000,
      submissionTimeoutMs = 10_000,
      responseTimeoutMs = 30_000,
    )
  private val realtimeTarget =
    T3VoiceRealtimeTarget(
      environmentId = "environment-a",
      conversation =
        T3VoiceConversationSelection.New(T3VoiceConversationRetention.EPHEMERAL, null),
      focus = T3VoiceRealtimeFocus("project-a", "thread-a"),
      threadSwitch = T3VoiceThreadStart(threadTarget, settings),
    )
}
