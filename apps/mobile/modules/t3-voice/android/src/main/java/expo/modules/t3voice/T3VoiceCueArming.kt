package expo.modules.t3voice

/**
 * Thin façade used by Realtime/Thread sessions to request Ready/Ended sonification without owning
 * player lifecycle. Completions are always asynchronous and generation-stamped.
 */
internal interface T3VoiceCueArming {
  fun isEnabled(): Boolean

  fun setEnabled(enabled: Boolean): T3VoiceCueSettings

  fun settings(): T3VoiceCueSettings

  /**
   * Request Ready cue. Invokes [completion] with the terminal outcome.
   * Returns false if the player rejected the request (stale generation / released).
   * When cues are disabled, completes immediately with [T3VoiceCueOutcome.DRAINED].
   */
  fun requestReady(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean

  /**
   * Request Ended cue. Invokes [completion] with the terminal outcome so route teardown can remain
   * fenced until playback drains (or fails open at the player's bounded timeout).
   */
  fun requestEnded(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean

  fun cancel(generation: Long)

  fun cancelAll()

  fun release()
}

internal class T3VoiceCueArmingLive(
  private val settingsStore: T3VoiceCueSettingsStore,
  private val coordinator: T3VoiceCueCoordinator = T3VoiceCueCoordinator(),
) : T3VoiceCueArming {
  override fun isEnabled(): Boolean = settingsStore.read().enabled

  override fun setEnabled(enabled: Boolean): T3VoiceCueSettings {
    val next = settingsStore.write(enabled)
    if (!next.enabled) {
      coordinator.stop()
    }
    return next
  }

  override fun settings(): T3VoiceCueSettings = settingsStore.read()

  override fun requestReady(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean {
    if (!isEnabled()) {
      completion(
        T3VoiceCueCompletion(
          generation = generation,
          cue = T3VoiceCue.READY,
          outcome = T3VoiceCueOutcome.DRAINED,
        ),
      )
      return true
    }
    val accepted =
      coordinator.requestReady(generation) { result ->
        completion(result)
      }
    if (!accepted) {
      // Fail-open so a rejected generation does not strand capture admission.
      completion(
        T3VoiceCueCompletion(
          generation = generation,
          cue = T3VoiceCue.READY,
          outcome = T3VoiceCueOutcome.FAILED,
        ),
      )
    }
    return accepted
  }

  override fun requestEnded(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean {
    if (!isEnabled()) {
      completion(
        T3VoiceCueCompletion(
          generation = generation,
          cue = T3VoiceCue.ENDED,
          outcome = T3VoiceCueOutcome.DRAINED,
        ),
      )
      return true
    }
    val accepted = coordinator.requestEnded(generation, completion)
    if (!accepted) {
      completion(
        T3VoiceCueCompletion(
          generation = generation,
          cue = T3VoiceCue.ENDED,
          outcome = T3VoiceCueOutcome.FAILED,
        ),
      )
    }
    return accepted
  }

  override fun cancel(generation: Long) {
    coordinator.stop(generation)
  }

  override fun cancelAll() {
    coordinator.stop()
  }

  override fun release() {
    coordinator.release()
  }
}

/** Default no-op for unit tests that construct sessions without a cue player. */
internal object NoOpCueArming : T3VoiceCueArming {
  override fun isEnabled(): Boolean = false

  override fun setEnabled(enabled: Boolean): T3VoiceCueSettings = T3VoiceCueSettings(enabled = enabled)

  override fun settings(): T3VoiceCueSettings = T3VoiceCueSettings()

  override fun requestReady(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean {
    completion(
      T3VoiceCueCompletion(
        generation = generation,
        cue = T3VoiceCue.READY,
        outcome = T3VoiceCueOutcome.DRAINED,
      ),
    )
    return true
  }

  override fun requestEnded(
    generation: Long,
    completion: (T3VoiceCueCompletion) -> Unit,
  ): Boolean {
    completion(
      T3VoiceCueCompletion(
        generation = generation,
        cue = T3VoiceCue.ENDED,
        outcome = T3VoiceCueOutcome.DRAINED,
      ),
    )
    return true
  }

  override fun cancel(generation: Long) = Unit

  override fun cancelAll() = Unit

  override fun release() = Unit
}
