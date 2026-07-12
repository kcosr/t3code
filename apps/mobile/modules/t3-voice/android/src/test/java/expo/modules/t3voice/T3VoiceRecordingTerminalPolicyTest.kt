package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRecordingTerminalPolicyTest {
  @Test
  fun limitCallbackClaimsCurrentOwnerExactlyOnce() {
    val policy = T3VoiceRecordingTerminalPolicy()
    val owner = policy.activate("recording")

    assertTrue(policy.claim(owner))
    assertFalse(policy.claim(owner))
  }

  @Test
  fun staleCallbackCannotClaimReplacement() {
    val policy = T3VoiceRecordingTerminalPolicy()
    val stale = policy.activate("shared")
    assertTrue(policy.deactivate(stale))
    val replacement = policy.activate("shared")

    assertFalse(policy.claim(stale))
    assertTrue(policy.claim(replacement))
  }

  @Test
  fun completedLimitEventRetainsRecordingResultForUpload() {
    val recording = T3VoiceRecordingResult("recording", "file:///recording.m4a", 1_000, 4_096)
    val body =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = recording.recordingId,
        recording = recording,
        outcome = "completed",
        reason = "media-file-size-limit",
      ).toEventBody()

    assertEquals("completed", body["outcome"])
    assertEquals(recording.toResultBody(), body["recording"])
  }
}
