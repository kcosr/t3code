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
  fun exactAuthorityStartsNativeThreadAndProjectsBackgroundState() {
    configure()
    val receipt = controller.dispatch(start())

    assertTrue(receipt.outcome is VoiceRuntimeCommandOutcome.Accepted)
    assertEquals("turn-client", execution.started)
    assertTrue(controller.snapshot().operation is VoiceRuntimeOperation.ThreadTurn)

    controller.observeBackground(
      T3VoiceBackgroundSnapshot(
        runtimeId = "runtime",
        readinessGeneration = 1,
        mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.RECORDING,
        operationId = "turn-operation",
        operationGeneration = 1,
        recordingId = "recording",
      ),
    )
    val operation = controller.snapshot().operation as VoiceRuntimeOperation.ThreadTurn
    assertEquals("turn-operation", operation.turnOperationId)
    assertEquals(VoiceRuntimeMediaOwner.Recorder("thread-mode", "turn-operation"), controller.snapshot().mediaOwner)

    controller.observeBackground(
      T3VoiceBackgroundSnapshot(
        runtimeId = "runtime",
        readinessGeneration = 1,
        mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.IDLE,
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
    val retained = VoiceRuntimeMemoryJournalRepository()
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
  }

  @Test
  fun realtimeTerminalsAreExactlyFencedBoundedAndProjectedLive() {
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment", "conversation")
    val exactIdentity = VoiceRuntimeIdentity("runtime", "instance", 1)
    val retained = (0 until 70).map { index ->
      realtimeSummary(
        exactIdentity,
        "mode-$index",
        terminalAtEpochMillis = 1_000L + index,
      )
    } + realtimeSummary(
      exactIdentity.copy(runtimeInstanceId = "stale-instance"),
      "stale-mode",
      terminalAtEpochMillis = 2_000,
    )
    val local = VoiceRuntimeActiveThreadController(
      "runtime", "instance", { now }, { installed }, execution,
      realtimeTerminals = { retained },
    )
    val digest = local.targetDigest(realtimeTarget)
    installed = VoiceRuntimeInstalledAuthority("runtime", 1, digest, "token", 5_000)
    local.configureRealtimeAuthority(reservation(digest), realtimeTarget, "realtime-fingerprint")
    local.observeRealtime(
      VoiceRuntimeRealtimeCheckpoint(
        VoiceRuntimeRealtimeFence(exactIdentity, "live-mode"),
        realtimeTarget,
        "start-command",
        VoiceRealtimePhase.CONNECTED,
        serverSessionId = "session",
        leaseGeneration = 1,
        controlGrant = T3VoiceBackgroundRealtimeControlGrant("control-token", 5_000, 15, 30),
        lastConnectedAtEpochMillis = now,
      ),
    )
    val lease = local.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val cursorBeforeTerminal = local.snapshot().cursor()
    val rebase = local.deliver(lease, null) as VoiceRuntimeDelivery.Rebase

    assertEquals(64, rebase.realtimeTerminalSummaries.size)
    assertEquals("mode-6", rebase.realtimeTerminalSummaries.first().modeSessionId)
    assertTrue(rebase.realtimeTerminalSummaries.all { it.identity == exactIdentity })
    val rebaseBody = VoiceRuntimeBridge.deliveryBody(rebase)
    @Suppress("UNCHECKED_CAST")
    val rebaseSummaries = rebaseBody["realtimeTerminalSummaries"] as List<Map<String, Any?>>
    assertEquals("mode-69", rebaseSummaries.last()["modeSessionId"])
    assertFalse(rebaseBody.toString().contains("control-token"))

    assertFalse(local.publishRealtimeTerminal(realtimeSummary(
      exactIdentity.copy(generation = 2), "live-mode",
    )))
    val live = realtimeSummary(exactIdentity, "live-mode")
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
