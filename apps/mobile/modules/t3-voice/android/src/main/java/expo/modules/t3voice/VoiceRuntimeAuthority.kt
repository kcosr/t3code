package expo.modules.t3voice

internal data class VoiceRuntimeAuthorityReservation(
  val identity: VoiceRuntimeIdentity,
  val provisioningOperationId: String,
  val expectedCurrentGeneration: Long,
  val targetDigest: String,
  val token: String,
  val issuedAtEpochMillis: Long,
  val expiresAtEpochMillis: Long,
)

internal class VoiceRuntimeAuthorityRegistry(
  private val runtimeId: String,
  private val runtimeInstanceId: String,
  private val now: () -> Long,
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
    provisioning.resolve(reservation.provisioningOperationId, fingerprint) {
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
      val currentTime = now()
      require(reservation.issuedAtEpochMillis <= currentTime) {
        "Authority reservation was issued in the future."
      }
      require(reservation.expiresAtEpochMillis > currentTime) {
        "Authority reservation is expired."
      }
      authority = reservation
      generationFloor = reservation.identity.generation
      reservation
    }

  fun current(): VoiceRuntimeAuthorityReservation? =
    authority?.takeIf { it.expiresAtEpochMillis > now() }

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

  private fun requireIdentity(identity: VoiceRuntimeIdentity) {
    if (identity.runtimeId != runtimeId || identity.runtimeInstanceId != runtimeInstanceId) {
      throw VoiceRuntimeFenceException("Runtime identity changed.")
    }
  }
}
