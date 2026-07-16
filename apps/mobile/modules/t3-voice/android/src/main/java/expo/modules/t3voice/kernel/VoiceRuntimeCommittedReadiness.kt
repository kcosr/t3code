package expo.modules.t3voice.kernel

import expo.modules.t3voice.net.VoiceRuntimeOriginPolicy
import expo.modules.t3voice.store.VoiceRuntimePersistedAuthority
import expo.modules.t3voice.store.grantOperation

internal sealed interface VoiceRuntimeCommittedReadinessDecision {
  data object NotRequired : VoiceRuntimeCommittedReadinessDecision
  data class Current(val authority: T3VoicePreparedReadiness) :
    VoiceRuntimeCommittedReadinessDecision
  data class Promote(val authority: T3VoicePreparedReadiness) :
    VoiceRuntimeCommittedReadinessDecision
  data object Mismatch : VoiceRuntimeCommittedReadinessDecision
}

internal object VoiceRuntimeCommittedReadinessPolicy {
  fun reconcile(
    canonical: VoiceRuntimePersistedAuthority,
    prepared: T3VoicePreparedReadiness?,
    active: T3VoicePreparedReadiness?,
  ): VoiceRuntimeCommittedReadinessDecision {
    if (!canonical.readinessEnabled) return VoiceRuntimeCommittedReadinessDecision.NotRequired
    active?.takeIf { matches(canonical, it) }?.let {
      return VoiceRuntimeCommittedReadinessDecision.Current(it)
    }
    prepared?.takeIf { matches(canonical, it) }?.let {
      return VoiceRuntimeCommittedReadinessDecision.Promote(it)
    }
    return VoiceRuntimeCommittedReadinessDecision.Mismatch
  }

  private fun matches(
    canonical: VoiceRuntimePersistedAuthority,
    readiness: T3VoicePreparedReadiness,
  ): Boolean = readiness.config.enabled &&
    readiness.runtimeId == canonical.runtimeId &&
    readiness.config.generation == canonical.generation &&
    readiness.operation == canonical.target.grantOperation() &&
    readiness.targetIdentityDigest == canonical.targetDigest &&
    VoiceRuntimeOriginPolicy.normalize(readiness.environmentOrigin) ==
      VoiceRuntimeOriginPolicy.normalize(canonical.environmentOrigin)
}
