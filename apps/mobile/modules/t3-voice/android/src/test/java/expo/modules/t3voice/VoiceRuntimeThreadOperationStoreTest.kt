package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeThreadOperationStoreTest {
  @Test fun `prepared claim survives create response loss and activates exact child`() {
    val store = store()
    val claim = claim()
    store.writePrepared(claim)
    assertEquals(VoiceRuntimeThreadOperationState.Prepared(claim), available(store))
    val active = VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret",
      acknowledgedCursor = 6,
      detached = true,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.WAITING, operationId = "operation-1",
        operationGeneration = 4, dispatchAcknowledged = true, eventCursor = 8,
        playbackCursor = 2, highestAdvertisedSpeechSegment = 2,
        highestStartedSpeechSegment = 2, highestDrainedSpeechSegment = 2,
        speechSegmentDispositions = (0..2).map {
          VoiceRuntimeSpeechDisposition(it, "drained")
        },
      ),
    )
    store.writeActive(active)
    assertEquals(active, available(store))
    assertTrue(store.clear(claim.clientOperationId))
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `pending receipt survives restart until exact durable publication is cleared`() {
    val store = store()
    val claim = claim()
    val receipt = VoiceRuntimeThreadReceipt(
      identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
      modeSessionId = "mode-1",
      turnClientOperationId = "client-1",
      turnOperationId = "operation-1",
      environmentId = "environment-1",
      projectId = "project-1",
      threadId = "thread-1",
      userMessageId = "message-1",
      turnId = "turn-1",
      assistantMessageIds = listOf("assistant-1"),
      speechPlanId = "speech-1",
      highestAdvertisedSegment = 2,
      highestStartedSegment = 1,
      highestDrainedSegment = 0,
      segmentDispositions = listOf(VoiceRuntimeSpeechDisposition(0, "drained")),
      speechTerminal = "completed",
      terminalOutcome = "completed",
      createdAtEpochMillis = 1_000,
      expiresAtEpochMillis = 5_000,
    )
    store.writePrepared(claim)
    store.writeActive(VoiceRuntimeThreadOperationState.Active(
      claim = claim,
      operationId = "operation-1",
      expiresAtEpochMillis = 5_000,
      token = "child-secret",
      acknowledgedCursor = 0,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1",
        readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD,
        phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1",
        operationGeneration = 4,
      ),
      pendingReceipt = receipt,
    ))

    val recovered = available(store) as VoiceRuntimeThreadOperationState.Active
    assertEquals(receipt, recovered.pendingReceipt)
    val cleared = store.updateActive(claim.clientOperationId) { it.copy(pendingReceipt = null) }
      as VoiceRuntimeThreadOperationUpdateResult.Updated
    assertEquals(null, cleared.state.pendingReceipt)
    assertEquals(null, (available(store) as VoiceRuntimeThreadOperationState.Active).pendingReceipt)
  }

  @Test fun `corrupt active state locks without clearing durable claim`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage, Cipher())
    store.writePrepared(claim())
    storage.values["thread_operation_phase"] = "active"
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Locked, store.load())
    assertTrue(storage.values.isNotEmpty())
  }

  @Test fun `parent revocation acknowledgement clears child fence after cancel rejection`() {
    val store = store()
    val prepared = VoiceRuntimeThreadOperationState.Prepared(claim())
    store.writePrepared(prepared.claim)
    val revoked = T3VoicePendingRuntimeRevocation("runtime-1", "https://example.test")
    if (VoiceRuntimeThreadRevocationPolicy.matches(prepared, revoked)) {
      assertTrue(store.clear(prepared.claim.clientOperationId))
    }
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `prepared cancellation survives ambiguous create and process death`() {
    val store = store()
    store.writePrepared(claim(), cancelRequested = true)
    assertEquals(
      VoiceRuntimeThreadOperationState.Prepared(claim(), cancelRequested = true),
      available(store),
    )
  }

  @Test fun `stop after acknowledged events keeps durable operation writable`() {
    val store = store()
    val claim = claim()
    store.writePrepared(claim)
    val active = VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret",
      acknowledgedCursor = 5,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1", operationGeneration = 4, eventCursor = 5,
      ),
    )
    store.writeActive(active)
    val stopped = VoiceRuntimeExecutionReducer.reduce(
      active.snapshot,
      VoiceRuntimeExecutionEvent.Stop,
    ).snapshot

    store.writeActive(
      active.copy(
        detached = true,
        cancelRequested = true,
        snapshot = VoiceRuntimeThreadPersistencePolicy.snapshotAfterTransition(active, stopped),
      ),
    )

    assertEquals(
      active.copy(detached = true, cancelRequested = true),
      available(store),
    )
  }

  @Test fun `locked state clears only through authority revocation cleanup`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage, Cipher())
    store.writePrepared(claim())
    storage.values.remove("thread_operation_runtime")
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Locked, store.load())
    assertTrue(store.clearLockedAfterAuthorityRevocation())
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `active update decrypts and commits only once`() {
    val storage = MemoryStore()
    val cipher = CountingCipher()
    val store = VoiceRuntimeThreadOperationStore(storage, cipher)
    val claim = claim()
    store.writePrepared(claim)
    store.writeActive(VoiceRuntimeThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret", 0,
      snapshot = VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1", operationGeneration = 4, eventCursor = 1,
      ),
    ))
    storage.putCount = 0
    cipher.encryptCount = 0
    cipher.decryptCount = 0

    val updated = store.updateActive(claim.clientOperationId) {
      it.copy(snapshot = it.snapshot.copy(eventCursor = 2))
    }

    assertEquals(
      2L,
      (updated as VoiceRuntimeThreadOperationUpdateResult.Updated).state.snapshot.eventCursor,
    )
    assertEquals(1, storage.putCount)
    assertEquals(1, cipher.decryptCount)
    assertEquals(1, cipher.encryptCount)
  }

  @Test fun `locked store rejects recording finalized transition without mutating durable cursor`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage, Cipher())
    val active = active(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.RECORDING,
        operationId = "operation-1", operationGeneration = 4,
        recordingId = "recording-1",
      ),
    )
    store.writePrepared(active.claim)
    store.writeActive(active)
    storage.values.remove("thread_operation_runtime")
    val finalized = VoiceRuntimeExecutionReducer.reduce(
      active.snapshot,
      VoiceRuntimeExecutionEvent.RecordingFinalized("operation-1", "recording-1"),
    ).snapshot

    val result = store.updateActive(active.claim.clientOperationId) {
      it.copy(snapshot = finalized)
    }

    assertEquals(VoiceRuntimeThreadOperationUpdateResult.Locked, result)
    assertEquals(VoiceRuntimePhase.RECORDING, active.snapshot.phase)
  }

  @Test fun `locked store rejects playback event transition without advancing durable state`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeThreadOperationStore(storage, Cipher())
    val active = active(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1", operationGeneration = 4,
        dispatchAcknowledged = true, eventCursor = 3,
        playbackCursor = -1, highestAdvertisedSpeechSegment = 0,
      ),
    )
    store.writePrepared(active.claim)
    store.writeActive(active)
    storage.values.remove("thread_operation_runtime")
    val playing = VoiceRuntimeExecutionReducer.reduce(
      active.snapshot,
      VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
    ).snapshot

    val result = store.updateActive(active.claim.clientOperationId) {
      it.copy(snapshot = playing)
    }

    assertEquals(VoiceRuntimeThreadOperationUpdateResult.Locked, result)
    assertEquals(VoiceRuntimePhase.WAITING, active.snapshot.phase)
    assertEquals(3L, active.snapshot.eventCursor)
  }

  @Test fun `started playback survives process death as an interrupted terminal disposition`() {
    val store = store()
    val active = active(
      VoiceRuntimeExecutionSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = VoiceRuntimeExecutionMode.THREAD, phase = VoiceRuntimePhase.WAITING,
        operationId = "operation-1", operationGeneration = 4,
        dispatchAcknowledged = true, eventCursor = 3,
        highestAdvertisedSpeechSegment = 1,
      ),
    )
    store.writePrepared(active.claim)
    store.writeActive(active)
    val started = VoiceRuntimeExecutionReducer.reduce(
      active.snapshot,
      VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
    ).snapshot
    store.updateActive(active.claim.clientOperationId) { it.copy(snapshot = started) }

    val restored = available(store) as VoiceRuntimeThreadOperationState.Active
    assertEquals(0, restored.snapshot.highestStartedSpeechSegment)
    assertEquals(-1, restored.snapshot.playbackCursor)
    val recovered = VoiceRuntimeExecutionReducer.reduce(
      restored.snapshot,
      VoiceRuntimeExecutionEvent.ProcessRestored,
    ).snapshot
    assertEquals(0, recovered.playbackCursor)
    assertEquals(
      listOf(VoiceRuntimeSpeechDisposition(0, "interrupted")),
      recovered.speechSegmentDispositions,
    )
  }

  private fun available(store: VoiceRuntimeThreadOperationStore) =
    (store.load() as VoiceRuntimeThreadOperationLoadResult.Available).state
  private fun store() = VoiceRuntimeThreadOperationStore(MemoryStore(), Cipher())
  private fun claim() = VoiceRuntimeThreadClaim(
    runtimeId = "runtime-1",
    runtimeInstanceId = "instance-1",
    readinessGeneration = 4,
    modeSessionId = "mode-1",
    environmentOrigin = "https://example.test",
    projectId = "project-1",
    threadId = "thread-1",
    clientOperationId = "client-1",
    submissionPolicy = "auto-submit",
    speechPlanId = "speech-1",
    draftContext = null,
  )
  private fun active(snapshot: VoiceRuntimeExecutionSnapshot) =
    VoiceRuntimeThreadOperationState.Active(
      claim(), "operation-1", 1_900_000_000_000, "child-secret", 0,
      snapshot = snapshot,
    )

  private class Cipher : T3VoiceRuntimeGrantCipher {
    override fun encrypt(plaintext: ByteArray, authenticatedMetadata: ByteArray) =
      T3VoiceEncryptedGrant(byteArrayOf(1), plaintext + authenticatedMetadata.size.toByte())
    override fun decrypt(encrypted: T3VoiceEncryptedGrant, authenticatedMetadata: ByteArray) =
      encrypted.ciphertext.copyOf(encrypted.ciphertext.size - 1)
    override fun deleteKey() = Unit
  }
  private class CountingCipher : T3VoiceRuntimeGrantCipher {
    var encryptCount = 0
    var decryptCount = 0
    override fun encrypt(plaintext: ByteArray, authenticatedMetadata: ByteArray): T3VoiceEncryptedGrant {
      encryptCount += 1
      return T3VoiceEncryptedGrant(byteArrayOf(1), plaintext + authenticatedMetadata.size.toByte())
    }
    override fun decrypt(encrypted: T3VoiceEncryptedGrant, authenticatedMetadata: ByteArray): ByteArray {
      decryptCount += 1
      return encrypted.ciphertext.copyOf(encrypted.ciphertext.size - 1)
    }
    override fun deleteKey() = Unit
  }
  private class MemoryStore : VoiceRuntimeKeyValueStore {
    val values = mutableMapOf<String, String>()
    var putCount = 0
    override fun getString(key: String) = values[key]
    override fun put(values: Map<String, String?>): Boolean { values.forEach { (k, v) ->
      if (v == null) this.values.remove(k) else this.values[k] = v }; putCount += 1; return true }
    override fun clear(keys: Set<String>): Boolean { keys.forEach(values::remove); return true }
  }
}
