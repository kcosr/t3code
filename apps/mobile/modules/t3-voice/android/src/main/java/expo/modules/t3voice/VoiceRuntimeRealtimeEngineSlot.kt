package expo.modules.t3voice

internal data class VoiceRuntimeRealtimeEngineBinding<E : Any>(
  val authority: VoiceRuntimeRealtimeAuthority,
  val engine: E,
)

internal data class VoiceRuntimeRealtimeEngineSlotSnapshot<E : Any>(
  val current: VoiceRuntimeRealtimeEngineBinding<E>?,
  val version: Long,
)

internal data class VoiceRuntimeRealtimeEngineSlotFence<E : Any>(
  internal val engine: E?,
  val identity: VoiceRuntimeIdentity?,
  val version: Long,
)

internal data class VoiceRuntimeRealtimeEngineInstallation(
  internal val installationId: Long,
)

/**
 * Owns the installed Realtime engine reference independently from service lifecycle concerns.
 * Candidate engines must remain inert until their installation is completed.
 */
internal class VoiceRuntimeRealtimeEngineSlot<E : Any>(
  initial: VoiceRuntimeRealtimeEngineBinding<E>? = null,
  private val isActive: (E) -> Boolean,
) {
  private data class StagedInstallation<E : Any>(
    val installationId: Long,
    val baseVersion: Long,
    val previous: VoiceRuntimeRealtimeEngineBinding<E>?,
    val candidate: VoiceRuntimeRealtimeEngineBinding<E>?,
    var committedVersion: Long? = null,
  )

  private var current = initial
  private var version = 0L
  private var nextInstallationId = 0L
  private var stagedInstallation: StagedInstallation<E>? = null

  init {
    initial?.let(::validateBinding)
  }

  @Synchronized
  fun snapshot(): VoiceRuntimeRealtimeEngineSlotSnapshot<E> =
    VoiceRuntimeRealtimeEngineSlotSnapshot(current, version)

  @Synchronized
  fun fence(): VoiceRuntimeRealtimeEngineSlotFence<E> = currentFence()

  @Synchronized
  fun stageIdleInstall(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
    authority: VoiceRuntimeRealtimeAuthority,
    candidateEngine: E,
  ): VoiceRuntimeRealtimeEngineInstallation {
    check(!isActive(candidateEngine)) { "A candidate Realtime engine must be idle." }
    val candidate = VoiceRuntimeRealtimeEngineBinding(authority, candidateEngine)
    validateBinding(candidate)
    current?.let { validateReplacement(it.authority, authority) }
    return stageIdleReplacement(expected, candidate)
  }

  @Synchronized
  fun stageRecoveredInstall(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
    authority: VoiceRuntimeRealtimeAuthority,
    candidateEngine: E,
  ): VoiceRuntimeRealtimeEngineInstallation {
    requireNoInstallation()
    requireFence(expected)
    check(current == null) { "Recovered Realtime state can only enter an empty engine slot." }
    val candidate = VoiceRuntimeRealtimeEngineBinding(authority, candidateEngine)
    validateBinding(candidate)
    return stageIdleReplacement(expected, candidate)
  }

  @Synchronized
  fun stageIdleClear(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
  ): VoiceRuntimeRealtimeEngineInstallation = stageIdleReplacement(expected, null)

  private fun stageIdleReplacement(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
    candidate: VoiceRuntimeRealtimeEngineBinding<E>?,
  ): VoiceRuntimeRealtimeEngineInstallation {
    requireNoInstallation()
    requireFence(expected)
    current?.let {
      check(!isActive(it.engine)) { "An active Realtime engine cannot be replaced." }
    }
    nextInstallationId += 1
    stagedInstallation = StagedInstallation(
      installationId = nextInstallationId,
      baseVersion = version,
      previous = current,
      candidate = candidate,
    )
    return VoiceRuntimeRealtimeEngineInstallation(nextInstallationId)
  }

  @Synchronized
  fun commit(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    val staged = requireInstallation(installation)
    check(staged.committedVersion == null) { "The Realtime engine installation is already committed." }
    check(version == staged.baseVersion) { "The Realtime engine slot changed during installation." }
    requireBinding(current, staged.previous)
    current = staged.candidate
    version += 1
    staged.committedVersion = version
    return snapshot()
  }

  @Synchronized
  fun rollback(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    val staged = requireInstallation(installation)
    val committedVersion = staged.committedVersion
    if (committedVersion == null) {
      check(version == staged.baseVersion) { "The Realtime engine slot changed during installation." }
      requireBinding(current, staged.previous)
    } else {
      check(version == committedVersion) { "The committed Realtime engine installation is stale." }
      requireBinding(current, staged.candidate)
      check(staged.candidate?.engine?.let(isActive) != true) {
        "An active candidate Realtime engine cannot be rolled back."
      }
      current = staged.previous
      version += 1
    }
    stagedInstallation = null
    return snapshot()
  }

  @Synchronized
  fun complete(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    val staged = requireInstallation(installation)
    val committedVersion = requireNotNull(staged.committedVersion) {
      "The Realtime engine installation has not been committed."
    }
    check(version == committedVersion) { "The committed Realtime engine installation is stale." }
    requireBinding(current, staged.candidate)
    stagedInstallation = null
    return snapshot()
  }

  @Synchronized
  fun clear(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
  ): VoiceRuntimeRealtimeEngineBinding<E>? {
    requireNoInstallation()
    requireFence(expected)
    val removed = current
    current = null
    version += 1
    return removed
  }

  private fun currentFence() = VoiceRuntimeRealtimeEngineSlotFence(
    current?.engine,
    current?.authority?.identity,
    version,
  )

  private fun requireFence(expected: VoiceRuntimeRealtimeEngineSlotFence<E>) {
    val actual = currentFence()
    if (
      expected.version != actual.version ||
        expected.engine !== actual.engine ||
        expected.identity != actual.identity
    ) {
      throw VoiceRuntimeFenceException("The Realtime engine slot fence is stale.")
    }
  }

  private fun requireBinding(
    actual: VoiceRuntimeRealtimeEngineBinding<E>?,
    expected: VoiceRuntimeRealtimeEngineBinding<E>?,
  ) {
    if (
      actual?.engine !== expected?.engine ||
        actual?.authority != expected?.authority
    ) {
      throw VoiceRuntimeFenceException("The Realtime engine binding changed during installation.")
    }
  }

  private fun requireInstallation(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): StagedInstallation<E> = stagedInstallation?.takeIf {
    it.installationId == installation.installationId
  } ?: throw VoiceRuntimeFenceException("The Realtime engine installation is stale.")

  private fun requireNoInstallation() {
    check(stagedInstallation == null) { "A Realtime engine installation is already in progress." }
  }

  private fun validateBinding(binding: VoiceRuntimeRealtimeEngineBinding<E>) {
    validateAuthority(binding.authority)
  }

  private fun validateReplacement(
    installed: VoiceRuntimeRealtimeAuthority,
    candidate: VoiceRuntimeRealtimeAuthority,
  ) {
    val installedIdentity = installed.identity
    val candidateIdentity = candidate.identity
    val replay = installed == candidate
    if (
      !replay &&
        (
          installedIdentity.runtimeId != candidateIdentity.runtimeId ||
            installedIdentity.runtimeInstanceId != candidateIdentity.runtimeInstanceId ||
            candidateIdentity.generation != installedIdentity.generation + 1
        )
    ) {
      throw VoiceRuntimeFenceException("Replacement Realtime authority changed its runtime fence.")
    }
  }

  private fun validateAuthority(authority: VoiceRuntimeRealtimeAuthority) {
    VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin)
  }
}
