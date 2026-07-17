package expo.modules.t3voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build

internal class T3VoicePlaybackAudioFocus(
  context: Context,
  private val onSuspend: () -> Unit,
  private val onResume: () -> Unit,
  private val onTerminate: () -> Unit,
) {
  private val audioManager = context.getSystemService(AudioManager::class.java)
  private val listener =
    AudioManager.OnAudioFocusChangeListener { change ->
      handleFocusChange(change)
    }
  private var request: AudioFocusRequest? = null
  private var active = false
  private var focusState = T3VoiceAudioFocusState.TERMINATED

  @Synchronized
  fun start(): Boolean {
    if (active) return true
    val result =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val focusRequest =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            )
            .setOnAudioFocusChangeListener(listener)
            .build()
        request = focusRequest
        audioManager.requestAudioFocus(focusRequest)
      } else {
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(
          listener,
          AudioManager.STREAM_MUSIC,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        )
      }
    active = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    focusState =
      if (active) {
        T3VoiceAudioFocusState.ACTIVE
      } else {
        request = null
        T3VoiceAudioFocusState.TERMINATED
      }
    return active
  }

  @Synchronized
  fun stop() {
    if (!active) {
      request = null
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      request?.let(audioManager::abandonAudioFocusRequest)
      request = null
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(listener)
    }
    active = false
    focusState = T3VoiceAudioFocusState.TERMINATED
  }

  @Synchronized
  private fun handleFocusChange(change: Int) {
    if (!active) return
    val event =
      when (change) {
        AudioManager.AUDIOFOCUS_GAIN -> T3VoiceAudioFocusEvent.GAINED
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> T3VoiceAudioFocusEvent.LOST_TRANSIENTLY
        AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> T3VoiceAudioFocusEvent.DUCK_REQUESTED
        AudioManager.AUDIOFOCUS_LOSS -> T3VoiceAudioFocusEvent.LOST_PERMANENTLY
        else -> return
      }
    val transition = T3VoiceAudioFocusPolicy.reduce(focusState, event)
    focusState = transition.state
    transition.actions.forEach { action ->
      when (action) {
        T3VoiceAudioFocusAction.PAUSE_PLAYBACK -> onSuspend()
        T3VoiceAudioFocusAction.RESUME_PLAYBACK -> onResume()
        T3VoiceAudioFocusAction.TERMINATE_SESSION -> onTerminate()
        T3VoiceAudioFocusAction.MUTE_CAPTURE,
        T3VoiceAudioFocusAction.UNMUTE_CAPTURE,
        -> Unit
      }
    }
  }
}
