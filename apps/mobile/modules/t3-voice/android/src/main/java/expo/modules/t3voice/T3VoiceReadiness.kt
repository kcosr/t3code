package expo.modules.t3voice

import android.content.Context

internal enum class T3VoiceReadinessMode {
  REALTIME,
  THREAD,
}

internal sealed interface T3VoicePreparedStart {
  val session: T3VoiceNativeSessionConfig

  data class Realtime(
    val target: T3VoiceRealtimeTarget,
    override val session: T3VoiceNativeSessionConfig,
  ) : T3VoicePreparedStart

  data class Thread(
    val start: T3VoiceThreadStart,
    override val session: T3VoiceNativeSessionConfig,
  ) : T3VoicePreparedStart

  fun command(): T3VoiceRuntimeCommand =
    when (this) {
      is Realtime -> T3VoiceRuntimeCommand.StartRealtime(target, session)
      is Thread -> T3VoiceRuntimeCommand.StartThread(start.target, start.settings, session)
    }
}

internal data class T3VoiceReadinessConfiguration(
  val generation: Long,
  val mode: T3VoiceReadinessMode,
  val label: String,
  val preparedStart: T3VoicePreparedStart?,
  val preparedThreadSwitch: T3VoiceThreadStart?,
) {
  init {
    require(generation > 0) { "Readiness generation must be positive." }
    require(label.isNotBlank()) { "Readiness label must be non-empty." }
    require(
      preparedStart == null ||
        (mode == T3VoiceReadinessMode.REALTIME && preparedStart is T3VoicePreparedStart.Realtime) ||
        (mode == T3VoiceReadinessMode.THREAD && preparedStart is T3VoicePreparedStart.Thread),
    ) { "Prepared voice start does not match readiness mode." }
  }
}

internal sealed interface T3VoiceReadinessSnapshot {
  val generation: Long

  data class Disabled(
    override val generation: Long,
  ) : T3VoiceReadinessSnapshot

  data class Ready(
    override val generation: Long,
    val mode: T3VoiceReadinessMode,
    val label: String,
    val expiresAt: String,
  ) : T3VoiceReadinessSnapshot

  data class Unavailable(
    override val generation: Long,
    val mode: T3VoiceReadinessMode,
    val label: String,
  ) : T3VoiceReadinessSnapshot

  data class NeedsRefresh(
    override val generation: Long,
    val mode: T3VoiceReadinessMode,
    val label: String,
    val expiresAt: String,
  ) : T3VoiceReadinessSnapshot

  fun retainsService(): Boolean = this !is Disabled
}

internal sealed interface T3VoiceReadinessStartDecision {
  data class Start(val command: T3VoiceRuntimeCommand) : T3VoiceReadinessStartDecision

  data object IgnoreStale : T3VoiceReadinessStartDecision

  data object Unavailable : T3VoiceReadinessStartDecision

  data class Expired(val snapshot: T3VoiceReadinessSnapshot.NeedsRefresh) :
    T3VoiceReadinessStartDecision
}

internal data class T3VoiceReadinessCheckpoint(
  val configuration: T3VoiceReadinessConfiguration?,
  val snapshot: T3VoiceReadinessSnapshot,
)

/** Process-local owner for the idle Ready envelope. It never persists credentials or targets. */
internal class T3VoiceReadinessOwner(
  private val nowEpochMillis: () -> Long = T3VoiceTime::nowEpochMillis,
) {
  private var configuration: T3VoiceReadinessConfiguration? = null
  private var current: T3VoiceReadinessSnapshot = T3VoiceReadinessSnapshot.Disabled(0)

  fun snapshot(): T3VoiceReadinessSnapshot = current

  fun checkpoint(): T3VoiceReadinessCheckpoint =
    T3VoiceReadinessCheckpoint(configuration, current)

  fun restore(checkpoint: T3VoiceReadinessCheckpoint) {
    configuration = checkpoint.configuration
    current = checkpoint.snapshot
  }

  fun configure(next: T3VoiceReadinessConfiguration): T3VoiceReadinessSnapshot {
    require(next.generation > current.generation) { "Readiness generation is stale." }
    val nextSnapshot = snapshotFor(next)
    configuration = next
    current = nextSnapshot
    return current
  }

  fun <A> configureTransaction(
    next: T3VoiceReadinessConfiguration,
    activate: (T3VoiceReadinessSnapshot) -> A,
  ): A {
    val previous = checkpoint()
    val nextSnapshot = configure(next)
    return try {
      activate(nextSnapshot)
    } catch (cause: Throwable) {
      restore(previous)
      throw cause
    }
  }

  fun disable(generation: Long): T3VoiceReadinessSnapshot.Disabled {
    validateNextGeneration(generation)
    configuration = null
    return T3VoiceReadinessSnapshot.Disabled(generation).also { current = it }
  }

  fun validateNextGeneration(generation: Long) {
    require(generation > current.generation) { "Readiness generation is stale." }
  }

  fun start(generation: Long): T3VoiceReadinessStartDecision {
    if (generation != current.generation) return T3VoiceReadinessStartDecision.IgnoreStale
    val configured = configuration ?: return T3VoiceReadinessStartDecision.Unavailable
    val prepared = configured.preparedStart ?: return T3VoiceReadinessStartDecision.Unavailable
    if (current !is T3VoiceReadinessSnapshot.Ready) {
      return T3VoiceReadinessStartDecision.Unavailable
    }
    val expiresAt = parseExpiration(prepared.session.expiresAt)
    if (nowEpochMillis() >= expiresAt) {
      val expired =
        T3VoiceReadinessSnapshot.NeedsRefresh(
          generation = configured.generation,
          mode = configured.mode,
          label = configured.label,
          expiresAt = prepared.session.expiresAt,
        )
      current = expired
      return T3VoiceReadinessStartDecision.Expired(expired)
    }
    return T3VoiceReadinessStartDecision.Start(prepared.command())
  }

  fun preparedThreadStartFor(environmentId: String): T3VoiceThreadStart? =
    (
      configuration?.preparedThreadSwitch
        ?: (configuration?.preparedStart as? T3VoicePreparedStart.Thread)?.start
    )?.takeIf { it.target.environmentId == environmentId }

  fun markNeedsRefresh(): T3VoiceReadinessSnapshot.NeedsRefresh? {
    val configured = configuration ?: return null
    val prepared = configured.preparedStart ?: return null
    if (current is T3VoiceReadinessSnapshot.NeedsRefresh) return null
    return T3VoiceReadinessSnapshot.NeedsRefresh(
      configured.generation,
      configured.mode,
      configured.label,
      prepared.session.expiresAt,
    ).also { current = it }
  }

  fun markUnavailable(): T3VoiceReadinessSnapshot.Unavailable? {
    val configured = configuration ?: return null
    if (current is T3VoiceReadinessSnapshot.Unavailable) return null
    return T3VoiceReadinessSnapshot.Unavailable(
      configured.generation,
      configured.mode,
      configured.label,
    ).also { current = it }
  }

  private fun snapshotFor(
    configuration: T3VoiceReadinessConfiguration,
  ): T3VoiceReadinessSnapshot {
    val prepared = configuration.preparedStart
      ?: return T3VoiceReadinessSnapshot.Unavailable(
        configuration.generation,
        configuration.mode,
        configuration.label,
      )
    val expiresAt = parseExpiration(prepared.session.expiresAt)
    return if (nowEpochMillis() < expiresAt) {
      T3VoiceReadinessSnapshot.Ready(
        configuration.generation,
        configuration.mode,
        configuration.label,
        prepared.session.expiresAt,
      )
    } else {
      T3VoiceReadinessSnapshot.NeedsRefresh(
        configuration.generation,
        configuration.mode,
        configuration.label,
        prepared.session.expiresAt,
      )
    }
  }

  private fun parseExpiration(value: String): Long =
    T3VoiceTime.parseIsoEpochMillis(value, "native session expiration")
}

internal fun T3VoiceReadinessSnapshot.toBridgeBody(): Map<String, Any?> =
  when (this) {
    is T3VoiceReadinessSnapshot.Disabled ->
      mapOf("posture" to "disabled", "generation" to generation.toDouble())
    is T3VoiceReadinessSnapshot.Ready ->
      mapOf(
        "posture" to "ready",
        "generation" to generation.toDouble(),
        "mode" to mode.bridgeName(),
        "label" to label,
        "expiresAt" to expiresAt,
      )
    is T3VoiceReadinessSnapshot.Unavailable ->
      mapOf(
        "posture" to "unavailable",
        "generation" to generation.toDouble(),
        "mode" to mode.bridgeName(),
        "label" to label,
      )
    is T3VoiceReadinessSnapshot.NeedsRefresh ->
      mapOf(
        "posture" to "needs-refresh",
        "generation" to generation.toDouble(),
        "mode" to mode.bridgeName(),
        "label" to label,
        "expiresAt" to expiresAt,
      )
  }

private fun T3VoiceReadinessMode.bridgeName(): String = name.lowercase()

/** Durable only for reconciling an explicit notification Disable; stores no target or credential. */
internal class T3VoiceReadinessDisableMarker(context: Context) {
  private val preferences =
    context.getSharedPreferences("t3_voice_readiness_control", Context.MODE_PRIVATE)

  fun pendingGeneration(): Long? =
    preferences.getLong(KEY_GENERATION, 0).takeIf { it > 0 }

  fun mark(generation: Long) {
    require(generation > 0)
    check(preferences.edit().putLong(KEY_GENERATION, generation).commit()) {
      "Could not persist the voice readiness disable marker."
    }
  }

  fun acknowledge(generation: Long) {
    if (pendingGeneration() != generation) return
    check(preferences.edit().remove(KEY_GENERATION).commit()) {
      "Could not clear the voice readiness disable marker."
    }
  }

  private companion object {
    const val KEY_GENERATION = "pendingDisableGeneration"
  }
}
