package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeDurabilityTest {
  @Test
  fun `encrypted drafts survive restart expire and rebind exact runtime target`() {
    var now = 1_000L
    val storage = MemoryStore()
    val cipher = AuthenticatedCipher()
    val repository = VoiceRuntimeDurableDraftRepository(storage, cipher) { now }
    val original = artifact("artifact-1", "instance-old", 2_000)
    repository.publish(VoiceRuntimeStoredDraft(original, "private transcript"))

    assertFalse(storage.values.values.filterNotNull().any { "private transcript" in it })
    assertEquals("private transcript", repository.read("artifact-1")?.transcript)

    val restarted = VoiceRuntimeDurableDraftRepository(storage, cipher) { now }
    restarted.rebind(
      VoiceRuntimeIdentity("runtime-1", "instance-new", 4),
      target(),
      now,
    )
    assertEquals("instance-new", restarted.read("artifact-1")?.handle?.identity?.runtimeInstanceId)
    assertEquals("private transcript", restarted.read("artifact-1")?.transcript)

    now = 2_000
    assertNull(restarted.read("artifact-1"))
    assertTrue(restarted.handles(now).isEmpty())
  }

  @Test
  fun `draft repository retains only the latest thirty two deterministic live artifacts`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableDraftRepository(storage, AuthenticatedCipher()) { 1_000 }
    repeat(35) { index ->
      repository.publish(VoiceRuntimeStoredDraft(
        artifact("artifact-${index.toString().padStart(2, '0')}", "instance", 2_000L + index),
        "transcript-$index",
      ))
    }
    val ids = repository.handles(1_000).map { it.artifactId }
    assertEquals(32, ids.size)
    assertFalse("artifact-00" in ids)
    assertEquals("artifact-03", ids.first())
  }

  @Test
  fun `corrupt durable drafts fail closed without overwriting pending artifacts`() {
    val storage = MemoryStore()
    storage.values["entries"] = "not-json"
    val repository = VoiceRuntimeDurableDraftRepository(storage, AuthenticatedCipher()) { 1_000 }

    expectThrows<VoiceRuntimeDurableStateCorruptionException> { repository.handles(1_000) }
    expectThrows<VoiceRuntimeDurableStateCorruptionException> {
      repository.publish(VoiceRuntimeStoredDraft(artifact("new", "instance", 2_000), "secret"))
    }
    assertEquals("not-json", storage.values["entries"])
  }

  @Test
  fun `durable receipts and actions reconstruct and expire across restart`() {
    var now = 1_000L
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { now })
    val receipt = VoiceRuntimeThreadReceipt(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
      "mode-1", "client-1", "operation-1", "environment-1", "project-1", "thread-1",
      "message-1", "turn-1", listOf("assistant-1"), "speech-1", 2, 1, 1,
      listOf(VoiceRuntimeSpeechDisposition(1, "drained")),
      "completed", "completed", 1_000, 2_000,
    )
    val action = VoiceRuntimePresentationAction.ReviewDraft(
      "review-artifact-1", artifact("artifact-1", "instance-1", 2_000), 2_000,
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishReceipt(receipt))
    val retainedAction = retainedAction(action)
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishAction(retainedAction))

    val restarted = VoiceRuntimeDurableJournalRepository(storage, now = { now })
    assertEquals(listOf(receipt), restarted.receipts(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", 1_500,
    ))
    assertEquals(listOf(retainedAction), restarted.actions(1_500))
    now = 2_000
    assertTrue(restarted.receipts(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", now,
    ).isEmpty())
    assertTrue(restarted.actions(now).isEmpty())
  }

  @Test
  fun `all presentation action variants survive restart with strict payloads`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val actions = listOf(
      VoiceRuntimePresentationAction.NavigateThread(
        "navigate-1", "project-1", "thread-1", 2_000,
      ),
      VoiceRuntimePresentationAction.ReviewDraft(
        "review-1", artifact("artifact-1", "instance-1", 2_000), 2_000,
      ),
      VoiceRuntimePresentationAction.RealtimeConfirmationRequired(
        "confirm-1", "confirmation-1", "tool-call-1", "send_message",
        "Send a synchronous message", 2_000,
      ),
    )
    actions.forEach { repository.publishAction(retainedAction(it)) }

    val restarted = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val recovered = restarted.actions(1_000).map { it.action }
    assertEquals(actions.associateBy { it.actionId }, recovered.associateBy { it.actionId })
    val confirmation = recovered.single {
      it is VoiceRuntimePresentationAction.RealtimeConfirmationRequired
    }
    assertEquals(
      mapOf(
        "actionId" to "confirm-1",
        "action" to "realtime-confirmation-required",
        "confirmationId" to "confirmation-1",
        "toolCallId" to "tool-call-1",
        "tool" to "send_message",
        "summary" to "Send a synchronous message",
        "expiresAt" to "1970-01-01T00:00:02Z",
      ),
      VoiceRuntimeBridge.presentationActionBody(confirmation),
    )
  }

  @Test
  fun `full journal rejects new records without evicting live entries and ack or expiry frees capacity`() {
    var now = 1_000L
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { now })
    repeat(256) { index ->
      repository.publishReceipt(receipt(index, 2_000))
    }
    repeat(64) { index ->
      repository.publishAction(retainedAction(VoiceRuntimePresentationAction.NavigateThread(
        "action-$index", "project-$index", "thread-$index", 2_000,
      )))
    }
    val nextReceipt = receipt(256, 2_000)
    assertEquals(
      VoiceRuntimeRetentionAdmission.FULL,
      repository.receiptAdmission(nextReceipt.retentionKeyForTest(), now),
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.FULL, repository.publishReceipt(nextReceipt))
    val nextAction = retainedAction(VoiceRuntimePresentationAction.NavigateThread(
        "action-64", "project-64", "thread-64", 2_000,
      ))
    assertEquals(VoiceRuntimeRetentionAdmission.FULL, repository.actionCapacity(now))
    assertEquals(VoiceRuntimeRetentionWriteResult.FULL, repository.publishAction(nextAction))

    val restarted = VoiceRuntimeDurableJournalRepository(storage, now = { now })
    assertEquals(256, restarted.receipts(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", now,
    ).size)
    assertEquals(64, restarted.actions(now).size)
    val acknowledged = receipt(42, 2_000)
    assertTrue(restarted.acknowledgeReceipt(VoiceRuntimeRetainedRecordKey.ThreadReceipt(
      acknowledged.identity, acknowledged.modeSessionId, acknowledged.turnClientOperationId,
    )))
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, restarted.publishReceipt(nextReceipt))
    assertEquals(256, restarted.receipts(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", now,
    ).size)
    assertEquals(
      VoiceRuntimeRetentionRemovalResult.REMOVED,
      restarted.removeAction(retainedAction(
        VoiceRuntimePresentationAction.NavigateThread("action-42", "project-42", "thread-42", 2_000),
      ).key),
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, restarted.publishAction(nextAction))
    assertEquals(64, restarted.actions(now).size)

    now = 2_000
    assertTrue(restarted.receipts(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", now,
    ).isEmpty())
    assertTrue(restarted.actions(now).isEmpty())
  }

  @Test
  fun `corrupt durable journal fails closed without erasing receipts or actions`() {
    val storage = MemoryStore()
    storage.values["voice_runtime_thread_receipts"] = "not-json"
    storage.values["voice_runtime_presentation_actions"] = "not-json"
    val repository = VoiceRuntimeDurableJournalRepository(storage)

    assertEquals(
      VoiceRuntimeRetentionAdmission.UNAVAILABLE,
      repository.receiptAdmission(
        VoiceRuntimeReceiptRetentionKey(
          VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "mode-1", "client-1",
        ),
        1_000,
      ),
    )
    assertEquals(VoiceRuntimeRetentionAdmission.UNAVAILABLE, repository.actionCapacity(1_000))
    expectThrows<VoiceRuntimeDurableStateCorruptionException> {
      repository.receipts(
        VoiceRuntimeIdentity("runtime-1", "instance-1", 4), "environment-1", 1_000,
      )
    }
    expectThrows<VoiceRuntimeDurableStateCorruptionException> { repository.actions(1_000) }
    assertEquals("not-json", storage.values["voice_runtime_thread_receipts"])
    assertEquals("not-json", storage.values["voice_runtime_presentation_actions"])
  }

  @Test
  fun `legacy unfenced presentation actions are retired once`() {
    val storage = MemoryStore()
    storage.values["voice_runtime_presentation_actions"] =
      """[{"action":"navigate-thread","actionId":"legacy","projectId":"p","threadId":"t","expiresAt":"2030-01-01T00:00:00Z"}]"""

    val repository = VoiceRuntimeDurableJournalRepository(storage)

    assertTrue(repository.actions(1_000).isEmpty())
    assertEquals(
      "identity-mode-v1",
      storage.values["voice_runtime_presentation_actions_schema"],
    )
  }

  @Test
  fun `thread scope retains live same-runtime receipts across generations and environments`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val oldInstance = VoiceRuntimeIdentity("runtime-1", "old-instance", 4)
    val newInstance = VoiceRuntimeIdentity("runtime-1", "new-instance", 4)
    val priorGeneration = VoiceRuntimeIdentity("runtime-1", "old-instance", 3)
    repository.publishReceipt(receipt(1, 2_000).copy(identity = oldInstance))
    repository.publishReceipt(receipt(2, 2_000).copy(identity = priorGeneration))
    repository.publishReceipt(receipt(3, 2_000).copy(
      identity = VoiceRuntimeIdentity("runtime-1", "future-instance", 5),
    ))
    repository.publishReceipt(receipt(4, 2_000).copy(environmentId = "other-environment"))
    val review = retainedAction(
      VoiceRuntimePresentationAction.ReviewDraft(
        "review-artifact-1",
        artifact("artifact-1", "old-instance", 2_000),
        2_000,
      ),
      oldInstance,
    )
    val navigate = retainedAction(
      VoiceRuntimePresentationAction.NavigateThread("navigate-1", "project-1", "thread-1", 2_000),
      oldInstance,
    )
    val priorConfirmation = retainedAction(
      VoiceRuntimePresentationAction.RealtimeConfirmationRequired(
        "confirm-1", "confirmation-1", "tool-call-1", "send_message", "Send", 2_000,
      ),
      priorGeneration,
    )
    listOf(review, navigate, priorConfirmation).forEach(repository::publishAction)

    assertEquals(
      VoiceRuntimeRetentionScopeResult(receiptsRetired = 1, actionsRetired = 2, actionsRebound = 1),
      repository.activateScope(
        newInstance, VoiceRuntimeRetentionScope.Thread("environment-1"), 1_000,
      ),
    )

    val restarted = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    assertEquals(
      listOf(
        receipt(2, 2_000).copy(identity = priorGeneration),
        receipt(1, 2_000).copy(identity = oldInstance),
      ).sortedBy { it.turnClientOperationId },
      restarted.receipts(newInstance, "environment-1", 1_000)
        .sortedBy { it.turnClientOperationId },
    )
    assertEquals(
      listOf(receipt(4, 2_000).copy(environmentId = "other-environment")),
      restarted.receipts(newInstance, "other-environment", 1_000),
    )
    assertEquals(3, restarted.checkpoint()?.receipts?.size)
    val recovered = restarted.actions(1_000).single()
    assertEquals(newInstance, recovered.identity)
    assertTrue(recovered.action is VoiceRuntimePresentationAction.ReviewDraft)
    assertEquals(
      newInstance,
      (recovered.action as VoiceRuntimePresentationAction.ReviewDraft).artifact.identity,
    )
    assertEquals(VoiceRuntimeRetentionAdmission.AVAILABLE, restarted.actionCapacity(1_000))
  }

  @Test
  fun `environment switching cannot evict live receipts or bypass capacity`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(
      storage,
      now = { 1_000 },
      receiptCapacity = 2,
    )
    val identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4)
    val first = receipt(1, 5_000).copy(environmentId = "environment-1")
    val second = receipt(2, 5_000).copy(environmentId = "environment-2")
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishReceipt(first))
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishReceipt(second))

    assertEquals(
      VoiceRuntimeRetentionScopeResult(0, 0, 0),
      repository.activateScope(
        identity,
        VoiceRuntimeRetentionScope.Thread("environment-2"),
        1_000,
      ),
    )
    assertEquals(listOf(second), repository.receipts(identity, "environment-2", 1_000))
    assertEquals(listOf(first), repository.receipts(identity, "environment-1", 1_000))
    assertEquals(
      VoiceRuntimeRetentionAdmission.FULL,
      repository.receiptAdmission(receipt(3, 5_000).retentionKeyForTest(), 1_000),
    )
    assertEquals(2, VoiceRuntimeDurableJournalRepository(storage).checkpoint()?.receipts?.size)
  }

  @Test
  fun `realtime scope retires stale actions but preserves prior generation receipts`() {
    val repository = VoiceRuntimeMemoryJournalRepository()
    val oldIdentity = VoiceRuntimeIdentity("runtime-1", "old-instance", 4)
    val current = VoiceRuntimeIdentity("runtime-1", "new-instance", 5)
    repository.publishReceipt(receipt(1, 2_000).copy(identity = oldIdentity))
    repository.publishAction(retainedAction(
      VoiceRuntimePresentationAction.NavigateThread("navigate-1", "project-1", "thread-1", 2_000),
      oldIdentity,
    ))

    assertEquals(
      VoiceRuntimeRetentionScopeResult(receiptsRetired = 0, actionsRetired = 1, actionsRebound = 0),
      repository.activateScope(
        current, VoiceRuntimeRetentionScope.Realtime("environment-1"), 1_000,
      ),
    )
    assertEquals(
      listOf(receipt(1, 2_000).copy(identity = oldIdentity)),
      repository.receipts(current, "environment-1", 1_000),
    )
    assertTrue(repository.actions(1_000).isEmpty())
  }

  @Test
  fun `recovered realtime scope rebinds only the exact persisted fence and mode`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val oldIdentity = VoiceRuntimeIdentity("runtime-1", "old-instance", 4)
    val currentIdentity = VoiceRuntimeIdentity("runtime-1", "new-instance", 4)
    val exact = retainedAction(
      VoiceRuntimePresentationAction.NavigateThread(
        "navigate-exact", "project-1", "thread-1", 5_000,
      ),
      oldIdentity,
      "mode-exact",
    )
    val unrelatedMode = retainedAction(
      VoiceRuntimePresentationAction.RealtimeConfirmationRequired(
        "confirm-unrelated", "confirmation-1", "tool-call-1", "send_message", "Send", 5_000,
      ),
      oldIdentity,
      "mode-unrelated",
    )
    repository.publishAction(exact)
    repository.publishAction(unrelatedMode)

    assertEquals(
      VoiceRuntimeRetentionScopeResult(0, 0, 0),
      repository.activateScope(
        currentIdentity,
        VoiceRuntimeRetentionScope.Realtime("environment-1"),
        1_000,
      ),
    )
    assertEquals(setOf(oldIdentity), repository.actions(1_000).map { it.identity }.toSet())

    val restarted = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    assertEquals(
      VoiceRuntimeRetentionScopeResult(0, 1, 1),
      restarted.activateScope(
        currentIdentity,
        VoiceRuntimeRetentionScope.RecoveredRealtime(
          "environment-1",
          VoiceRuntimeRealtimeFence(oldIdentity, "mode-exact"),
        ),
        1_000,
      ),
    )
    assertEquals(
      listOf(exact.copy(identity = currentIdentity)),
      VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 }).actions(1_000),
    )
  }

  @Test
  fun `failed durable writes return unavailable and preserve the previous retention snapshot`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val receipt = receipt(1, 2_000)
    val action = retainedAction(
      VoiceRuntimePresentationAction.NavigateThread("navigate-1", "project-1", "thread-1", 2_000),
    )
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishReceipt(receipt))
    assertEquals(VoiceRuntimeRetentionWriteResult.INSERTED, repository.publishAction(action))
    val before = repository.checkpoint()
    storage.acceptWrites = false

    assertEquals(
      VoiceRuntimeRetentionWriteResult.UNAVAILABLE,
      repository.publishReceipt(receipt(2, 2_000)),
    )
    assertEquals(
      VoiceRuntimeRetentionWriteResult.UNAVAILABLE,
      repository.publishAction(retainedAction(
        VoiceRuntimePresentationAction.NavigateThread("navigate-2", "project-2", "thread-2", 2_000),
      )),
    )
    assertNull(repository.activateScope(
      VoiceRuntimeIdentity("runtime-1", "instance-2", 5),
      VoiceRuntimeRetentionScope.Realtime("environment-1"),
      1_000,
    ))
    storage.acceptWrites = true
    assertEquals(before, repository.checkpoint())
  }

  @Test
  fun `presentation retraction removes only the exact fenced action payload`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage, now = { 1_000 })
    val identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4)
    val original = retainedAction(
      VoiceRuntimePresentationAction.NavigateThread(
        "navigate", "project", "old-thread", 2_000,
      ),
      identity,
    )
    val replacement = original.copy(
      action = VoiceRuntimePresentationAction.NavigateThread(
        "navigate", "project", "new-thread", 3_000,
      ),
    )
    repository.publishAction(original)
    repository.publishAction(replacement)

    assertEquals(
      VoiceRuntimeRetentionRemovalResult.MISSING,
      repository.retractAction(original),
    )
    assertEquals(listOf(replacement), repository.actions(1_000))
    assertEquals(
      VoiceRuntimeRetentionRemovalResult.MISSING,
      repository.retractAction(original.copy(identity = identity.copy(runtimeInstanceId = "stale"))),
    )
    assertEquals(
      VoiceRuntimeRetentionRemovalResult.REMOVED,
      repository.retractAction(replacement),
    )
    assertTrue(repository.actions(1_000).isEmpty())
  }

  @Test
  fun `draft consume marker survives operation store restart`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage)
    val claim = VoiceRuntimeThreadClaim(
      "runtime-1", "instance-1", 4, "mode-1", "https://example.test",
      "project-1", "thread-1", "client-1", "draft", "speech-1",
      VoiceRuntimeDraftContext("environment-1", "project-1", "thread-1", "revision-1"),
    )
    store.writePrepared(claim)
    store.writeActive(VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", 2_000, 0,
      draftConsumePending = true,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.WAITING, operationId = "operation-1",
        operationGeneration = 4,
      ),
    ))

    val loaded = (VoiceRuntimeThreadOperationStore(storage).load()
      as VoiceRuntimeThreadOperationLoadResult.Available).state
      as VoiceRuntimeThreadOperationState.Active
    assertTrue(loaded.draftConsumePending)
  }

  @Test
  fun `auto submit manual stop persists exact target draft disposition across restart`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage)
    val claim = VoiceRuntimeThreadClaim(
      "runtime-1", "instance-1", 4, "mode-1", "https://example.test",
      "project-1", "thread-1", "client-1", "auto-submit", "speech-1", null,
    )
    store.writePrepared(claim)
    store.writeActive(VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", 2_000, 0,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.WAITING, operationId = "operation-1",
        operationGeneration = 4,
      ),
    ))
    val context = VoiceRuntimeDraftContext(
      "environment-1", "project-1", "thread-1", "revision-1",
    )

    val prepared = store.prepareDraftDisposition("client-1", context)
      as VoiceRuntimeThreadOperationUpdateResult.Updated
    assertEquals("draft", prepared.state.claim.submissionPolicy)
    assertEquals(context, prepared.state.claim.draftContext)
    assertTrue(prepared.state.draftDispositionPending)

    val restarted = VoiceRuntimeThreadOperationStore(storage)
    val loaded = (restarted.load() as VoiceRuntimeThreadOperationLoadResult.Available).state
      as VoiceRuntimeThreadOperationState.Active
    assertEquals("draft", loaded.claim.submissionPolicy)
    assertEquals(context, loaded.claim.draftContext)
    assertTrue(loaded.draftDispositionPending)
  }

  private fun target() = VoiceRuntimeTarget.Thread(
    "environment-1", "project-1", "thread-1", "default", true,
    2_200, null, 600_000, true, 500,
  )

  private fun artifact(id: String, instance: String, expiresAt: Long) = VoiceRuntimeDraftHandle(
    id,
    VoiceRuntimeIdentity("runtime-1", instance, 4),
    "mode-1",
    "client-1",
    VoiceRuntimeDraftContext("environment-1", "project-1", "thread-1", "revision-1"),
    expiresAt,
  )

  private fun receipt(index: Int, expiresAt: Long) = VoiceRuntimeThreadReceipt(
    VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
    "mode-$index", "client-$index", "operation-$index", "environment-1", "project-1",
    "thread-1", "message-$index", "turn-$index", emptyList(), null, null, null, null,
    emptyList(), "completed", "completed", 1_000, expiresAt,
  )

  private fun retainedAction(
    action: VoiceRuntimePresentationAction,
    identity: VoiceRuntimeIdentity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
    modeSessionId: String = "mode-1",
  ) = VoiceRuntimeRetainedPresentationAction(identity, modeSessionId, action)

  private fun VoiceRuntimeThreadReceipt.retentionKeyForTest() = VoiceRuntimeReceiptRetentionKey(
    identity, modeSessionId, turnClientOperationId,
  )

  private class MemoryStore : VoiceRuntimeKeyValueStore {
    val values = mutableMapOf<String, String?>()
    var acceptWrites = true
    override fun getString(key: String) = values[key]
    override fun put(values: Map<String, String?>): Boolean {
      if (!acceptWrites) return false
      values.forEach { (key, value) -> if (value == null) this.values.remove(key) else this.values[key] = value }
      return true
    }
    override fun clear(keys: Set<String>): Boolean { keys.forEach(values::remove); return true }
  }

  private class AuthenticatedCipher : T3VoiceRuntimeGrantCipher {
    override fun encrypt(plaintext: ByteArray, authenticatedMetadata: ByteArray) =
      T3VoiceEncryptedGrant(byteArrayOf(1), authenticatedMetadata + byteArrayOf(0) + plaintext)

    override fun decrypt(encrypted: T3VoiceEncryptedGrant, authenticatedMetadata: ByteArray): ByteArray {
      val prefix = authenticatedMetadata + byteArrayOf(0)
      require(encrypted.ciphertext.take(prefix.size).toByteArray().contentEquals(prefix))
      return encrypted.ciphertext.copyOfRange(prefix.size, encrypted.ciphertext.size)
    }

    override fun deleteKey() = Unit
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
