package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeSpeechDisposition
import expo.modules.t3voice.store.MemoryRuntimeStorage
import expo.modules.t3voice.store.VoiceRuntimeExecutionSnapshotStore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeExecutionStateTest {
  @Test
  fun `thread operation advances through capture dispatch speech drain and rearm`() {
    var transition =
      VoiceRuntimeExecutionReducer.reduce(
        VoiceRuntimeExecutionSnapshot(),
        authority(generation = 3, autoRearm = true),
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.StartRecording("operation-1", "recording-1"),
        VoiceRuntimePhase.RECORDING,
        VoiceRuntimeCommand.START_RECORDING,
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.RecordingFinalized("operation-1", "recording-1"),
        VoiceRuntimePhase.FINALIZED,
        VoiceRuntimeCommand.UPLOAD_RECORDING,
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.UploadStarted("operation-1"),
        VoiceRuntimePhase.UPLOADING,
      )
    transition =
      reduce(
        transition,
        serverEvent(1, VoiceRuntimeServerPhase.TRANSCRIBING),
        VoiceRuntimePhase.TRANSCRIBING,
      )
    transition =
      reduce(
        transition,
        serverEvent(
          2,
          VoiceRuntimeServerPhase.WAITING,
          dispatchAcknowledged = true,
          messageId = "message-1",
          turnId = "turn-1",
        ),
        VoiceRuntimePhase.WAITING,
        VoiceRuntimeCommand.DELETE_RECORDING,
      )
    assertTrue(transition.snapshot.dispatchAcknowledged)
    assertEquals(null, transition.snapshot.recordingId)
    transition =
      reduce(
        transition,
        serverEvent(
          3,
          VoiceRuntimeServerPhase.SPEAKING,
          speechSegmentIndex = 0,
          finalSpeechSegment = true,
          speechTerminal = true,
        ),
        VoiceRuntimePhase.WAITING,
        VoiceRuntimeCommand.FETCH_SPEECH_SEGMENT,
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
        VoiceRuntimePhase.PLAYING,
      )
    transition =
      reduce(
        transition,
        serverEvent(4, VoiceRuntimeServerPhase.COMPLETED),
        VoiceRuntimePhase.PLAYING,
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.PlaybackDrained("operation-1", 0),
        VoiceRuntimePhase.PLAYBACK_DRAINED,
      )
    transition =
      reduce(
        transition,
        VoiceRuntimeExecutionEvent.RearmGuardElapsed,
        VoiceRuntimePhase.REARMING,
        VoiceRuntimeCommand.START_RECORDING,
      )
    assertEquals(null, transition.snapshot.operationId)
  }

  @Test
  fun `auto rearm waits for both terminal response and final playback drain`() {
    var snapshot = activeWaitingSnapshot(autoRearm = true)
    snapshot =
      VoiceRuntimeExecutionReducer.reduce(
        snapshot,
        serverEvent(
          2,
          VoiceRuntimeServerPhase.SPEAKING,
          speechSegmentIndex = 0,
          finalSpeechSegment = true,
          speechTerminal = true,
        ),
      ).snapshot
    snapshot =
      VoiceRuntimeExecutionReducer.reduce(
        snapshot,
        VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
      ).snapshot
    val drained =
      VoiceRuntimeExecutionReducer.reduce(
        snapshot,
        VoiceRuntimeExecutionEvent.PlaybackDrained("operation-1", 0),
      )
    assertEquals(VoiceRuntimePhase.WAITING, drained.snapshot.phase)
    assertFalse(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD in drained.commands)

    val completed =
      VoiceRuntimeExecutionReducer.reduce(
        drained.snapshot,
        serverEvent(3, VoiceRuntimeServerPhase.COMPLETED),
      )
    assertEquals(VoiceRuntimePhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertFalse(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `final segment advertisement waits for explicit speech terminal`() {
    val advertised = VoiceRuntimeExecutionReducer.reduce(
      activeWaitingSnapshot(autoRearm = true),
      serverEvent(2, VoiceRuntimeServerPhase.SPEAKING, speechSegmentIndex = 0,
        finalSpeechSegment = true, speechTerminal = false),
    ).snapshot
    assertEquals(0, advertised.finalSpeechSegment)
    assertFalse(advertised.speechTerminal)
    val terminal = VoiceRuntimeExecutionReducer.reduce(
      advertised,
      serverEvent(3, VoiceRuntimeServerPhase.SPEAKING, speechTerminal = true),
    ).snapshot
    assertTrue(terminal.speechTerminal)
  }

  @Test
  fun `stale duplicate and gap events cannot move cursors`() {
    val current = activeWaitingSnapshot(autoRearm = false)
    assertEquals(
      current,
      VoiceRuntimeExecutionReducer.reduce(
        current,
        serverEvent(1, VoiceRuntimeServerPhase.COMPLETED),
      ).snapshot,
    )
    val gap =
      VoiceRuntimeExecutionReducer.reduce(
        current,
        serverEvent(3, VoiceRuntimeServerPhase.COMPLETED),
      )
    assertEquals(current, gap.snapshot)
    assertEquals(listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP), gap.commands)
    assertEquals(
      current,
      VoiceRuntimeExecutionReducer.reduce(
        current,
        serverEvent(2, VoiceRuntimeServerPhase.COMPLETED, generation = 2),
      ).snapshot,
    )
  }

  @Test
  fun `same target authority update preserves operation generation and accepts its events`() {
    val current = activeWaitingSnapshot(autoRearm = false)
    val updated =
      VoiceRuntimeExecutionReducer.reduce(
        current,
        authority(generation = 4, autoRearm = true),
      )
    assertEquals(4L, updated.snapshot.readinessGeneration)
    assertEquals(3L, updated.snapshot.operationGeneration)
    assertEquals("operation-1", updated.snapshot.operationId)
    assertTrue(updated.snapshot.autoRearm)
    assertTrue(updated.commands.isEmpty())

    val applied =
      VoiceRuntimeExecutionReducer.reduce(
        updated.snapshot,
        serverEvent(2, VoiceRuntimeServerPhase.WAITING, generation = 3),
      )
    assertEquals(2L, applied.snapshot.eventCursor)
  }

  @Test
  fun `authority replacement cleans old target before accepting the new target`() {
    val replaced =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = false),
        VoiceRuntimeExecutionEvent.AuthorityValidated(
          runtimeId = "runtime-2",
          readinessGeneration = 4,
          mode = VoiceRuntimeExecutionMode.THREAD,
          autoRearm = false,
        ),
      )
    assertEquals(VoiceRuntimePhase.IDLE, replaced.snapshot.phase)
    assertEquals("runtime-2", replaced.snapshot.runtimeId)
    assertEquals(null, replaced.snapshot.operationId)
    assertTrue(VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION in replaced.commands)
  }

  @Test
  fun `completed without explicit speech terminal does not infer no speech`() {
    val completed =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        serverEvent(2, VoiceRuntimeServerPhase.COMPLETED),
      )
    assertTrue(completed.snapshot.responseTerminal)
    assertFalse(completed.snapshot.speechTerminal)
    assertEquals(VoiceRuntimePhase.WAITING, completed.snapshot.phase)
    assertFalse(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `explicit no speech terminal permits completed operation to rearm`() {
    val completed =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        serverEvent(
          2,
          VoiceRuntimeServerPhase.COMPLETED,
          speechTerminal = true,
          noSpeech = true,
        ),
      )
    assertTrue(completed.snapshot.noSpeech)
    assertEquals(VoiceRuntimePhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertFalse(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD in completed.commands)
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
      VoiceRuntimeExecutionReducer.reduce(
        current,
        serverEvent(
          2,
          VoiceRuntimeServerPhase.COMPLETED,
          speechTerminal = true,
          noSpeech = true,
        ),
      )
    assertEquals(VoiceRuntimePhase.PLAYBACK_DRAINED, completed.snapshot.phase)
    assertEquals(null, completed.snapshot.recordingId)
    assertEquals("operation-1", completed.snapshot.operationId)
    assertTrue(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in completed.commands)
    assertTrue(VoiceRuntimeCommand.DELETE_RECORDING in completed.commands)
    assertFalse(VoiceRuntimeCommand.SCHEDULE_REARM_GUARD in completed.commands)
  }

  @Test
  fun `network retry reuploads only before dispatch acceptance`() {
    val uploading =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = VoiceRuntimePhase.UPLOADING,
        dispatchAcknowledged = false,
        eventCursor = 0,
        recordingId = "recording-1",
      )
    val retry = VoiceRuntimeExecutionReducer.reduce(uploading, VoiceRuntimeExecutionEvent.NetworkRetry)
    assertEquals(VoiceRuntimePhase.FINALIZED, retry.snapshot.phase)
    assertEquals(listOf(VoiceRuntimeCommand.UPLOAD_RECORDING), retry.commands)

    val accepted =
      uploading.copy(
        dispatchAcknowledged = true,
        phase = VoiceRuntimePhase.WAITING,
        recordingId = null,
      )
    val poll = VoiceRuntimeExecutionReducer.reduce(accepted, VoiceRuntimeExecutionEvent.NetworkRetry)
    assertEquals(listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP), poll.commands)
  }

  @Test
  fun `retryable failure reuploads retained recording under the same operation`() {
    val failed =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = VoiceRuntimePhase.FAILED,
        dispatchAcknowledged = false,
        recordingId = "recording-1",
        responseTerminal = true,
        terminalSummary = VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
        messageId = null,
        turnId = null,
      )
    val retry = VoiceRuntimeExecutionReducer.reduce(failed, VoiceRuntimeExecutionEvent.NetworkRetry)
    assertEquals(VoiceRuntimePhase.FINALIZED, retry.snapshot.phase)
    assertEquals("operation-1", retry.snapshot.operationId)
    assertEquals("recording-1", retry.snapshot.recordingId)
    assertFalse(retry.snapshot.responseTerminal)
    assertEquals(null, retry.snapshot.terminalSummary)
    assertEquals(listOf(VoiceRuntimeCommand.UPLOAD_RECORDING), retry.commands)

    val dispatched =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = false).copy(
          phase = VoiceRuntimePhase.FAILED,
          responseTerminal = true,
          terminalSummary = VoiceRuntimeTerminalSummary.FAILED_RETRYABLE,
        ),
        VoiceRuntimeExecutionEvent.NetworkRetry,
      )
    assertEquals(VoiceRuntimePhase.FAILED, dispatched.snapshot.phase)
    assertEquals(listOf(VoiceRuntimeCommand.FETCH_EVENT_GAP), dispatched.commands)
  }

  @Test
  fun `process restore abandons dead capture and restarts realtime`() {
    var thread =
      VoiceRuntimeExecutionReducer.reduce(
        VoiceRuntimeExecutionSnapshot(),
        authority(generation = 3, autoRearm = false),
      )
    thread =
      VoiceRuntimeExecutionReducer.reduce(
        thread.snapshot,
        VoiceRuntimeExecutionEvent.StartRecording("operation-1", "recording-1"),
      )
    val abandoned =
      VoiceRuntimeExecutionReducer.reduce(thread.snapshot, VoiceRuntimeExecutionEvent.ProcessRestored)
    assertEquals(VoiceRuntimePhase.IDLE, abandoned.snapshot.phase)
    assertTrue(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in abandoned.commands)
    assertTrue(VoiceRuntimeCommand.DELETE_RECORDING in abandoned.commands)

    val realtimeReady =
      VoiceRuntimeExecutionReducer.reduce(
        VoiceRuntimeExecutionSnapshot(),
        VoiceRuntimeExecutionEvent.AuthorityValidated(
          runtimeId = "runtime-1",
          readinessGeneration = 3,
          mode = VoiceRuntimeExecutionMode.REALTIME,
          autoRearm = false,
        ),
      )
    val realtimeStarting =
      VoiceRuntimeExecutionReducer.reduce(
        realtimeReady.snapshot,
        VoiceRuntimeExecutionEvent.StartRealtime("operation-realtime"),
      )
    val active =
      VoiceRuntimeExecutionReducer.reduce(
        realtimeStarting.snapshot,
        VoiceRuntimeExecutionEvent.RealtimeConnected("operation-realtime"),
      )
    val restarted =
      VoiceRuntimeExecutionReducer.reduce(active.snapshot, VoiceRuntimeExecutionEvent.ProcessRestored)
    assertEquals(VoiceRuntimePhase.IDLE, restarted.snapshot.phase)
    assertEquals(null, restarted.snapshot.operationId)
    assertEquals(null, restarted.snapshot.operationGeneration)
    assertEquals(listOf(VoiceRuntimeCommand.RESTART_REALTIME), restarted.commands)
  }

  @Test
  fun `process restore reuploads durable recording and reconciles accepted playback`() {
    val finalized =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = VoiceRuntimePhase.FINALIZED,
        dispatchAcknowledged = false,
        recordingId = "recording-1",
        eventCursor = 0,
        messageId = null,
        turnId = null,
      )
    val upload =
      VoiceRuntimeExecutionReducer.reduce(finalized, VoiceRuntimeExecutionEvent.ProcessRestored)
    assertEquals(VoiceRuntimePhase.FINALIZED, upload.snapshot.phase)
    assertEquals("operation-1", upload.snapshot.operationId)
    assertEquals(listOf(VoiceRuntimeCommand.UPLOAD_RECORDING), upload.commands)

    val advertised = activeWaitingSnapshot(autoRearm = false).copy(
      highestAdvertisedSpeechSegment = 0,
      finalSpeechSegment = 0,
      speechTerminal = true,
    )
    val playing = VoiceRuntimeExecutionReducer.reduce(
      advertised,
      VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
    ).snapshot
    val reconciled =
      VoiceRuntimeExecutionReducer.reduce(playing, VoiceRuntimeExecutionEvent.ProcessRestored)
    assertEquals(VoiceRuntimePhase.WAITING, reconciled.snapshot.phase)
    assertEquals(0, reconciled.snapshot.highestStartedSpeechSegment)
    assertEquals(-1, reconciled.snapshot.highestDrainedSpeechSegment)
    assertEquals(0, reconciled.snapshot.playbackCursor)
    assertEquals(
      listOf(VoiceRuntimeSpeechDisposition(0, "interrupted")),
      reconciled.snapshot.speechSegmentDispositions,
    )
    assertTrue(VoiceRuntimeCommand.FETCH_EVENT_GAP in reconciled.commands)
    assertTrue(VoiceRuntimeCommand.FETCH_SPEECH_SEGMENT in reconciled.commands)
  }

  @Test
  fun `playback start is durable before drain and failed playback is never retried`() {
    val advertised = activeWaitingSnapshot(autoRearm = false).copy(
      highestAdvertisedSpeechSegment = 0,
    )
    val started = VoiceRuntimeExecutionReducer.reduce(
      advertised,
      VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
    ).snapshot
    assertEquals(0, started.highestStartedSpeechSegment)
    assertEquals(-1, started.playbackCursor)
    assertTrue(started.speechSegmentDispositions.isEmpty())

    val failed = VoiceRuntimeExecutionReducer.reduce(
      started,
      VoiceRuntimeExecutionEvent.PlaybackFailed("operation-1", 0),
    ).snapshot
    assertEquals(0, failed.playbackCursor)
    assertEquals(-1, failed.highestDrainedSpeechSegment)
    assertEquals(
      listOf(VoiceRuntimeSpeechDisposition(0, "failed")),
      failed.speechSegmentDispositions,
    )
  }

  @Test
  fun `stop detaches an accepted coding turn without cancelling it`() {
    val stopped =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = true),
        VoiceRuntimeExecutionEvent.Stop,
      )
    assertEquals(VoiceRuntimePhase.IDLE, stopped.snapshot.phase)
    assertTrue(VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION in stopped.commands)
    assertFalse(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in stopped.commands)
  }

  @Test
  fun `stop cancels an undispatched operation and deletes its finalized recording`() {
    val stopped =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = false).copy(
          phase = VoiceRuntimePhase.FINALIZED,
          dispatchAcknowledged = false,
          eventCursor = 0,
          recordingId = "recording-1",
          messageId = null,
          turnId = null,
        ),
        VoiceRuntimeExecutionEvent.Stop,
      )
    assertTrue(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in stopped.commands)
    assertTrue(VoiceRuntimeCommand.DELETE_RECORDING in stopped.commands)
    assertEquals(null, stopped.snapshot.recordingId)
  }

  @Test
  fun `server cancellation and permanent failure retain operation through acknowledgement`() {
    listOf(
      VoiceRuntimeServerPhase.CANCELLED,
      VoiceRuntimeServerPhase.FAILED_PERMANENT,
    ).forEach { terminalPhase ->
      val current =
        activeWaitingSnapshot(autoRearm = false).copy(
          dispatchAcknowledged = false,
          recordingId = "recording-1",
          messageId = null,
          turnId = null,
        )
      val terminal =
        VoiceRuntimeExecutionReducer.reduce(current, serverEvent(2, terminalPhase))
      assertEquals(VoiceRuntimePhase.FAILED, terminal.snapshot.phase)
      assertTrue(terminal.snapshot.responseTerminal)
      assertEquals("operation-1", terminal.snapshot.operationId)
      assertEquals("recording-1", terminal.snapshot.recordingId)
      assertFalse(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in terminal.commands)
      assertFalse(VoiceRuntimeCommand.DELETE_RECORDING in terminal.commands)
    }
  }

  @Test
  fun `attention required retains operation for foreground resolution`() {
    val attention =
      VoiceRuntimeExecutionReducer.reduce(
        activeWaitingSnapshot(autoRearm = false),
        serverEvent(2, VoiceRuntimeServerPhase.ATTENTION_REQUIRED),
      )
    assertEquals(VoiceRuntimePhase.ATTENTION_REQUIRED, attention.snapshot.phase)
    assertEquals("operation-1", attention.snapshot.operationId)
    assertFalse(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in attention.commands)
    assertFalse(VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION in attention.commands)
  }

  @Test
  fun `target replacement locks state and fences stale replacements`() {
    val current = activeWaitingSnapshot(autoRearm = true)
    val stale =
      VoiceRuntimeExecutionReducer.reduce(
        current,
        VoiceRuntimeExecutionEvent.TargetReplaced(2),
      )
    assertEquals(current, stale.snapshot)
    val replaced =
      VoiceRuntimeExecutionReducer.reduce(
        current,
        VoiceRuntimeExecutionEvent.TargetReplaced(4),
      )
    assertEquals(VoiceRuntimePhase.LOCKED, replaced.snapshot.phase)
    assertTrue(VoiceRuntimeCommand.DETACH_DISPATCHED_OPERATION in replaced.commands)
  }

  @Test
  fun `target replacement deletes a finalized recording`() {
    val current =
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = VoiceRuntimePhase.FINALIZED,
        dispatchAcknowledged = false,
        eventCursor = 0,
        recordingId = "recording-1",
        messageId = null,
        turnId = null,
      )
    val replaced =
      VoiceRuntimeExecutionReducer.reduce(current, VoiceRuntimeExecutionEvent.TargetReplaced(4))
    assertTrue(VoiceRuntimeCommand.CANCEL_UNDISPATCHED_OPERATION in replaced.commands)
    assertTrue(VoiceRuntimeCommand.DELETE_RECORDING in replaced.commands)
  }

  @Test
  fun `snapshot store round trips a process recovery cursor and rejects corrupt state`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeExecutionSnapshotStore(storage)
    val snapshot = activeWaitingSnapshot(autoRearm = true)
    store.write(snapshot)
    assertEquals(snapshot, store.read())

    val cursorKey = storage.values.keys.single { it.endsWith("event_cursor") }
    storage.values[cursorKey] = "not-a-number"
    assertEquals(VoiceRuntimeExecutionSnapshot(), store.read())
    assertTrue(storage.values.isEmpty())
  }

  @Test
  fun `snapshot invariants reject cross-mode and incomplete operation recovery`() {
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(mode = VoiceRuntimeExecutionMode.REALTIME)
    }
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(operationGeneration = null)
    }
    assertThrows(IllegalArgumentException::class.java) {
      activeWaitingSnapshot(autoRearm = false).copy(
        phase = VoiceRuntimePhase.PLAYBACK_DRAINED,
      )
    }
  }

  @Test
  fun `snapshot recovery clears a persisted cross-mode phase`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeExecutionSnapshotStore(storage)
    store.write(activeWaitingSnapshot(autoRearm = false))
    val modeKey = storage.values.keys.single { it.endsWith("_mode") }
    storage.values[modeKey] = VoiceRuntimeExecutionMode.REALTIME.name

    assertEquals(VoiceRuntimeExecutionSnapshot(), store.read())
    assertTrue(storage.values.isEmpty())
  }

  private fun reduce(
    previous: VoiceRuntimeExecutionTransition,
    event: VoiceRuntimeExecutionEvent,
    phase: VoiceRuntimePhase,
    vararg commands: VoiceRuntimeCommand,
  ): VoiceRuntimeExecutionTransition =
    VoiceRuntimeExecutionReducer.reduce(previous.snapshot, event).also { transition ->
      assertEquals(phase, transition.snapshot.phase)
      commands.forEach { assertTrue(it in transition.commands) }
    }

  private fun authority(generation: Long, autoRearm: Boolean) =
    VoiceRuntimeExecutionEvent.AuthorityValidated(
      runtimeId = "runtime-1",
      readinessGeneration = generation,
      mode = VoiceRuntimeExecutionMode.THREAD,
      autoRearm = autoRearm,
    )

  private fun activeWaitingSnapshot(autoRearm: Boolean) =
    VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime-1",
      readinessGeneration = 3,
      mode = VoiceRuntimeExecutionMode.THREAD,
      phase = VoiceRuntimePhase.WAITING,
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
    phase: VoiceRuntimeServerPhase,
    generation: Long = 3,
    dispatchAcknowledged: Boolean = false,
    speechSegmentIndex: Int? = null,
    finalSpeechSegment: Boolean = false,
    speechTerminal: Boolean = false,
    noSpeech: Boolean = false,
    messageId: String? = null,
    turnId: String? = null,
  ) =
    VoiceRuntimeExecutionEvent.ServerEvent(
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
