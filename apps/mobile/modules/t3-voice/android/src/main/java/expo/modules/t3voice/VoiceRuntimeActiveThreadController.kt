package expo.modules.t3voice

import android.content.Context
import java.util.UUID

internal class VoiceRuntimeDeviceIdentityStore(context: Context) {
  private val preferences = context.getSharedPreferences("t3_voice_runtime_identity", Context.MODE_PRIVATE)

  @Synchronized
  fun getOrCreate(installedRuntimeId: String?): String {
    preferences.getString("runtime_id", null)?.let { return it }
    val runtimeId = installedRuntimeId ?: "android-${UUID.randomUUID()}"
    check(preferences.edit().putString("runtime_id", runtimeId).commit()) {
      "Could not persist voice runtime identity."
    }
    return runtimeId
  }
}

internal data class VoiceRuntimeInstalledAuthority(
  val runtimeId: String,
  val generation: Long,
  val targetDigest: String,
  val token: String,
  val expiresAtEpochMillis: Long,
)

internal sealed interface VoiceRuntimeThreadCommand {
  val commandId: String
  val identity: VoiceRuntimeIdentity
  val modeSessionId: String

  data class Start(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val turnClientOperationId: String,
    val submissionPolicy: String,
    val draftContext: VoiceRuntimeDraftContext?,
    val interruptionPolicy: String,
  ) : VoiceRuntimeThreadCommand

  data class Resume(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val turnClientOperationId: String,
  ) : VoiceRuntimeThreadCommand

  data class Finish(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val turnClientOperationId: String,
    val outcome: String,
    val draftContext: VoiceRuntimeDraftContext?,
  ) : VoiceRuntimeThreadCommand

  data class Cancel(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val turnClientOperationId: String,
  ) : VoiceRuntimeThreadCommand

  data class Stop(
    override val commandId: String,
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val policy: String,
  ) : VoiceRuntimeThreadCommand
}

internal data class VoiceRuntimeDraftContext(
  val environmentId: String,
  val projectId: String,
  val threadId: String,
  val composerRevision: String,
)

internal interface VoiceRuntimeThreadExecution {
  fun start(
    modeSessionId: String,
    turnClientOperationId: String,
    submissionPolicy: String,
    draftContext: VoiceRuntimeDraftContext?,
  ): Boolean
  fun finish(outcome: String, draftContext: VoiceRuntimeDraftContext?): Boolean
  fun cancel(): Boolean
  fun stop(policy: String): Boolean
  fun acknowledgeDraft(artifactId: String, outcome: String): Boolean
}

internal class VoiceRuntimeActiveThreadController(
  runtimeId: String,
  runtimeInstanceId: String,
  private val now: () -> Long,
  private val installedAuthority: () -> VoiceRuntimeInstalledAuthority?,
  private val execution: VoiceRuntimeThreadExecution,
  private val drafts: VoiceRuntimeDraftRepository = VoiceRuntimeMemoryDraftRepository(),
  private val retained: VoiceRuntimeJournalRepository = VoiceRuntimeMemoryJournalRepository(),
  private val realtimeTerminals: (Long) -> List<VoiceRuntimeRealtimeTerminalSummary> = { emptyList() },
  private val realtimeTerminalAcknowledgement:
    (VoiceRuntimeRetainedRecordKey.RealtimeTerminal) -> Boolean = { false },
  private val onJournalChanged: (VoiceRuntimeCursor) -> Unit = {},
  initialGeneration: Long? = null,
  journalCapacity: Int = 256,
  idempotencyCapacity: Int = 512,
  leaseDurationMillis: Long = 30_000,
) {
  private val initiallyInstalled = installedAuthority()
  private var identity = VoiceRuntimeIdentity(
    runtimeId,
    runtimeInstanceId,
    initialGeneration
      ?: (initiallyInstalled?.generation?.minus(1))?.coerceAtLeast(0)
      ?: 0,
  )
  private val journal = VoiceRuntimeJournal(
    VoiceRuntimeSnapshot(
      identity,
      0,
      VoiceRuntimeAvailability.LOCKED,
      null,
      VoiceRuntimeOperation.None,
      VoiceRuntimeMediaOwner.None,
      VoiceRuntimeReadiness.Disabled,
      null,
      null,
      null,
    ),
    journalCapacity,
    onJournalChanged,
  )
  private val consumers = VoiceRuntimeConsumerRegistry({ identity }, now, leaseDurationMillis) { election ->
    journal.append(
      kind = "presentation-election",
      occurredAtEpochMillis = election.changedAtEpochMillis,
      presentationElection = election,
    )
  }
  private val deliveryGate = VoiceRuntimeDeliveryGate(consumers, journal)
  private val presentationActions = VoiceRuntimePresentationActionStore(consumers, now)
  private val draftReaders = mutableMapOf<String, String>()
  private val authority = VoiceRuntimeAuthorityRegistry(
    runtimeId,
    runtimeInstanceId,
    now,
    initialGenerationFloor = identity.generation,
  )
  private val commands = VoiceRuntimeIdempotencyLedger<VoiceRuntimeCommandReceipt>(idempotencyCapacity)
  private var activeModeSessionId: String? = null
  private var activeTurnClientOperationId: String? = null

  @Synchronized
  fun snapshot(): VoiceRuntimeSnapshot = journal.snapshot

  @Synchronized
  fun validateAuthorityReplacement(
    reservation: VoiceRuntimeAuthorityReservation,
    target: VoiceRuntimeTarget.Thread,
  ) {
    if (targetDigest(target) != reservation.targetDigest) {
      throw VoiceRuntimeFenceException("Authority target digest does not match its target.")
    }
    if (reservation.identity.runtimeId != identity.runtimeId ||
      reservation.identity.runtimeInstanceId != identity.runtimeInstanceId ||
      reservation.expectedCurrentGeneration != identity.generation ||
      reservation.identity.generation != identity.generation + 1 ||
      reservation.issuedAtEpochMillis > now() ||
      reservation.expiresAtEpochMillis <= now()) {
      throw VoiceRuntimeFenceException("Authority replacement fence is stale.")
    }
    val replacingRealtime = journal.snapshot.operation is VoiceRuntimeOperation.Realtime
    if (!replacingRealtime && (journal.snapshot.operation != VoiceRuntimeOperation.None ||
      journal.snapshot.mediaOwner != VoiceRuntimeMediaOwner.None)) {
      throw VoiceRuntimeFenceException("Active voice work must stop before authority replacement.")
    }
  }

  @Synchronized
  fun refreshAuthority(reservation: VoiceRuntimeAuthorityReservation): VoiceRuntimeSnapshot {
    requireInstalledAuthority(reservation)
    authority.refresh(reservation)
    appendState("authority-refreshed") { it.copy(failureCode = null) }
    return journal.snapshot
  }

  @Synchronized
  fun configureAuthority(
    reservation: VoiceRuntimeAuthorityReservation,
    target: VoiceRuntimeTarget.Thread,
    fingerprint: String,
  ): VoiceRuntimeSnapshot {
    if (targetDigest(target) != reservation.targetDigest) {
      throw VoiceRuntimeFenceException("Authority target digest does not match its target.")
    }
    requireInstalledAuthority(reservation)
    val replacingStoppingRealtime =
      (journal.snapshot.operation as? VoiceRuntimeOperation.Realtime)?.phase ==
        VoiceRealtimePhase.STOPPING
    if (!replacingStoppingRealtime && (journal.snapshot.operation != VoiceRuntimeOperation.None ||
      journal.snapshot.mediaOwner != VoiceRuntimeMediaOwner.None)) {
      throw VoiceRuntimeFenceException("Active voice work must stop before authority replacement.")
    }
    val (_, replayed) = authority.configure(reservation, fingerprint)
    if (replayed) return journal.snapshot
    identity = reservation.identity
    drafts.rebind(identity, target, now())
    val recoveredActions = retained.actions(now()).filter(::actionMatchesCurrentIdentity)
    val reviewIds = recoveredActions.mapTo(mutableSetOf()) { it.actionId }
    val reconstructed = drafts.handles(now()).filter { it.identity == identity }.mapNotNull { handle ->
      val actionId = "review-${handle.artifactId}"
      if (actionId in reviewIds) null else VoiceRuntimePresentationAction.ReviewDraft(
        actionId, handle, handle.expiresAtEpochMillis,
      ).also(retained::publishAction)
    }
    presentationActions.replace(recoveredActions + reconstructed)
    appendState("authority-configured") {
      it.copy(
        identity = identity,
        availability = VoiceRuntimeAvailability.READY,
        target = target,
        operation = VoiceRuntimeOperation.None,
        mediaOwner = VoiceRuntimeMediaOwner.None,
        readiness = VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.THREAD),
        failureCode = null,
      )
    }
    return journal.snapshot
  }

  @Synchronized
  fun activateHandoffAuthority(
    reservation: VoiceRuntimeAuthorityReservation,
    target: VoiceRuntimeTarget.Thread,
    fingerprint: String,
    command: VoiceRuntimeThreadCommand.Start,
  ): VoiceRuntimeCommandReceipt {
    val priorAuthority = authority.checkpoint()
    val priorIdentity = identity
    val priorSnapshot = journal.snapshot
    val priorModeSessionId = activeModeSessionId
    val priorTurnClientOperationId = activeTurnClientOperationId
    return try {
      configureAuthority(reservation, target, fingerprint)
      dispatch(command).also { receipt ->
        if (!VoiceRuntimeHandoffActivationPolicy.accepted(receipt)) {
          throw VoiceRuntimeHandoffActivationRejected(receipt)
        }
      }
    } catch (cause: Throwable) {
      authority.restore(priorAuthority, reservation.provisioningOperationId)
      commands.forget(command.commandId)
      identity = priorIdentity
      activeModeSessionId = priorModeSessionId
      activeTurnClientOperationId = priorTurnClientOperationId
      journal.replaceSnapshot(priorSnapshot)
      presentationActions.replace(retained.actions(now()).filter(::actionMatchesCurrentIdentity))
      throw cause
    }
  }

  @Synchronized
  fun configureRealtimeAuthority(
    reservation: VoiceRuntimeAuthorityReservation,
    target: VoiceRuntimeTarget.Realtime,
    fingerprint: String,
  ): VoiceRuntimeSnapshot {
    if (targetDigest(target) != reservation.targetDigest) {
      throw VoiceRuntimeFenceException("Authority target digest does not match its target.")
    }
    requireInstalledAuthority(reservation)
    if (journal.snapshot.operation != VoiceRuntimeOperation.None ||
      journal.snapshot.mediaOwner != VoiceRuntimeMediaOwner.None) {
      throw VoiceRuntimeFenceException("Active voice work must stop before authority replacement.")
    }
    val (_, replayed) = authority.configure(reservation, fingerprint)
    if (replayed) return journal.snapshot
    identity = reservation.identity
    presentationActions.replace(retained.actions(now()))
    appendState("authority-configured") {
      it.copy(
        identity = identity,
        availability = VoiceRuntimeAvailability.READY,
        target = target,
        operation = VoiceRuntimeOperation.None,
        mediaOwner = VoiceRuntimeMediaOwner.None,
        readiness = VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.REALTIME),
        failureCode = null,
      )
    }
    return journal.snapshot
  }

  @Synchronized
  fun observeRealtime(checkpoint: VoiceRuntimeRealtimeCheckpoint?) {
    val target = journal.snapshot.target as? VoiceRuntimeTarget.Realtime ?: return
    if (checkpoint == null) {
      appendState("realtime-state") {
        it.copy(
          operation = VoiceRuntimeOperation.None,
          mediaOwner = VoiceRuntimeMediaOwner.None,
          readiness = VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.REALTIME),
        )
      }
      return
    }
    if (checkpoint.fence.identity != identity || checkpoint.target != target) return
    val media = when (checkpoint.phase) {
      VoiceRealtimePhase.CUEING -> VoiceRuntimeMediaOwner.Cue(checkpoint.fence.modeSessionId)
      VoiceRealtimePhase.NEGOTIATING,
      VoiceRealtimePhase.CONNECTED,
      VoiceRealtimePhase.DRAINING,
      VoiceRealtimePhase.STOPPING,
      -> VoiceRuntimeMediaOwner.RealtimePeer(checkpoint.fence.modeSessionId)
      else -> VoiceRuntimeMediaOwner.None
    }
    appendState("realtime-state") {
      it.copy(
        operation = VoiceRuntimeOperation.Realtime(
          checkpoint.fence.modeSessionId,
          checkpoint.phase,
          checkpoint.target.conversationId,
          checkpoint.serverSessionId,
          muted = checkpoint.muted,
        ),
        mediaOwner = media,
        readiness = VoiceRuntimeReadiness.Active(VoiceRuntimeMode.REALTIME),
        failureCode = if (checkpoint.phase == VoiceRealtimePhase.FAILED) "native-realtime-failed" else null,
      )
    }
  }

  @Synchronized
  fun publishRealtimePresentationAction(action: VoiceRuntimeRealtimeAction) {
    val projected = when (action) {
      is VoiceRuntimeRealtimeAction.NavigateThread -> VoiceRuntimePresentationAction.NavigateThread(
        action.actionId, action.projectId, action.threadId, action.expiresAtEpochMillis,
      )
      is VoiceRuntimeRealtimeAction.ConfirmationRequired ->
        VoiceRuntimePresentationAction.RealtimeConfirmationRequired(
        action.actionId,
        action.confirmationId,
        action.toolCallId,
        action.tool,
        action.summary,
        action.expiresAtEpochMillis,
      )
      else -> return
    }
    presentationActions.publish(projected)
    retained.publishAction(projected)
    journal.append(
      kind = "presentation-action",
      rootOperationId = (journal.snapshot.operation as? VoiceRuntimeOperation.Realtime)?.modeSessionId,
      occurredAtEpochMillis = now(),
      presentationAction = projected,
    )
  }

  @Synchronized
  fun publishRealtimeTerminal(summary: VoiceRuntimeRealtimeTerminalSummary): Boolean {
    if (summary.identity != identity) return false
    val operation = journal.snapshot.operation as? VoiceRuntimeOperation.Realtime ?: return false
    if (operation.modeSessionId != summary.modeSessionId ||
      operation.conversationId != summary.conversationId) return false
    journal.append(
      kind = "realtime-terminal",
      rootOperationId = summary.modeSessionId,
      occurredAtEpochMillis = summary.terminalAtEpochMillis,
      realtimeTerminalSummary = summary,
    )
    return true
  }

  @Synchronized
  fun clearAuthority(commandId: String, candidate: VoiceRuntimeIdentity): VoiceRuntimeSnapshot {
    requireFence(candidate.runtimeId, candidate.runtimeInstanceId, candidate.generation)
    if (journal.snapshot.operation != VoiceRuntimeOperation.None &&
      !runCatching { execution.stop("immediate") }.getOrDefault(false)) {
      throw VoiceRuntimeFenceException("Active voice work could not be stopped.")
    }
    authority.clear(candidate)
    activeModeSessionId = null
    activeTurnClientOperationId = null
    appendState("authority-cleared", commandId) {
      it.copy(
        availability = VoiceRuntimeAvailability.LOCKED,
        target = null,
        operation = VoiceRuntimeOperation.None,
        mediaOwner = VoiceRuntimeMediaOwner.None,
        readiness = VoiceRuntimeReadiness.Disabled,
        failureCode = null,
      )
    }
    return journal.snapshot
  }

  @Synchronized
  fun attach(presentation: VoiceRuntimePresentation): VoiceRuntimeConsumerLease =
    consumers.attach(presentation)

  @Synchronized
  fun updateAttachment(
    lease: VoiceRuntimeConsumerLease,
    presentation: VoiceRuntimePresentation,
  ): VoiceRuntimeConsumerLease = consumers.update(lease, presentation)

  @Synchronized
  fun detach(lease: VoiceRuntimeConsumerLease) = consumers.detach(lease)

  @Synchronized
  fun hasConsumers(): Boolean = consumers.count() > 0

  @Synchronized
  fun consumerCount(): Int = consumers.count()

  @Synchronized
  fun isIdle(): Boolean =
    journal.snapshot.operation == VoiceRuntimeOperation.None &&
      journal.snapshot.mediaOwner == VoiceRuntimeMediaOwner.None

  @Synchronized
  fun deliver(
    lease: VoiceRuntimeConsumerLease,
    after: VoiceRuntimeCursor?,
  ): VoiceRuntimeDelivery = when (val delivery = deliveryGate.deliver(lease, after)) {
    is VoiceRuntimeDelivery.Events -> delivery
    is VoiceRuntimeDelivery.Rebase -> delivery.copy(
      threadReceipts = retained.receipts(identity.runtimeId, identity.generation, now()),
      realtimeTerminalSummaries = retainedRealtimeTerminals(),
      draftArtifacts = drafts.handles(now()).filter { it.identity == identity },
      presentationActions = retained.actions(now()).filter(::actionMatchesCurrentIdentity),
    )
  }

  @Synchronized
  fun acknowledge(lease: VoiceRuntimeConsumerLease, through: VoiceRuntimeCursor) {
    consumers.requireLease(lease)
    requireFence(through.runtimeId, through.runtimeInstanceId, through.generation)
    if (through.sequence > journal.snapshot.sequence) {
      throw VoiceRuntimeFenceException("Cannot acknowledge an unpublished event.")
    }
  }

  @Synchronized
  fun publishDraft(handle: VoiceRuntimeDraftHandle, transcript: String) {
    require(handle.identity == identity)
    drafts.publish(VoiceRuntimeStoredDraft(handle, transcript))
    val action = VoiceRuntimePresentationAction.ReviewDraft(
      actionId = "review-${handle.artifactId}",
      artifact = handle,
      expiresAtEpochMillis = handle.expiresAtEpochMillis,
    )
    presentationActions.publish(action)
    retained.publishAction(action)
    journal.append(
      kind = "draft-artifact-ready",
      rootOperationId = handle.modeSessionId,
      occurredAtEpochMillis = now(),
      draftArtifact = handle,
    )
    journal.append(
      kind = "presentation-action",
      rootOperationId = handle.modeSessionId,
      occurredAtEpochMillis = now(),
      presentationAction = action,
    )
  }

  @Synchronized
  fun readDraft(lease: VoiceRuntimeConsumerLease, artifactId: String): VoiceRuntimeStoredDraft {
    val elected = consumers.requireElected(lease)
    var artifact = drafts.read(artifactId) ?: throw VoiceRuntimeExpiredException()
    if (artifact.handle.identity != identity) {
      val currentTarget = journal.snapshot.target as? VoiceRuntimeTarget.Thread
      val recoverable = currentTarget != null &&
        artifact.handle.identity.runtimeId == identity.runtimeId &&
        artifact.handle.identity.generation == identity.generation &&
        artifact.handle.target.environmentId == currentTarget.environmentId &&
        artifact.handle.target.projectId == currentTarget.projectId &&
        artifact.handle.target.threadId == currentTarget.threadId
      if (recoverable) {
        artifact = artifact.copy(handle = artifact.handle.copy(identity = identity))
        drafts.publish(artifact)
      } else {
        throw VoiceRuntimeFenceException("Draft artifact belongs to a different runtime fence.")
      }
    }
    if (artifact.handle.expiresAtEpochMillis <= now()) {
      drafts.remove(artifactId)
      throw VoiceRuntimeExpiredException()
    }
    val currentReader = draftReaders[artifactId]
    if (currentReader != null && currentReader != elected.leaseId && consumers.isElected(currentReader)) {
      throw VoiceRuntimeFenceException("Draft artifact already claimed.")
    }
    draftReaders[artifactId] = elected.leaseId
    return artifact
  }

  @Synchronized
  fun acknowledgeDraft(
    lease: VoiceRuntimeConsumerLease,
    artifactId: String,
    outcome: String,
  ) {
    require(outcome in setOf("appended", "discarded"))
    val elected = consumers.requireElected(lease)
    if (draftReaders[artifactId] != elected.leaseId) {
      throw VoiceRuntimeFenceException("Stale draft claim.")
    }
    if (!execution.acknowledgeDraft(artifactId, outcome)) {
      throw VoiceRuntimeFenceException("Draft acknowledgement could not be scheduled.")
    }
    if (outcome == "discarded") completeDraftAcknowledgement(artifactId)
  }

  @Synchronized
  fun completeDraftAcknowledgement(artifactId: String) {
    drafts.remove(artifactId)
    draftReaders.remove(artifactId)
    presentationActions.live().firstOrNull { it.actionId == "review-$artifactId" }?.let {
      // Completion is authoritative even if the original UI lease has expired.
      runCatching { presentationActions.remove(it.actionId) }
      retained.removeAction(it.actionId)
    }
  }

  @Synchronized
  fun publishThreadReceipt(receipt: VoiceRuntimeThreadReceipt) {
    require(receipt.identity.runtimeId == identity.runtimeId)
    retained.publishReceipt(receipt)
    journal.append(
      kind = "thread-receipt",
      rootOperationId = receipt.modeSessionId,
      occurredAtEpochMillis = now(),
      threadReceipt = receipt,
    )
  }

  @Synchronized
  fun acknowledgeRetainedRecord(
    candidate: VoiceRuntimeIdentity,
    key: VoiceRuntimeRetainedRecordKey,
  ) {
    requireFence(candidate.runtimeId, candidate.runtimeInstanceId, candidate.generation)
    if (key.identity.runtimeId != identity.runtimeId || key.identity.generation != identity.generation) {
      throw VoiceRuntimeFenceException("Retained record belongs to another authority generation.")
    }
    when (key) {
      is VoiceRuntimeRetainedRecordKey.ThreadReceipt -> retained.acknowledgeReceipt(key)
      is VoiceRuntimeRetainedRecordKey.RealtimeTerminal -> acknowledgeRealtimeTerminal(key)
    }
  }

  @Synchronized
  fun claimPresentationAction(
    lease: VoiceRuntimeConsumerLease,
    actionId: String,
  ): VoiceRuntimePresentationAction = presentationActions.claim(actionId, lease)

  @Synchronized
  fun acknowledgePresentationAction(
    lease: VoiceRuntimeConsumerLease,
    actionId: String,
  ) {
    presentationActions.acknowledge(actionId, lease)
    retained.removeAction(actionId)
  }

  @Synchronized
  fun dispatch(command: VoiceRuntimeThreadCommand): VoiceRuntimeCommandReceipt {
    val fingerprint = commandFingerprint(command)
    val (receipt, replayed) = commands.resolve(command.commandId, fingerprint) {
      admit(command)
    }
    return if (replayed) receipt.copy(replayed = true) else receipt
  }

  @Synchronized
  fun observeRuntime(snapshot: VoiceRuntimeExecutionSnapshot) {
    if (snapshot.runtimeId != identity.runtimeId || snapshot.readinessGeneration != identity.generation) {
      return
    }
    val target = journal.snapshot.target as? VoiceRuntimeTarget.Thread ?: return
    val operation = operationFrom(snapshot)
    val media = mediaFrom(snapshot)
    val readiness = if (operation is VoiceRuntimeOperation.ThreadTurn) {
      VoiceRuntimeReadiness.Active(VoiceRuntimeMode.THREAD)
    } else {
      VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.THREAD)
    }
    appendState("runtime-state") {
      it.copy(
        availability = VoiceRuntimeAvailability.READY,
        operation = operation,
        mediaOwner = media,
        readiness = readiness,
        failureCode = if (snapshot.phase == VoiceRuntimePhase.FAILED) {
          "native-thread-failed"
        } else null,
      )
    }
    if (operation == VoiceRuntimeOperation.None) {
      activeModeSessionId = null
      activeTurnClientOperationId = null
    }
  }

  private fun admit(command: VoiceRuntimeThreadCommand): VoiceRuntimeCommandReceipt {
    val stale = rebaseFor(command.identity)
    if (stale != null) return receipt(command, VoiceRuntimeCommandOutcome.RebaseRequired(stale))
    if (command is VoiceRuntimeThreadCommand.Start || command is VoiceRuntimeThreadCommand.Resume) {
      if (runCatching { authority.requireCurrent(command.identity.generation) }.isFailure ||
        !installedAuthorityMatchesCurrent()) {
        return receipt(command, VoiceRuntimeCommandOutcome.Rejected("authority-unavailable"))
      }
    }
    val accepted = when (command) {
      is VoiceRuntimeThreadCommand.Start -> {
        if (journal.snapshot.operation != VoiceRuntimeOperation.None) {
          if (command.interruptionPolicy == "drain-conflicting") {
            return receipt(command, VoiceRuntimeCommandOutcome.Rejected("unsupported-capability"))
          }
          if (command.interruptionPolicy != "stop-conflicting" ||
            !runCatching { execution.stop("immediate") }.getOrDefault(false) ||
            journal.snapshot.operation != VoiceRuntimeOperation.None) {
            return receipt(command, VoiceRuntimeCommandOutcome.Rejected("owner-conflict"))
          }
        }
        activeModeSessionId = command.modeSessionId
        activeTurnClientOperationId = command.turnClientOperationId
        val started = runCatching {
          execution.start(
            command.modeSessionId,
            command.turnClientOperationId,
            command.submissionPolicy,
            command.draftContext,
          )
        }
          .getOrDefault(false)
        if (!started) {
          activeModeSessionId = null
          activeTurnClientOperationId = null
          return receipt(command, VoiceRuntimeCommandOutcome.Rejected("invalid-phase"))
        }
        appendThreadPhase(command, VoiceThreadOrdinaryPhase.ARMING)
        true
      }
      is VoiceRuntimeThreadCommand.Resume -> {
        if (journal.snapshot.operation != VoiceRuntimeOperation.None) return receipt(
          command,
          VoiceRuntimeCommandOutcome.Rejected("owner-conflict"),
        )
        activeModeSessionId = command.modeSessionId
        activeTurnClientOperationId = command.turnClientOperationId
        val started = runCatching {
          execution.start(command.modeSessionId, command.turnClientOperationId, "auto-submit", null)
        }
          .getOrDefault(false)
        if (!started) {
          activeModeSessionId = null
          activeTurnClientOperationId = null
          return receipt(command, VoiceRuntimeCommandOutcome.Rejected("invalid-phase"))
        }
        appendThreadPhase(command, VoiceThreadOrdinaryPhase.ARMING)
        true
      }
      is VoiceRuntimeThreadCommand.Finish -> {
        if (!matchesActive(command)) return receipt(
          command,
          VoiceRuntimeCommandOutcome.Rejected("invalid-phase"),
        )
        val target = journal.snapshot.target as? VoiceRuntimeTarget.Thread
        if ((command.outcome == "finish-to-draft") != (command.draftContext != null) ||
          command.draftContext?.let {
            target == null || it.environmentId != target.environmentId ||
              it.projectId != target.projectId || it.threadId != target.threadId
          } == true) {
          return receipt(command, VoiceRuntimeCommandOutcome.Rejected("invalid-context"))
        }
        runCatching { execution.finish(command.outcome, command.draftContext) }.getOrDefault(false)
      }
      is VoiceRuntimeThreadCommand.Cancel -> {
        if (!matchesActive(command)) return receipt(
          command,
          VoiceRuntimeCommandOutcome.Rejected("invalid-phase"),
        )
        runCatching { execution.cancel() }.getOrDefault(false)
      }
      is VoiceRuntimeThreadCommand.Stop -> {
        if (activeModeSessionId != command.modeSessionId) return receipt(
          command,
          VoiceRuntimeCommandOutcome.Rejected("invalid-phase"),
        )
        runCatching { execution.stop(command.policy) }.getOrDefault(false)
      }
    }
    return if (accepted) receipt(command, VoiceRuntimeCommandOutcome.Accepted) else {
      receipt(command, VoiceRuntimeCommandOutcome.Rejected("invalid-phase"))
    }
  }

  private fun receipt(
    command: VoiceRuntimeThreadCommand,
    outcome: VoiceRuntimeCommandOutcome,
  ): VoiceRuntimeCommandReceipt {
    val nextCursor = journal.snapshot.cursor().copy(sequence = journal.snapshot.sequence + 1)
    val receipt = VoiceRuntimeCommandReceipt(
      command.commandId,
      command.modeSessionId,
      turnClientOperationId(command),
      false,
      outcome,
      nextCursor,
    )
    journal.append(
      kind = "command-outcome",
      rootOperationId = command.modeSessionId,
      causedByCommandId = command.commandId,
      occurredAtEpochMillis = now(),
      commandReceipt = receipt,
    )
    return receipt
  }

  private fun appendThreadPhase(
    command: VoiceRuntimeThreadCommand,
    phase: VoiceThreadOrdinaryPhase,
  ) = appendState("command-state", command.commandId) {
    it.copy(
      operation = VoiceRuntimeOperation.ThreadTurn(
        command.modeSessionId,
        VoiceThreadPhase.Ordinary(phase),
        turnClientOperationId(command),
        null,
      ),
      readiness = VoiceRuntimeReadiness.Active(VoiceRuntimeMode.THREAD),
      failureCode = null,
    )
  }

  private fun appendState(
    root: String,
    commandId: String? = null,
    transform: (VoiceRuntimeSnapshot) -> VoiceRuntimeSnapshot,
  ) {
    journal.append("state-changed", root, commandId, now(), transform = transform)
  }

  private fun requireInstalledAuthority(reservation: VoiceRuntimeAuthorityReservation) {
    val installed = installedAuthority() ?: throw VoiceRuntimeFenceException("Authority unavailable.")
    if (installed.runtimeId != reservation.identity.runtimeId ||
      installed.generation != reservation.identity.generation ||
      installed.targetDigest != reservation.targetDigest ||
      installed.token != reservationToken(reservation) ||
      installed.expiresAtEpochMillis != reservation.expiresAtEpochMillis ||
      installed.expiresAtEpochMillis <= now()) {
      throw VoiceRuntimeFenceException("Canonical authority does not match installed grant.")
    }
  }

  private fun installedAuthorityMatchesCurrent(): Boolean {
    val reservation = authority.current() ?: return false
    return runCatching { requireInstalledAuthority(reservation) }.isSuccess
  }

  private fun rebaseFor(candidate: VoiceRuntimeIdentity): VoiceRuntimeDelivery.Rebase? {
    if (candidate.runtimeId != identity.runtimeId || candidate.runtimeInstanceId != identity.runtimeInstanceId) {
      return (journal.read(candidate.toCursor()) as VoiceRuntimeDelivery.Rebase).copy(
        realtimeTerminalSummaries = retainedRealtimeTerminals(),
      )
    }
    if (candidate.generation != identity.generation) {
      return (journal.read(candidate.toCursor()) as VoiceRuntimeDelivery.Rebase).copy(
        realtimeTerminalSummaries = retainedRealtimeTerminals(),
      )
    }
    return null
  }

  private fun retainedRealtimeTerminals(): List<VoiceRuntimeRealtimeTerminalSummary> =
    realtimeTerminals(now())
      .filter {
        it.identity.runtimeId == identity.runtimeId && it.identity.generation == identity.generation
      }
      .sortedWith(compareBy({ it.terminalAtEpochMillis }, { it.modeSessionId }))

  private fun acknowledgeRealtimeTerminal(
    key: VoiceRuntimeRetainedRecordKey.RealtimeTerminal,
  ): Boolean = realtimeTerminalAcknowledgement(key)

  private fun actionMatchesCurrentIdentity(action: VoiceRuntimePresentationAction): Boolean =
    (action as? VoiceRuntimePresentationAction.ReviewDraft)?.artifact?.identity
      ?.let { it == identity } ?: true

  private fun requireFence(runtimeId: String, runtimeInstanceId: String, generation: Long) {
    if (runtimeId != identity.runtimeId || runtimeInstanceId != identity.runtimeInstanceId ||
      generation != identity.generation) throw VoiceRuntimeFenceException("Runtime fence is stale.")
  }

  private fun VoiceRuntimeIdentity.toCursor() =
    VoiceRuntimeCursor(runtimeId, runtimeInstanceId, generation, 0)

  private fun matchesActive(command: VoiceRuntimeThreadCommand): Boolean =
    activeModeSessionId == command.modeSessionId &&
      activeTurnClientOperationId == turnClientOperationId(command)

  private fun operationFrom(snapshot: VoiceRuntimeExecutionSnapshot): VoiceRuntimeOperation {
    if (snapshot.mode != VoiceRuntimeExecutionMode.THREAD ||
      snapshot.phase in setOf(VoiceRuntimePhase.IDLE, VoiceRuntimePhase.LOCKED)) {
      return VoiceRuntimeOperation.None
    }
    val mode = activeModeSessionId ?: return VoiceRuntimeOperation.None
    val phase = when (snapshot.phase) {
      VoiceRuntimePhase.RECORDING -> VoiceThreadOrdinaryPhase.RECORDING
      VoiceRuntimePhase.FINALIZED -> VoiceThreadOrdinaryPhase.FINALIZING
      VoiceRuntimePhase.UPLOADING -> VoiceThreadOrdinaryPhase.UPLOADING
      VoiceRuntimePhase.TRANSCRIBING -> VoiceThreadOrdinaryPhase.TRANSCRIBING
      VoiceRuntimePhase.WAITING -> VoiceThreadOrdinaryPhase.WAITING
      VoiceRuntimePhase.PLAYING -> VoiceThreadOrdinaryPhase.PLAYING
      VoiceRuntimePhase.PLAYBACK_DRAINED -> VoiceThreadOrdinaryPhase.PLAYBACK_DRAINED
      VoiceRuntimePhase.REARMING -> VoiceThreadOrdinaryPhase.REARMING
      VoiceRuntimePhase.FAILED -> VoiceThreadOrdinaryPhase.FAILED
      VoiceRuntimePhase.ATTENTION_REQUIRED -> return VoiceRuntimeOperation.ThreadTurn(
        mode,
        VoiceThreadPhase.AttentionRequired(
          VoiceThreadPhase.AttentionRequired.Reason.USER_INPUT,
        ),
        activeTurnClientOperationId,
        snapshot.operationId,
      )
      else -> VoiceThreadOrdinaryPhase.ARMING
    }
    return VoiceRuntimeOperation.ThreadTurn(
      mode,
      VoiceThreadPhase.Ordinary(phase),
      activeTurnClientOperationId,
      snapshot.operationId,
    )
  }

  private fun mediaFrom(snapshot: VoiceRuntimeExecutionSnapshot): VoiceRuntimeMediaOwner =
    when (snapshot.phase) {
      VoiceRuntimePhase.RECORDING -> VoiceRuntimeMediaOwner.Recorder(
        "thread-mode",
        snapshot.operationId ?: "pending",
      )
      VoiceRuntimePhase.PLAYING -> VoiceRuntimeMediaOwner.Player(
        "thread-mode",
        snapshot.operationId ?: "pending",
      )
      else -> VoiceRuntimeMediaOwner.None
    }

  private fun commandFingerprint(command: VoiceRuntimeThreadCommand): String = command.toString()

  private fun turnClientOperationId(command: VoiceRuntimeThreadCommand): String? = when (command) {
    is VoiceRuntimeThreadCommand.Start -> command.turnClientOperationId
    is VoiceRuntimeThreadCommand.Resume -> command.turnClientOperationId
    is VoiceRuntimeThreadCommand.Finish -> command.turnClientOperationId
    is VoiceRuntimeThreadCommand.Cancel -> command.turnClientOperationId
    is VoiceRuntimeThreadCommand.Stop -> null
  }

  private fun reservationToken(reservation: VoiceRuntimeAuthorityReservation): String =
    reservation.token

  internal fun targetDigest(target: VoiceRuntimeTarget.Thread): String {
    return T3VoiceRuntimeTargetIdentity.digest(VoiceRuntimeBridge.canonicalThreadTargetIdentity(target))
  }

  internal fun targetDigest(target: VoiceRuntimeTarget.Realtime): String =
    T3VoiceRuntimeTargetIdentity.digest(VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target))

}
