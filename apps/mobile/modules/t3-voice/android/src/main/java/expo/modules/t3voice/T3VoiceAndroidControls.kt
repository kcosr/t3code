package expo.modules.t3voice

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.KeyEvent

internal enum class T3VoiceAndroidControlOwner {
  OPERATION,
  READINESS,
}

internal enum class T3VoiceAndroidControlAction {
  START,
  DISABLE,
  MUTE,
  UNMUTE,
  FINISH_UTTERANCE,
  SUBMIT_TRANSCRIPT,
  SWITCH_TO_THREAD,
  SKIP,
  STOP,
}

internal sealed interface T3VoiceAndroidControlsPresentation {
  data object Inactive : T3VoiceAndroidControlsPresentation

  data class Active(
    val owner: T3VoiceAndroidControlOwner,
    val generation: Long,
    val playbackState: Int,
    val actions: List<T3VoiceAndroidControlAction>,
    val title: String,
    val statusText: String,
  ) : T3VoiceAndroidControlsPresentation
}

internal class T3VoiceAndroidControlsPresentationCache {
  private var current: T3VoiceAndroidControlsPresentation? = null

  fun accept(
    snapshot: T3VoiceControllerSnapshot,
    readiness: T3VoiceReadinessSnapshot = T3VoiceReadinessSnapshot.Disabled(0),
    preparedThreadAvailable: Boolean = false,
  ): T3VoiceAndroidControlsPresentation? {
    val next = snapshot.androidControlsPresentation(readiness, preparedThreadAvailable)
    if (next == current) return null
    current = next
    return next
  }
}

internal data class T3VoiceAndroidControlsRender(
  val changed: Boolean,
  val notification: Notification?,
)

internal data class T3VoiceNotificationPendingIntentIdentity(
  val requestCode: Int,
  val dataUri: String,
)

internal fun T3VoiceAndroidControlAction.pendingIntentIdentity(
  owner: T3VoiceAndroidControlOwner,
  generation: Long,
): T3VoiceNotificationPendingIntentIdentity =
  T3VoiceNotificationPendingIntentIdentity(
    requestCode = ACTION_REQUEST_CODE_BASE + ordinal,
    dataUri = "$SEMANTIC_CONTROL_URI_PREFIX/${owner.name}/$generation/$name",
  )

internal fun transportActionsFor(actions: List<T3VoiceAndroidControlAction>): Long =
  actions.fold(0L) { mask, id ->
    mask or
      when (id) {
        T3VoiceAndroidControlAction.START,
        T3VoiceAndroidControlAction.UNMUTE,
        T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT,
        -> PlaybackState.ACTION_PLAY
        T3VoiceAndroidControlAction.MUTE,
        T3VoiceAndroidControlAction.FINISH_UTTERANCE,
        -> PlaybackState.ACTION_PAUSE
        T3VoiceAndroidControlAction.SWITCH_TO_THREAD -> PlaybackState.ACTION_SKIP_TO_NEXT
        T3VoiceAndroidControlAction.SKIP ->
          PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_PLAY or
            PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or
            PlaybackState.ACTION_STOP
        T3VoiceAndroidControlAction.STOP -> PlaybackState.ACTION_STOP
        T3VoiceAndroidControlAction.DISABLE -> 0L
      }
  }.let { mask ->
    if (T3VoiceAndroidControlAction.START in actions) {
      mask or PlaybackState.ACTION_PLAY_PAUSE
    } else {
      mask
    }
  }

/** Renders notification and MediaSession controls from the controller's current state. */
internal class T3VoiceAndroidControls(
  private val context: Context,
  private val dispatch: (
    action: T3VoiceAndroidControlAction,
    owner: T3VoiceAndroidControlOwner,
    generation: Long,
  ) -> Unit,
) {
  @Volatile private var snapshot = idleSnapshot()
  @Volatile private var currentPresentation: T3VoiceAndroidControlsPresentation =
    T3VoiceAndroidControlsPresentation.Inactive
  private val presentationCache = T3VoiceAndroidControlsPresentationCache()
  private var notification: Notification? = null

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
              T3VoiceAndroidControlAction.SKIP,
              T3VoiceAndroidControlAction.START,
              T3VoiceAndroidControlAction.UNMUTE,
              T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT,
            )
          }

          override fun onPause() {
            // While PLAYING, transport pause must skip speech (not pause/resume product).
            dispatchFirst(
              T3VoiceAndroidControlAction.SKIP,
              T3VoiceAndroidControlAction.MUTE,
              T3VoiceAndroidControlAction.FINISH_UTTERANCE,
            )
          }

          override fun onStop() {
            dispatchFirst(
              T3VoiceAndroidControlAction.SKIP,
              T3VoiceAndroidControlAction.STOP,
            )
          }

          override fun onSkipToNext() {
            // Match MEDIA_NEXT policy preference: SKIP first when available, else SWITCH.
            dispatchFirst(
              T3VoiceAndroidControlAction.SKIP,
              T3VoiceAndroidControlAction.SWITCH_TO_THREAD,
            )
          }

          override fun onCustomAction(action: String, extras: Bundle?) {
            val id = action.removePrefix(MEDIA_CUSTOM_ACTION_PREFIX).let(::parseActionId) ?: return
            dispatchFirst(id)
          }

          override fun onMediaButtonEvent(mediaButtonIntent: Intent): Boolean {
            val event =
              if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java)
              } else {
                @Suppress("DEPRECATION")
                mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)
              } ?: return super.onMediaButtonEvent(mediaButtonIntent)
            val decision =
              T3VoiceMediaButtonPolicy.decide(
                keyCode = event.keyCode,
                keyAction = event.action,
                repeatCount = event.repeatCount,
                available = activeActions(),
              )
            val presentation =
              currentPresentation as? T3VoiceAndroidControlsPresentation.Active
            T3VoiceDiagnostics.record(
              generation = presentation?.generation ?: 0,
              category = T3VoiceDiagnosticCategory.STATE,
              code = T3VoiceDiagnosticCode.MEDIA_BUTTON_RECEIVED,
              primaryCount = event.keyCode,
              secondaryCount = decision.action?.ordinal?.plus(1) ?: 0,
            )
            decision.action?.let { dispatchFirst(it) }
            return decision.consume || super.onMediaButtonEvent(mediaButtonIntent)
          }
        },
      )
    }

  fun render(
    snapshot: T3VoiceControllerSnapshot,
    readiness: T3VoiceReadinessSnapshot,
    preparedThreadAvailable: Boolean,
    channelId: String,
  ): T3VoiceAndroidControlsRender {
    this.snapshot = snapshot
    val presentation =
      presentationCache.accept(snapshot, readiness, preparedThreadAvailable)
        ?: return T3VoiceAndroidControlsRender(changed = false, notification)
    currentPresentation = presentation
    notification =
      when (presentation) {
        T3VoiceAndroidControlsPresentation.Inactive -> {
          mediaSession.isActive = false
          null
        }
        is T3VoiceAndroidControlsPresentation.Active -> {
          renderMediaSession(presentation)
          buildNotification(presentation, channelId)
        }
      }
    return T3VoiceAndroidControlsRender(changed = true, notification)
  }

  private fun renderMediaSession(presentation: T3VoiceAndroidControlsPresentation.Active) {
    val transportActions = transportActionsFor(presentation.actions)
    mediaSession.setPlaybackState(
      PlaybackState.Builder()
        .setState(presentation.playbackState, 0, 1f)
        .setActions(transportActions)
        .also { builder ->
          presentation.actions.forEach { id ->
            builder.addCustomAction(id.customActionName(), id.label(), id.icon())
          }
        }
        .build(),
    )
    mediaSession.setMetadata(
      MediaMetadata.Builder()
        .putString(MediaMetadata.METADATA_KEY_TITLE, presentation.title)
        .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, presentation.statusText)
        .build(),
    )
    mediaSession.isActive = true
  }

  @Suppress("DEPRECATION")
  private fun buildNotification(
    presentation: T3VoiceAndroidControlsPresentation.Active,
    channelId: String,
  ): Notification {
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
      .setContentTitle(presentation.title)
      .setContentText(presentation.statusText)
      .setContentIntent(contentIntent)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)

    presentation.actions.forEach { id ->
      builder.addAction(
        id.icon(),
        id.label(),
        id.pendingIntent(context, presentation.owner, presentation.generation),
      )
    }
    val compact = presentation.actions.indices.take(MAXIMUM_COMPACT_ACTIONS).toList().toIntArray()
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

  private fun activeActions(): List<T3VoiceAndroidControlAction> =
    (currentPresentation as? T3VoiceAndroidControlsPresentation.Active)?.actions.orEmpty()

  private fun dispatchFirst(vararg ids: T3VoiceAndroidControlAction) {
    val presentation = currentPresentation as? T3VoiceAndroidControlsPresentation.Active ?: return
    ids.firstOrNull(presentation.actions::contains)
      ?.let {
        T3VoiceDiagnostics.record(
          generation = presentation.generation,
          category = T3VoiceDiagnosticCategory.STATE,
          code = T3VoiceDiagnosticCode.MEDIA_ACTION_DISPATCHED,
          primaryCount = it.ordinal + 1,
        )
        dispatch(it, presentation.owner, presentation.generation)
      }
  }

  private fun parseActionId(value: String): T3VoiceAndroidControlAction? =
    runCatching { T3VoiceAndroidControlAction.valueOf(value) }.getOrNull()

  private fun T3VoiceAndroidControlAction.pendingIntent(
    context: Context,
    owner: T3VoiceAndroidControlOwner,
    generation: Long,
  ): PendingIntent {
    val identity = pendingIntentIdentity(owner, generation)
    val intent =
      Intent(context, T3VoiceRuntimeService::class.java).apply {
        action = T3VoiceRuntimeService.ACTION_SEMANTIC_CONTROL
        data = Uri.parse(identity.dataUri)
        putExtra(T3VoiceRuntimeService.EXTRA_SEMANTIC_ACTION, name)
        putExtra(T3VoiceRuntimeService.EXTRA_SEMANTIC_GENERATION, generation)
        putExtra(T3VoiceRuntimeService.EXTRA_CONTROL_OWNER, owner.name)
      }
    return PendingIntent.getService(
      context,
      identity.requestCode,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun T3VoiceAndroidControlAction.customActionName(): String =
    MEDIA_CUSTOM_ACTION_PREFIX + name

  private fun T3VoiceAndroidControlAction.label(): String =
    when (this) {
      T3VoiceAndroidControlAction.START -> "Start"
      T3VoiceAndroidControlAction.DISABLE -> "Disable"
      T3VoiceAndroidControlAction.MUTE -> "Mute"
      T3VoiceAndroidControlAction.UNMUTE -> "Unmute"
      T3VoiceAndroidControlAction.FINISH_UTTERANCE -> "Finish"
      T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT -> "Submit"
      T3VoiceAndroidControlAction.SWITCH_TO_THREAD -> "Thread"
      T3VoiceAndroidControlAction.SKIP -> "Skip"
      T3VoiceAndroidControlAction.STOP -> "Stop"
    }

  private fun T3VoiceAndroidControlAction.icon(): Int =
    when (this) {
      T3VoiceAndroidControlAction.START,
      T3VoiceAndroidControlAction.UNMUTE,
      T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT,
      -> android.R.drawable.ic_media_play
      T3VoiceAndroidControlAction.MUTE,
      T3VoiceAndroidControlAction.FINISH_UTTERANCE,
      -> android.R.drawable.ic_media_pause
      T3VoiceAndroidControlAction.SWITCH_TO_THREAD,
      T3VoiceAndroidControlAction.SKIP,
      -> android.R.drawable.ic_media_next
      T3VoiceAndroidControlAction.STOP,
      T3VoiceAndroidControlAction.DISABLE,
      -> android.R.drawable.ic_menu_close_clear_cancel
    }

  private companion object {
    const val MEDIA_SESSION_TAG = "T3VoiceRuntime"
    const val MEDIA_CUSTOM_ACTION_PREFIX = "expo.modules.t3voice.media."
    const val CONTENT_REQUEST_CODE = 3140
    const val MAXIMUM_COMPACT_ACTIONS = 3

    fun idleSnapshot() =
      T3VoiceControllerSnapshot(T3VoiceControllerState.Idle, generation = 0, sequence = 0)
  }
}

private const val ACTION_REQUEST_CODE_BASE = 3150
private const val SEMANTIC_CONTROL_URI_PREFIX = "t3voice-runtime://semantic-control"

internal fun T3VoiceControllerSnapshot.androidControlsPresentation(
  readiness: T3VoiceReadinessSnapshot = T3VoiceReadinessSnapshot.Disabled(0),
  preparedThreadAvailable: Boolean = false,
):
  T3VoiceAndroidControlsPresentation {
  if (!state.needsForeground()) return readiness.androidControlsPresentation()
  return T3VoiceAndroidControlsPresentation.Active(
    owner = T3VoiceAndroidControlOwner.OPERATION,
    generation = generation,
    playbackState = androidPlaybackState(),
    actions =
      buildList {
        addAll(T3VoiceNotificationActions.forSnapshot(this@androidControlsPresentation).map { it.id.toAndroidAction() })
        if (
          preparedThreadAvailable &&
            state is T3VoiceControllerState.Realtime &&
            state.stage == T3VoiceRealtimeStage.CONNECTED
        ) {
          add(indexOf(T3VoiceAndroidControlAction.STOP).coerceAtLeast(0), T3VoiceAndroidControlAction.SWITCH_TO_THREAD)
        }
      },
    title = androidControlsTitle(),
    statusText = androidControlsStatusText(),
  )
}

private fun T3VoiceNotificationActionId.toAndroidAction(): T3VoiceAndroidControlAction =
  when (this) {
    T3VoiceNotificationActionId.MUTE -> T3VoiceAndroidControlAction.MUTE
    T3VoiceNotificationActionId.UNMUTE -> T3VoiceAndroidControlAction.UNMUTE
    T3VoiceNotificationActionId.FINISH_UTTERANCE -> T3VoiceAndroidControlAction.FINISH_UTTERANCE
    T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT -> T3VoiceAndroidControlAction.SUBMIT_TRANSCRIPT
    T3VoiceNotificationActionId.SKIP -> T3VoiceAndroidControlAction.SKIP
    T3VoiceNotificationActionId.STOP -> T3VoiceAndroidControlAction.STOP
  }

private fun T3VoiceReadinessSnapshot.androidControlsPresentation():
  T3VoiceAndroidControlsPresentation =
  when (this) {
    is T3VoiceReadinessSnapshot.Disabled -> T3VoiceAndroidControlsPresentation.Inactive
    is T3VoiceReadinessSnapshot.Ready ->
      T3VoiceAndroidControlsPresentation.Active(
        owner = T3VoiceAndroidControlOwner.READINESS,
        generation = generation,
        playbackState = PlaybackState.STATE_PAUSED,
        actions = listOf(T3VoiceAndroidControlAction.START, T3VoiceAndroidControlAction.DISABLE),
        title = "Voice ready — $label",
        statusText = "Press Start to begin",
      )
    is T3VoiceReadinessSnapshot.Unavailable ->
      T3VoiceAndroidControlsPresentation.Active(
        owner = T3VoiceAndroidControlOwner.READINESS,
        generation = generation,
        playbackState = PlaybackState.STATE_PAUSED,
        actions = listOf(T3VoiceAndroidControlAction.DISABLE),
        title = "Voice unavailable — $label",
        statusText = "Active Thread unavailable",
      )
    is T3VoiceReadinessSnapshot.NeedsRefresh ->
      T3VoiceAndroidControlsPresentation.Active(
        owner = T3VoiceAndroidControlOwner.READINESS,
        generation = generation,
        playbackState = PlaybackState.STATE_PAUSED,
        actions = listOf(T3VoiceAndroidControlAction.DISABLE),
        title = "Voice controls need refresh",
        statusText = "Open T3 to refresh voice controls",
      )
  }

private fun T3VoiceControllerSnapshot.androidPlaybackState(): Int =
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
    is T3VoiceControllerState.SwitchingToRealtime -> PlaybackState.STATE_BUFFERING
    T3VoiceControllerState.Idle,
    is T3VoiceControllerState.Failed,
    -> PlaybackState.STATE_STOPPED
  }

private fun T3VoiceControllerSnapshot.androidControlsTitle(): String =
  when (state) {
    is T3VoiceControllerState.Realtime -> "T3 Realtime voice"
    is T3VoiceControllerState.SwitchingToThread -> "Switching to Thread voice"
    is T3VoiceControllerState.SwitchingToRealtime -> "T3 Thread voice"
    is T3VoiceControllerState.Thread -> "T3 Thread voice"
    T3VoiceControllerState.Idle -> "T3 voice"
    is T3VoiceControllerState.Failed -> "T3 voice stopped"
  }

private fun T3VoiceControllerSnapshot.androidControlsStatusText(): String =
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
    is T3VoiceControllerState.SwitchingToRealtime -> "Stopping before Realtime…"
    is T3VoiceControllerState.Thread ->
      state.cycleFailure?.message ?: when (state.stage) {
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
