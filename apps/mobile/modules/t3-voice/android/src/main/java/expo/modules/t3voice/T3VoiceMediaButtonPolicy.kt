package expo.modules.t3voice

import android.view.KeyEvent

internal data class T3VoiceMediaButtonDecision(
  val consume: Boolean,
  val action: T3VoiceAndroidControlAction?,
)

/** Pure filtering/mapping so key-up and repeats are consumed without duplicate dispatch. */
internal object T3VoiceMediaButtonPolicy {
  fun decide(
    keyCode: Int,
    keyAction: Int,
    repeatCount: Int,
    available: List<T3VoiceAndroidControlAction>,
  ): T3VoiceMediaButtonDecision {
    if (!isRecognized(keyCode)) return T3VoiceMediaButtonDecision(false, null)
    if (keyAction != KeyEvent.ACTION_DOWN || repeatCount != 0) {
      return T3VoiceMediaButtonDecision(true, null)
    }
    return T3VoiceMediaButtonDecision(true, select(keyCode, available))
  }

  private fun select(
    keyCode: Int,
    available: List<T3VoiceAndroidControlAction>,
  ): T3VoiceAndroidControlAction? =
    when (keyCode) {
      KeyEvent.KEYCODE_HEADSETHOOK,
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
      ->
        firstAvailable(
          available,
          T3VoiceAndroidControlAction.SKIP,
          T3VoiceAndroidControlAction.START,
          T3VoiceAndroidControlAction.MUTE,
          T3VoiceAndroidControlAction.UNMUTE,
          T3VoiceAndroidControlAction.FINISH_UTTERANCE,
          T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT,
        )
      KeyEvent.KEYCODE_MEDIA_PLAY ->
        firstAvailable(
          available,
          T3VoiceAndroidControlAction.START,
          T3VoiceAndroidControlAction.UNMUTE,
          T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT,
        )
      KeyEvent.KEYCODE_MEDIA_PAUSE ->
        firstAvailable(
          available,
          T3VoiceAndroidControlAction.SKIP,
          T3VoiceAndroidControlAction.MUTE,
          T3VoiceAndroidControlAction.FINISH_UTTERANCE,
        )
      KeyEvent.KEYCODE_MEDIA_STOP ->
        firstAvailable(available, T3VoiceAndroidControlAction.STOP)
      KeyEvent.KEYCODE_MEDIA_NEXT ->
        firstAvailable(
          available,
          T3VoiceAndroidControlAction.SKIP,
          T3VoiceAndroidControlAction.SWITCH_TO_THREAD,
        )
      else -> null
    }

  private fun firstAvailable(
    available: List<T3VoiceAndroidControlAction>,
    vararg preferred: T3VoiceAndroidControlAction,
  ): T3VoiceAndroidControlAction? = preferred.firstOrNull(available::contains)

  private fun isRecognized(keyCode: Int): Boolean =
    keyCode == KeyEvent.KEYCODE_HEADSETHOOK ||
      keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE ||
      keyCode == KeyEvent.KEYCODE_MEDIA_PLAY ||
      keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE ||
      keyCode == KeyEvent.KEYCODE_MEDIA_STOP ||
      keyCode == KeyEvent.KEYCODE_MEDIA_NEXT
}
