package expo.modules.t3voice

internal enum class T3VoiceNotificationActionId {
  MUTE,
  UNMUTE,
  FINISH_UTTERANCE,
  SUBMIT_TRANSCRIPT,
  SKIP,
  STOP,
}

internal data class T3VoiceNotificationAction(
  val id: T3VoiceNotificationActionId,
  val command: T3VoiceRuntimeCommand,
)

/**
 * State-derived controls shared by the notification and MediaSession renderers.
 *
 * The renderer only turns these values into Android intents. Intent delivery dispatches the
 * embedded command through [T3VoiceRuntimeController.dispatch], exactly as the React bridge does.
 */
internal object T3VoiceNotificationActions {
  fun forSnapshot(snapshot: T3VoiceControllerSnapshot): List<T3VoiceNotificationAction> =
    when (val state = snapshot.state) {
      T3VoiceControllerState.Idle -> emptyList()
      is T3VoiceControllerState.Failed -> listOf(stop())
      is T3VoiceControllerState.Realtime -> realtimeActions(state)
      is T3VoiceControllerState.SwitchingToThread -> listOf(stop())
      is T3VoiceControllerState.SwitchingToRealtime -> listOf(stop())
      is T3VoiceControllerState.Thread -> threadActions(state, snapshot.generation)
    }

  private fun realtimeActions(
    state: T3VoiceControllerState.Realtime,
  ): List<T3VoiceNotificationAction> {
    if (state.stage == T3VoiceRealtimeStage.STOPPING) return emptyList()
    if (state.stage == T3VoiceRealtimeStage.STARTING) return listOf(stop())

    return buildList {
      add(
        T3VoiceNotificationAction(
          id =
            if (state.muted) {
              T3VoiceNotificationActionId.UNMUTE
            } else {
              T3VoiceNotificationActionId.MUTE
            },
          command = T3VoiceRuntimeCommand.SetRealtimeMuted(!state.muted),
        ),
      )
      add(stop())
    }
  }

  private fun threadActions(
    state: T3VoiceControllerState.Thread,
    generation: Long,
  ): List<T3VoiceNotificationAction> =
    when (state.stage) {
      T3VoiceThreadStage.RECORDING ->
        listOf(
          T3VoiceNotificationAction(
            id = T3VoiceNotificationActionId.FINISH_UTTERANCE,
            command = T3VoiceRuntimeCommand.FinishThreadUtterance,
          ),
          stop(),
        )
      T3VoiceThreadStage.REVIEWING ->
        buildList {
          state.transcript?.takeIf(String::isNotBlank)?.let { transcript ->
            val reviewId = checkNotNull(state.reviewId) { "Reviewing thread is missing reviewId." }
            add(
              T3VoiceNotificationAction(
                id = T3VoiceNotificationActionId.SUBMIT_TRANSCRIPT,
                command =
                  T3VoiceRuntimeCommand.SubmitThreadTranscript(
                    expectedGeneration = generation,
                    expectedReviewId = reviewId,
                    transcript = transcript,
                  ),
              ),
            )
          }
          add(stop())
        }
      T3VoiceThreadStage.PLAYING -> listOf(skip(), stop())
      T3VoiceThreadStage.STARTING,
      T3VoiceThreadStage.FINALIZING,
      T3VoiceThreadStage.UPLOADING,
      T3VoiceThreadStage.SUBMITTING,
      T3VoiceThreadStage.WAITING,
      T3VoiceThreadStage.REARMING,
      -> listOf(stop())
      T3VoiceThreadStage.STOPPING -> emptyList()
    }

  private fun skip() =
    T3VoiceNotificationAction(
      id = T3VoiceNotificationActionId.SKIP,
      command = T3VoiceRuntimeCommand.SkipThreadPlayback,
    )

  private fun stop() =
    T3VoiceNotificationAction(
      id = T3VoiceNotificationActionId.STOP,
      command = T3VoiceRuntimeCommand.Stop,
    )

}
