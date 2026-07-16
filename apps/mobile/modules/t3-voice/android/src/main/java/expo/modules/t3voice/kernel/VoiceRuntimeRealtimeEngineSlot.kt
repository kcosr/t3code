package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeOriginPolicy

internal class VoiceRuntimeRealtimeEngineBinding<E : Any>(
  val authority: VoiceRuntimeRealtimeAuthority,
  val engine: E,
  var state: VoiceRuntimeRealtimeState = VoiceRuntimeRealtimeState(),
) {
  /** Stable continuation fence; immutable RealtimeState values are never used as identity tokens. */
  val identityToken: Any = Any()
}

internal data class VoiceRuntimeRealtimeEngineSlotSnapshot<E : Any>(
  val current: VoiceRuntimeRealtimeEngineBinding<E>?,
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
  private val isActive: (E) -> Boolean = { false },
  private val isRealtimeStateActive: (VoiceRuntimeRealtimeState) -> Boolean =
    VoiceRuntimeRealtimeState::isOperational,
  private val assertKernelThread: () -> Unit = {},
) {
  private enum class InstallationPhase { STAGED, COMMITTED }

  private data class StagedInstallation<E : Any>(
    val installationId: Long,
    val previous: VoiceRuntimeRealtimeEngineBinding<E>?,
    val candidate: VoiceRuntimeRealtimeEngineBinding<E>?,
    var phase: InstallationPhase = InstallationPhase.STAGED,
  )

  private var current = initial
  private var nextInstallationId = 0L
  private var stagedInstallation: StagedInstallation<E>? = null

  init {
    initial?.let(::validateBinding)
  }

  fun snapshot(): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    assertKernelThread()
    return VoiceRuntimeRealtimeEngineSlotSnapshot(current)
  }

  fun stageIdleInstall(
    authority: VoiceRuntimeRealtimeAuthority,
    candidateEngine: E,
    candidateState: VoiceRuntimeRealtimeState = VoiceRuntimeRealtimeState(),
  ): VoiceRuntimeRealtimeEngineInstallation {
    assertKernelThread()
    check(!isActive(candidateEngine)) { "A candidate Realtime engine must be idle." }
    check(!isRealtimeStateActive(candidateState)) { "A candidate Realtime state must be idle." }
    val candidate = VoiceRuntimeRealtimeEngineBinding(authority, candidateEngine, candidateState)
    validateBinding(candidate)
    current?.let { validateReplacement(it.authority, authority) }
    return stageIdleReplacement(candidate)
  }

  fun stageRecoveredInstall(
    authority: VoiceRuntimeRealtimeAuthority,
    candidateEngine: E,
    candidateState: VoiceRuntimeRealtimeState = VoiceRuntimeRealtimeState(),
  ): VoiceRuntimeRealtimeEngineInstallation {
    assertKernelThread()
    requireNoInstallation()
    check(current == null) { "Recovered Realtime state can only enter an empty engine slot." }
    val candidate = VoiceRuntimeRealtimeEngineBinding(authority, candidateEngine, candidateState)
    validateBinding(candidate)
    return stageIdleReplacement(candidate)
  }

  fun stageIdleClear(
  ): VoiceRuntimeRealtimeEngineInstallation {
    assertKernelThread()
    return stageIdleReplacement(null)
  }

  private fun stageIdleReplacement(
    candidate: VoiceRuntimeRealtimeEngineBinding<E>?,
  ): VoiceRuntimeRealtimeEngineInstallation {
    requireNoInstallation()
    current?.let {
      check(!bindingIsActive(it)) { "An active Realtime engine cannot be replaced." }
    }
    nextInstallationId += 1
    stagedInstallation = StagedInstallation(
      installationId = nextInstallationId,
      previous = current,
      candidate = candidate,
    )
    return VoiceRuntimeRealtimeEngineInstallation(nextInstallationId)
  }

  fun commit(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    assertKernelThread()
    val staged = requireInstallation(installation)
    check(staged.phase == InstallationPhase.STAGED) {
      "The Realtime engine installation is already committed."
    }
    current = staged.candidate
    staged.phase = InstallationPhase.COMMITTED
    return snapshot()
  }

  fun rollback(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    assertKernelThread()
    val staged = requireInstallation(installation)
    if (staged.phase == InstallationPhase.COMMITTED) {
      check(staged.candidate?.let(::bindingIsActive) != true) {
        "An active candidate Realtime engine cannot be rolled back."
      }
      current = staged.previous
    }
    stagedInstallation = null
    return snapshot()
  }

  fun complete(
    installation: VoiceRuntimeRealtimeEngineInstallation,
  ): VoiceRuntimeRealtimeEngineSlotSnapshot<E> {
    assertKernelThread()
    val staged = requireInstallation(installation)
    check(staged.phase == InstallationPhase.COMMITTED) {
      "The Realtime engine installation has not been committed."
    }
    stagedInstallation = null
    return snapshot()
  }

  fun clear(
  ): VoiceRuntimeRealtimeEngineBinding<E>? {
    assertKernelThread()
    requireNoInstallation()
    val removed = current
    current = null
    return removed
  }

  fun applyReduction(
    reduction: VoiceRuntimeRealtimeReduction<*>,
  ): VoiceRuntimeRealtimeEngineBinding<E>? {
    assertKernelThread()
    val binding = current ?: return null
    binding.state = reduction.state
    return binding
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

  private fun bindingIsActive(binding: VoiceRuntimeRealtimeEngineBinding<E>) =
    isActive(binding.engine) || isRealtimeStateActive(binding.state)

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
      android.util.Log.i("T3VoiceDbg", "slot.replacementFenceReject")
      throw VoiceRuntimeFenceException("Replacement Realtime authority changed its runtime fence.")
    }
  }

  private fun validateAuthority(authority: VoiceRuntimeRealtimeAuthority) {
    VoiceRuntimeOriginPolicy.normalize(authority.environmentOrigin)
  }
}
