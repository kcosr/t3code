package expo.modules.t3voice

internal class T3VoiceCueCoordinator(
  private val player: T3VoiceCuePlayer = T3VoiceCuePlayer(),
) {
  fun requestReady(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean = player.play(T3VoiceCue.READY, generation, completion)

  fun requestEnded(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean = player.play(T3VoiceCue.ENDED, generation, completion)

  fun stop(generation: Long): Boolean = player.cancel(generation)

  fun stop(): Boolean = player.cancelActive()

  fun release() = player.release()
}
