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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording(event.recordingId))
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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording(event.recordingId))
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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording(event.recordingId))
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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording(event.recordingId))
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
  fun recordingAndPlaybackRejectStaleGenerationsEvenWhenIdsAreReused() {
    val firstRecording = checkNotNull(T3VoiceStateStore.claimRecording("recording"))
    assertTrue(T3VoiceStateStore.releaseRecording(firstRecording))
    val replacementRecording = checkNotNull(T3VoiceStateStore.claimRecording("recording"))
    assertTrue(replacementRecording.generation > firstRecording.generation)
    assertFalse(T3VoiceStateStore.releaseRecording(firstRecording))
    assertEquals("recording", T3VoiceStateStore.state.value.activeRecordingId)
    assertTrue(T3VoiceStateStore.releaseRecording(replacementRecording))

    val firstPlayback = checkNotNull(T3VoiceStateStore.claimPlayback("playback"))
    assertTrue(T3VoiceStateStore.releasePlayback(firstPlayback))
    val replacementPlayback = checkNotNull(T3VoiceStateStore.claimPlayback("playback"))
    assertTrue(replacementPlayback.generation > firstPlayback.generation)
    assertFalse(T3VoiceStateStore.releasePlayback(firstPlayback))
    assertEquals("playback", T3VoiceStateStore.state.value.activePlaybackId)
    assertTrue(T3VoiceStateStore.releasePlayback(replacementPlayback))
    assertEquals(T3VoiceRuntimePhase.IDLE, T3VoiceStateStore.state.value.phase)
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

    val recording = checkNotNull(T3VoiceStateStore.claimRecording("recording-a"))
    val recordingState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.ARMING, recordingState.phase)
    assertTrue(T3VoiceStateStore.markRecordingStarted(recording))
    assertEquals(T3VoiceRuntimePhase.RECORDING, T3VoiceStateStore.state.value.phase)
    assertEquals(recording.generation, recordingState.activeRecordingGeneration)
    assertNull(recordingState.activePlaybackId)
    assertNull(recordingState.activePlaybackGeneration)
    assertNull(recordingState.activeRealtimeSessionId)
    assertNull(recordingState.realtimeConnectionState)
    assertFalse(recordingState.realtimeMuted)
    assertTrue(T3VoiceStateStore.releaseRecording(recording))

    val playback = checkNotNull(T3VoiceStateStore.claimPlayback("playback-a"))
    val playbackState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.PLAYING, playbackState.phase)
    assertEquals(playback.generation, playbackState.activePlaybackGeneration)
    assertNull(playbackState.activeRecordingId)
    assertNull(playbackState.activeRecordingGeneration)
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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording("recording-a"))
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
    val owner = checkNotNull(T3VoiceStateStore.claimRecording("recording-a"))
    val terminal =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = "recording-a",
        recording = null,
        outcome = "failed",
        reason = "finalization-failed",
      )
    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))

    assertNull(T3VoiceStateStore.claimRecording("recording-b"))
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    T3VoiceStateStore.releaseRealtimeClaim("session-a")
    T3VoiceStateStore.clearRecordingTermination("recording-a")
    assertTrue(T3VoiceStateStore.claimRecording("recording-b") != null)
  }

  @Test
  fun playbackTerminationIsDurableAndBlocksReplacementUntilAcknowledged() {
    val owner = checkNotNull(T3VoiceStateStore.claimPlayback("playback-a"))
    val terminal = T3VoiceRuntimeEvent.PlaybackTerminated("playback-a", "completed")

    assertTrue(T3VoiceStateStore.terminatePlayback(owner, terminal))
    assertEquals(terminal, T3VoiceStateStore.playbackTermination.value)
    assertNull(T3VoiceStateStore.claimPlayback("playback-b"))
    T3VoiceStateStore.clearPlaybackTermination("other-playback")
    assertEquals(terminal, T3VoiceStateStore.playbackTermination.value)
    T3VoiceStateStore.clearPlaybackTermination("playback-a")
    assertNull(T3VoiceStateStore.playbackTermination.value)
    assertTrue(T3VoiceStateStore.claimPlayback("playback-b") != null)
  }
}
