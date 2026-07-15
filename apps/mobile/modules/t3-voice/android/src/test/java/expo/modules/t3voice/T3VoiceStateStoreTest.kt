package expo.modules.t3voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class T3VoiceStateStoreTest {
  @Before
  fun resetStore() {
    T3VoiceStateStore.recordingTermination.value?.let {
      T3VoiceStateStore.clearRecordingTermination(it.recordingId)
    }
    T3VoiceStateStore.playbackTermination.value?.let {
      T3VoiceStateStore.clearPlaybackTermination(it.playbackId)
    }
    T3VoiceStateStore.threadVoiceHandoff.value?.let {
      T3VoiceStateStore.clearThreadVoiceHandoff(it.actionId)
    }
    T3VoiceStateStore.setInactive()
    T3VoiceStateStore.setServiceReady()
  }

  @After
  fun tearDown() {
    T3VoiceStateStore.setInactive()
  }

  @Test
  fun realtimeOwnershipIsClaimedAtomically() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertFalse(T3VoiceStateStore.claimRealtime("session-b"))
    assertEquals("session-a", T3VoiceStateStore.state.value.activeRealtimeSessionId)
  }

  @Test
  fun threadVoiceHandoffRemainsReplayableUntilAcknowledged() {
    val event =
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = "action-1",
        projectId = "project-1",
        threadId = "thread-1",
        recordingId = "recording-1",
        autoRearm = true,
        environmentOrigin = "https://termstation",
        expiresAtEpochMillis = 2_000,
      )
    val owner = checkNotNull(claimComposerRecording(event.recordingId))
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    assertEquals(event, T3VoiceStateStore.pendingThreadVoiceHandoff())
    T3VoiceStateStore.clearThreadVoiceHandoff("other-action")
    assertEquals(event, T3VoiceStateStore.threadVoiceHandoff.value)
    T3VoiceStateStore.clearThreadVoiceHandoff(event.actionId)
    assertNull(T3VoiceStateStore.threadVoiceHandoff.value)
    assertTrue(T3VoiceStateStore.releaseRecording(owner))
  }

  @Test
  fun handoffLifetimeFollowsItsRecordingInsteadOfTheServerActionDeadline() {
    val event =
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = "expired-action",
        projectId = "project-1",
        threadId = "thread-1",
        recordingId = "recording-1",
        autoRearm = true,
        environmentOrigin = "https://termstation",
        expiresAtEpochMillis = 2_000,
      )
    val owner = checkNotNull(claimComposerRecording(event.recordingId))
    T3VoiceStateStore.publishThreadVoiceHandoff(event)

    assertEquals(event, T3VoiceStateStore.pendingThreadVoiceHandoff())
    assertTrue(T3VoiceStateStore.releaseRecording(owner))
    assertNull(T3VoiceStateStore.pendingThreadVoiceHandoff())
    assertNull(T3VoiceStateStore.threadVoiceHandoff.value)
  }

  @Test
  fun completedRecordingKeepsHandoffReplayableUntilReactConsumesIt() {
    val event =
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = "completed-action",
        projectId = "project-1",
        threadId = "thread-1",
        recordingId = "recording-1",
        autoRearm = true,
        environmentOrigin = "https://termstation",
        expiresAtEpochMillis = 2_000,
      )
    val owner = checkNotNull(claimComposerRecording(event.recordingId))
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    assertTrue(
      T3VoiceStateStore.terminateRecording(
        owner,
        T3VoiceRuntimeEvent.RecordingTerminated(
          recordingId = event.recordingId,
          recording = null,
          outcome = "completed",
          reason = "speech-ended",
        ),
      ),
    )

    assertEquals(event, T3VoiceStateStore.pendingThreadVoiceHandoff())
    T3VoiceStateStore.clearRecordingTermination(event.recordingId)
    assertNull(T3VoiceStateStore.pendingThreadVoiceHandoff())
  }

  @Test
  fun adoptedHandoffProtectsItsTerminationUntilTheComposerConsumesIt() {
    val event =
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = "adopted-action",
        projectId = "project-1",
        threadId = "thread-1",
        recordingId = "recording-1",
        autoRearm = true,
        environmentOrigin = "https://termstation",
        expiresAtEpochMillis = 2_000,
      )
    val owner = checkNotNull(claimComposerRecording(event.recordingId))
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    assertTrue(T3VoiceStateStore.markThreadVoiceHandoffAdopted(event.actionId))
    assertTrue(T3VoiceStateStore.isThreadVoiceHandoffAdopted(event.actionId))
    assertTrue(T3VoiceStateStore.isThreadVoiceHandoffRecordingProtected(event.recordingId))
    assertFalse(T3VoiceStateStore.isThreadVoiceHandoffRecordingProtected("unrelated-recording"))
    assertTrue(
      T3VoiceStateStore.terminateRecording(
        owner,
        T3VoiceRuntimeEvent.RecordingTerminated(
          recordingId = event.recordingId,
          recording = null,
          outcome = "completed",
          reason = "speech-ended",
        ),
      ),
    )

    assertEquals(event, T3VoiceStateStore.pendingThreadVoiceHandoff())
    T3VoiceStateStore.clearRecordingTermination(event.recordingId)
    assertNull(T3VoiceStateStore.pendingThreadVoiceHandoff())
    assertFalse(T3VoiceStateStore.isThreadVoiceHandoffRecordingProtected(event.recordingId))
  }

  @Test
  fun adoptionClaimProtectsPendingHandoffUntilItsBoundedDeadline() {
    val event =
      T3VoiceRuntimeEvent.ThreadVoiceHandoff(
        actionId = "claimed-action",
        projectId = "project-1",
        threadId = "thread-1",
        recordingId = "recording-1",
        autoRearm = true,
        environmentOrigin = "https://termstation",
        expiresAtEpochMillis = 2_000,
      )
    val owner = checkNotNull(claimComposerRecording(event.recordingId))
    T3VoiceStateStore.publishThreadVoiceHandoff(event)

    assertTrue(T3VoiceStateStore.beginThreadVoiceHandoffAdoption(event.actionId, 5_000))
    assertTrue(T3VoiceStateStore.isThreadVoiceHandoffAdoptionClaimed(event.actionId, 4_999))
    assertFalse(T3VoiceStateStore.isThreadVoiceHandoffAdoptionClaimed(event.actionId, 5_000))
    assertFalse(T3VoiceStateStore.beginThreadVoiceHandoffAdoption("other-action", 5_000))
    assertTrue(T3VoiceStateStore.releaseRecording(owner))
  }

  @Test
  fun modeClaimsClearMutuallyExclusiveAndTerminalRealtimeFields() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertTrue(
      T3VoiceStateStore.terminateRealtime(
        T3VoiceRuntimeEvent.RealtimeTerminated(
          nativeSessionId = "session-a",
          outcome = "failed",
          code = "test-failure",
          retryable = true,
        ),
      ),
    )
    assertEquals("failed", T3VoiceStateStore.state.value.realtimeConnectionState)

    val recording = checkNotNull(claimComposerRecording("recording-a"))
    val recordingState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.ARMING, recordingState.phase)
    assertTrue(T3VoiceStateStore.markRecordingStarted(recording))
    assertEquals(T3VoiceRuntimePhase.RECORDING, T3VoiceStateStore.state.value.phase)
    assertNull(recordingState.activePlaybackId)
    assertNull(recordingState.activeRealtimeSessionId)
    assertNull(recordingState.realtimeConnectionState)
    assertFalse(recordingState.realtimeMuted)
    assertTrue(T3VoiceStateStore.releaseRecording(recording))

    val playback = checkNotNull(claimManualPlayback("playback-a"))
    val playbackState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.PLAYING, playbackState.phase)
    assertNull(playbackState.activeRecordingId)
    assertNull(playbackState.activeRealtimeSessionId)
    assertNull(playbackState.realtimeConnectionState)
    assertFalse(playbackState.realtimeMuted)
    assertTrue(T3VoiceStateStore.releasePlayback(playback))
  }

  @Test
  fun terminalStateIsDurableAndRejectsStaleUpdates() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    val terminal =
      T3VoiceRuntimeEvent.RealtimeTerminated(
        nativeSessionId = "session-a",
        outcome = "failed",
        code = "realtime-connection-failed",
        retryable = true,
      )

    T3VoiceStateStore.terminateRealtime(terminal)
    T3VoiceStateStore.setRealtime("session-a", "connected", false, true)

    assertNull(T3VoiceStateStore.state.value.activeRealtimeSessionId)
    assertEquals("failed", T3VoiceStateStore.state.value.realtimeConnectionState)
    assertEquals(terminal, T3VoiceStateStore.realtimeTermination.value)
  }

  @Test
  fun recordingTerminationIsDurableUntilMatchingAcknowledgement() {
    val owner = checkNotNull(claimComposerRecording("recording-a"))
    val recording = T3VoiceRecordingResult("recording-a", "file:///recording.m4a", 1_000, 4_096)
    val terminal =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = recording.recordingId,
        recording = recording,
        outcome = "completed",
        reason = "speech-ended",
      )

    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    T3VoiceStateStore.clearRecordingTermination("other-recording")
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    T3VoiceStateStore.clearRecordingTermination(recording.recordingId)
    assertNull(T3VoiceStateStore.recordingTermination.value)
  }

  @Test
  fun pendingRecordingTerminationBlocksReplacementButSurvivesRealtime() {
    val owner = checkNotNull(claimComposerRecording("recording-a"))
    val terminal =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = "recording-a",
        recording = null,
        outcome = "failed",
        reason = "finalization-failed",
      )
    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))

    assertNull(claimComposerRecording("recording-b"))
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    T3VoiceStateStore.releaseRealtimeClaim("session-a")
    T3VoiceStateStore.clearRecordingTermination("recording-a")
    assertTrue(claimComposerRecording("recording-b") != null)
  }

  @Test
  fun playbackTerminationIsDurableAndBlocksReplacementUntilAcknowledged() {
    val owner = checkNotNull(claimManualPlayback("playback-a"))
    val terminal = T3VoiceRuntimeEvent.PlaybackTerminated("playback-a", "completed")

    assertTrue(T3VoiceStateStore.terminatePlayback(owner, terminal))
    assertEquals(terminal, T3VoiceStateStore.playbackTermination.value)
    assertNull(claimManualPlayback("playback-b"))
    T3VoiceStateStore.clearPlaybackTermination("other-playback")
    assertEquals(terminal, T3VoiceStateStore.playbackTermination.value)
    T3VoiceStateStore.clearPlaybackTermination("playback-a")
    assertNull(T3VoiceStateStore.playbackTermination.value)
    assertTrue(claimManualPlayback("playback-b") != null)
  }

  @Test
  fun nativeThreadRecordingCyclesDoNotOccupyTheBridgeTerminalSlot() {
    repeat(3) { cycle ->
      val recordingId = "thread-recording-$cycle"
      val owner = checkNotNull(
        T3VoiceStateStore.claimRecording(
          recordingId,
          T3VoiceOperationOwnerDomain.THREAD_MODE,
          "thread-operation",
        ),
      )
      assertEquals(T3VoiceOperationOwnerDomain.THREAD_MODE, owner.domain)
      assertEquals("thread-operation", owner.operationId)
      assertTrue(
        T3VoiceStateStore.terminateRecording(
          owner,
          T3VoiceRuntimeEvent.RecordingTerminated(
            recordingId,
            null,
            "completed",
            "speech-ended",
          ),
        ),
      )
      assertNull(T3VoiceStateStore.recordingTermination.value)
    }
  }

  @Test
  fun nativeThreadPlaybackSegmentsDoNotOccupyTheBridgeTerminalSlot() {
    repeat(4) { segment ->
      val playbackId = "thread-playback:$segment"
      val owner = checkNotNull(
        T3VoiceStateStore.claimPlayback(
          playbackId,
          T3VoiceOperationOwnerDomain.THREAD_MODE,
          "thread-operation",
        ),
      )
      assertTrue(
        T3VoiceStateStore.terminatePlayback(
          owner,
          T3VoiceRuntimeEvent.PlaybackTerminated(playbackId, "completed"),
        ),
      )
      assertNull(T3VoiceStateStore.playbackTermination.value)
    }
  }

  @Test
  fun bridgeTerminalDoesNotBlockNativeThreadWork() {
    val composer = checkNotNull(claimComposerRecording("composer"))
    assertTrue(
      T3VoiceStateStore.terminateRecording(
        composer,
        T3VoiceRuntimeEvent.RecordingTerminated(
          "composer",
          null,
          "completed",
          "speech-ended",
        ),
      ),
    )

    val native = T3VoiceStateStore.claimRecording(
      "thread-recording",
      T3VoiceOperationOwnerDomain.THREAD_MODE,
      "thread-operation",
    )
    assertTrue(native != null)
    assertTrue(T3VoiceStateStore.releaseRecording(checkNotNull(native)))
    assertNull(claimComposerRecording("other-composer"))
  }

  @Test
  fun handoffTerminationIsHiddenUntilAtomicAdoption() {
    val event = T3VoiceRuntimeEvent.ThreadVoiceHandoff(
      actionId = "handoff-action",
      projectId = "project",
      threadId = "thread",
      recordingId = "handoff-recording",
      autoRearm = true,
      environmentOrigin = "https://termstation",
      expiresAtEpochMillis = 5_000,
    )
    val owner = checkNotNull(
      T3VoiceStateStore.claimRecording(
        event.recordingId,
        T3VoiceOperationOwnerDomain.REALTIME_HANDOFF,
        event.actionId,
      ),
    )
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    val terminal = T3VoiceRuntimeEvent.RecordingTerminated(
      event.recordingId,
      null,
      "completed",
      "speech-ended",
    )
    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))

    assertNull(T3VoiceStateStore.recordingTermination.value)
    T3VoiceStateStore.clearRecordingTermination(event.recordingId)
    assertEquals(event, T3VoiceStateStore.pendingThreadVoiceHandoff())
    assertEquals(
      terminal,
      T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(event.recordingId),
    )
    assertTrue(T3VoiceStateStore.beginThreadVoiceHandoffAdoption(event.actionId, 10_000))
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    assertNull(T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(event.recordingId))
  }

  @Test
  fun blockedHandoffAdoptionLeavesNativeOwnershipAndTerminalsUnchanged() {
    val composer = checkNotNull(claimComposerRecording("composer-recording"))
    val composerTerminal = T3VoiceRuntimeEvent.RecordingTerminated(
      "composer-recording",
      null,
      "completed",
      "speech-ended",
    )
    assertTrue(T3VoiceStateStore.terminateRecording(composer, composerTerminal))

    val event = T3VoiceRuntimeEvent.ThreadVoiceHandoff(
      actionId = "blocked-handoff",
      projectId = "project",
      threadId = "thread",
      recordingId = "handoff-recording",
      autoRearm = true,
      environmentOrigin = "https://termstation",
      expiresAtEpochMillis = 5_000,
    )
    val handoff = checkNotNull(
      T3VoiceStateStore.claimRecording(
        event.recordingId,
        T3VoiceOperationOwnerDomain.REALTIME_HANDOFF,
        event.actionId,
      ),
    )
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    val handoffTerminal = T3VoiceRuntimeEvent.RecordingTerminated(
      event.recordingId,
      null,
      "completed",
      "speech-ended",
    )
    assertTrue(T3VoiceStateStore.terminateRecording(handoff, handoffTerminal))

    assertFalse(T3VoiceStateStore.beginThreadVoiceHandoffAdoption(event.actionId, 10_000))
    assertEquals(composerTerminal, T3VoiceStateStore.recordingTermination.value)
    assertEquals(
      handoffTerminal,
      T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(event.recordingId),
    )
    assertFalse(T3VoiceStateStore.isThreadVoiceHandoffAdoptionClaimed(event.actionId, 9_000))
  }

  @Test
  fun replacementHandoffReturnsAndClearsTheDisplacedNativeTerminal() {
    val first = T3VoiceRuntimeEvent.ThreadVoiceHandoff(
      "first-action",
      "project",
      "thread",
      "first-recording",
      true,
      "https://termstation",
      5_000,
    )
    val owner = checkNotNull(
      T3VoiceStateStore.claimRecording(
        first.recordingId,
        T3VoiceOperationOwnerDomain.REALTIME_HANDOFF,
        first.actionId,
      ),
    )
    T3VoiceStateStore.publishThreadVoiceHandoff(first)
    val terminal = T3VoiceRuntimeEvent.RecordingTerminated(
      first.recordingId,
      null,
      "completed",
      "speech-ended",
    )
    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))
    val replacement = first.copy(actionId = "second-action", recordingId = "second-recording")

    assertEquals(terminal, T3VoiceStateStore.publishThreadVoiceHandoff(replacement))
    assertNull(T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(first.recordingId))
    assertEquals(replacement, T3VoiceStateStore.threadVoiceHandoff.value)
  }

  @Test
  fun clearingHandoffAlsoClearsItsPrivateTerminal() {
    val event = T3VoiceRuntimeEvent.ThreadVoiceHandoff(
      "teardown-action",
      "project",
      "thread",
      "teardown-recording",
      true,
      "https://termstation",
      5_000,
    )
    val owner = checkNotNull(
      T3VoiceStateStore.claimRecording(
        event.recordingId,
        T3VoiceOperationOwnerDomain.REALTIME_HANDOFF,
        event.actionId,
      ),
    )
    T3VoiceStateStore.publishThreadVoiceHandoff(event)
    assertTrue(
      T3VoiceStateStore.terminateRecording(
        owner,
        T3VoiceRuntimeEvent.RecordingTerminated(
          event.recordingId,
          null,
          "cancelled",
          "service-destroyed",
        ),
      ),
    )

    T3VoiceStateStore.clearThreadVoiceHandoff(event.actionId)

    assertNull(T3VoiceStateStore.threadVoiceHandoff.value)
    assertNull(T3VoiceStateStore.pendingRealtimeHandoffRecordingTermination(event.recordingId))
  }

  private fun claimComposerRecording(recordingId: String): T3VoiceOperationOwner? =
    T3VoiceStateStore.claimRecording(
      recordingId,
      T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
      recordingId,
    )

  private fun claimManualPlayback(playbackId: String): T3VoiceOperationOwner? =
    T3VoiceStateStore.claimPlayback(
      playbackId,
      T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK,
      playbackId,
    )
}
