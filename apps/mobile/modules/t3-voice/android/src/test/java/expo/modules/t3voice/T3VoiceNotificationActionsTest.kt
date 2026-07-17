package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceNotificationActionsTest {
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
      runtimeMode = T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS,
      interactionMode = T3VoiceThreadInteractionMode.PLAN,
    )
  private val settings =
    T3VoiceThreadSettings(
      submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW,
      playResponses = true,
      autoRearm = false,
      endpointDetection =
        T3VoiceThreadEndpointDetection(
          endSilenceMs = 900,
          noSpeechTimeoutMs = null,
          maximumUtteranceMs = 120_000,
        ),
      rearmDelayMs = 0,
      transcriptionTimeoutMs = 600_000,
      submissionTimeoutMs = 30_000,
      responseTimeoutMs = 600_000,
    )
  private val realtimeTarget =
    T3VoiceRealtimeTarget(
      environmentId = "environment-a",
      conversation =
        T3VoiceConversationSelection.Continue(
          conversationId = "conversation-a",
          takeover = false,
        ),
      focus = T3VoiceRealtimeFocus(projectId = "project-a", threadId = "thread-a"),
      threadSwitch = T3VoiceThreadStart(threadTarget, settings),
    )
  private val session =
    T3VoiceNativeSessionConfig(
      baseUrl = "https://example.test",
      accessToken = "test-token",
      expiresAt = "2099-01-01T00:00:00Z",
    )

  @Test
  fun realtimeNotificationCommandsUseTheControllerCommandPath() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)

    val connectedActions =
      T3VoiceNotificationActions.forSnapshot(controller.snapshot())
    assertEquals(
      listOf(
        T3VoiceNotificationActionId.MUTE,
        T3VoiceNotificationActionId.SWITCH_TO_THREAD,
        T3VoiceNotificationActionId.STOP,
      ),
      connectedActions.map { it.id },
    )

    val mute = connectedActions.single { it.id == T3VoiceNotificationActionId.MUTE }
    assertEquals(T3VoiceCommandOutcome.APPLIED, controller.dispatch(mute.command).outcome)
    val muted = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertTrue(muted.muted)

    val switch = connectedActions.single { it.id == T3VoiceNotificationActionId.SWITCH_TO_THREAD }
    assertEquals(T3VoiceCommandOutcome.APPLIED, controller.dispatch(switch.command).outcome)
    assertTrue(controller.snapshot().state is T3VoiceControllerState.SwitchingToThread)
  }

  @Test
  fun threadNotificationOnlyExposesControlsValidForItsStage() {
    val driver = NotificationFakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)

    assertEquals(
      listOf(
        T3VoiceNotificationActionId.FINISH_UTTERANCE,
        T3VoiceNotificationActionId.STOP,
      ),
      T3VoiceNotificationActions.forSnapshot(controller.snapshot()).map { it.id },
    )

    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    assertEquals(
      listOf(T3VoiceNotificationActionId.STOP),
      T3VoiceNotificationActions.forSnapshot(controller.snapshot()).map { it.id },
    )

    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.ThreadTranscriptReady("review this transcript"),
    )
    val reviewId =
      checkNotNull((controller.snapshot().state as T3VoiceControllerState.Thread).reviewId)
    controller.dispatch(
      T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(
        expectedGeneration = 1,
        expectedReviewId = reviewId,
        transcript = "edited notification transcript",
      ),
    )
    val reviewing = T3VoiceNotificationActions.forSnapshot(controller.snapshot())
    assertEquals(
      listOf(
        T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT,
        T3VoiceNotificationActionId.STOP,
      ),
      reviewing.map { it.id },
    )
    val submit = reviewing.single { it.id == T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT }
    assertEquals(
      T3VoiceRuntimeCommand.SubmitThreadTranscript(
        1,
        reviewId,
        "edited notification transcript",
      ),
      submit.command,
    )
    assertEquals(T3VoiceCommandOutcome.APPLIED, controller.dispatch(submit.command).outcome)
    assertEquals(listOf("edited notification transcript"), driver.submittedTranscripts)
  }

  @Test
  fun blankReviewEditHidesNotificationAndMediaSubmit() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("delete me"))
    val reviewId =
      checkNotNull((controller.snapshot().state as T3VoiceControllerState.Thread).reviewId)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, ""),
      ).outcome,
    )

    assertEquals(
      listOf(T3VoiceNotificationActionId.STOP),
      T3VoiceNotificationActions.forSnapshot(controller.snapshot()).map { it.id },
    )
    assertEquals("", (controller.snapshot().state as T3VoiceControllerState.Thread).transcript)
  }

  @Test
  fun idleAndStoppingSnapshotsDoNotAdvertiseInvalidActions() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    assertTrue(T3VoiceNotificationActions.forSnapshot(controller.snapshot()).isEmpty())

    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.dispatch(T3VoiceRuntimeCommand.Stop)
    assertTrue(T3VoiceNotificationActions.forSnapshot(controller.snapshot()).isEmpty())
  }

  @Test
  fun noSpeechRearmDelayAdvertisesOnlyStop() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(
        threadTarget,
        settings.copy(autoRearm = true, rearmDelayMs = 750),
        session,
      ),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)

    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected)

    val state = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(T3VoiceThreadStage.REARMING, state.stage)
    assertEquals(
      listOf(T3VoiceNotificationActionId.STOP),
      T3VoiceNotificationActions.forSnapshot(controller.snapshot()).map { it.id },
    )
  }

  @Test
  fun controlsPresentationSkipsNonVisualReviewUpdatesAndNoOpCommands() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("initial transcript"))
    val reviewId =
      checkNotNull((controller.snapshot().state as T3VoiceControllerState.Thread).reviewId)
    val presentations = T3VoiceAndroidControlsPresentationCache()

    assertNotNull(presentations.accept(controller.snapshot()))
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, "edited transcript"),
      ).outcome,
    )
    assertNull(presentations.accept(controller.snapshot()))

    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, "edited transcript"),
      ).outcome,
    )
    assertNull(presentations.accept(controller.snapshot()))

    assertEquals(
      T3VoiceCommandOutcome.REJECTED,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(2, reviewId, "stale transcript"),
      ).outcome,
    )
    assertNull(presentations.accept(controller.snapshot()))

    controller.dispatch(T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, ""))
    assertNotNull(presentations.accept(controller.snapshot()))
  }

  @Test
  fun controlsPresentationRefreshesGenerationFencedActions() {
    val controller = T3VoiceRuntimeController(NotificationFakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    val snapshot = controller.snapshot()
    val presentations = T3VoiceAndroidControlsPresentationCache()

    assertNotNull(presentations.accept(snapshot))
    assertNotNull(
      presentations.accept(
        snapshot.copy(generation = snapshot.generation + 1, sequence = snapshot.sequence + 1),
      ),
    )
  }

  @Test
  fun notificationPendingIntentIdentityIsStableForTheSameActionAndGeneration() {
    val first = T3VoiceNotificationActionId.MUTE.pendingIntentIdentity(generation = 42)
    val second = T3VoiceNotificationActionId.MUTE.pendingIntentIdentity(generation = 42)

    assertEquals(first, second)
    assertEquals("t3voice-runtime://semantic-control/42/MUTE", first.dataUri)
  }

  @Test
  fun notificationPendingIntentIdentityFencesGenerationsAndActions() {
    val muteGenerationOne =
      T3VoiceNotificationActionId.MUTE.pendingIntentIdentity(generation = 1)
    val muteGenerationTwo =
      T3VoiceNotificationActionId.MUTE.pendingIntentIdentity(generation = 2)
    val stopGenerationOne =
      T3VoiceNotificationActionId.STOP.pendingIntentIdentity(generation = 1)

    assertEquals(muteGenerationOne.requestCode, muteGenerationTwo.requestCode)
    assertNotEquals(muteGenerationOne.dataUri, muteGenerationTwo.dataUri)
    assertNotEquals(muteGenerationOne.dataUri, stopGenerationOne.dataUri)
    assertNotEquals(muteGenerationOne, muteGenerationTwo)
    assertNotEquals(muteGenerationOne, stopGenerationOne)
  }
}

private class NotificationFakeDriver : T3VoiceRuntimeDriver {
  val submittedTranscripts = mutableListOf<String>()

  override fun startRealtime(
    generation: Long,
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ) = Unit

  override fun closeRealtime(
    generation: Long,
    preserveSessionForThread: Boolean,
    drainPlayout: Boolean,
  ) = Unit

  override fun cancelRealtimeToThreadSwitch(generation: Long) = Unit

  override fun setRealtimeMuted(generation: Long, muted: Boolean) = Unit

  override fun setRealtimeAudioRoute(generation: Long, routeId: String) = Unit

  override fun updateRealtimeContext(generation: Long, context: T3VoiceRealtimeContext) = Unit

  override fun decideRealtimeConfirmation(
    generation: Long,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  ) = Unit

  override fun startInitialThread(
    generation: Long,
    start: T3VoiceThreadStart,
    session: T3VoiceNativeSessionConfig,
  ) = Unit

  override fun startThreadAfterRealtime(generation: Long, start: T3VoiceThreadStart) = Unit

  override fun rearmThreadRecording(generation: Long) = Unit

  override fun acknowledgeRealtimeClientAction(
    generation: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ) = Unit

  override fun finishThreadRecording(generation: Long) = Unit

  override fun uploadAndTranscribeThreadRecording(generation: Long) = Unit

  override fun submitThreadTranscript(generation: Long, transcript: String) {
    submittedTranscripts += transcript
  }

  override fun waitForThreadResponse(generation: Long) = Unit

  override fun startThreadPlayback(generation: Long) = Unit

  override fun scheduleThreadRearm(generation: Long, delayMs: Long) = Unit

  override fun stopThread(generation: Long) = Unit

  override fun releaseAll(generation: Long): Boolean = false
}
