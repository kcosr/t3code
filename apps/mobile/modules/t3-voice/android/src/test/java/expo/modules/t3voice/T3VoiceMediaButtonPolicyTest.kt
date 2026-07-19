package expo.modules.t3voice

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceMediaButtonPolicyTest {
  @Test
  fun recognizedKeyUpAndRepeatsAreConsumedWithoutDispatch() {
    val available = listOf(T3VoiceAndroidControlAction.START)
    val keyUp =
      T3VoiceMediaButtonPolicy.decide(
        KeyEvent.KEYCODE_HEADSETHOOK,
        KeyEvent.ACTION_UP,
        0,
        available,
      )
    val repeat =
      T3VoiceMediaButtonPolicy.decide(
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.ACTION_DOWN,
        1,
        available,
      )
    assertTrue(keyUp.consume)
    assertNull(keyUp.action)
    assertTrue(repeat.consume)
    assertNull(repeat.action)
  }

  @Test
  fun readyPlayStartsButPauseAndStopNeverStart() {
    val available =
      listOf(T3VoiceAndroidControlAction.START, T3VoiceAndroidControlAction.DISABLE)
    assertEquals(
      T3VoiceAndroidControlAction.START,
      decide(KeyEvent.KEYCODE_MEDIA_PLAY, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.START,
      decide(KeyEvent.KEYCODE_HEADSETHOOK, available).action,
    )
    assertNull(decide(KeyEvent.KEYCODE_MEDIA_PAUSE, available).action)
    assertNull(decide(KeyEvent.KEYCODE_MEDIA_STOP, available).action)
  }

  @Test
  fun activeKeysMapOnlyToAdvertisedSemanticActions() {
    assertEquals(
      T3VoiceAndroidControlAction.MUTE,
      decide(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, listOf(T3VoiceAndroidControlAction.MUTE)).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.FINISH_UTTERANCE,
      decide(KeyEvent.KEYCODE_MEDIA_PAUSE, listOf(T3VoiceAndroidControlAction.FINISH_UTTERANCE)).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SWITCH_TO_THREAD,
      decide(KeyEvent.KEYCODE_MEDIA_NEXT, listOf(T3VoiceAndroidControlAction.SWITCH_TO_THREAD)).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.STOP,
      decide(KeyEvent.KEYCODE_MEDIA_STOP, listOf(T3VoiceAndroidControlAction.STOP)).action,
    )
  }

  @Test
  fun playingKeysPreferSkipAndNeverMapHeadsetToStop() {
    val available =
      listOf(T3VoiceAndroidControlAction.SKIP, T3VoiceAndroidControlAction.STOP)
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_HEADSETHOOK, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_MEDIA_NEXT, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_MEDIA_PAUSE, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_MEDIA_STOP, available).action,
    )
    assertEquals(
      T3VoiceAndroidControlAction.SKIP,
      decide(KeyEvent.KEYCODE_MEDIA_PLAY, available).action,
    )
  }

  @Test
  fun unknownKeysFallThrough() {
    val decision = decide(KeyEvent.KEYCODE_VOLUME_UP, emptyList())
    assertFalse(decision.consume)
    assertNull(decision.action)
  }

  private fun decide(
    keyCode: Int,
    available: List<T3VoiceAndroidControlAction>,
  ) = T3VoiceMediaButtonPolicy.decide(keyCode, KeyEvent.ACTION_DOWN, 0, available)
}
