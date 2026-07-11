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
    assertEquals(T3VoiceRuntimePhase.RECORDING, recordingState.phase)
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
    T3VoiceStateStore.setRealtime("session-a", "connected", false)

    assertNull(T3VoiceStateStore.state.value.activeRealtimeSessionId)
    assertEquals("failed", T3VoiceStateStore.state.value.realtimeConnectionState)
    assertEquals(terminal, T3VoiceStateStore.realtimeTermination.value)
  }
}
