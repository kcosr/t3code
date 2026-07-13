package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBackgroundStateTest {
  @Test
  fun `thread operation advances through capture dispatch speech drain and rearm`() {
    var transition =
      T3VoiceBackgroundReducer.reduce(
        T3VoiceBackgroundSnapshot(),
        authority(generation = 3, autoRearm = true),
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.StartRecording("operation-1", "recording-1"),
        T3VoiceBackgroundPhase.RECORDING,
        T3VoiceBackgroundCommand.START_RECORDING,
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.RecordingFinalized("operation-1", "recording-1"),
        T3VoiceBackgroundPhase.FINALIZED,
        T3VoiceBackgroundCommand.UPLOAD_RECORDING,
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.UploadStarted("operation-1"),
        T3VoiceBackgroundPhase.UPLOADING,
      )
    transition =
      reduce(
        transition,
        serverEvent(1, T3VoiceBackgroundServerPhase.TRANSCRIBING),
        T3VoiceBackgroundPhase.TRANSCRIBING,
      )
    transition =
      reduce(
        transition,
        serverEvent(
          2,
          T3VoiceBackgroundServerPhase.WAITING,
          dispatchAcknowledged = true,
          messageId = "message-1",
          turnId = "turn-1",
        ),
        T3VoiceBackgroundPhase.WAITING,
        T3VoiceBackgroundCommand.DELETE_RECORDING,
      )
    assertTrue(transition.snapshot.dispatchAcknowledged)
    assertEquals(null, transition.snapshot.recordingId)
    transition =
      reduce(
        transition,
        serverEvent(
          3,
          T3VoiceBackgroundServerPhase.SPEAKING,
          speechSegmentIndex = 0,
          finalSpeechSegment = true,
          speechTerminal = true,
        ),
        T3VoiceBackgroundPhase.WAITING,
        T3VoiceBackgroundCommand.FETCH_SPEECH_SEGMENT,
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.PlaybackStarted("operation-1", 0),
        T3VoiceBackgroundPhase.PLAYING,
      )
    transition =
      reduce(
        transition,
        serverEvent(4, T3VoiceBackgroundServerPhase.COMPLETED),
        T3VoiceBackgroundPhase.PLAYING,
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.PlaybackDrained("operation-1", 0),
        T3VoiceBackgroundPhase.PLAYBACK_DRAINED,
      )
    transition =
      reduce(
        transition,
        T3VoiceBackgroundEvent.RearmGuardElapsed,
        T3VoiceBackgroundPhase.REARMING,
        T3VoiceBackgroundCommand.START_RECORDING,
      )
    assertEquals(null, transition.snapshot.operationId)
  }

  @Test
  fun `auto rearm waits for both terminal response and final playback drain`() {
    var snapshot = activeWaitingSnapshot(autoRearm = true)
    snapshot =
      T3VoiceBackgroundReducer.reduce(
        snapshot,
        serverEvent(
          2,
          T3VoiceBackgroundServerPhase.SPEAKING,
          speechSegmentIndex = 0,
          finalSpeechSegment = true,
          speechTerminal = true,
        ),
      ).snapshot
    snapshot =
      T3VoiceBackgroundReducer.reduce(
        snapshot,
        T3VoiceBackgroundEvent.PlaybackStarted("operation-1", 0),
      ).snapshot
    val drained =
      T3VoiceBackgroundReducer.reduce(
        snapshot,
        T3VoiceBackgroundEvent.PlaybackDrained("operation-1", 0),
      )
    assertEquals(T3VoiceBackgroundPhase.WAITING, drained.snapshot.phase)
    assertFalse(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD in drained.commands)

    val completed =
      T3VoiceBackgroundReducer.reduce(
        drained.snapshot,
        serverEvent(3, T3VoiceBackgroundServerPhase.COMPLETED),
      )
    assertEquals(T3VoiceBackgroundPhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertFalse(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `final segment advertisement waits for explicit speech terminal`() {
    val advertised = T3VoiceBackgroundReducer.reduce(
      activeWaitingSnapshot(autoRearm = true),
      serverEvent(2, T3VoiceBackgroundServerPhase.SPEAKING, speechSegmentIndex = 0,
        finalSpeechSegment = true, speechTerminal = false),
    ).snapshot
    assertEquals(0, advertised.finalSpeechSegment)
    assertFalse(advertised.speechTerminal)
    val terminal = T3VoiceBackgroundReducer.reduce(
      advertised,
      serverEvent(3, T3VoiceBackgroundServerPhase.SPEAKING, speechTerminal = true),
    ).snapshot
    assertTrue(terminal.speechTerminal)
  }

  @Test
  fun `stale duplicate and gap events cannot move cursors`() {
    val current = activeWaitingSnapshot(autoRearm = false)
    assertEquals(
      current,
      T3VoiceBackgroundReducer.reduce(
        current,
        serverEvent(1, T3VoiceBackgroundServerPhase.COMPLETED),
      ).snapshot,
    )
    val gap =
      T3VoiceBackgroundReducer.reduce(
        current,
        serverEvent(3, T3VoiceBackgroundServerPhase.COMPLETED),
      )
    assertEquals(current, gap.snapshot)
    assertEquals(listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP), gap.commands)
    assertEquals(
      current,
      T3VoiceBackgroundReducer.reduce(
        current,
        serverEvent(2, T3VoiceBackgroundServerPhase.COMPLETED, generation = 2),
      ).snapshot,
    )
  }

  @Test
  fun `same target authority refresh preserves operation generation and accepts its events`() {
    val current = activeWaitingSnapshot(autoRearm = false)
    val refreshed =
      T3VoiceBackgroundReducer.reduce(
        current,
        authority(generation = 4, autoRearm = true),
      )
    assertEquals(4L, refreshed.snapshot.readinessGeneration)
    assertEquals(3L, refreshed.snapshot.operationGeneration)
    assertEquals("operation-1", refreshed.snapshot.operationId)
    assertTrue(refreshed.snapshot.autoRearm)
    assertTrue(refreshed.commands.isEmpty())

    val applied =
      T3VoiceBackgroundReducer.reduce(
        refreshed.snapshot,
        serverEvent(2, T3VoiceBackgroundServerPhase.WAITING, generation = 3),
      )
    assertEquals(2L, applied.snapshot.eventCursor)
  }

  @Test
  fun `authority replacement cleans old target before accepting the new target`() {
    val replaced =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = false),
        T3VoiceBackgroundEvent.AuthorityValidated(
          runtimeId = "runtime-2",
          readinessGeneration = 4,
          mode = T3VoiceBackgroundMode.THREAD,
          autoRearm = false,
        ),
      )
    assertEquals(T3VoiceBackgroundPhase.IDLE, replaced.snapshot.phase)
    assertEquals("runtime-2", replaced.snapshot.runtimeId)
    assertEquals(null, replaced.snapshot.operationId)
    assertTrue(T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION in replaced.commands)
  }

  @Test
  fun `completed without explicit speech terminal does not infer no speech`() {
    val completed =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        serverEvent(2, T3VoiceBackgroundServerPhase.COMPLETED),
      )
    assertTrue(completed.snapshot.responseTerminal)
    assertFalse(completed.snapshot.speechTerminal)
    assertEquals(T3VoiceBackgroundPhase.WAITING, completed.snapshot.phase)
    assertFalse(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `explicit no speech terminal permits completed operation to rearm`() {
    val completed =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        serverEvent(
          2,
          T3VoiceBackgroundServerPhase.COMPLETED,
          speechTerminal = true,
          noSpeech = true,
        ),
      )
    assertTrue(completed.snapshot.noSpeech)
    assertEquals(T3VoiceBackgroundPhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertFalse(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `terminal no speech cleans undispatched recording before rearm`() {
    val current =
      activeWaitingSnapshot(autoRearm = true).copy(
        dispatchAcknowledged = false,
        recordingId = "recording-1",
        messageId = null,
        turnId = null,
      )
    val completed =
      T3VoiceBackgroundReducer.reduce(
        current,
        serverEvent(
          2,
          T3VoiceBackgroundServerPhase.COMPLETED,
          speechTerminal = true,
          noSpeech = true,
        ),
      )
    assertEquals(T3VoiceBackgroundPhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertEquals(null, completed.snapshot.recordingId)
    assertEquals("operation-1", completed.snapshot.operationId)
    assertTrue(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in completed.commands)
    assertTrue(T3VoiceBackgroundCommand.DELETE_RECORDING in completed.commands)
    assertFalse(T3VoiceBackgroundCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `network retry reuploads only before dispatch acceptance`() {
    val uploading =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.UPLOADING,
        dispatchAcknowledged = false,
        eventCursor = 0,
        recordingId = "recording-1",
      )
    val retry = T3VoiceBackgroundReducer.reduce(uploading, T3VoiceBackgroundEvent.NetworkRetry)
    assertEquals(T3VoiceBackgroundPhase.FINALIZED, retry.snapshot.phase)
    assertEquals(listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING), retry.commands)

    val accepted =
      uploading.copy(
        dispatchAcknowledged = true,
        phase = T3VoiceBackgroundPhase.WAITING,
        recordingId = null,
      )
    val poll = T3VoiceBackgroundReducer.reduce(accepted, T3VoiceBackgroundEvent.NetworkRetry)
    assertEquals(listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP), poll.commands)
  }

  @Test
  fun `retryable failure reuploads retained recording under the same operation`() {
    val failed =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.FAILED,
        dispatchAcknowledged = false,
        recordingId = "recording-1",
        responseTerminal = true,
        terminalSummary = T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
        messageId = null,
        turnId = null,
      )
    val retry = T3VoiceBackgroundReducer.reduce(failed, T3VoiceBackgroundEvent.NetworkRetry)
    assertEquals(T3VoiceBackgroundPhase.FINALIZED, retry.snapshot.phase)
    assertEquals("operation-1", retry.snapshot.operationId)
    assertEquals("recording-1", retry.snapshot.recordingId)
    assertFalse(retry.snapshot.responseTerminal)
    assertEquals(null, retry.snapshot.terminalSummary)
    assertEquals(listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING), retry.commands)

    val dispatched =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = false).copy(
          phase = T3VoiceBackgroundPhase.FAILED,
          responseTerminal = true,
          terminalSummary = T3VoiceBackgroundTerminalSummary.FAILED_RETRYABLE,
        ),
        T3VoiceBackgroundEvent.NetworkRetry,
      )
    assertEquals(T3VoiceBackgroundPhase.FAILED, dispatched.snapshot.phase)
    assertEquals(listOf(T3VoiceBackgroundCommand.FETCH_EVENT_GAP), dispatched.commands)
  }

  @Test
  fun `process restore abandons dead capture and restarts realtime`() {
    var thread =
      T3VoiceBackgroundReducer.reduce(
        T3VoiceBackgroundSnapshot(),
        authority(generation = 3, autoRearm = false),
      )
    thread =
      T3VoiceBackgroundReducer.reduce(
        thread.snapshot,
        T3VoiceBackgroundEvent.StartRecording("operation-1", "recording-1"),
      )
    val abandoned =
      T3VoiceBackgroundReducer.reduce(thread.snapshot, T3VoiceBackgroundEvent.ProcessRestored)
    assertEquals(T3VoiceBackgroundPhase.IDLE, abandoned.snapshot.phase)
    assertTrue(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in abandoned.commands)
    assertTrue(T3VoiceBackgroundCommand.DELETE_RECORDING in abandoned.commands)

    val realtimeReady =
      T3VoiceBackgroundReducer.reduce(
        T3VoiceBackgroundSnapshot(),
        T3VoiceBackgroundEvent.AuthorityValidated(
          runtimeId = "runtime-1",
          readinessGeneration = 3,
          mode = T3VoiceBackgroundMode.REALTIME,
          autoRearm = false,
        ),
      )
    val realtimeStarting =
      T3VoiceBackgroundReducer.reduce(
        realtimeReady.snapshot,
        T3VoiceBackgroundEvent.StartRealtime("operation-realtime"),
      )
    val active =
      T3VoiceBackgroundReducer.reduce(
        realtimeStarting.snapshot,
        T3VoiceBackgroundEvent.RealtimeConnected("operation-realtime"),
      )
    val restarted =
      T3VoiceBackgroundReducer.reduce(active.snapshot, T3VoiceBackgroundEvent.ProcessRestored)
    assertEquals(T3VoiceBackgroundPhase.IDLE, restarted.snapshot.phase)
    assertEquals(null, restarted.snapshot.operationId)
    assertEquals(null, restarted.snapshot.operationGeneration)
    assertEquals(listOf(T3VoiceBackgroundCommand.RESTART_REALTIME), restarted.commands)
  }

  @Test
  fun `process restore reuploads durable recording and reconciles accepted playback`() {
    val finalized =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.FINALIZED,
        dispatchAcknowledged = false,
        recordingId = "recording-1",
        eventCursor = 0,
        messageId = null,
        turnId = null,
      )
    val upload =
      T3VoiceBackgroundReducer.reduce(finalized, T3VoiceBackgroundEvent.ProcessRestored)
    assertEquals(T3VoiceBackgroundPhase.FINALIZED, upload.snapshot.phase)
    assertEquals("operation-1", upload.snapshot.operationId)
    assertEquals(listOf(T3VoiceBackgroundCommand.UPLOAD_RECORDING), upload.commands)

    val playing =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.PLAYING,
        highestAdvertisedSpeechSegment = 0,
        finalSpeechSegment = 0,
        speechTerminal = true,
      )
    val reconciled =
      T3VoiceBackgroundReducer.reduce(playing, T3VoiceBackgroundEvent.ProcessRestored)
    assertEquals(T3VoiceBackgroundPhase.WAITING, reconciled.snapshot.phase)
    assertTrue(T3VoiceBackgroundCommand.FETCH_EVENT_GAP in reconciled.commands)
    assertTrue(T3VoiceBackgroundCommand.FETCH_SPEECH_SEGMENT in reconciled.commands)
  }

  @Test
  fun `stop detaches an accepted coding turn without cancelling it`() {
    val stopped =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        T3VoiceBackgroundEvent.Stop,
      )
    assertEquals(T3VoiceBackgroundPhase.IDLE, stopped.snapshot.phase)
    assertTrue(T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION in stopped.commands)
    assertFalse(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in stopped.commands)
  }

  @Test
  fun `stop cancels an undispatched operation and deletes its finalized recording`() {
    val stopped =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = false).copy(
          phase = T3VoiceBackgroundPhase.FINALIZED,
          dispatchAcknowledged = false,
          eventCursor = 0,
          recordingId = "recording-1",
          messageId = null,
          turnId = null,
        ),
        T3VoiceBackgroundEvent.Stop,
      )
    assertTrue(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in stopped.commands)
    assertTrue(T3VoiceBackgroundCommand.DELETE_RECORDING in stopped.commands)
    assertEquals(null, stopped.snapshot.recordingId)
  }

  @Test
  fun `server cancellation and permanent failure retain operation through acknowledgement`() {
    listOf(
      T3VoiceBackgroundServerPhase.CANCELLED,
      T3VoiceBackgroundServerPhase.FAILED_PERMANENT,
    ).forEach { terminalPhase ->
      val current =
        activeWaitingSnapshot(autoRearm = false).copy(
          dispatchAcknowledged = false,
          recordingId = "recording-1",
          messageId = null,
          turnId = null,
        )
      val terminal =
        T3VoiceBackgroundReducer.reduce(current, serverEvent(2, terminalPhase))
      assertEquals(T3VoiceBackgroundPhase.FAILED, terminal.snapshot.phase)
      assertTrue(terminal.snapshot.responseTerminal)
      assertEquals("operation-1", terminal.snapshot.operationId)
      assertEquals("recording-1", terminal.snapshot.recordingId)
      assertFalse(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in terminal.commands)
      assertFalse(T3VoiceBackgroundCommand.DELETE_RECORDING in terminal.commands)
    }
  }

  @Test
  fun `attention required retains operation for foreground resolution`() {
    val attention =
      T3VoiceBackgroundReducer.reduce(
        activeWaitingSnapshot(autoRearm = false),
        serverEvent(2, T3VoiceBackgroundServerPhase.ATTENTION_REQUIRED),
      )
    assertEquals(T3VoiceBackgroundPhase.ATTENTION_REQUIRED, attention.snapshot.phase)
    assertEquals("operation-1", attention.snapshot.operationId)
    assertFalse(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in attention.commands)
    assertFalse(T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION in attention.commands)
  }

  @Test
  fun `target replacement locks state and fences stale replacements`() {
    val current = activeWaitingSnapshot(autoRearm = true)
    val stale =
      T3VoiceBackgroundReducer.reduce(
        current,
        T3VoiceBackgroundEvent.TargetReplaced(2),
      )
    assertEquals(current, stale.snapshot)
    val replaced =
      T3VoiceBackgroundReducer.reduce(
        current,
        T3VoiceBackgroundEvent.TargetReplaced(4),
      )
    assertEquals(T3VoiceBackgroundPhase.LOCKED, replaced.snapshot.phase)
    assertTrue(T3VoiceBackgroundCommand.DETACH_DISPATCHED_OPERATION in replaced.commands)
  }

  @Test
  fun `target replacement deletes a finalized recording`() {
    val current =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.FINALIZED,
        dispatchAcknowledged = false,
        eventCursor = 0,
        recordingId = "recording-1",
        messageId = null,
        turnId = null,
      )
    val replaced =
      T3VoiceBackgroundReducer.reduce(current, T3VoiceBackgroundEvent.TargetReplaced(4))
    assertTrue(T3VoiceBackgroundCommand.CANCEL_UNDISPATCHED_OPERATION in replaced.commands)
    assertTrue(T3VoiceBackgroundCommand.DELETE_RECORDING in replaced.commands)
  }

  @Test
  fun `snapshot store round trips a process recovery cursor and rejects corrupt state`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceBackgroundSnapshotStore(storage)
    val snapshot = activeWaitingSnapshot(autoRearm = true)
    store.write(snapshot)
    assertEquals(snapshot, store.read())

    val cursorKey = storage.values.keys.single { it.endsWith("event_cursor") }
    storage.values[cursorKey] = "not-a-number"
    assertEquals(T3VoiceBackgroundSnapshot(), store.read())
    assertTrue(storage.values.isEmpty())
  }

  @Test
  fun `snapshot invariants reject cross-mode and incomplete operation recovery`() {
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(mode = T3VoiceBackgroundMode.REALTIME)
    }
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(operationGeneration = null)
    }
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = T3VoiceBackgroundPhase.PLAYBACK_DRAINED,
      )
    }
  }

  @Test
  fun `snapshot recovery clears a persisted cross-mode phase`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceBackgroundSnapshotStore(storage)
    store.write(activeWaitingSnapshot(autoRearm = false))
    val modeKey = storage.values.keys.single { it.endsWith("_mode") }
    storage.values[modeKey] = T3VoiceBackgroundMode.REALTIME.name

    assertEquals(T3VoiceBackgroundSnapshot(), store.read())
    assertTrue(storage.values.isEmpty())
  }

  private fun reduce(
    previous: T3VoiceBackgroundTransition,
    event: T3VoiceBackgroundEvent,
    phase: T3VoiceBackgroundPhase,
    vararg commands: T3VoiceBackgroundCommand,
  ): T3VoiceBackgroundTransition =
    T3VoiceBackgroundReducer.reduce(previous.snapshot, event).also { transition ->
      assertEquals(phase, transition.snapshot.phase)
      commands.forEach { assertTrue(it in transition.commands) }
    }

  private fun authority(generation: Long, autoRearm: Boolean) =
    T3VoiceBackgroundEvent.AuthorityValidated(
      runtimeId = "runtime-1",
      readinessGeneration = generation,
      mode = T3VoiceBackgroundMode.THREAD,
      autoRearm = autoRearm,
    )

  private fun activeWaitingSnapshot(autoRearm: Boolean) =
    T3VoiceBackgroundSnapshot(
      runtimeId = "runtime-1",
      readinessGeneration = 3,
      mode = T3VoiceBackgroundMode.THREAD,
      phase = T3VoiceBackgroundPhase.WAITING,
      operationId = "operation-1",
      operationGeneration = 3,
      dispatchAcknowledged = true,
      eventCursor = 1,
      autoRearm = autoRearm,
      messageId = "message-1",
      turnId = "turn-1",
    )

  private fun serverEvent(
    sequence: Long,
    phase: T3VoiceBackgroundServerPhase,
    generation: Long = 3,
    dispatchAcknowledged: Boolean = false,
    speechSegmentIndex: Int? = null,
    finalSpeechSegment: Boolean = false,
    speechTerminal: Boolean = false,
    noSpeech: Boolean = false,
    messageId: String? = null,
    turnId: String? = null,
  ) =
    T3VoiceBackgroundEvent.ServerEvent(
      operationId = "operation-1",
      operationGeneration = generation,
      sequence = sequence,
      phase = phase,
      dispatchAcknowledged = dispatchAcknowledged,
      speechSegmentIndex = speechSegmentIndex,
      finalSpeechSegment = finalSpeechSegment,
      speechTerminal = speechTerminal,
      noSpeech = noSpeech,
      messageId = messageId,
      turnId = turnId,
    )
}
