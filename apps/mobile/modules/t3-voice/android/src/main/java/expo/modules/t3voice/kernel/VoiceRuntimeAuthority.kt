package expo.modules.t3voice.kernel

import expo.modules.t3voice.store.VoiceRuntimeIdempotencyLedger

internal data class VoiceRuntimeAuthorityReservation(
  val identity: VoiceRuntimeIdentity,
  val expectedCurrentGeneration: Long,
  val targetDigest: String,
)

internal data class VoiceRuntimeAuthorityRegistryCheckpoint(
  val authority: VoiceRuntimeAuthorityReservation?,
  val generationFloor: Long,
)

internal class VoiceRuntimeAuthorityRegistry(
  private val runtimeId: String,
  private val runtimeInstanceId: String,
  idempotencyCapacity: Int = 128,
  initialGenerationFloor: Long = 0,
) {
  init { require(initialGenerationFloor >= 0) }
  private val provisioning =
    VoiceRuntimeIdempotencyLedger<VoiceRuntimeAuthorityReservation>(idempotencyCapacity)
  private var authority: VoiceRuntimeAuthorityReservation? = null
  private var generationFloor = initialGenerationFloor

  fun configure(
    reservation: VoiceRuntimeAuthorityReservation,
    fingerprint: String,
  ): Pair<VoiceRuntimeAuthorityReservation, Boolean> =
    provisioning.resolve(idempotencyKey(reservation), fingerprint) {
      requireIdentity(reservation.identity)
      val comparisonFloor =
        if (authority == null && reservation.expectedCurrentGeneration >= generationFloor) {
          reservation.expectedCurrentGeneration
        } else {
          generationFloor
        }
      if (reservation.expectedCurrentGeneration != comparisonFloor ||
        reservation.identity.generation != comparisonFloor + 1) {
        throw VoiceRuntimeFenceException("Authority generation compare-and-swap failed.")
      }
      authority = reservation
      generationFloor = reservation.identity.generation
      reservation
    }

  fun current(): VoiceRuntimeAuthorityReservation? = authority

  fun requireCurrent(expectedGeneration: Long): VoiceRuntimeAuthorityReservation {
    val current = current() ?: throw VoiceRuntimeExpiredException()
    if (current.identity.generation != expectedGeneration) {
      throw VoiceRuntimeFenceException("Stale authority generation.")
    }
    return current
  }

  fun clear(identity: VoiceRuntimeIdentity) {
    requireIdentity(identity)
    if (authority?.identity?.generation != identity.generation) {
      throw VoiceRuntimeFenceException("Stale authority clear.")
    }
    authority = null
  }

  fun checkpoint(): VoiceRuntimeAuthorityRegistryCheckpoint =
    VoiceRuntimeAuthorityRegistryCheckpoint(authority, generationFloor)

  fun restore(
    checkpoint: VoiceRuntimeAuthorityRegistryCheckpoint,
    failedReservation: VoiceRuntimeAuthorityReservation,
  ) {
    authority = checkpoint.authority
    generationFloor = checkpoint.generationFloor
    provisioning.forget(idempotencyKey(failedReservation))
  }

  private fun idempotencyKey(reservation: VoiceRuntimeAuthorityReservation): String =
    "${reservation.identity.generation}:${reservation.targetDigest}"

  private fun requireIdentity(identity: VoiceRuntimeIdentity) {
    if (identity.runtimeId != runtimeId || identity.runtimeInstanceId != runtimeInstanceId) {
      throw VoiceRuntimeFenceException("Runtime identity changed.")
    }
  }
}
