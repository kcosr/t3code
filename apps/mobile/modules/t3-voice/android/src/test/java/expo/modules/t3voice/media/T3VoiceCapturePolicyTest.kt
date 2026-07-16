package expo.modules.t3voice.media

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceCapturePolicyTest {
  @Test
  fun captureRemainsMutedUntilInputIsReady() {
    assertTrue(T3VoiceCaptureState().effectiveMuted)
    assertFalse(
      T3VoiceCapturePolicy.setInputReady(T3VoiceCaptureState(), ready = true).effectiveMuted,
    )
  }

  @Test
  fun userCannotUnmuteCaptureWhileAudioFocusIsSuspended() {
    val suspended =
      T3VoiceCapturePolicy.setFocusSuspended(
        T3VoiceCapturePolicy.setInputReady(T3VoiceCaptureState(), ready = true),
        suspended = true,
      )
    val userUnmuted = T3VoiceCapturePolicy.setUserMuted(suspended, muted = false)

    assertTrue(userUnmuted.effectiveMuted)
  }

  @Test
  fun focusGainRestoresTheUsersMutePreference() {
    val userMuted =
      T3VoiceCapturePolicy.setUserMuted(
        T3VoiceCapturePolicy.setInputReady(T3VoiceCaptureState(), ready = true),
        muted = true,
      )
    val suspended = T3VoiceCapturePolicy.setFocusSuspended(userMuted, suspended = true)
    val restored = T3VoiceCapturePolicy.setFocusSuspended(suspended, suspended = false)

    assertTrue(restored.effectiveMuted)
    assertTrue(restored.userMuted)
  }

  @Test
  fun focusGainRestoresCaptureForAnUnmutedUser() {
    val suspended =
      T3VoiceCapturePolicy.setFocusSuspended(
        T3VoiceCapturePolicy.setInputReady(T3VoiceCaptureState(), ready = true),
        suspended = true,
      )
    val restored = T3VoiceCapturePolicy.setFocusSuspended(suspended, suspended = false)

    assertFalse(restored.effectiveMuted)
  }
}
