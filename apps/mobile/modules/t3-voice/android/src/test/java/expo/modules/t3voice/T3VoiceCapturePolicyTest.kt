package expo.modules.t3voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceCapturePolicyTest {
  @Test
  fun userCannotUnmuteCaptureWhileAudioFocusIsSuspended() {
    val suspended =
      T3VoiceCapturePolicy.setFocusSuspended(T3VoiceCaptureState(), suspended = true)
    val userUnmuted = T3VoiceCapturePolicy.setUserMuted(suspended, muted = false)

    assertTrue(userUnmuted.effectiveMuted)
  }

  @Test
  fun focusGainRestoresTheUsersMutePreference() {
    val userMuted = T3VoiceCapturePolicy.setUserMuted(T3VoiceCaptureState(), muted = true)
    val suspended = T3VoiceCapturePolicy.setFocusSuspended(userMuted, suspended = true)
    val restored = T3VoiceCapturePolicy.setFocusSuspended(suspended, suspended = false)

    assertTrue(restored.effectiveMuted)
    assertTrue(restored.userMuted)
  }

  @Test
  fun focusGainRestoresCaptureForAnUnmutedUser() {
    val suspended =
      T3VoiceCapturePolicy.setFocusSuspended(T3VoiceCaptureState(), suspended = true)
    val restored = T3VoiceCapturePolicy.setFocusSuspended(suspended, suspended = false)

    assertFalse(restored.effectiveMuted)
  }

  @Test
  fun terminalFenceCannotBeClearedByUnmuteOrAudioFocusGain() {
    val fenced = T3VoiceCapturePolicy.fenceTerminalInput(T3VoiceCaptureState())
    val muted = T3VoiceCapturePolicy.setUserMuted(fenced, muted = true)
    val unmuted = T3VoiceCapturePolicy.setUserMuted(muted, muted = false)
    val suspended = T3VoiceCapturePolicy.setFocusSuspended(unmuted, suspended = true)
    val restored = T3VoiceCapturePolicy.setFocusSuspended(suspended, suspended = false)

    assertTrue(restored.terminalFenced)
    assertTrue(restored.effectiveMuted)
    assertFalse(restored.recordingEnabled)
  }
}
