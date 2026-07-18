package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRuntimeControllerTest {
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
  private val continuousSettings =
    T3VoiceThreadSettings(
      submissionPolicy = T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT,
      playResponses = true,
      autoRearm = true,
      endpointDetection =
        T3VoiceThreadEndpointDetection(
          endSilenceMs = 900,
          noSpeechTimeoutMs = 10_000,
          maximumUtteranceMs = 120_000,
        ),
      rearmDelayMs = 750,
      transcriptionTimeoutMs = 600_000,
      submissionTimeoutMs = 30_000,
      responseTimeoutMs = 600_000,
    )
  private val remoteThreadTarget =
    T3VoiceRemoteThreadTarget(
      projectId = threadTarget.projectId,
      threadId = threadTarget.threadId,
      modelSelection = threadTarget.modelSelection,
      runtimeMode = threadTarget.runtimeMode,
      interactionMode = threadTarget.interactionMode,
    )
  private val realtimeTarget =
    T3VoiceRealtimeTarget(
      environmentId = "environment-a",
      conversation =
        T3VoiceConversationSelection.New(
          retention = T3VoiceConversationRetention.DURABLE,
          title = "Voice conversation",
        ),
      focus = T3VoiceRealtimeFocus(projectId = "project-a", threadId = "thread-a"),
      threadSettings = continuousSettings,
    )
  private val session =
    T3VoiceNativeSessionConfig(
      baseUrl = "https://example.test",
      accessToken = "test-token",
      expiresAt = "2099-01-01T00:00:00Z",
    )

  @Test
  fun freshControllerStartsIdleWithoutRecoveredOwnership() {
    val controller = T3VoiceRuntimeController(FakeDriver())

    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertEquals(0, controller.snapshot().generation)
    assertEquals(0, controller.snapshot().sequence)
  }

  @Test
  fun controllerReservesOwnershipBeforeStartingNativeResources() {
    val driver = FakeDriver()
    lateinit var controller: T3VoiceRuntimeController
    driver.onAction = { action ->
      if (action == "start-realtime:1:environment-a") {
        val state = controller.snapshot().state as T3VoiceControllerState.Realtime
        assertEquals(T3VoiceRealtimeStage.STARTING, state.stage)
      }
    }
    controller = T3VoiceRuntimeController(driver)

    val result = controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))

    assertEquals(T3VoiceCommandOutcome.APPLIED, result.outcome)
    assertTrue(driver.actions.isEmpty())
    assertTrue(controller.activateInitialStart(1))
    assertEquals(listOf("start-realtime:1:environment-a"), driver.actions)
  }

  @Test
  fun stopBeforeForegroundActivationClearsPendingCredentialsWithoutStartingMedia() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(controller.activateInitialStart(1))
    assertTrue(driver.actions.isEmpty())
  }

  @Test
  fun competingStartsAreSerializedAndOnlyOneAcquiresResources() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    val executor = Executors.newFixedThreadPool(2)
    val ready = CountDownLatch(2)
    val start = CountDownLatch(1)
    val realtime =
      executor.submit<T3VoiceCommandOutcome> {
        ready.countDown()
        start.await()
        controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).outcome
      }
    val thread =
      executor.submit<T3VoiceCommandOutcome> {
        ready.countDown()
        start.await()
        controller.dispatch(
          T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
        ).outcome
      }

    ready.await()
    start.countDown()
    val outcomes = listOf(realtime.get(), thread.get())
    executor.shutdownNow()

    assertEquals(1, outcomes.count { it == T3VoiceCommandOutcome.APPLIED })
    assertEquals(1, outcomes.count { it == T3VoiceCommandOutcome.REJECTED })
    assertTrue(driver.actions.isEmpty())
    assertTrue(controller.activateInitialStart(controller.snapshot().generation))
    assertEquals(1, driver.actions.size)
  }

  @Test
  fun duplicateStartsAndSwitchesDoNotRepeatDriverWork() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).outcome,
    )
    assertTrue(controller.activateInitialStart(1))
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).outcome,
    )
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected))
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, continuousSettings),
      ).outcome,
    )
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, continuousSettings),
      ).outcome,
    )

    assertEquals(
      listOf("start-realtime:1:environment-a", "close-realtime:1:SWITCH_IMMEDIATELY"),
      driver.actions,
    )
  }

  @Test
  fun threadToRealtimeSwitchWaitsForExactThreadQuiescenceBeforeStartingRealtime() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session),
      ).outcome,
    )
    val switching = controller.snapshot().state as T3VoiceControllerState.SwitchingToRealtime
    assertEquals(threadTarget, switching.threadStart.target)
    assertEquals(realtimeTarget, switching.realtimeTarget)
    assertEquals(listOf("start-thread:1:thread-a", "stop-thread:1"), driver.actions)
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session),
      ).outcome,
    )

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    val starting = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(T3VoiceRealtimeStage.STARTING, starting.stage)
    assertEquals(2, controller.snapshot().generation)
    assertEquals("start-realtime:2:environment-a", driver.actions.last())
    assertTrue(controller.onCallback(2, T3VoiceRuntimeCallback.RealtimeConnected))
    assertEquals(
      T3VoiceRealtimeStage.CONNECTED,
      (controller.snapshot().state as T3VoiceControllerState.Realtime).stage,
    )
  }

  @Test
  fun threadToRealtimeSwitchBeforeThreadActivationNeverStartsTheRecorder() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session))

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session),
      ).outcome,
    )

    assertEquals(emptyList<String>(), driver.actions)
    assertEquals(1, controller.snapshot().generation)
    val starting = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(T3VoiceRealtimeStage.STARTING, starting.stage)
    assertEquals(realtimeTarget, starting.target)

    assertTrue(controller.activateInitialStart(1))
    assertEquals(listOf("start-realtime:1:environment-a"), driver.actions)
  }

  @Test
  fun stoppingAThreadToRealtimeSwitchCancelsThePendingRealtimeStart() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session))

    assertEquals(T3VoiceCommandOutcome.APPLIED, controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome)
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(driver.actions.any { it.startsWith("start-realtime") })
  }

  @Test
  fun realtimeResumeCanReplaceAnAlreadyStoppingThread() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.Stop)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session),
      ).outcome,
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.SwitchingToRealtime)
    assertEquals(1, driver.actions.count { it == "stop-thread:1" })

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals("start-realtime:2:environment-a", driver.actions.last())
  }

  @Test
  fun threadToRealtimeStartFailureReportsTheTransitionAndReleasesTheNewGeneration() {
    val driver = FakeDriver(failAction = "start-realtime:2:environment-a")
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.SwitchThreadToRealtime(realtimeTarget, session))

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    val failed = controller.snapshot().state as T3VoiceControllerState.Failed
    assertEquals(T3VoiceOperation.SWITCHING_TO_REALTIME, failed.operation)
    assertEquals("native-operation-failed", failed.failure.code)
    assertEquals("release-all:2", driver.actions.last())
  }

  @Test
  fun realtimeContextUpdatesLocallyBeforeSchedulingTheDriver() {
    val driver = FakeDriver()
    lateinit var controller: T3VoiceRuntimeController
    driver.onAction = { action ->
      if (action == "context-realtime:1:thread-b") {
        val state = controller.snapshot().state as T3VoiceControllerState.Realtime
        assertEquals("thread-b", state.target.focus?.threadId)
        assertEquals(null, state.target.threadSettings)
      }
    }
    controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    val context =
      T3VoiceRealtimeContext(
        focus = T3VoiceRealtimeFocus("project-b", "thread-b"),
        threadSettings = null,
      )

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.UpdateRealtimeContext(context)).outcome,
    )
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(T3VoiceRuntimeCommand.UpdateRealtimeContext(context)).outcome,
    )
    assertEquals(1, driver.actions.count { it == "context-realtime:1:thread-b" })
  }

  @Test
  fun switchWaitsForExactRealtimeReleaseBeforeStartingRecorder() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)

    controller.dispatch(
      T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, continuousSettings),
    )
    val closing = controller.snapshot().state as T3VoiceControllerState.SwitchingToThread
    assertEquals(T3VoiceSwitchStage.CLOSING_REALTIME, closing.stage)
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    assertEquals(2, driver.actions.size)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))
    val starting = controller.snapshot().state as T3VoiceControllerState.SwitchingToThread
    assertEquals(T3VoiceSwitchStage.STARTING_RECORDER, starting.stage)
    assertEquals("start-thread:2:thread-a", driver.actions.last())

    assertFalse(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(T3VoiceFailure("late-peer", "Late peer error.", true)),
      ),
    )
    assertTrue(controller.onCallback(2, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    val recording = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(T3VoiceThreadStage.RECORDING, recording.stage)
    assertEquals(2, controller.snapshot().generation)
  }

  @Test
  fun stoppingDuringPeerCloseCancelsThePendingSwitch() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    controller.dispatch(
      T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, continuousSettings),
    )

    controller.dispatch(T3VoiceRuntimeCommand.Stop)
    val stopping = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(T3VoiceRealtimeStage.STOPPING, stopping.stage)
    assertEquals("cancel-switch:1", driver.actions.last())
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))

    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(driver.actions.any { it.startsWith("start-thread") })
  }

  @Test
  fun agentTerminalStopDrainsOnceFromConnectedAndReturnsToIdle() {
    val driver = FakeDriver()
    val controller = connectedRealtimeController(driver)
    val action =
      T3VoiceRealtimeTerminalAction.StopRealtime("terminal-stop")

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(action),
      ),
    )
    assertEquals(
      T3VoiceRealtimeStage.STOPPING,
      (controller.snapshot().state as T3VoiceControllerState.Realtime).stage,
    )
    assertEquals("close-realtime:1:STOP_AFTER_PLAYOUT", driver.actions.last())
    assertFalse(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(action),
      ),
    )
    assertFalse(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(
          T3VoiceRealtimeTerminalAction.StopRealtime("terminal-stop-other"),
        ),
      ),
    )
    assertEquals(1, driver.actions.count { it == "close-realtime:1:STOP_AFTER_PLAYOUT" })

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun agentTerminalSwitchIsAdmittedDuringStartingAndUsesTheResolvedTarget() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(
          T3VoiceRealtimeTerminalAction.SwitchToThread("terminal-switch", remoteThreadTarget),
        ),
      ),
    )
    val closing = controller.snapshot().state as T3VoiceControllerState.SwitchingToThread
    assertEquals(T3VoiceSwitchStage.CLOSING_REALTIME, closing.stage)
    assertEquals(T3VoiceThreadStart(threadTarget, continuousSettings), closing.threadStart)
    assertEquals("close-realtime:1:SWITCH_AFTER_PLAYOUT", driver.actions.last())

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))
    assertEquals("start-thread:2:thread-a", driver.actions.last())
  }

  @Test
  fun missingThreadSettingsClosesRealtimeThenPublishesRecoverableSwitchFailure() {
    val driver = FakeDriver()
    val terminalFailures = mutableListOf<T3VoiceControllerSnapshot>()
    val controller = T3VoiceRuntimeController(driver, terminalFailures::add)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartRealtime(realtimeTarget.copy(threadSettings = null), session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(
          T3VoiceRealtimeTerminalAction.SwitchToThread(
            "terminal-missing-settings",
            remoteThreadTarget,
          ),
        ),
      ),
    )
    assertEquals("close-realtime:1:STOP_AFTER_PLAYOUT", driver.actions.last())
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))

    val failed = controller.snapshot().state as T3VoiceControllerState.Failed
    assertEquals(T3VoiceOperation.SWITCHING_TO_THREAD, failed.operation)
    assertEquals("thread-settings-unavailable", failed.failure.code)
    assertTrue(failed.failure.recoverable)
    assertEquals(controller.snapshot(), terminalFailures.single())
    assertFalse(driver.actions.any { it.startsWith("start-thread") })
  }

  @Test
  fun userStopOverridesMissingSettingsFailureWhileAgentDrainIsPending() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartRealtime(realtimeTarget.copy(threadSettings = null), session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.RealtimeTerminalActionReceived(
        T3VoiceRealtimeTerminalAction.SwitchToThread(
          "terminal-missing-settings-stop",
          remoteThreadTarget,
        ),
      ),
    )

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertEquals("close-realtime:1:STOP_IMMEDIATELY", driver.actions.last())
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun staleCallbacksCannotMutateAReplacementOperation() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    controller.dispatch(T3VoiceRuntimeCommand.Stop)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClosed)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(2)
    val replacement = controller.snapshot()

    assertFalse(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(T3VoiceFailure("old", "Old callback.", true)),
      ),
    )
    assertEquals(replacement, controller.snapshot())
    assertEquals(2, controller.snapshot().generation)
  }

  @Test
  fun boundedRealtimeFailureStopAndRetryWaitForExactNativeQuiescence() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          failure = T3VoiceFailure("realtime-shutdown-timeout", "Still draining.", true),
          releasePending = true,
        ),
      ),
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertEquals(
      T3VoiceCommandRejection.BUSY,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).rejection,
    )

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.NativeReleaseQuiesced))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).outcome,
    )
    assertEquals(2, controller.snapshot().generation)
  }

  @Test
  fun `Stop before bounded Realtime failure reaches Idle on exact quiescence`() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          failure = T3VoiceFailure("realtime-shutdown-timeout", "Still draining.", true),
          releasePending = true,
        ),
      ),
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.NativeReleaseQuiesced))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun `Stop intent reaches Idle when an already quiesced Realtime failure arrives`() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.dispatch(T3VoiceRuntimeCommand.Stop)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure("peer-failed", "Realtime already quiesced.", true),
        ),
      ),
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun `Stop intent reaches Idle when an already quiesced Thread failure arrives`() {
    val terminalFailures = mutableListOf<T3VoiceControllerSnapshot>()
    val controller = T3VoiceRuntimeController(FakeDriver(), terminalFailures::add)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.Stop)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure("recording-failed", "Thread already quiesced.", true),
        ),
      ),
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertEquals(1, terminalFailures.size)
    val terminal = terminalFailures.single()
    assertEquals(1, terminal.generation)
    assertEquals("recording-failed", (terminal.state as T3VoiceControllerState.Failed).failure.code)
  }

  @Test
  fun `driver exception during Stop preserves the explicit Stop intent`() {
    val controller =
      T3VoiceRuntimeController(FakeDriver(failAction = "close-realtime:1:STOP_IMMEDIATELY"))
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun `release exception cannot publish Idle until a later Stop proves quiescence`() {
    val controller = T3VoiceRuntimeController(FakeDriver(failAction = "release-all:1"))
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.dispatch(T3VoiceRuntimeCommand.Stop)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure("peer-failed", "Realtime cleanup failed.", true),
        ),
      ),
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertEquals(
      T3VoiceCommandRejection.BUSY,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).rejection,
    )

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun switchCloseFailureReturnsToIdleOnExactNativeQuiescence() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    controller.dispatch(
      T3VoiceRuntimeCommand.SwitchRealtimeToThread(threadTarget, continuousSettings),
    )

    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.Failed(
        failure = T3VoiceFailure("realtime-shutdown-timeout", "Still draining.", true),
        releasePending = true,
      ),
    )
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.NativeReleaseQuiesced))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun successfulClientActionAdmitsFocusBeforeAcknowledgement() {
    val driver = FakeDriver()
    lateinit var controller: T3VoiceRuntimeController
    driver.onAction = { action ->
      if (action.startsWith("context-realtime")) {
        val realtime = controller.snapshot().state as T3VoiceControllerState.Realtime
        assertEquals(T3VoiceRealtimeFocus("project-b", "thread-b"), realtime.target.focus)
        assertEquals(continuousSettings, realtime.target.threadSettings)
        assertTrue(realtime.pendingClientActions.isEmpty())
      }
    }
    controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    val action =
      T3VoiceRealtimeClientAction(
        actionId = "action-a",
        projectId = "project-b",
        threadId = "thread-b",
        expiresAt = "2099-01-01T00:00:00Z",
      )
    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeClientActionReceived(action),
      ),
    )

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = "action-a",
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).outcome,
    )
    assertEquals(
      listOf(
        "context-realtime:1:thread-b",
        "ack-realtime:1:action-a:SUCCEEDED",
      ),
      driver.actions.takeLast(2),
    )

    val actionCount = driver.actions.size
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = "action-a",
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).outcome,
    )
    assertEquals(actionCount, driver.actions.size)
  }

  @Test
  fun realtimeClientActionReceivedDuringStartupCanBeCompletedBeforeConnection() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    val action =
      T3VoiceRealtimeClientAction(
        actionId = "startup-action",
        projectId = "project-b",
        threadId = "thread-b",
        expiresAt = "2099-01-01T00:00:00Z",
      )

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeClientActionReceived(action),
      ),
    )
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = "different-action",
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).outcome,
    )
    assertFalse(driver.actions.any { it.startsWith("ack-realtime:1:different-action") })
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = action.actionId,
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).outcome,
    )

    val starting = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(T3VoiceRealtimeStage.STARTING, starting.stage)
    assertTrue(starting.pendingClientActions.isEmpty())
    assertEquals(T3VoiceRealtimeFocus("project-b", "thread-b"), starting.target.focus)
    assertEquals(
      listOf(
        "context-realtime:1:thread-b",
        "ack-realtime:1:startup-action:SUCCEEDED",
      ),
      driver.actions.takeLast(2),
    )
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected))

    val connected = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(T3VoiceRealtimeStage.CONNECTED, connected.stage)
    assertTrue(connected.pendingClientActions.isEmpty())
  }

  @Test
  fun realtimeClientActionCannotCompleteAfterStoppingStarts() {
    val driver = FakeDriver()
    val controller = connectedRealtimeController(driver)
    val action =
      T3VoiceRealtimeClientAction(
        actionId = "stopping-action",
        projectId = "project-b",
        threadId = "thread-b",
        expiresAt = "2099-01-01T00:00:00Z",
      )
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClientActionReceived(action))
    controller.dispatch(T3VoiceRuntimeCommand.Stop)

    assertEquals(
      T3VoiceCommandRejection.INVALID_STATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = action.actionId,
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).rejection,
    )
    assertFalse(driver.actions.any { it.startsWith("ack-realtime:1:${action.actionId}") })
  }

  @Test
  fun expiredClientActionIsRemovedWithoutAcknowledgingIt() {
    val driver = FakeDriver()
    val controller = connectedRealtimeController(driver)
    val action =
      T3VoiceRealtimeClientAction(
        actionId = "action-expiring",
        projectId = "project-b",
        threadId = "thread-b",
        expiresAt = "2026-07-16T00:00:00Z",
      )
    controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeClientActionReceived(action))

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeClientActionResolved(action.actionId),
      ),
    )
    val state = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertTrue(state.pendingClientActions.isEmpty())
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.CompleteRealtimeClientAction(
          actionId = action.actionId,
          outcome = T3VoiceClientActionOutcome.SUCCEEDED,
          message = null,
        ),
      ).outcome,
    )
    assertFalse(driver.actions.any { it.startsWith("ack-realtime:1:${action.actionId}") })
  }

  @Test
  fun pendingRealtimeClientActionsAreBoundedAndOverflowFailsClosed() {
    val driver = FakeDriver(releasePendingOnRelease = true)
    val controller = connectedRealtimeController(driver)

    repeat(T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CLIENT_ACTIONS) { index ->
      assertTrue(
        controller.onCallback(
          1,
          T3VoiceRuntimeCallback.RealtimeClientActionReceived(
            T3VoiceRealtimeClientAction(
              actionId = "action-$index",
              projectId = "project-a",
              threadId = "thread-a",
              expiresAt = "2099-01-01T00:00:00Z",
            ),
          ),
        ),
      )
    }
    val bounded = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(
      T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CLIENT_ACTIONS,
      bounded.pendingClientActions.size,
    )

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeClientActionReceived(
          T3VoiceRealtimeClientAction(
            actionId = "action-overflow",
            projectId = "project-a",
            threadId = "thread-a",
            expiresAt = "2099-01-01T00:00:00Z",
          ),
        ),
      ),
    )
    val failed = controller.snapshot().state as T3VoiceControllerState.Failed
    assertEquals("environment-a", failed.environmentId)
    assertEquals("realtime-client-action-overflow", failed.failure.code)
    assertEquals("release-all:1", driver.actions.last())
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertEquals(
      T3VoiceCommandRejection.BUSY,
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session)).rejection,
    )
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.NativeReleaseQuiesced))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun pendingRealtimeConfirmationsAreBoundedAndOverflowFailsClosed() {
    val driver = FakeDriver(releasePendingOnRelease = true)
    val controller = connectedRealtimeController(driver)

    repeat(T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CONFIRMATIONS) { index ->
      assertTrue(
        controller.onCallback(
          1,
          T3VoiceRuntimeCallback.RealtimeConfirmationReceived(
            T3VoiceRealtimeConfirmation(
              confirmationId = "confirmation-$index",
              tool = T3VoiceToolName.SEND_THREAD_MESSAGE,
              summary = "Confirmation $index",
              expiresAt = "2099-01-01T00:00:00Z",
            ),
          ),
        ),
      )
    }
    val bounded = controller.snapshot().state as T3VoiceControllerState.Realtime
    assertEquals(
      T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CONFIRMATIONS,
      bounded.pendingConfirmations.size,
    )

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.RealtimeConfirmationReceived(
          T3VoiceRealtimeConfirmation(
            confirmationId = "confirmation-overflow",
            tool = T3VoiceToolName.SEND_THREAD_MESSAGE,
            summary = "Overflow",
            expiresAt = "2099-01-01T00:00:00Z",
          ),
        ),
      ),
    )
    val failed = controller.snapshot().state as T3VoiceControllerState.Failed
    assertEquals("realtime-confirmation-overflow", failed.failure.code)
    assertEquals("release-all:1", driver.actions.last())
  }

  @Test
  fun threadPipelineUsesExplicitBoundedStagesAndRearmsAfterPlayback() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)

    assertThreadStage(controller, T3VoiceThreadStage.STARTING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    assertThreadStage(controller, T3VoiceThreadStage.RECORDING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected))
    assertThreadStage(controller, T3VoiceThreadStage.FINALIZING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized))
    assertThreadStage(controller, T3VoiceThreadStage.UPLOADING)
    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.ThreadTranscriptReady("spoken request"),
      ),
    )
    assertThreadStage(controller, T3VoiceThreadStage.SUBMITTING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted))
    assertThreadStage(controller, T3VoiceThreadStage.WAITING)
    assertTrue(
      controller.onCallback(1, T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = true)),
    )
    assertThreadStage(controller, T3VoiceThreadStage.PLAYING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertThreadStage(controller, T3VoiceThreadStage.REARMING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady))
    assertThreadStage(controller, T3VoiceThreadStage.STARTING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    assertThreadStage(controller, T3VoiceThreadStage.RECORDING)

    assertEquals(
      listOf(
        "start-thread:1:thread-a",
        "finish-thread:1",
        "upload-transcribe-thread:1",
        "submit-thread:1:spoken request",
        "wait-thread:1",
        "play-thread:1",
        "rearm-thread:1:750",
        "start-thread:1:thread-a",
      ),
      driver.actions,
    )
  }

  @Test
  fun noSpeechUsesControllerOwnedRearmAndCoalescesDelayControls() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected))
    assertThreadStage(controller, T3VoiceThreadStage.REARMING)
    assertEquals("rearm-thread:1:750", driver.actions.last())

    val actionCount = driver.actions.size
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance).outcome,
    )
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected))
    assertEquals(actionCount, driver.actions.size)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady))
    assertThreadStage(controller, T3VoiceThreadStage.STARTING)
    assertEquals("start-thread:1:thread-a", driver.actions.last())
    val rearmActionCount = driver.actions.size
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady))
    assertEquals(rearmActionCount, driver.actions.size)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    assertThreadStage(controller, T3VoiceThreadStage.RECORDING)
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
  }

  @Test
  fun noSpeechWithoutAutoRearmStopsAndReturnsToIdle() {
    val settings = continuousSettings.copy(autoRearm = false)
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected))

    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertEquals("stop-thread:1", driver.actions.last())
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected))
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun blankTranscriptionNoSpeechStopsFromUploadingWithoutSubmission() {
    val settings = continuousSettings.copy(autoRearm = false)
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected))
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertFalse(driver.actions.any { it.startsWith("submit-thread") })
    assertEquals("stop-thread:1", driver.actions.last())
  }

  @Test
  fun recoverableThreadCycleFailureRearmsAndClearsItsStatusOnRestart() {
    val driver = FakeDriver()
    val terminalFailures = mutableListOf<T3VoiceControllerSnapshot>()
    val controller = T3VoiceRuntimeController(driver, terminalFailures::add)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    val failure = T3VoiceFailure("transcription-timeout", "Voice transcription failed.", true)

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadCycleFailed(failure)))
    val rearming = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(T3VoiceThreadStage.REARMING, rearming.stage)
    assertEquals(failure, rearming.cycleFailure)
    assertEquals("rearm-thread:1:750", driver.actions.last())

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady))
    val starting = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(T3VoiceThreadStage.STARTING, starting.stage)
    assertNull(starting.cycleFailure)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    val recording = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(T3VoiceThreadStage.RECORDING, recording.stage)
    assertNull(recording.cycleFailure)
    assertTrue(terminalFailures.isEmpty())
  }

  @Test
  fun submissionFailureIsTerminalAndNeverRearmsTheThreadCycle() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.dispatch(T3VoiceRuntimeCommand.FinishThreadUtterance)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("dispatch once"))

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure("submission-ambiguous", "The Thread message could not be submitted.", true),
        ),
      ),
    )
    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertFalse(driver.actions.any { it.startsWith("rearm-thread") })
    assertEquals("release-all:1", driver.actions.last())
  }

  @Test
  fun alreadyQuiescedFailureCanSettleWithoutAStopCommand() {
    val controller = T3VoiceRuntimeController(FakeDriver())
    controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
    controller.activateInitialStart(1)
    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.Failed(T3VoiceFailure("peer-failed", "Realtime stopped.", true)),
    )

    assertTrue(controller.snapshot().state is T3VoiceControllerState.Failed)
    assertTrue(controller.settleQuiescedFailure(1))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(controller.settleQuiescedFailure(1))
  }

  @Test
  fun stopDuringNoSpeechDelayWinsOverTheScheduledRearm() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadNoSpeechDetected)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertEquals("stop-thread:1", driver.actions.last())
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady))
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun directThreadStartWaitsForRecorderStartedCallback() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)

    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)

    assertThreadStage(controller, T3VoiceThreadStage.STARTING)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted))
    assertThreadStage(controller, T3VoiceThreadStage.RECORDING)
  }

  @Test
  fun reviewPolicyWaitsForTheTypedSubmitCommand() {
    val settings =
      continuousSettings.copy(submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW)
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)

    assertTrue(
      controller.onCallback(
        1,
        T3VoiceRuntimeCallback.ThreadTranscriptReady("draft transcript"),
      ),
    )
    assertThreadStage(controller, T3VoiceThreadStage.REVIEWING)
    assertFalse(driver.actions.any { it.startsWith("submit-thread") })
    val reviewId =
      checkNotNull((controller.snapshot().state as T3VoiceControllerState.Thread).reviewId)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, "edited transcript"),
      ).outcome,
    )
    val editedSnapshot = controller.snapshot()
    assertEquals(
      "edited transcript",
      (editedSnapshot.state as T3VoiceControllerState.Thread).transcript,
    )
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, reviewId, "edited transcript"),
      ).outcome,
    )
    assertEquals(editedSnapshot, controller.snapshot())

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.SubmitThreadTranscript(
          1,
          reviewId,
          "final submitted transcript",
        ),
      ).outcome,
    )
    assertThreadStage(controller, T3VoiceThreadStage.SUBMITTING)
    assertEquals("submit-thread:1:final submitted transcript", driver.actions.last())
  }

  @Test
  fun reviewCommandsRejectInvalidPhaseAndStaleGeneration() {
    val settings = continuousSettings.copy(submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW)
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)

    val invalid =
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, 1, "too early"),
      )
    assertEquals(T3VoiceCommandOutcome.REJECTED, invalid.outcome)
    assertEquals(T3VoiceCommandRejection.INVALID_STATE, invalid.rejection)

    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("draft transcript"))
    val reviewingSnapshot = controller.snapshot()
    val reviewId =
      checkNotNull((reviewingSnapshot.state as T3VoiceControllerState.Thread).reviewId)

    val staleUpdate =
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(2, reviewId, "stale edit"),
      )
    assertEquals(T3VoiceCommandOutcome.REJECTED, staleUpdate.outcome)
    assertEquals(T3VoiceCommandRejection.STALE_GENERATION, staleUpdate.rejection)
    val staleSubmit =
      controller.dispatch(
        T3VoiceRuntimeCommand.SubmitThreadTranscript(2, reviewId, "stale submit"),
      )
    assertEquals(T3VoiceCommandOutcome.REJECTED, staleSubmit.outcome)
    assertEquals(T3VoiceCommandRejection.STALE_GENERATION, staleSubmit.rejection)
    assertEquals(reviewingSnapshot, controller.snapshot())
    assertFalse(driver.actions.any { it.startsWith("submit-thread") })
  }

  @Test
  fun delayedReviewCommandsCannotCrossAnAutoRearmCycle() {
    val settings =
      continuousSettings.copy(
        submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW,
        playResponses = false,
      )
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("cycle one"))
    val firstReviewId =
      checkNotNull((controller.snapshot().state as T3VoiceControllerState.Thread).reviewId)

    controller.dispatch(
      T3VoiceRuntimeCommand.SubmitThreadTranscript(1, firstReviewId, "cycle one"),
    )
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = false))
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRearmReady)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("cycle two"))

    val secondReviewSnapshot = controller.snapshot()
    val secondReviewState = secondReviewSnapshot.state as T3VoiceControllerState.Thread
    val secondReviewId = checkNotNull(secondReviewState.reviewId)
    assertEquals(1, secondReviewSnapshot.generation)
    assertTrue(firstReviewId != secondReviewId)

    val delayedUpdate =
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(
          1,
          firstReviewId,
          "late cycle-one edit",
        ),
      )
    assertEquals(T3VoiceCommandOutcome.REJECTED, delayedUpdate.outcome)
    assertEquals(T3VoiceCommandRejection.STALE_REVIEW, delayedUpdate.rejection)

    val submissionsBeforeDelayedSubmit = driver.actions.count { it.startsWith("submit-thread") }
    val delayedSubmit =
      controller.dispatch(
        T3VoiceRuntimeCommand.SubmitThreadTranscript(
          1,
          firstReviewId,
          "late cycle-one submit",
        ),
      )
    assertEquals(T3VoiceCommandOutcome.REJECTED, delayedSubmit.outcome)
    assertEquals(T3VoiceCommandRejection.STALE_REVIEW, delayedSubmit.rejection)
    assertEquals(
      submissionsBeforeDelayedSubmit,
      driver.actions.count { it.startsWith("submit-thread") },
    )
    assertEquals(secondReviewSnapshot, controller.snapshot())

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(
        T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(
          1,
          secondReviewId,
          "current cycle edit",
        ),
      ).outcome,
    )
  }

  @Test
  fun completedOneShotThreadDoesNotRearm() {
    val settings =
      continuousSettings.copy(
        playResponses = false,
        autoRearm = false,
      )
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(
      1,
      T3VoiceRuntimeCallback.ThreadTranscriptReady("one shot request"),
    )
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted)

    assertTrue(
      controller.onCallback(1, T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = true)),
    )
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertEquals("stop-thread:1", driver.actions.last())
    assertFalse(driver.actions.any { it.startsWith("rearm-thread") })
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun updateThreadPlayResponsesDisableWhileWaitingPreventsPlayback() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("spoken request"))
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted)
    assertThreadStage(controller, T3VoiceThreadStage.WAITING)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller
        .dispatch(
          T3VoiceRuntimeCommand.UpdateThreadPlayResponses(
            expectedGeneration = 1,
            playResponses = false,
          ),
        )
        .outcome,
    )
    val state = controller.snapshot().state as T3VoiceControllerState.Thread
    assertFalse(state.settings.playResponses)

    assertTrue(
      controller.onCallback(1, T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = true)),
    )
    assertThreadStage(controller, T3VoiceThreadStage.REARMING)
    assertFalse(driver.actions.any { it.startsWith("play-thread") })
  }

  @Test
  fun updateThreadPlayResponsesDisableWhilePlayingSkips() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    advanceThreadToPlaying(controller)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller
        .dispatch(
          T3VoiceRuntimeCommand.UpdateThreadPlayResponses(
            expectedGeneration = 1,
            playResponses = false,
          ),
        )
        .outcome,
    )
    assertEquals("cancel-thread-playback:1", driver.actions.last())
    assertThreadStage(controller, T3VoiceThreadStage.PLAYING)
  }

  @Test
  fun updateThreadPlayResponsesRejectsStaleGeneration() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)

    assertEquals(
      T3VoiceCommandRejection.STALE_GENERATION,
      controller
        .dispatch(
          T3VoiceRuntimeCommand.UpdateThreadPlayResponses(
            expectedGeneration = 2,
            playResponses = false,
          ),
        )
        .rejection,
    )
    val state = controller.snapshot().state as T3VoiceControllerState.Thread
    assertTrue(state.settings.playResponses)
  }

  @Test
  fun skipThreadPlaybackWithAutoRearmCancelsThenRearmsOnFinish() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    advanceThreadToPlaying(controller)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback).outcome,
    )
    assertThreadStage(controller, T3VoiceThreadStage.PLAYING)
    assertEquals("cancel-thread-playback:1", driver.actions.last())
    assertFalse(driver.actions.any { it.startsWith("rearm-thread") })
    assertFalse(driver.actions.any { it.startsWith("stop-thread") })

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertThreadStage(controller, T3VoiceThreadStage.REARMING)
    assertEquals("rearm-thread:1:750", driver.actions.last())
  }

  @Test
  fun skipThreadPlaybackWithoutAutoRearmStopsOnFinish() {
    val settings = continuousSettings.copy(autoRearm = false)
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(T3VoiceRuntimeCommand.StartThread(threadTarget, settings, session))
    controller.activateInitialStart(1)
    advanceThreadToPlaying(controller)

    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback).outcome,
    )
    assertThreadStage(controller, T3VoiceThreadStage.PLAYING)
    assertEquals("cancel-thread-playback:1", driver.actions.last())

    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertEquals("stop-thread:1", driver.actions.last())
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  @Test
  fun skipThreadPlaybackOutsidePlayingIsDuplicateAndNonThreadIsRejected() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    assertEquals(
      T3VoiceCommandOutcome.REJECTED,
      controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback).outcome,
    )

    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    val actionCount = driver.actions.size
    assertEquals(
      T3VoiceCommandOutcome.DUPLICATE,
      controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback).outcome,
    )
    assertEquals(actionCount, driver.actions.size)
  }

  @Test
  fun skipThenNaturalFinishProducesExactlyOneCycleCompletion() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    advanceThreadToPlaying(controller)

    controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback)
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertThreadStage(controller, T3VoiceThreadStage.REARMING)
    val rearmCount = driver.actions.count { it.startsWith("rearm-thread") }
    assertEquals(1, rearmCount)
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertEquals(rearmCount, driver.actions.count { it.startsWith("rearm-thread") })
  }

  @Test
  fun skipThenStopDropsLatePlaybackFinished() {
    val driver = FakeDriver()
    val controller = T3VoiceRuntimeController(driver)
    controller.dispatch(
      T3VoiceRuntimeCommand.StartThread(threadTarget, continuousSettings, session),
    )
    controller.activateInitialStart(1)
    advanceThreadToPlaying(controller)

    controller.dispatch(T3VoiceRuntimeCommand.SkipThreadPlayback)
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertThreadStage(controller, T3VoiceThreadStage.STOPPING)
    assertFalse(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadPlaybackFinished))
    assertTrue(controller.onCallback(1, T3VoiceRuntimeCallback.ThreadStopped))
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
    assertFalse(driver.actions.any { it.startsWith("rearm-thread") })
  }

  private fun advanceThreadToPlaying(controller: T3VoiceRuntimeController) {
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingStarted)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadEndpointDetected)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadRecordingFinalized)
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadTranscriptReady("spoken request"))
    controller.onCallback(1, T3VoiceRuntimeCallback.ThreadSubmitted)
    assertTrue(
      controller.onCallback(1, T3VoiceRuntimeCallback.ThreadResponseReady(hasPlayback = true)),
    )
    assertThreadStage(controller, T3VoiceThreadStage.PLAYING)
  }

  @Test
  fun driverFailureReleasesResourcesAndExposesAStableFailure() {
    val driver = FakeDriver(failAction = "start-realtime:1:environment-a")
    val controller = T3VoiceRuntimeController(driver)

    val result = controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))

    assertEquals(T3VoiceCommandOutcome.APPLIED, result.outcome)
    assertTrue(controller.activateInitialStart(1))
    val failed = controller.snapshot().state as T3VoiceControllerState.Failed
    assertEquals(T3VoiceOperation.REALTIME, failed.operation)
    assertEquals("native-operation-failed", failed.failure.code)
    assertEquals(
      listOf("start-realtime:1:environment-a", "release-all:1"),
      driver.actions,
    )
    assertEquals(
      T3VoiceCommandOutcome.APPLIED,
      controller.dispatch(T3VoiceRuntimeCommand.Stop).outcome,
    )
    assertEquals(T3VoiceControllerState.Idle, controller.snapshot().state)
  }

  private fun assertThreadStage(
    controller: T3VoiceRuntimeController,
    expected: T3VoiceThreadStage,
  ) {
    val state = controller.snapshot().state as T3VoiceControllerState.Thread
    assertEquals(expected, state.stage)
  }

  private fun connectedRealtimeController(driver: FakeDriver): T3VoiceRuntimeController =
    T3VoiceRuntimeController(driver).also { controller ->
      controller.dispatch(T3VoiceRuntimeCommand.StartRealtime(realtimeTarget, session))
      controller.activateInitialStart(1)
      controller.onCallback(1, T3VoiceRuntimeCallback.RealtimeConnected)
    }
}

internal class FakeDriver(
  private val failAction: String? = null,
  private val releasePendingOnRelease: Boolean = false,
) : T3VoiceRuntimeDriver {
  val actions = mutableListOf<String>()
  var onAction: (String) -> Unit = {}
  private var failureDelivered = false

  override fun startRealtime(
    generation: Long,
    target: T3VoiceRealtimeTarget,
    session: T3VoiceNativeSessionConfig,
  ) {
    record("start-realtime:$generation:${target.environmentId}")
  }

  override fun closeRealtime(
    generation: Long,
    policy: T3VoiceRealtimeClosePolicy,
  ) {
    record("close-realtime:$generation:$policy")
  }

  override fun cancelRealtimeToThreadSwitch(generation: Long) {
    record("cancel-switch:$generation")
  }

  override fun setRealtimeMuted(generation: Long, muted: Boolean) {
    record("mute-realtime:$generation:$muted")
  }

  override fun updateRealtimeContext(generation: Long, context: T3VoiceRealtimeContext) {
    record("context-realtime:$generation:${context.focus?.threadId ?: "none"}")
  }

  override fun decideRealtimeConfirmation(
    generation: Long,
    confirmationId: String,
    decision: T3VoiceConfirmationDecision,
  ) {
    record("confirmation-realtime:$generation:$confirmationId:${decision.name}")
  }

  override fun startInitialThread(
    generation: Long,
    start: T3VoiceThreadStart,
    session: T3VoiceNativeSessionConfig,
  ) {
    record("start-thread:$generation:${start.target.threadId}")
  }

  override fun startThreadAfterRealtime(generation: Long, start: T3VoiceThreadStart) {
    record("start-thread:$generation:${start.target.threadId}")
  }

  override fun rearmThreadRecording(generation: Long) {
    record("start-thread:$generation:thread-a")
  }

  override fun acknowledgeRealtimeClientAction(
    generation: Long,
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ) {
    record("ack-realtime:$generation:$actionId:${outcome.name}")
  }

  override fun finishThreadRecording(generation: Long) {
    record("finish-thread:$generation")
  }

  override fun uploadAndTranscribeThreadRecording(generation: Long) {
    record("upload-transcribe-thread:$generation")
  }

  override fun submitThreadTranscript(generation: Long, transcript: String) {
    record("submit-thread:$generation:$transcript")
  }

  override fun waitForThreadResponse(generation: Long) {
    record("wait-thread:$generation")
  }

  override fun startThreadPlayback(generation: Long) {
    record("play-thread:$generation")
  }

  override fun cancelThreadPlayback(generation: Long) {
    record("cancel-thread-playback:$generation")
  }

  override fun scheduleThreadRearm(generation: Long, delayMs: Long) {
    record("rearm-thread:$generation:$delayMs")
  }

  override fun stopThread(generation: Long) {
    record("stop-thread:$generation")
  }

  override fun releaseAll(generation: Long): Boolean {
    record("release-all:$generation")
    return releasePendingOnRelease
  }

  private fun record(action: String) {
    actions.add(action)
    onAction(action)
    if (action == failAction && !failureDelivered) {
      failureDelivered = true
      error("Test driver failure")
    }
  }
}
