package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.VoiceRuntimeElection
import expo.modules.t3voice.kernel.VoiceRuntimeExpiredException
import expo.modules.t3voice.kernel.VoiceRuntimeFenceException
import expo.modules.t3voice.kernel.VoiceRuntimeIdentity
import expo.modules.t3voice.kernel.VoiceRuntimeNotElectedException
import expo.modules.t3voice.kernel.VoiceRuntimePresentation
import expo.modules.t3voice.kernel.VoiceRuntimePresentationElection

internal data class VoiceRuntimeConsumerLease(
  val leaseId: String,
  val identity: VoiceRuntimeIdentity,
  val leaseGeneration: Long,
  val attachOrdinal: Long,
  val presentation: VoiceRuntimePresentation,
  val election: VoiceRuntimeElection,
  val expiresAtEpochMillis: Long,
)

internal class VoiceRuntimeConsumerRegistry(
  private val identity: () -> VoiceRuntimeIdentity,
  private val now: () -> Long,
  private val leaseDurationMillis: Long,
  private val onElectionChanged: (VoiceRuntimePresentationElection) -> Unit = {},
) {
  private val leases = linkedMapOf<String, VoiceRuntimeConsumerLease>()
  private var nextLease = 0L
  private var nextOrdinal = 0L
  private var lastElection = VoiceRuntimePresentationElection(null, null, 0, now())

  fun attach(presentation: VoiceRuntimePresentation): VoiceRuntimeConsumerLease {
    expire()
    nextLease += 1
    nextOrdinal += 1
    val lease = VoiceRuntimeConsumerLease(
      "consumer-$nextLease",
      identity(),
      1,
      nextOrdinal,
      presentation,
      VoiceRuntimeElection.STANDBY,
      now() + leaseDurationMillis,
    )
    leases[lease.leaseId] = lease
    elect()
    return requireLease(leases.getValue(lease.leaseId))
  }

  fun update(lease: VoiceRuntimeConsumerLease, presentation: VoiceRuntimePresentation): VoiceRuntimeConsumerLease {
    val current = requireLease(lease)
    leases[lease.leaseId] = current.copy(
      leaseGeneration = current.leaseGeneration + 1,
      presentation = presentation,
      expiresAtEpochMillis = now() + leaseDurationMillis,
    )
    elect()
    return leases.getValue(lease.leaseId)
  }

  fun detach(lease: VoiceRuntimeConsumerLease) {
    requireLease(lease)
    leases.remove(lease.leaseId)
    elect()
  }

  fun requireLease(lease: VoiceRuntimeConsumerLease): VoiceRuntimeConsumerLease {
    expire()
    val current = leases[lease.leaseId] ?: throw VoiceRuntimeExpiredException()
    if (current.identity != identity() || current.leaseGeneration != lease.leaseGeneration) {
      throw VoiceRuntimeFenceException("Stale consumer lease.")
    }
    return current
  }

  fun requireElected(lease: VoiceRuntimeConsumerLease): VoiceRuntimeConsumerLease =
    requireLease(lease).also {
      if (it.election != VoiceRuntimeElection.ELECTED) throw VoiceRuntimeNotElectedException()
    }

  fun isElected(leaseId: String): Boolean {
    expire()
    return leases[leaseId]?.election == VoiceRuntimeElection.ELECTED
  }

  fun count(): Int {
    expire()
    return leases.size
  }

  private fun expire() {
    val cutoff = now()
    val currentIdentity = identity()
    if (leases.entries.removeAll {
        it.value.expiresAtEpochMillis <= cutoff || it.value.identity != currentIdentity
      }) elect()
  }

  private fun elect() {
    val eligible = leases.values
      .filter { it.presentation == VoiceRuntimePresentation.FOREGROUND_ACTIVE }
    val winner = eligible.maxByOrNull { it.attachOrdinal }
      ?.leaseId
    leases.replaceAll { id, lease ->
      lease.copy(election = if (id == winner) VoiceRuntimeElection.ELECTED else VoiceRuntimeElection.STANDBY)
    }
    val elected = winner?.let(leases::getValue)
    val nextElection = VoiceRuntimePresentationElection(
      electedLeaseId = winner,
      electedAttachOrdinal = elected?.attachOrdinal,
      eligibleConsumerCount = eligible.size,
      changedAtEpochMillis = now(),
    )
    if (nextElection.copy(changedAtEpochMillis = 0) != lastElection.copy(changedAtEpochMillis = 0)) {
      lastElection = nextElection
      onElectionChanged(nextElection)
    }
  }
}

internal sealed interface VoiceRuntimePresentationAction {
  val actionId: String
  val expiresAtEpochMillis: Long

  data class NavigateThread(
    override val actionId: String,
    val projectId: String,
    val threadId: String,
    override val expiresAtEpochMillis: Long,
  ) : VoiceRuntimePresentationAction

  data class ReviewDraft(
    override val actionId: String,
    val artifact: VoiceRuntimeDraftHandle,
    override val expiresAtEpochMillis: Long,
  ) : VoiceRuntimePresentationAction

  data class RealtimeConfirmationRequired(
    override val actionId: String,
    val confirmationId: String,
    val toolCallId: String,
    val tool: String,
    val summary: String,
    override val expiresAtEpochMillis: Long,
  ) : VoiceRuntimePresentationAction
}

internal class VoiceRuntimePresentationActionStore(
  private val consumers: VoiceRuntimeConsumerRegistry,
  private val now: () -> Long,
) {
  private data class Entry(val action: VoiceRuntimePresentationAction, val claimantLeaseId: String?)
  private val entries = mutableMapOf<String, Entry>()

  data class CheckpointEntry(
    val action: VoiceRuntimePresentationAction,
    val claimantLeaseId: String?,
  )

  fun publish(action: VoiceRuntimePresentationAction) { entries[action.actionId] = Entry(action, null) }

  fun claim(actionId: String, lease: VoiceRuntimeConsumerLease): VoiceRuntimePresentationAction {
    val elected = consumers.requireElected(lease)
    val entry = requireLive(actionId)
    if (entry.claimantLeaseId != null && entry.claimantLeaseId != elected.leaseId &&
      consumers.isElected(entry.claimantLeaseId)) {
      throw VoiceRuntimeFenceException("Presentation action already claimed.")
    }
    entries[actionId] = entry.copy(claimantLeaseId = elected.leaseId)
    return entry.action
  }

  fun acknowledge(actionId: String, lease: VoiceRuntimeConsumerLease) {
    requireAcknowledgement(actionId, lease)
    entries.remove(actionId)
  }

  fun requireAcknowledgement(actionId: String, lease: VoiceRuntimeConsumerLease) {
    val elected = consumers.requireElected(lease)
    val entry = requireLive(actionId)
    if (entry.claimantLeaseId != elected.leaseId) throw VoiceRuntimeFenceException("Stale action claim.")
  }

  fun live(): List<VoiceRuntimePresentationAction> {
    entries.keys.toList().forEach { actionId -> runCatching { requireLive(actionId) } }
    return entries.values.map { it.action }
  }

  fun remove(actionId: String) { entries.remove(actionId) }

  fun replace(actions: List<VoiceRuntimePresentationAction>) {
    entries.clear()
    actions.forEach(::publish)
  }

  fun checkpoint(): List<CheckpointEntry> = entries.values.map {
    CheckpointEntry(it.action, it.claimantLeaseId)
  }

  fun restore(checkpoint: List<CheckpointEntry>) {
    entries.clear()
    checkpoint.forEach { entry ->
      entries[entry.action.actionId] = Entry(entry.action, entry.claimantLeaseId)
    }
  }

  private fun requireLive(actionId: String): Entry {
    val entry = entries[actionId] ?: throw VoiceRuntimeExpiredException()
    if (entry.action.expiresAtEpochMillis <= now()) {
      entries.remove(actionId)
      throw VoiceRuntimeExpiredException()
    }
    return entry
  }
}

/** In-memory only. Durable stores must never serialize this wrapper. */
internal class VoiceRuntimeOpaqueDraftPayload private constructor(private val plaintext: String) {
  fun revealInMemory(): String = plaintext

  override fun toString(): String = "VoiceRuntimeOpaqueDraftPayload([REDACTED])"

  companion object {
    fun inMemory(plaintext: String) = VoiceRuntimeOpaqueDraftPayload(plaintext)
  }
}

internal data class VoiceRuntimeDraftArtifact(
  val artifactId: String,
  val payload: VoiceRuntimeOpaqueDraftPayload,
  val expiresAtEpochMillis: Long,
)

internal class VoiceRuntimeDraftArtifactStore(
  private val consumers: VoiceRuntimeConsumerRegistry,
  private val now: () -> Long,
) {
  private data class Entry(val artifact: VoiceRuntimeDraftArtifact, val readerLeaseId: String?)
  private val entries = mutableMapOf<String, Entry>()

  fun publish(artifact: VoiceRuntimeDraftArtifact) { entries[artifact.artifactId] = Entry(artifact, null) }

  fun read(artifactId: String, lease: VoiceRuntimeConsumerLease): VoiceRuntimeDraftArtifact {
    val elected = consumers.requireElected(lease)
    val entry = requireLive(artifactId)
    if (entry.readerLeaseId != null && entry.readerLeaseId != elected.leaseId &&
      consumers.isElected(entry.readerLeaseId)) {
      throw VoiceRuntimeFenceException("Draft artifact already claimed.")
    }
    entries[artifactId] = entry.copy(readerLeaseId = elected.leaseId)
    return entry.artifact
  }

  fun acknowledge(artifactId: String, lease: VoiceRuntimeConsumerLease) {
    val elected = consumers.requireElected(lease)
    val entry = requireLive(artifactId)
    if (entry.readerLeaseId != elected.leaseId) throw VoiceRuntimeFenceException("Stale draft claim.")
    entries.remove(artifactId)
  }

  private fun requireLive(artifactId: String): Entry {
    val entry = entries[artifactId] ?: throw VoiceRuntimeExpiredException()
    if (entry.artifact.expiresAtEpochMillis <= now()) {
      entries.remove(artifactId)
      throw VoiceRuntimeExpiredException()
    }
    return entry
  }
}
