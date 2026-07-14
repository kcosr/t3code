package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class VoiceRuntimeFoundationTest {
  private val identity = VoiceRuntimeIdentity("runtime", "instance", 1)

  @Test
  fun snapshotAxesRemainIndependent() {
    val snapshot = snapshot().copy(
      operation = VoiceRuntimeOperation.ThreadTurn(
        "mode",
        VoiceThreadPhase.Ordinary(VoiceThreadOrdinaryPhase.WAITING),
        "turn-client",
        "turn",
      ),
      mediaOwner = VoiceRuntimeMediaOwner.None,
      readiness = VoiceRuntimeReadiness.Active(VoiceRuntimeMode.THREAD),
    )

    assertTrue(snapshot.operation is VoiceRuntimeOperation.ThreadTurn)
    assertEquals(VoiceRuntimeMediaOwner.None, snapshot.mediaOwner)
    assertEquals(VoiceRuntimeReadiness.Active(VoiceRuntimeMode.THREAD), snapshot.readiness)
  }

  @Test
  fun journalReplaysRetainedEventsAndRebasesStaleCursors() {
    val journal = VoiceRuntimeJournal(snapshot(), capacity = 2)
    val initial = snapshot().cursor()
    journal.append("one")
    journal.append("two")
    journal.append("three")

    val replay = journal.read(initial)
    assertTrue(replay is VoiceRuntimeDelivery.Rebase)
    assertEquals(
      VoiceRuntimeRebaseReason.CURSOR_TOO_OLD,
      (replay as VoiceRuntimeDelivery.Rebase).reason,
    )
    val retained = journal.read(initial.copy(sequence = 1)) as VoiceRuntimeDelivery.Events
    assertEquals(listOf("two", "three"), retained.events.map { it.kind })
    val replaced = journal.read(initial.copy(runtimeInstanceId = "old")) as VoiceRuntimeDelivery.Rebase
    assertEquals(VoiceRuntimeRebaseReason.RUNTIME_REPLACED, replaced.reason)
    val generation = journal.read(initial.copy(generation = 0)) as VoiceRuntimeDelivery.Rebase
    assertEquals(VoiceRuntimeRebaseReason.GENERATION_CHANGED, generation.reason)
  }

  @Test
  fun journalReplacementClearsOldEventsAndUsesNewIdentity() {
    val journal = VoiceRuntimeJournal(snapshot(), 4)
    journal.append("old")
    val oldCursor = journal.snapshot.cursor()
    val nextIdentity = VoiceRuntimeIdentity("runtime", "new-instance", 1)
    journal.replaceSnapshot(snapshot(nextIdentity))

    val delivery = journal.read(oldCursor) as VoiceRuntimeDelivery.Rebase
    assertEquals(VoiceRuntimeRebaseReason.RUNTIME_REPLACED, delivery.reason)
    assertEquals(nextIdentity, delivery.snapshot.identity)
  }

  @Test
  fun idempotencySurvivesGenerationChangesAndRejectsBodyConflict() {
    val ledger = VoiceRuntimeIdempotencyLedger<String>(capacity = 2)
    val first = ledger.resolve("command", "generation=1;start") { "accepted-generation-1" }
    val replay = ledger.resolve("command", "generation=1;start") { "must-not-run" }

    assertEquals("accepted-generation-1" to false, first)
    assertEquals("accepted-generation-1" to true, replay)
    expectThrows<VoiceRuntimeIdempotencyConflictException> {
      ledger.resolve("command", "generation=2;stop") { "invalid" }
    }
  }

  @Test
  fun idempotencyEvictsOldestOutcomeAtCapacity() {
    val ledger = VoiceRuntimeIdempotencyLedger<String>(capacity = 2)
    ledger.resolve("first", "body-1") { "one" }
    ledger.resolve("second", "body-2") { "two" }
    ledger.resolve("third", "body-3") { "three" }

    val evicted = ledger.resolve("first", "new-body") { "new-one" }
    assertEquals("new-one" to false, evicted)
    val retained = ledger.resolve("third", "body-3") { "must-not-run" }
    assertEquals("three" to true, retained)
  }

  @Test
  fun authorityUsesCasRetainsProvisioningReplayAndExpiresClosed() {
    var now = 1_000L
    val registry = VoiceRuntimeAuthorityRegistry("runtime", "instance", { now })
    val first = reservation(1, expected = 0, operationId = "provision-1", expiresAt = 2_000)

    assertEquals(first to false, registry.configure(first, "first-body"))
    assertEquals(first to true, registry.configure(first, "first-body"))
    expectThrows<VoiceRuntimeIdempotencyConflictException> {
      registry.configure(first.copy(targetDigest = "other"), "different-body")
    }
    expectThrows<VoiceRuntimeFenceException> {
      registry.configure(reservation(2, expected = 0, operationId = "stale", expiresAt = 3_000), "stale")
    }
    val second = reservation(2, expected = 1, operationId = "provision-2", expiresAt = 3_000)
    assertEquals(second to false, registry.configure(second, "second-body"))
    assertEquals(first to true, registry.configure(first, "first-body"))
    now = 3_000
    expectThrows<VoiceRuntimeExpiredException> { registry.requireCurrent(2) }
  }

  @Test
  fun newestForegroundLeaseWinsAndExpiryOccursBeforeDelivery() {
    var now = 0L
    val consumers = VoiceRuntimeConsumerRegistry({ identity }, { now }, 100)
    val first = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val second = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)

    assertEquals(VoiceRuntimeElection.STANDBY, consumers.requireLease(first).election)
    assertEquals(VoiceRuntimeElection.ELECTED, consumers.requireLease(second).election)
    expectThrows<VoiceRuntimeNotElectedException> { consumers.requireElected(first) }
    val background = consumers.update(second, VoiceRuntimePresentation.BACKGROUND)
    assertEquals(VoiceRuntimeElection.ELECTED, consumers.requireElected(first).election)
    assertEquals(VoiceRuntimeElection.STANDBY, consumers.requireLease(background).election)
    now = 100
    expectThrows<VoiceRuntimeExpiredException> { consumers.requireLease(first) }
  }

  @Test
  fun deliveryGateExpiresAndFencesConsumersBeforeReadingJournal() {
    var now = 0L
    var currentIdentity = identity
    val consumers = VoiceRuntimeConsumerRegistry({ currentIdentity }, { now }, 100)
    val journal = VoiceRuntimeJournal(snapshot(), capacity = 4)
    val gate = VoiceRuntimeDeliveryGate(consumers, journal)
    val lease = consumers.attach(VoiceRuntimePresentation.VISIBLE_INACTIVE)
    journal.append("available")

    val delivery = gate.deliver(lease, snapshot().cursor()) as VoiceRuntimeDelivery.Events
    assertEquals(listOf("available"), delivery.events.map { it.kind })

    currentIdentity = identity.copy(generation = 2)
    expectThrows<VoiceRuntimeExpiredException> { gate.deliver(lease, snapshot().cursor()) }

    currentIdentity = identity
    val expiring = consumers.attach(VoiceRuntimePresentation.VISIBLE_INACTIVE)
    now = 100
    expectThrows<VoiceRuntimeExpiredException> { gate.deliver(expiring, snapshot().cursor()) }
  }

  @Test
  fun staleLeaseCannotClaimOrAcknowledgePresentationAction() {
    var now = 0L
    val consumers = VoiceRuntimeConsumerRegistry({ identity }, { now }, 1_000)
    val actions = VoiceRuntimePresentationActionStore(consumers, { now })
    val old = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    actions.publish(VoiceRuntimePresentationAction.NavigateThread(
      "action", "project-1", "thread-1", 500,
    ))
    assertEquals("action", actions.claim("action", old).actionId)
    val replacement = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)

    expectThrows<VoiceRuntimeNotElectedException> { actions.acknowledge("action", old) }
    assertEquals("action", actions.claim("action", replacement).actionId)
    actions.acknowledge("action", replacement)
    actions.publish(VoiceRuntimePresentationAction.NavigateThread(
      "expiring", "project-1", "thread-1", 500,
    ))
    now = 500
    expectThrows<VoiceRuntimeExpiredException> { actions.claim("expiring", replacement) }
  }

  @Test
  fun draftArtifactRequiresElectedLeaseAndExpiresBeforeRead() {
    var now = 0L
    val consumers = VoiceRuntimeConsumerRegistry({ identity }, { now }, 1_000)
    val drafts = VoiceRuntimeDraftArtifactStore(consumers, { now })
    val standby = consumers.attach(VoiceRuntimePresentation.VISIBLE_INACTIVE)
    val elected = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    val payload = VoiceRuntimeOpaqueDraftPayload.inMemory("private transcript")
    drafts.publish(VoiceRuntimeDraftArtifact("draft", payload, 100))

    expectThrows<VoiceRuntimeNotElectedException> { drafts.read("draft", standby) }
    assertEquals("private transcript", drafts.read("draft", elected).payload.revealInMemory())
    assertEquals("VoiceRuntimeOpaqueDraftPayload([REDACTED])", payload.toString())
    val replacement = consumers.attach(VoiceRuntimePresentation.FOREGROUND_ACTIVE)
    expectThrows<VoiceRuntimeNotElectedException> { drafts.acknowledge("draft", elected) }
    assertEquals("private transcript", drafts.read("draft", replacement).payload.revealInMemory())
    drafts.acknowledge("draft", replacement)
    drafts.publish(
      VoiceRuntimeDraftArtifact(
        "expiring",
        VoiceRuntimeOpaqueDraftPayload.inMemory("private"),
        100,
      ),
    )
    now = 100
    expectThrows<VoiceRuntimeExpiredException> { drafts.read("expiring", replacement) }
  }

  private fun snapshot(value: VoiceRuntimeIdentity = identity) = VoiceRuntimeSnapshot(
    identity = value,
    sequence = 0,
    availability = VoiceRuntimeAvailability.READY,
    target = null,
    operation = VoiceRuntimeOperation.None,
    mediaOwner = VoiceRuntimeMediaOwner.None,
    readiness = VoiceRuntimeReadiness.Disabled,
    inputRouteId = null,
    outputRouteId = null,
    failureCode = null,
  )

  private fun reservation(
    generation: Long,
    expected: Long,
    operationId: String,
    expiresAt: Long,
  ) = VoiceRuntimeAuthorityReservation(
    identity.copy(generation = generation),
    operationId,
    expected,
    "target-$generation",
    "token-$generation",
    1_000,
    expiresAt,
  )

  private inline fun <reified T : Throwable> expectThrows(block: () -> Unit): T {
    try {
      block()
      fail("Expected ${T::class.java.simpleName}")
    } catch (cause: Throwable) {
      if (cause !is T) throw cause
      return cause
    }
    error("Unreachable")
  }
}
