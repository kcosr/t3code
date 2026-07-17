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
    T3VoiceStateStore.setInactive()
    T3VoiceStateStore.setServiceReady()
  }

  @After
  fun tearDown() {
    T3VoiceStateStore.setInactive()
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
  fun recordingAndPlaybackClaimsClearMutuallyExclusiveFields() {
    val recording = checkNotNull(T3VoiceStateStore.claimRecording("recording-a"))
    val recordingState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.RECORDING, recordingState.phase)
    assertEquals(recording.generation, recordingState.activeRecordingGeneration)
    assertNull(recordingState.activePlaybackId)
    assertNull(recordingState.activePlaybackGeneration)
    assertTrue(T3VoiceStateStore.releaseRecording(recording))

    val playback = checkNotNull(T3VoiceStateStore.claimPlayback("playback-a"))
    val playbackState = T3VoiceStateStore.state.value
    assertEquals(T3VoiceRuntimePhase.PLAYING, playbackState.phase)
    assertEquals(playback.generation, playbackState.activePlaybackGeneration)
    assertNull(playbackState.activeRecordingId)
    assertNull(playbackState.activeRecordingGeneration)
    assertTrue(T3VoiceStateStore.releasePlayback(playback))
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
  fun pendingRecordingTerminationBlocksReplacementButDoesNotBlockPlayback() {
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
    val playback = checkNotNull(T3VoiceStateStore.claimPlayback("playback-a"))
    assertEquals(terminal, T3VoiceStateStore.recordingTermination.value)
    assertTrue(T3VoiceStateStore.releasePlayback(playback))
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
