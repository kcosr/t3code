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
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableJournalRepository(storage)
    val receipt = VoiceRuntimeThreadReceipt(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
      "mode-1", "client-1", "operation-1", "environment-1", "project-1", "thread-1",
      "message-1", "turn-1", listOf("assistant-1"), "speech-1", 2, 1, 1,
      listOf(T3VoiceBackgroundSpeechDisposition(1, "drained")),
      "completed", "completed", 1_000, 2_000,
    )
    val action = VoiceRuntimePresentationAction(
      "review-artifact-1", "review-draft", 2_000, artifact = artifact("artifact-1", "instance-1", 2_000),
    )
    repository.publishReceipt(receipt)
    repository.publishAction(action)

    val restarted = VoiceRuntimeDurableJournalRepository(storage)
    assertEquals(listOf(receipt), restarted.receipts("runtime-1", 4, 1_500))
    assertEquals(listOf(action), restarted.actions(1_500))
    assertTrue(restarted.receipts("runtime-1", 4, 2_000).isEmpty())
    assertTrue(restarted.actions(2_000).isEmpty())
  }

  @Test
  fun `corrupt durable journal fails closed without erasing receipts or actions`() {
    val storage = MemoryStore()
    storage.values["voice_runtime_thread_receipts"] = "not-json"
    storage.values["voice_runtime_presentation_actions"] = "not-json"
    val repository = VoiceRuntimeDurableJournalRepository(storage)

    expectThrows<VoiceRuntimeDurableStateCorruptionException> {
      repository.receipts("runtime-1", 4, 1_000)
    }
    expectThrows<VoiceRuntimeDurableStateCorruptionException> { repository.actions(1_000) }
    assertEquals("not-json", storage.values["voice_runtime_thread_receipts"])
    assertEquals("not-json", storage.values["voice_runtime_presentation_actions"])
  }

  @Test
  fun `draft consume marker survives operation store restart`() {
    val storage = MemoryStore()
    val cipher = AuthenticatedCipher()
    val store = T3VoiceBackgroundThreadOperationStore(storage, cipher)
    val claim = T3VoiceBackgroundThreadClaim(
      "runtime-1", "instance-1", 4, "mode-1", "https://example.test",
      "project-1", "thread-1", "client-1", "draft", "speech-1",
      VoiceRuntimeDraftContext("environment-1", "project-1", "thread-1", "revision-1"),
    )
    store.writePrepared(claim)
    store.writeActive(T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", 2_000, "token", 0,
      draftConsumePending = true,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.WAITING, operationId = "operation-1",
        operationGeneration = 4,
      ),
    ))

    val loaded = (T3VoiceBackgroundThreadOperationStore(storage, cipher).load()
      as T3VoiceBackgroundThreadOperationLoadResult.Available).state
      as T3VoiceBackgroundThreadOperationState.Active
    assertTrue(loaded.draftConsumePending)
  }

  @Test
  fun `auto submit manual stop persists exact target draft disposition across restart`() {
    val storage = MemoryStore()
    val cipher = AuthenticatedCipher()
    val store = T3VoiceBackgroundThreadOperationStore(storage, cipher)
    val claim = T3VoiceBackgroundThreadClaim(
      "runtime-1", "instance-1", 4, "mode-1", "https://example.test",
      "project-1", "thread-1", "client-1", "auto-submit", "speech-1", null,
    )
    store.writePrepared(claim)
    store.writeActive(T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", 2_000, "token", 0,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.WAITING, operationId = "operation-1",
        operationGeneration = 4,
      ),
    ))
    val context = VoiceRuntimeDraftContext(
      "environment-1", "project-1", "thread-1", "revision-1",
    )

    val prepared = store.prepareDraftDisposition("client-1", context)
      as T3VoiceBackgroundThreadOperationUpdateResult.Updated
    assertEquals("draft", prepared.state.claim.submissionPolicy)
    assertEquals(context, prepared.state.claim.draftContext)
    assertTrue(prepared.state.draftDispositionPending)

    val restarted = T3VoiceBackgroundThreadOperationStore(storage, cipher)
    val loaded = (restarted.load() as T3VoiceBackgroundThreadOperationLoadResult.Available).state
      as T3VoiceBackgroundThreadOperationState.Active
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

  private class MemoryStore : T3VoiceBackgroundKeyValueStore {
    val values = mutableMapOf<String, String?>()
    override fun getString(key: String) = values[key]
    override fun put(values: Map<String, String?>): Boolean {
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
