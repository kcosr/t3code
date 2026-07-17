package expo.modules.t3voice

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Bundle

/** Renders notification and MediaSession controls from the controller's current state. */
internal class T3VoiceAndroidControls(
  private val context: Context,
  private val dispatch: (T3VoiceRuntimeCommand) -> Unit,
) {
  @Volatile private var snapshot = idleSnapshot()

  private val mediaSession =
    MediaSession(context, MEDIA_SESSION_TAG).apply {
      setFlags(
        MediaSession.FLAG_HANDLES_MEDIA_BUTTONS or
          MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS,
      )
      setCallback(
        object : MediaSession.Callback() {
          override fun onPlay() {
            dispatchFirst(
              T3VoiceNotificationActionId.UNMUTE,
              T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT,
            )
          }

          override fun onPause() {
            dispatchFirst(
              T3VoiceNotificationActionId.MUTE,
              T3VoiceNotificationActionId.FINISH_UTTERANCE,
            )
          }

          override fun onSkipToNext() {
            dispatchFirst(T3VoiceNotificationActionId.SWITCH_TO_THREAD)
          }

          override fun onStop() {
            dispatchFirst(T3VoiceNotificationActionId.STOP)
          }

          override fun onCustomAction(action: String, extras: Bundle?) {
            val id = action.removePrefix(MEDIA_CUSTOM_ACTION_PREFIX).let(::parseActionId) ?: return
            dispatchFirst(id)
          }
        },
      )
    }

  fun update(snapshot: T3VoiceControllerSnapshot) {
    this.snapshot = snapshot
    val active = snapshot.state.needsForeground()
    mediaSession.isActive = active
    if (!active) return

    val actions = T3VoiceNotificationActions.forSnapshot(snapshot)
    mediaSession.setPlaybackState(
      PlaybackState.Builder()
        .setState(snapshot.playbackState(), 0, 1f)
        .setActions(actions.fold(0L) { mask, action -> mask or action.transportAction() })
        .also { builder ->
          actions.forEach { action ->
            builder.addCustomAction(
              action.customActionName(),
              action.label(),
              action.icon(),
            )
          }
        }
        .build(),
    )
    mediaSession.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, snapshot.title())
        .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, snapshot.statusText())
        .build(),
    )
  }

  @Suppress("DEPRECATION")
  fun buildNotification(
    snapshot: T3VoiceControllerSnapshot,
    channelId: String,
  ): Notification {
    check(snapshot.state.needsForeground()) { "Semantic notification requires an active state." }
    val actions = T3VoiceNotificationActions.forSnapshot(snapshot)
    val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    val contentIntent =
      launchIntent?.let {
        PendingIntent.getActivity(
          context,
          CONTENT_REQUEST_CODE,
          it,
          PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
      }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        Notification.Builder(context, channelId)
      } else {
        @Suppress("DEPRECATION")
        Notification.Builder(context)
      }
    builder
      .setSmallIcon(android.R.drawable.ic_btn_speak_now)
      .setContentTitle(snapshot.title())
      .setContentText(snapshot.statusText())
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)

    actions.forEach { action ->
      builder.addAction(
        action.icon(),
        action.label(),
        action.pendingIntent(context, snapshot.generation),
      )
    }
    val compact = actions.indices.take(MAXIMUM_COMPACT_ACTIONS).toList().toIntArray()
    builder.setStyle(
      Notification.MediaStyle()
        .setMediaSession(mediaSession.sessionToken)
        .setShowActionsInCompactView(*compact),
    )
    return builder.build()
  }

  fun release() {
    mediaSession.isActive = false
    mediaSession.release()
  }

  private fun dispatchFirst(vararg ids: T3VoiceNotificationActionId) {
    val available = T3VoiceNotificationActions.forSnapshot(snapshot)
    ids.firstNotNullOfOrNull { id -> available.firstOrNull { it.id == id } }
      ?.let { dispatch(it.command) }
  }

  private fun parseActionId(value: String): T3VoiceNotificationActionId? =
    runCatching { T3VoiceNotificationActionId.valueOf(value) }.getOrNull()

  private fun T3VoiceNotificationAction.pendingIntent(
    context: Context,
    generation: Long,
  ): PendingIntent {
    val intent =
      Intent(context, T3VoiceRuntimeService::class.java).apply {
        action = T3VoiceRuntimeService.ACTION_SEMANTIC_CONTROL
        putExtra(T3VoiceRuntimeService.EXTRA_SEMANTIC_ACTION, id.name)
        putExtra(T3VoiceRuntimeService.EXTRA_SEMANTIC_GENERATION, generation)
      }
    return PendingIntent.getService(
      context,
      ACTION_REQUEST_CODE_BASE + id.ordinal,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun T3VoiceNotificationAction.transportAction(): Long =
    when (id) {
      T3VoiceNotificationActionId.UNMUTE,
      T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT,
      -> PlaybackState.ACTION_PLAY
      T3VoiceNotificationActionId.MUTE,
      T3VoiceNotificationActionId.FINISH_UTTERANCE,
      -> PlaybackState.ACTION_PAUSE
      T3VoiceNotificationActionId.SWITCH_TO_THREAD -> PlaybackState.ACTION_SKIP_TO_NEXT
      T3VoiceNotificationActionId.STOP -> PlaybackState.ACTION_STOP
    }

  private fun T3VoiceNotificationAction.customActionName(): String =
    MEDIA_CUSTOM_ACTION_PREFIX + id.name

  private fun T3VoiceNotificationAction.label(): String =
    when (id) {
      T3VoiceNotificationActionId.MUTE -> "Mute"
      T3VoiceNotificationActionId.UNMUTE -> "Unmute"
      T3VoiceNotificationActionId.SWITCH_TO_THREAD -> "Use Thread"
      T3VoiceNotificationActionId.FINISH_UTTERANCE -> "Finish"
      T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT -> "Submit"
      T3VoiceNotificationActionId.STOP -> "Stop"
    }

  private fun T3VoiceNotificationAction.icon(): Int =
    when (id) {
      T3VoiceNotificationActionId.UNMUTE,
      T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT,
      -> android.R.drawable.ic_media_play
      T3VoiceNotificationActionId.MUTE,
      T3VoiceNotificationActionId.FINISH_UTTERANCE,
      -> android.R.drawable.ic_media_pause
      T3VoiceNotificationActionId.SWITCH_TO_THREAD -> android.R.drawable.ic_media_next
      T3VoiceNotificationActionId.STOP -> android.R.drawable.ic_menu_close_clear_cancel
    }

  private fun T3VoiceControllerSnapshot.playbackState(): Int =
    when (val state = state) {
      is T3VoiceControllerState.Realtime ->
        when (state.stage) {
          T3VoiceRealtimeStage.STARTING -> PlaybackState.STATE_BUFFERING
          T3VoiceRealtimeStage.CONNECTED ->
            if (state.muted) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING
          T3VoiceRealtimeStage.STOPPING -> PlaybackState.STATE_STOPPED
        }
      is T3VoiceControllerState.Thread ->
        when (state.stage) {
          T3VoiceThreadStage.RECORDING,
          T3VoiceThreadStage.PLAYING,
          -> PlaybackState.STATE_PLAYING
          T3VoiceThreadStage.REVIEWING -> PlaybackState.STATE_PAUSED
          T3VoiceThreadStage.STARTING,
          T3VoiceThreadStage.FINALIZING,
          T3VoiceThreadStage.UPLOADING,
          T3VoiceThreadStage.SUBMITTING,
          T3VoiceThreadStage.WAITING,
          T3VoiceThreadStage.REARMING,
          -> PlaybackState.STATE_BUFFERING
          T3VoiceThreadStage.STOPPING -> PlaybackState.STATE_STOPPED
        }
      is T3VoiceControllerState.SwitchingToThread -> PlaybackState.STATE_BUFFERING
      T3VoiceControllerState.Idle,
      is T3VoiceControllerState.Failed,
      -> PlaybackState.STATE_STOPPED
    }

  private fun T3VoiceControllerSnapshot.title(): String =
    when (state) {
      is T3VoiceControllerState.Realtime -> "T3 Realtime voice"
      is T3VoiceControllerState.SwitchingToThread -> "Switching to Thread voice"
      is T3VoiceControllerState.Thread -> "T3 Thread voice"
      T3VoiceControllerState.Idle -> "T3 voice"
      is T3VoiceControllerState.Failed -> "T3 voice stopped"
    }

  private fun T3VoiceControllerSnapshot.statusText(): String =
    when (val state = state) {
      is T3VoiceControllerState.Realtime ->
        when (state.stage) {
          T3VoiceRealtimeStage.STARTING -> "Connecting…"
          T3VoiceRealtimeStage.CONNECTED ->
            when {
              state.pendingConfirmations.isNotEmpty() -> "Confirmation required in app"
              state.muted -> "Muted"
              else -> "Listening"
            }
          T3VoiceRealtimeStage.STOPPING -> "Stopping…"
        }
      is T3VoiceControllerState.SwitchingToThread -> "Preparing Thread recording…"
      is T3VoiceControllerState.Thread ->
        when (state.stage) {
          T3VoiceThreadStage.STARTING -> "Starting recorder…"
          T3VoiceThreadStage.RECORDING -> "Listening"
          T3VoiceThreadStage.FINALIZING -> "Finishing recording…"
          T3VoiceThreadStage.UPLOADING -> "Transcribing…"
          T3VoiceThreadStage.REVIEWING -> "Transcript ready to submit"
          T3VoiceThreadStage.SUBMITTING -> "Submitting…"
          T3VoiceThreadStage.WAITING ->
            when (state.attention) {
              T3VoiceThreadAttention.APPROVAL_REQUIRED -> "Approval required in app"
              T3VoiceThreadAttention.USER_INPUT_REQUIRED -> "User input required in app"
              null -> "Waiting for response…"
            }
          T3VoiceThreadStage.PLAYING -> "Playing response"
          T3VoiceThreadStage.REARMING -> "Preparing to listen…"
          T3VoiceThreadStage.STOPPING -> "Stopping…"
        }
      T3VoiceControllerState.Idle -> "Idle"
      is T3VoiceControllerState.Failed -> state.failure.message
    }

  private companion object {
    const val MEDIA_SESSION_TAG = "T3VoiceRuntime"
    const val MEDIA_CUSTOM_ACTION_PREFIX = "expo.modules.t3voice.media."
    const val CONTENT_REQUEST_CODE = 3140
    const val ACTION_REQUEST_CODE_BASE = 3150
    const val MAXIMUM_COMPACT_ACTIONS = 3

    fun idleSnapshot() =
      T3VoiceControllerSnapshot(T3VoiceControllerState.Idle, generation = 0, sequence = 0)
  }
}
