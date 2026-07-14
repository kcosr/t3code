package expo.modules.t3voice

internal class VoiceRuntimeJournal(
  initialSnapshot: VoiceRuntimeSnapshot,
  private val capacity: Int,
  private val onChanged: (VoiceRuntimeCursor) -> Unit = {},
) {
  init { require(capacity > 0) }

  private val events = ArrayDeque<VoiceRuntimeEvent>()
  var snapshot: VoiceRuntimeSnapshot = initialSnapshot
    private set

  fun replaceSnapshot(next: VoiceRuntimeSnapshot) {
    snapshot = next
    events.clear()
    onChanged(snapshot.cursor())
  }

  fun append(
    kind: String,
    rootOperationId: String? = null,
    causedByCommandId: String? = null,
    occurredAtEpochMillis: Long = 0,
    commandReceipt: VoiceRuntimeCommandReceipt? = null,
    threadReceipt: VoiceRuntimeThreadReceipt? = null,
    realtimeTerminalSummary: VoiceRuntimeRealtimeTerminalSummary? = null,
    draftArtifact: VoiceRuntimeDraftHandle? = null,
    presentationAction: VoiceRuntimePresentationAction? = null,
    presentationElection: VoiceRuntimePresentationElection? = null,
    transform: (VoiceRuntimeSnapshot) -> VoiceRuntimeSnapshot = { it },
  ): VoiceRuntimeEvent {
    val nextSequence = snapshot.sequence + 1
    snapshot = transform(snapshot).copy(sequence = nextSequence)
    val event = VoiceRuntimeEvent(
      snapshot.cursor(),
      kind,
      rootOperationId,
      causedByCommandId,
      occurredAtEpochMillis,
      snapshot = if (kind == "state-changed") snapshot else null,
      commandReceipt = commandReceipt,
      threadReceipt = threadReceipt,
      realtimeTerminalSummary = realtimeTerminalSummary,
      draftArtifact = draftArtifact,
      presentationAction = presentationAction,
      presentationElection = presentationElection,
    )
    events.addLast(event)
    while (events.size > capacity) events.removeFirst()
    onChanged(snapshot.cursor())
    return event
  }

  fun read(after: VoiceRuntimeCursor?): VoiceRuntimeDelivery {
    if (after == null) return rebase(VoiceRuntimeRebaseReason.CURSOR_TOO_OLD)
    val identity = snapshot.identity
    if (after.runtimeId != identity.runtimeId || after.runtimeInstanceId != identity.runtimeInstanceId) {
      return rebase(VoiceRuntimeRebaseReason.RUNTIME_REPLACED)
    }
    if (after.generation != identity.generation) {
      return rebase(VoiceRuntimeRebaseReason.GENERATION_CHANGED)
    }
    if (after.sequence > snapshot.sequence) return rebase(VoiceRuntimeRebaseReason.CURSOR_TOO_OLD)
    val firstRetained = events.firstOrNull()?.cursor?.sequence ?: (snapshot.sequence + 1)
    if (after.sequence < firstRetained - 1) return rebase(VoiceRuntimeRebaseReason.CURSOR_TOO_OLD)
    return VoiceRuntimeDelivery.Events(events.filter { it.cursor.sequence > after.sequence })
  }

  private fun rebase(reason: VoiceRuntimeRebaseReason) =
    VoiceRuntimeDelivery.Rebase(reason, snapshot.cursor(), snapshot)
}

internal data class VoiceRuntimeStoredOutcome<T>(val fingerprint: String, val value: T)

internal class VoiceRuntimeIdempotencyLedger<T>(private val capacity: Int) {
  init { require(capacity > 0) }

  private val outcomes = linkedMapOf<String, VoiceRuntimeStoredOutcome<T>>()

  fun resolve(id: String, fingerprint: String, create: () -> T): Pair<T, Boolean> {
    val existing = outcomes[id]
    if (existing != null) {
      if (existing.fingerprint != fingerprint) throw VoiceRuntimeIdempotencyConflictException()
      return existing.value to true
    }
    return create().also {
      outcomes[id] = VoiceRuntimeStoredOutcome(fingerprint, it)
      while (outcomes.size > capacity) outcomes.remove(outcomes.keys.first())
    } to false
  }

  fun forget(id: String) {
    outcomes.remove(id)
  }
}

internal class VoiceRuntimeDeliveryGate(
  private val consumers: VoiceRuntimeConsumerRegistry,
  private val journal: VoiceRuntimeJournal,
) {
  fun deliver(
    lease: VoiceRuntimeConsumerLease,
    after: VoiceRuntimeCursor?,
  ): VoiceRuntimeDelivery {
    val current = consumers.requireLease(lease)
    if (current.identity != journal.snapshot.identity) {
      throw VoiceRuntimeFenceException("Consumer and journal identities differ.")
    }
    return journal.read(after)
  }
}
