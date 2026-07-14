package expo.modules.t3voice

internal data class VoiceRuntimeRealtimeEngineBinding<E : Any>(
  val authority: VoiceRuntimeRealtimeAuthority,
  val engine: E,
)

internal data class VoiceRuntimeRealtimeEngineSlotSnapshot<E : Any>(
  val current: VoiceRuntimeRealtimeEngineBinding<E>?,
  val deferredAuthority: VoiceRuntimeRealtimeAuthority?,
  val version: Long,
)

internal data class VoiceRuntimeRealtimeEngineSlotFence<E : Any>(
  internal val engine: E?,
  val identity: VoiceRuntimeIdentity?,
  val version: Long,
)

internal data class VoiceRuntimeRealtimeDeferredAuthority<E : Any>(
  internal val engine: E,
  val identity: VoiceRuntimeIdentity,
  val authority: VoiceRuntimeRealtimeAuthority,
  val slotVersion: Long,
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
    val previousDeferredAuthority: VoiceRuntimeRealtimeAuthority?,
    val candidate: VoiceRuntimeRealtimeEngineBinding<E>?,
    var committedVersion: Long? = null,
  )

  private var current = initial
  private var deferredAuthority: VoiceRuntimeRealtimeAuthority? = null
  private var version = 0L
  private var nextInstallationId = 0L
  private var stagedInstallation: StagedInstallation<E>? = null

  init {
    initial?.let(::validateBinding)
  }

  @Synchronized
  fun snapshot(): VoiceRuntimeRealtimeEngineSlotSnapshot<E> =
    VoiceRuntimeRealtimeEngineSlotSnapshot(current, deferredAuthority, version)

  @Synchronized
  fun fence(): VoiceRuntimeRealtimeEngineSlotFence<E> = currentFence()

  @Synchronized
  fun acceptRefresh(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
    refreshed: VoiceRuntimeRealtimeAuthority,
  ): VoiceRuntimeRealtimeDeferredAuthority<E>? {
    requireNoInstallation()
    requireFence(expected)
    val installed = current ?: throw VoiceRuntimeFenceException(
      "Realtime authority cannot be refreshed without an installed engine.",
    )
    validateAuthority(refreshed)
    requireSameFence(installed.authority, refreshed)

    val previous = deferredAuthority ?: installed.authority
    if (refreshed == previous) {
      return deferredAuthority?.let { deferredTicket(installed.engine, it) }
    }
    requireForwardRefresh(previous, refreshed)
    deferredAuthority = refreshed
    version += 1
    return deferredTicket(installed.engine, refreshed)
  }

  @Synchronized
  fun deferredFor(
    expectedEngine: E,
  ): VoiceRuntimeRealtimeDeferredAuthority<E>? {
    val installed = current ?: return null
    if (installed.engine !== expectedEngine) return null
    val deferred = deferredAuthority ?: return null
    return deferredTicket(installed.engine, deferred)
  }

  @Synchronized
  fun swapDeferredAfterTerminal(
    expected: VoiceRuntimeRealtimeDeferredAuthority<E>,
    candidateEngine: E,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    requireNoInstallation()
    val installed = current ?: throw VoiceRuntimeFenceException(
      "The Realtime engine was cleared before its refreshed authority could be installed.",
    )
    val deferred = deferredAuthority ?: throw VoiceRuntimeFenceException(
      "No refreshed Realtime authority is pending.",
    )
    if (
      expected.slotVersion != version ||
        installed.engine !== expected.engine ||
        installed.authority.identity != expected.identity ||
        deferred != expected.authority
    ) {
      throw VoiceRuntimeFenceException("The deferred Realtime authority is stale.")
    }
    check(!isActive(installed.engine)) {
      "An active Realtime engine must retain its child-session authority until terminal."
    }
    check(!isActive(candidateEngine)) { "A candidate Realtime engine must be idle." }
    validateBinding(VoiceRuntimeRealtimeEngineBinding(deferred, candidateEngine))

    current = VoiceRuntimeRealtimeEngineBinding(deferred, candidateEngine)
    deferredAuthority = null
    version += 1
    return snapshot()
  }

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
      previousDeferredAuthority = deferredAuthority,
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
    deferredAuthority = null
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
      deferredAuthority = staged.previousDeferredAuthority
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
    deferredAuthority = null
    version += 1
    return removed
  }

  @Synchronized
  fun discardDeferred(
    expected: VoiceRuntimeRealtimeEngineSlotFence<E>,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    requireNoInstallation()
    requireFence(expected)
    if (deferredAuthority != null) {
      deferredAuthority = null
      version += 1
    }
    return snapshot()
  }

  private fun currentFence() = VoiceRuntimeRealtimeEngineSlotFence(
    current?.engine,
    current?.authority?.identity,
    version,
  )

  private fun deferredTicket(
    engine: E,
    authority: VoiceRuntimeRealtimeAuthority,
  ) = VoiceRuntimeRealtimeDeferredAuthority(
    engine,
    authority.identity,
    authority,
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
    require(authority.environmentOrigin.isNotBlank())
    require(authority.runtimeToken.isNotBlank())
    require(authority.expiresAtEpochMillis > 0)
  }

  private fun requireSameFence(
    installed: VoiceRuntimeRealtimeAuthority,
    refreshed: VoiceRuntimeRealtimeAuthority,
  ) {
    if (
      installed.identity != refreshed.identity ||
        installed.target != refreshed.target ||
        VoiceRuntimeOriginPolicy.normalize(installed.environmentOrigin) !=
        VoiceRuntimeOriginPolicy.normalize(refreshed.environmentOrigin)
    ) {
      throw VoiceRuntimeFenceException("Refreshed Realtime authority changed its canonical fence.")
    }
  }

  private fun requireForwardRefresh(
    previous: VoiceRuntimeRealtimeAuthority,
    refreshed: VoiceRuntimeRealtimeAuthority,
  ) {
    if (
      refreshed.expiresAtEpochMillis <= previous.expiresAtEpochMillis ||
        refreshed.runtimeToken == previous.runtimeToken
    ) {
      throw VoiceRuntimeFenceException("Refreshed Realtime authority did not advance.")
    }
  }
}
