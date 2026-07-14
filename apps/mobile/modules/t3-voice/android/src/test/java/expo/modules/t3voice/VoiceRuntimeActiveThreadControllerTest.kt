package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeActiveThreadControllerTest {
  private var now = 1_000L
  private var installed: VoiceRuntimeInstalledAuthority? = null
  private val execution = FakeExecution()
  private val controller = VoiceRuntimeActiveThreadController(
    "runtime",
    "instance",
    { now },
    { installed },
    execution,
  )

  @Test
  fun exactAuthorityStartsNativeThreadAndProjectsRuntimeState() {
    configure()
    val receipt = controller.dispatch(start())

    assertTrue(receipt.outcome is VoiceRuntimeCommandOutcome.Accepted)
    assertEquals("turn-client", execution.started)
    assertTrue(controller.snapshot().operation is VoiceRuntimeOperation.ThreadTurn)

    controller.observeRuntime(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime",
        readinessGeneration = 1,
        mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.RECORDING,
        operationId = "turn-operation",
        operationGeneration = 1,
        recordingId = "recording",
      ),
    )
    val operation = controller.snapshot().operation as VoiceRuntimeOperation.ThreadTurn
    assertEquals("turn-operation", operation.turnOperationId)
    assertEquals(VoiceRuntimeMediaOwner.Recorder("thread-mode", "turn-operation"), controller.snapshot().mediaOwner)

    controller.observeRuntime(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime",
        readinessGeneration = 1,
        mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.IDLE,
      ),
    )
    assertEquals(VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.THREAD), controller.snapshot().readiness)
  }

  @Test
  fun rejectedAndThrowingStartsLeaveNoPhantomOwner() {
    configure()
    execution.startResult = false
    val rejected = controller.dispatch(start(commandId = "rejected"))
    assertTrue(rejected.outcome is VoiceRuntimeCommandOutcome.Rejected)
    assertEquals(VoiceRuntimeOperation.None, controller.snapshot().operation)

    execution.throwOnStart = true
    val thrown = controller.dispatch(start(commandId = "thrown"))
    assertTrue(thrown.outcome is VoiceRuntimeCommandOutcome.Rejected)
    assertEquals(VoiceRuntimeOperation.None, controller.snapshot().operation)
  }

  @Test
  fun rejectedHandoffStartRollsBackAuthorityAndCanBeRetried() {
    val source = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val sourceDigest = controller.targetDigest(source)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, sourceDigest, "token", 5_000)
    val sourceReservation = reservation(sourceDigest)
    controller.configureRealtimeAuthority(sourceReservation, source, "source")
    controller.observeRealtime(
      VoiceRuntimeRealtimeCheckpoint(
        VoiceRuntimeRealtimeFence(sourceReservation.identity, "realtime-mode"),
        source,
        "start-realtime",
        VoiceRealtimePhase.STOPPING,
        "session",
        1,
        VoiceRuntimeRealtimeControlGrant("control", 5_000, 15, 45),
      ),
    )
    val before = controller.snapshot()
    val target = target()
    val targetDigest = controller.targetDigest(target)
    val targetReservation = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity("runtime", "instance", 2),
      "handoff",
      1,
      targetDigest,
      "transition-token",
      1_000,
      5_000,
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 2, targetDigest, "transition-token", 5_000)
    val command = VoiceRuntimeThreadCommand.Start(
      "handoff-start", targetReservation.identity, "thread-mode", "handoff-turn",
      "auto-submit", null, "stop-conflicting",
    )
    execution.startResult = false

    expectThrows<VoiceRuntimeHandoffActivationRejected> {
      controller.activateHandoffAuthority(targetReservation, target, "handoff", command)
    }
    assertEquals(before, controller.snapshot())

    execution.startResult = true
    val accepted = controller.activateHandoffAuthority(targetReservation, target, "handoff", command)
    assertTrue(VoiceRuntimeHandoffActivationPolicy.accepted(accepted))
    assertEquals(2L, controller.snapshot().identity.generation)
  }

  @Test
  fun cleanupCommandSurvivesParentAuthorityExpiry() {
    configure()
    controller.dispatch(start())
    now = 5_001
    val finish = controller.dispatch(
      VoiceRuntimeThreadCommand.Finish(
        "finish",
        VoiceRuntimeIdentity("runtime", "instance", 1),
        "mode",
        "turn-client",
        "finish-and-submit",
        null,
      ),
    )
    assertTrue(finish.outcome is VoiceRuntimeCommandOutcome.Accepted)
    assertEquals(1, execution.finished)
  }

  @Test
  fun autoSubmitRecordingCanFinishToExactTargetDraftWithoutDispatch() {
    configure()
    controller.dispatch(start())
    val context = VoiceRuntimeDraftContext("environment", "project", "thread", "revision")

    val finish = controller.dispatch(
      VoiceRuntimeThreadCommand.Finish(
        "finish-draft", VoiceRuntimeIdentity("runtime", "instance", 1), "mode", "turn-client",
        "finish-to-draft", context,
      ),
    )

    assertTrue(finish.outcome is VoiceRuntimeCommandOutcome.Accepted)
    assertEquals("finish-to-draft", execution.lastFinishOutcome)
    assertEquals(context, execution.lastDraftContext)
  }

  @Test
  fun authorityRejectsMismatchedCanonicalTargetDigest() {
    val target = target()
    val digest = controller.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    expectThrows<VoiceRuntimeFenceException> {
      controller.configureAuthority(reservation("0".repeat(64)), target, "fingerprint")
    }
  }

  @Test
  fun canonicallyProvisionedThreadGrantConfiguresAuthority() {
    val target = target()
    val targetIdentity = VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)
    val grant = T3VoiceRuntimeGrant(
      T3VoiceRuntimeGrantMetadata(
        "runtime", 1, "https://example.test",
        T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
        T3VoiceRuntimeTargetIdentity.digest(targetIdentity),
        5_000,
      ),
      "token",
    )
    installed = VoiceRuntimeInstalledAuthority(
      grant.metadata.runtimeId,
      grant.metadata.readinessGeneration,
      grant.metadata.targetIdentityDigest,
      grant.token,
      grant.metadata.expiresAtEpochMillis,
    )

    val snapshot = controller.configureAuthority(
      reservation(grant.metadata.targetIdentityDigest),
      target,
      "provisioned-thread-grant",
    )

    assertEquals(target, snapshot.target)
    assertEquals(VoiceRuntimeAvailability.READY, snapshot.availability)
  }

  @Test
  fun bridgeStrictlyRejectsUnknownPoliciesAndPreservesDraftContext() {
    val input = mutableMapOf<String, Any?>(
      "kind" to "start-thread-mode",
      "commandId" to "command",
      "runtimeId" to "runtime",
      "runtimeInstanceId" to "instance",
      "authorityGeneration" to 1,
      "modeSessionId" to "mode",
      "turnClientOperationId" to "turn-client",
      "submissionPolicy" to "draft",
      "draftContext" to mapOf(
        "environmentId" to "environment",
        "projectId" to "project",
        "threadId" to "thread",
        "composerRevision" to "revision",
      ),
      "interruptionPolicy" to "reject",
    )
    val parsed = (VoiceRuntimeBridge.parseCommand(input) as VoiceRuntimeNativeCommand.Thread)
      .command as VoiceRuntimeThreadCommand.Start
    assertEquals("revision", parsed.draftContext?.composerRevision)
    input["interruptionPolicy"] = "unknown"
    expectThrows<IllegalArgumentException> { VoiceRuntimeBridge.parseCommand(input) }
  }

  @Test
  fun rebaseContainsDurableReceiptsDraftsAndActionsAndJournalEmitsWakeCursor() {
    val drafts = VoiceRuntimeMemoryDraftRepository()
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val wakes = mutableListOf<VoiceRuntimeCursor>()
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      drafts = drafts, retained = retained, onJournalChanged = wakes::add,
    )
    val target = target()
    val digest = local.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureAuthority(reservation(digest), target, "fingerprint")
    val handle = VoiceRuntimeDraftHandle(
      "artifact", VoiceRuntimeIdentity("runtime", "instance", 1), "mode", "turn-client",
      VoiceRuntimeDraftContext("environment", "project", "thread", "revision"), 5_000,
    )
    local.publishDraft(handle, "draft")
    val receipt = VoiceRuntimeThreadReceipt(
      VoiceRuntimeIdentity("runtime", "instance", 1), "mode", "turn-client", "operation",
      "environment", "project", "thread", null, null, emptyList(), "speech", null, null,
      null, emptyList(), null, null, 1_000, 5_000,
    )
    local.publishThreadReceipt(receipt)
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val rebase = local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase

    assertEquals(listOf(receipt), rebase.threadReceipts)
    assertEquals(listOf(handle), rebase.draftArtifacts)
    assertEquals("review-artifact", rebase.presentationActions.single().actionId)
    assertEquals(local.snapshot().cursor(), wakes.last())
    local.acknowledgeRetainedRecord(
      VoiceRuntimeIdentity("runtime", "instance", 1),
      VoiceRuntimeRetainedRecordKey.ThreadReceipt(
        receipt.identity, receipt.modeSessionId, receipt.turnClientOperationId,
      ),
    )
    assertTrue(retained.receipts(
      VoiceRuntimeIdentity("runtime", "instance", 1), "environment", now,
    ).isEmpty())
  }

  @Test
  fun canonicalInstallCheckpointRestoresAuthorityIdentityJournalClaimsAndRetentionExactly() {
    val drafts = VoiceRuntimeMemoryDraftRepository()
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      drafts = drafts, retained = retained,
    )
    val target = target()
    val digest = local.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureAuthority(reservation(digest), target, "generation-1")
    val handle = VoiceRuntimeDraftHandle(
      "artifact", VoiceRuntimeIdentity("runtime", "instance", 1), "mode", "turn-client",
      VoiceRuntimeDraftContext("environment", "project", "thread", "revision"), 5_000,
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, local.publishDraft(handle, "draft"))
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    local.claimPresentationAction(lease, "review-artifact")
    val checkpoint = local.checkpointCanonicalInstall()

    val replacement = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity("runtime", "instance", 2),
      "provision-2",
      1,
      digest,
      "token-2",
      1_000,
      5_000,
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 2, digest, "token-2", 5_000)
    local.configureAuthority(replacement, target, "generation-2")

    assertTrue(local.restoreCanonicalInstall(checkpoint, replacement.provisioningOperationId))
    assertEquals(checkpoint, local.checkpointCanonicalInstall())
    local.configureAuthority(replacement, target, "generation-2")
    assertEquals(2L, local.snapshot().identity.generation)
  }

  @Test
  fun canonicalInstallCheckpointRestoresActiveThreadIdentifiers() {
    configure()
    controller.dispatch(start())
    val checkpoint = controller.checkpointCanonicalInstall()
    controller.observeRuntime(VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime",
      readinessGeneration = 1,
      mode = VoiceRuntimeExecutionMode.THREAD,
      phase = VoiceRuntimePhase.IDLE,
    ))

    assertTrue(controller.restoreCanonicalInstall(checkpoint, "unused-provisioning"))
    assertEquals(checkpoint, controller.checkpointCanonicalInstall())
  }

  @Test
  fun canonicalInstallRollbackRestoresMemoryAndAuthorityWhenBothDurableRestoresFail() {
    val draftDelegate = VoiceRuntimeMemoryDraftRepository()
    var draftRestoreAttempted = false
    val failingDrafts = object : VoiceRuntimeDraftRepository by draftDelegate {
      override fun restore(checkpoint: List<VoiceRuntimeStoredDraft>): Boolean {
        draftRestoreAttempted = true
        return false
      }
    }
    val retentionDelegate = VoiceRuntimeMemoryJournalRepository()
    var retentionRestoreAttempted = false
    val failingRetention = object : VoiceRuntimeJournalRepository by retentionDelegate {
      override fun restore(checkpoint: VoiceRuntimeRetentionCheckpoint): Boolean {
        retentionRestoreAttempted = true
        return false
      }
    }
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      drafts = failingDrafts, retained = failingRetention,
    )
    val target = target()
    val digest = local.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureAuthority(reservation(digest), target, "generation-1")
    local.dispatch(start())
    val checkpoint = local.checkpointCanonicalInstall()
    local.observeRuntime(VoiceRuntimeExecutionSnapshot(
      runtimeId = "runtime",
      readinessGeneration = 1,
      mode = VoiceRuntimeExecutionMode.THREAD,
      phase = VoiceRuntimePhase.IDLE,
    ))

    assertFalse(local.restoreCanonicalInstall(checkpoint, "failed-provisioning"))
    assertTrue(draftRestoreAttempted)
    assertTrue(retentionRestoreAttempted)
    assertEquals(checkpoint.snapshot, local.snapshot())
    local.refreshAuthority(reservation(digest))
    assertEquals(checkpoint.identity, local.snapshot().identity)
  }

  @Test
  fun localRetentionAttentionIsTypedAndRestoresThePriorThreadPhase() {
    configure()
    controller.dispatch(start())
    val before = (controller.snapshot().operation as VoiceRuntimeOperation.ThreadTurn).phase

    assertTrue(controller.publishLocalRetentionStatus(
      "mode", "turn-client", VoiceRuntimeRetentionAdmission.FULL,
    ))
    val blocked = controller.snapshot().operation as VoiceRuntimeOperation.ThreadTurn
    assertEquals(
      VoiceThreadPhase.AttentionRequired(VoiceThreadPhase.AttentionRequired.Reason.LOCAL_RETENTION),
      blocked.phase,
    )
    @Suppress("UNCHECKED_CAST")
    val operationBody = VoiceRuntimeBridge.snapshotBody(controller.snapshot())["operation"]
      as Map<String, Any?>
    @Suppress("UNCHECKED_CAST")
    val phaseBody = operationBody["phase"] as Map<String, String>
    assertEquals("local-retention", phaseBody["reason"])

    assertTrue(controller.publishLocalRetentionStatus(
      "mode", "turn-client", VoiceRuntimeRetentionAdmission.AVAILABLE,
    ))
    assertEquals(
      before,
      (controller.snapshot().operation as VoiceRuntimeOperation.ThreadTurn).phase,
    )
  }

  @Test
  fun `full retention rejects publication without exposing a journal event`() {
    val retained = VoiceRuntimeMemoryJournalRepository(
      now = { now },
      receiptCapacity = 1,
      actionCapacity = 1,
    )
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution, retained = retained,
    )
    val target = target()
    val digest = local.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureAuthority(reservation(digest), target, "fingerprint")
    val firstReceipt = VoiceRuntimeThreadReceipt(
      VoiceRuntimeIdentity("runtime", "instance", 1), "mode-1", "turn-1", "operation-1",
      "environment", "project", "thread", null, null, emptyList(), null, null, null,
      null, emptyList(), null, null, 1_000, 5_000,
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, local.publishThreadReceipt(firstReceipt))
    val cursor = local.snapshot().cursor()
    val secondReceipt = firstReceipt.copy(modeSessionId = "mode-2", turnClientOperationId = "turn-2")

    assertEquals(VoiceRuntimeRetentionAdmission.FULL, local.receiptAdmission("mode-2", "turn-2"))
    assertEquals(VoiceRuntimeRetentionWriteResult.FULL, local.publishThreadReceipt(secondReceipt))
    assertEquals(cursor, local.snapshot().cursor())
  }

  @Test
  fun presentationElectionChangesAreDeliveredToExistingLeases() {
    configure()
    val first = controller.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val firstCursor = controller.snapshot().cursor()

    val second = controller.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val firstDelivery = controller.deliver(first, firstCursor) as VoiceRuntimeDelivery.Events
    val electedSecond = firstDelivery.events.single().presentationElection
    assertEquals("presentation-election", firstDelivery.events.single().kind)
    assertEquals(second.leaseId, electedSecond?.electedLeaseId)
    assertEquals(2, electedSecond?.eligibleConsumerCount)

    val secondCursor = controller.snapshot().cursor()
    val background = controller.updateAttachment(second, VoiceRuntimePresentation.BACKGROUND)
    val secondDelivery = controller.deliver(background, secondCursor) as VoiceRuntimeDelivery.Events
    val electedFirst = secondDelivery.events.single().presentationElection
    assertEquals(first.leaseId, electedFirst?.electedLeaseId)
    assertEquals(1, electedFirst?.eligibleConsumerCount)

    @Suppress("UNCHECKED_CAST")
    val eventBody = (VoiceRuntimeBridge.deliveryBody(secondDelivery)["events"]
      as List<Map<String, Any?>>).single()
    @Suppress("UNCHECKED_CAST")
    val electionBody = eventBody["election"] as Map<String, Any?>
    assertEquals(first.leaseId, electionBody["electedLeaseId"])
    assertEquals(1.0, electionBody["eligibleConsumerCount"])
  }

  @Test
  fun processDeathRealtimeTerminalRebasesToNewInstanceWithOriginalIdentityUntilAcknowledged() {
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val currentIdentity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val previousIdentity = currentIdentity.copy(runtimeInstanceId = "previous-process")
    val repository = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    val recovered = realtimeSummary(previousIdentity, "recovered-mode")
    repository.publishTerminal(recovered)
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      realtimeTerminals = repository::terminals,
      realtimeTerminalAcknowledgement = repository::acknowledgeTerminal,
    )
    val digest = local.targetDigest(realtimeTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureRealtimeAuthority(reservation(digest), realtimeTarget, "realtime-fingerprint")
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val rebase = local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase

    assertEquals(listOf(recovered), rebase.realtimeTerminalSummaries)
    assertEquals(previousIdentity, rebase.realtimeTerminalSummaries.single().identity)
    local.acknowledgeRetainedRecord(
      currentIdentity,
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(previousIdentity, "recovered-mode"),
    )
    assertTrue(repository.terminals(now).isEmpty())
    expectThrows<VoiceRuntimeFenceException> {
      local.acknowledgeRetainedRecord(
        currentIdentity.copy(generation = 2),
        VoiceRuntimeRetainedRecordKey.RealtimeTerminal(previousIdentity, "recovered-mode"),
      )
    }

    local.observeRealtime(
      VoiceRuntimeRealtimeCheckpoint(
        VoiceRuntimeRealtimeFence(currentIdentity, "live-mode"),
        realtimeTarget,
        "start-command",
        VoiceRealtimePhase.CONNECTED,
        serverSessionId = "session",
        leaseGeneration = 1,
        controlGrant = VoiceRuntimeRealtimeControlGrant("control-token", 5_000, 15, 30),
        lastConnectedAtEpochMillis = now,
      ),
    )
    val cursorBeforeTerminal = local.snapshot().cursor()
    assertFalse(local.publishRealtimeTerminal(realtimeSummary(
      currentIdentity.copy(generation = 2), "live-mode",
    )))
    val live = realtimeSummary(currentIdentity, "live-mode")
    repository.publishTerminal(live)
    assertTrue(local.publishRealtimeTerminal(live))
    val events = local.deliver(lease, cursorBeforeTerminal) as VoiceRuntimeDelivery.Events
    assertEquals(1, events.events.size)
    assertEquals(live, events.events.single().realtimeTerminalSummary)
    @Suppress("UNCHECKED_CAST")
    val eventBody = (VoiceRuntimeBridge.deliveryBody(events)["events"] as List<Map<String, Any?>>)
      .single()
    @Suppress("UNCHECKED_CAST")
    val summaryBody = eventBody["summary"] as Map<String, Any?>
    assertEquals("realtime-terminal", eventBody["kind"])
    assertEquals("stopped", summaryBody["outcome"])
    assertEquals("user-stop", summaryBody["reason"])
    assertFalse(eventBody.toString().contains("control-token"))
  }

  @Test
  fun sameGenerationRealtimeTerminalSurvivesNullStateOrderingAndProjectsIntoEventReadsOnce() {
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val identity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val repository = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      realtimeTerminals = repository::terminals,
      realtimeTerminalAcknowledgement = repository::acknowledgeTerminal,
    )
    val digest = local.targetDigest(realtimeTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureRealtimeAuthority(reservation(digest), realtimeTarget, "realtime")
    local.observeRealtime(VoiceRuntimeRealtimeCheckpoint(
      VoiceRuntimeRealtimeFence(identity, "mode"),
      realtimeTarget,
      "start",
      VoiceRealtimePhase.CONNECTED,
      "session",
      1,
      VoiceRuntimeRealtimeControlGrant("control", 5_000, 15, 30),
    ))
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val beforeTerminal = local.snapshot().cursor()
    local.observeRealtime(null)
    val terminal = realtimeSummary(identity, "mode")
    repository.publishTerminal(terminal)

    val delivery = local.deliver(lease, beforeTerminal) as VoiceRuntimeDelivery.Events
    assertEquals(terminal, delivery.events.single { it.kind == "realtime-terminal" }.realtimeTerminalSummary)
    assertTrue(local.publishRealtimeTerminal(terminal))
    val beforeUpdate = local.snapshot().cursor()
    val updatedTerminal = terminal.copy(serverCleanupPending = true, expiresAtEpochMillis = 20_000)
    repository.publishTerminal(updatedTerminal)
    assertTrue(local.publishRealtimeTerminal(updatedTerminal))
    val updatedDelivery = local.deliver(lease, beforeUpdate) as VoiceRuntimeDelivery.Events
    assertEquals(
      updatedTerminal,
      updatedDelivery.events.single { it.kind == "realtime-terminal" }.realtimeTerminalSummary,
    )
    val afterProjection = local.deliver(lease, local.snapshot().cursor()) as VoiceRuntimeDelivery.Events
    assertTrue(afterProjection.events.isEmpty())

    local.acknowledgeRetainedRecord(
      identity,
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(identity, "mode"),
    )
    assertTrue(repository.terminals(now).isEmpty())
    val replayAfterAcknowledgement =
      local.deliver(lease, beforeTerminal) as VoiceRuntimeDelivery.Events
    assertTrue(replayAfterAcknowledgement.events.none { it.realtimeTerminalSummary != null })
  }

  @Test
  fun processRestorationSurfacesOnlyExactRecoveredRealtimePresentationContext() {
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val oldIdentity = VoiceRuntimeIdentity("runtime", "old-instance", 1)
    val oldController = VoiceRuntimeActiveThreadController(
      "runtime", "old-instance", { now }, { installed }, execution, retained = retained,
    )
    val digest = oldController.targetDigest(realtimeTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    oldController.configureRealtimeAuthority(
      VoiceRuntimeAuthorityReservation(
        oldIdentity, "old-provision", 0, digest, "token", 1_000, 5_000,
      ),
      realtimeTarget,
      "old-process",
    )
    val navigateAction = VoiceRuntimeRealtimeAction.NavigateThread(
      1, now, "navigate", "project", "thread", 5_000,
    )
    val recoveredCheckpoint = VoiceRuntimeRealtimeCheckpoint(
      VoiceRuntimeRealtimeFence(oldIdentity, "mode"),
      realtimeTarget,
      "start",
      VoiceRealtimePhase.CONNECTED,
      "session",
      1,
      VoiceRuntimeRealtimeControlGrant("control", 5_000, 15, 30),
      pendingAction = navigateAction,
    )
    oldController.observeRealtime(recoveredCheckpoint)
    val oldFence = VoiceRuntimeRealtimeFence(oldIdentity, "mode")
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, oldController.publishRealtimePresentationAction(
      oldFence,
      navigateAction,
    ))
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, oldController.publishRealtimePresentationAction(
      oldFence,
      VoiceRuntimeRealtimeAction.ConfirmationRequired(
        2, now, "confirm", "confirmation", "tool-call", "send_message", "Send", 5_000,
      ),
    ))
    assertEquals(
      VoiceRuntimeRetentionWriteResult.INSERTED,
      retained.publishAction(VoiceRuntimeRetainedPresentationAction(
        oldIdentity,
        "unrelated-mode",
        VoiceRuntimePresentationAction.NavigateThread(
          "unrelated", "other-project", "other-thread", 5_000,
        ),
      )),
    )

    val newIdentity = VoiceRuntimeIdentity("runtime", "new-instance", 1)
    val restored = VoiceRuntimeActiveThreadController(
      "runtime", "new-instance", { now }, { installed }, execution, retained = retained,
    )
    restored.configureRealtimeAuthority(
      VoiceRuntimeAuthorityReservation(
        newIdentity, "new-provision", 0, digest, "token", 1_000, 5_000,
      ),
      realtimeTarget,
      "new-process",
    )
    val lease = restored.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    assertTrue(
      (restored.deliver(lease, null) as VoiceRuntimeDelivery.Rebase).presentationActions.isEmpty(),
    )
    assertEquals(setOf(oldIdentity), retained.actions(now).map { it.identity }.toSet())

    assertTrue(restored.recoverRealtimePresentationContext(recoveredCheckpoint))
    val rebase = restored.deliver(lease, null) as VoiceRuntimeDelivery.Rebase
    assertEquals(setOf("navigate", "confirm"), rebase.presentationActions.map { it.actionId }.toSet())
    assertEquals(setOf(newIdentity), retained.actions(now).map { it.identity }.toSet())
    assertEquals(setOf("mode"), retained.actions(now).map { it.modeSessionId }.toSet())
    assertTrue(restored.snapshot().operation is VoiceRuntimeOperation.None)
  }

  @Test
  fun realtimePresentationRetractionCannotRemoveAReplacementOrAnotherFence() {
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val identity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution, retained = retained,
    )
    val digest = local.targetDigest(realtimeTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureRealtimeAuthority(reservation(digest), realtimeTarget, "realtime")
    val fence = VoiceRuntimeRealtimeFence(identity, "mode")
    local.observeRealtime(VoiceRuntimeRealtimeCheckpoint(
      fence, realtimeTarget, "start", VoiceRealtimePhase.CONNECTED, "session", 1,
      VoiceRuntimeRealtimeControlGrant("control", 5_000, 15, 30),
    ))
    val original = VoiceRuntimeRealtimeAction.NavigateThread(
      1, now, "navigate", "project", "old-thread", 5_000,
    )
    val replacement = original.copy(threadId = "new-thread", expiresAtEpochMillis = 6_000)
    val beforePublication = local.snapshot().cursor()
    assertEquals(
      VoiceRuntimeRetentionWriteResult.INSERTED,
      local.publishRealtimePresentationAction(fence, original),
    )
    assertEquals(
      VoiceRuntimeRetentionWriteResult.UPDATED,
      local.publishRealtimePresentationAction(fence, replacement),
    )

    assertEquals(
      VoiceRuntimeRetentionRemovalResult.MISSING,
      local.retractRealtimePresentationAction(
        fence.copy(identity = identity.copy(runtimeInstanceId = "stale")), replacement,
      ),
    )
    assertEquals(
      VoiceRuntimeRetentionRemovalResult.MISSING,
      local.retractRealtimePresentationAction(fence, original),
    )
    assertEquals("new-thread", (
      retained.actions(now).single().action as VoiceRuntimePresentationAction.NavigateThread
    ).threadId)
    assertEquals(
      VoiceRuntimeRetentionRemovalResult.REMOVED,
      local.retractRealtimePresentationAction(fence, replacement),
    )
    assertTrue(retained.actions(now).isEmpty())
    val delivery = local.deliver(
      local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE),
      beforePublication,
    ) as VoiceRuntimeDelivery.Events
    assertTrue(delivery.events.none { it.presentationAction != null })
  }

  @Test
  fun priorGenerationThreadReceiptRemainsInRebaseUntilExactAcknowledgement() {
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution, retained = retained,
    )
    val target = target()
    val digest = local.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureAuthority(reservation(digest), target, "generation-1")
    val oldIdentity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val receipt = VoiceRuntimeThreadReceipt(
      oldIdentity, "old-mode", "old-client", "old-operation", "environment", "project", "thread",
      "message", "turn", listOf("assistant"), "speech", 2, 2, 2,
      listOf(VoiceRuntimeSpeechDisposition(2, "drained")), "completed", "completed", 1_000, 5_000,
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, local.publishThreadReceipt(receipt))
    val replacement = VoiceRuntimeAuthorityReservation(
      VoiceRuntimeIdentity("runtime", "instance", 2),
      "generation-2", 1, digest, "token-2", 1_000, 5_000,
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 2, digest, "token-2", 5_000)
    local.configureAuthority(replacement, target, "generation-2")
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)

    val rebase = local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase
    assertEquals(listOf(receipt), rebase.threadReceipts)
    assertEquals(2, rebase.threadReceipts.single().highestDrainedSegment)
    local.acknowledgeRetainedRecord(
      replacement.identity,
      VoiceRuntimeRetainedRecordKey.ThreadReceipt(oldIdentity, "old-mode", "old-client"),
    )
    assertTrue((local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase).threadReceipts.isEmpty())
  }

  @Test
  fun environmentSwitchScopesReceiptDeliveryAndAcknowledgementWithoutDeletingRecords() {
    val retained = VoiceRuntimeMemoryJournalRepository(now = { now })
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution, retained = retained,
    )
    val firstTarget = target()
    val firstDigest = local.targetDigest(firstTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, firstDigest, "token", 5_000)
    local.configureAuthority(reservation(firstDigest), firstTarget, "environment-1")
    val firstIdentity = local.snapshot().identity
    val firstReceipt = VoiceRuntimeThreadReceipt(
      firstIdentity, "mode-1", "client-1", "operation-1", "environment", "project", "thread",
      "message-1", "turn-1", emptyList(), null, null, null, null, emptyList(),
      "completed", "completed", 1_000, 5_000,
    )
    val secondReceipt = firstReceipt.copy(
      modeSessionId = "mode-2",
      turnClientOperationId = "client-2",
      environmentId = "environment-2",
      projectId = "project-2",
      threadId = "thread-2",
    )
    local.publishThreadReceipt(firstReceipt)
    retained.publishReceipt(secondReceipt)

    val secondTarget = firstTarget.copy(
      environmentId = "environment-2",
      projectId = "project-2",
      threadId = "thread-2",
    )
    val secondDigest = local.targetDigest(secondTarget)
    val secondIdentity = firstIdentity.copy(generation = 2)
    val secondReservation = VoiceRuntimeAuthorityReservation(
      secondIdentity, "environment-2", 1, secondDigest, "token-2", 1_000, 5_000,
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 2, secondDigest, "token-2", 5_000)
    local.configureAuthority(secondReservation, secondTarget, "environment-2")
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    assertEquals(
      listOf(secondReceipt),
      (local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase).threadReceipts,
    )
    expectThrows<VoiceRuntimeFenceException> {
      local.acknowledgeRetainedRecord(
        secondIdentity,
        VoiceRuntimeRetainedRecordKey.ThreadReceipt(firstIdentity, "mode-1", "client-1"),
      )
    }
    assertEquals(
      firstReceipt,
      retained.receipt(
        VoiceRuntimeRetainedRecordKey.ThreadReceipt(firstIdentity, "mode-1", "client-1"),
        now,
      ),
    )

    val thirdIdentity = firstIdentity.copy(generation = 3)
    val thirdReservation = VoiceRuntimeAuthorityReservation(
      thirdIdentity, "environment-1-again", 2, firstDigest, "token-3", 1_000, 5_000,
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 3, firstDigest, "token-3", 5_000)
    local.configureAuthority(thirdReservation, firstTarget, "environment-1-again")
    val restoredLease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    assertEquals(
      listOf(firstReceipt),
      (local.deliver(restoredLease, null) as VoiceRuntimeDelivery.Rebase).threadReceipts,
    )
  }

  @Test
  fun realtimeTerminalProjectionScopesPriorGenerationsToCurrentRuntimeAndEnvironment() {
    val target = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val repository = VoiceRuntimeMemoryRealtimeCheckpointRepository()
    val prior = realtimeSummary(
      VoiceRuntimeIdentity("runtime", "old-instance", 2),
      "prior-mode",
    )
    repository.publishTerminal(prior)
    repository.publishTerminal(realtimeSummary(
      VoiceRuntimeIdentity("runtime", "old-instance", 2),
      "wrong-environment",
    ).copy(environmentId = "other-environment"))
    repository.publishTerminal(realtimeSummary(
      VoiceRuntimeIdentity("other-runtime", "old-instance", 2),
      "wrong-runtime",
    ))
    repository.publishTerminal(realtimeSummary(
      VoiceRuntimeIdentity("runtime", "future-instance", 4),
      "future-generation",
    ))
    val digest = T3VoiceRuntimeTargetIdentity.digest(
      VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target),
    )
    installed = VoiceRuntimeInstalledAuthority("runtime", 3, digest, "token-3", 5_000)
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      realtimeTerminals = repository::terminals,
      realtimeTerminalAcknowledgement = repository::acknowledgeTerminal,
      initialGeneration = 2,
    )
    local.configureRealtimeAuthority(
      VoiceRuntimeAuthorityReservation(
        VoiceRuntimeIdentity("runtime", "instance", 3),
        "provision-3",
        2,
        digest,
        "token-3",
        1_000,
        5_000,
      ),
      target,
      "generation-3",
    )
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)

    val rebase = local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase
    assertEquals(listOf(prior), rebase.realtimeTerminalSummaries)
    local.acknowledgeRetainedRecord(
      VoiceRuntimeIdentity("runtime", "instance", 3),
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(prior.identity, prior.modeSessionId),
    )
    assertFalse(repository.terminals(now).contains(prior))
    expectThrows<VoiceRuntimeFenceException> {
      local.acknowledgeRetainedRecord(
        VoiceRuntimeIdentity("runtime", "instance", 3),
        VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
          VoiceRuntimeIdentity("runtime", "old-instance", 2),
          "wrong-environment",
        ),
      )
    }
  }

  private fun configure() {
    val target = target()
    val digest = controller.targetDigest(target)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    controller.configureAuthority(reservation(digest), target, "fingerprint")
    assertEquals(VoiceRuntimeReadiness.Ready(VoiceRuntimeMode.THREAD), controller.snapshot().readiness)
  }

  private fun reservation(digest: String) = VoiceRuntimeAuthorityReservation(
    VoiceRuntimeIdentity("runtime", "instance", 1),
    "provision",
    0,
    digest,
    "token",
    1_000,
    5_000,
  )

  private fun target() = VoiceRuntimeTarget.Thread(
    "environment",
    "project",
    "thread",
    "default",
    false,
    2_200,
    60_000,
    600_000,
    true,
    500,
  )

  private fun start(commandId: String = "start") = VoiceRuntimeThreadCommand.Start(
    commandId,
    VoiceRuntimeIdentity("runtime", "instance", 1),
    "mode",
    "turn-client",
    "auto-submit",
    null,
    "reject",
  )

  private fun realtimeSummary(
    identity: VoiceRuntimeIdentity,
    modeSessionId: String,
    terminalAtEpochMillis: Long = now,
  ) = VoiceRuntimeRealtimeTerminalSummary(
    identity,
    modeSessionId,
    "environment",
    "conversation",
    "session",
    VoiceRuntimeRealtimeTerminalOutcome.STOPPED,
    "user-stop",
    terminalAtEpochMillis - 1,
    terminalAtEpochMillis,
    false,
    terminalAtEpochMillis + 10_000,
  )

  private class FakeExecution : VoiceRuntimeThreadExecution {
    var startResult = true
    var throwOnStart = false
    var started: String? = null
    var finished = 0
    var lastFinishOutcome: String? = null
    var lastDraftContext: VoiceRuntimeDraftContext? = null

    override fun start(
      modeSessionId: String,
      turnClientOperationId: String,
      submissionPolicy: String,
      draftContext: VoiceRuntimeDraftContext?,
    ): Boolean {
      if (throwOnStart) error("failure")
      if (startResult) started = turnClientOperationId
      return startResult
    }

    override fun finish(outcome: String, draftContext: VoiceRuntimeDraftContext?): Boolean {
      finished += 1
      lastFinishOutcome = outcome
      lastDraftContext = draftContext
      return true
    }
    override fun cancel(): Boolean = true
    override fun stop(policy: String): Boolean = true
    override fun acknowledgeDraft(artifactId: String, outcome: String): Boolean = true
  }

  private inline fun <reified T : Throwable> expectThrows(block: () -> Unit) {
    try {
      block()
      throw AssertionError("Expected ${T::class.java.simpleName}")
    } catch (cause: Throwable) {
      if (cause !is T) throw cause
    }
  }
}
