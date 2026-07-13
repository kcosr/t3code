package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceBackgroundThreadOperationStoreTest {
  @Test fun `prepared claim survives create response loss and activates exact child`() {
    val store = store()
    val claim = claim()
    store.writePrepared(claim)
    assertEquals(T3VoiceBackgroundThreadOperationState.Prepared(claim), available(store))
    val active = T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret",
      acknowledgedCursor = 6,
      detached = true,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4, mode = T3VoiceBackgroundMode.THREAD,
        phase = T3VoiceBackgroundPhase.WAITING, operationId = "operation-1",
        operationGeneration = 4, dispatchAcknowledged = true, eventCursor = 8,
        playbackCursor = 2, highestAdvertisedSpeechSegment = 2,
      ),
    )
    store.writeActive(active)
    assertEquals(active, available(store))
    assertTrue(store.clear(claim.clientOperationId))
    assertEquals(T3VoiceBackgroundThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `corrupt active state locks without clearing durable claim`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundThreadOperationStore(storage, Cipher())
    store.writePrepared(claim())
    storage.values["thread_operation_phase"] = "active"
    assertEquals(T3VoiceBackgroundThreadOperationLoadResult.Locked, store.load())
    assertTrue(storage.values.isNotEmpty())
  }

  @Test fun `parent revocation acknowledgement clears child fence after cancel rejection`() {
    val store = store()
    val prepared = T3VoiceBackgroundThreadOperationState.Prepared(claim())
    store.writePrepared(prepared.claim)
    val revoked = T3VoicePendingRuntimeRevocation("runtime-1", "https://example.test")
    if (T3VoiceBackgroundThreadRevocationPolicy.matches(prepared, revoked)) {
      assertTrue(store.clear(prepared.claim.clientOperationId))
    }
    assertEquals(T3VoiceBackgroundThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `prepared cancellation survives ambiguous create and process death`() {
    val store = store()
    store.writePrepared(claim(), cancelRequested = true)
    assertEquals(
      T3VoiceBackgroundThreadOperationState.Prepared(claim(), cancelRequested = true),
      available(store),
    )
  }

  @Test fun `stop after acknowledged events keeps durable operation writable`() {
    val store = store()
    val claim = claim()
    store.writePrepared(claim)
    val active = T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret",
      acknowledgedCursor = 5,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.WAITING,
        operationId = "operation-1", operationGeneration = 4, eventCursor = 5,
      ),
    )
    store.writeActive(active)
    val stopped = T3VoiceBackgroundReducer.reduce(
      active.snapshot,
      T3VoiceBackgroundEvent.Stop,
    ).snapshot

    store.writeActive(
      active.copy(
        detached = true,
        cancelRequested = true,
        snapshot = T3VoiceBackgroundThreadPersistencePolicy.snapshotAfterTransition(active, stopped),
      ),
    )

    assertEquals(
      active.copy(detached = true, cancelRequested = true),
      available(store),
    )
  }

  @Test fun `locked state clears only through authority revocation cleanup`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundThreadOperationStore(storage, Cipher())
    store.writePrepared(claim())
    storage.values.remove("thread_operation_runtime")
    assertEquals(T3VoiceBackgroundThreadOperationLoadResult.Locked, store.load())
    assertTrue(store.clearLockedAfterAuthorityRevocation())
    assertEquals(T3VoiceBackgroundThreadOperationLoadResult.Missing, store.load())
  }

  @Test fun `active update decrypts and commits only once`() {
    val storage = MemoryStore()
    val cipher = CountingCipher()
    val store = T3VoiceBackgroundThreadOperationStore(storage, cipher)
    val claim = claim()
    store.writePrepared(claim)
    store.writeActive(T3VoiceBackgroundThreadOperationState.Active(
      claim, "operation-1", 1_900_000_000_000, "child-secret", 0,
      snapshot = T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.WAITING,
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
      (updated as T3VoiceBackgroundThreadOperationUpdateResult.Updated).state.snapshot.eventCursor,
    )
    assertEquals(1, storage.putCount)
    assertEquals(1, cipher.decryptCount)
    assertEquals(1, cipher.encryptCount)
  }

  @Test fun `locked store rejects recording finalized transition without mutating durable cursor`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundThreadOperationStore(storage, Cipher())
    val active = active(
      T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.RECORDING,
        operationId = "operation-1", operationGeneration = 4,
        recordingId = "recording-1",
      ),
    )
    store.writePrepared(active.claim)
    store.writeActive(active)
    storage.values.remove("thread_operation_runtime")
    val finalized = T3VoiceBackgroundReducer.reduce(
      active.snapshot,
      T3VoiceBackgroundEvent.RecordingFinalized("operation-1", "recording-1"),
    ).snapshot

    val result = store.updateActive(active.claim.clientOperationId) {
      it.copy(snapshot = finalized)
    }

    assertEquals(T3VoiceBackgroundThreadOperationUpdateResult.Locked, result)
    assertEquals(T3VoiceBackgroundPhase.RECORDING, active.snapshot.phase)
  }

  @Test fun `locked store rejects playback event transition without advancing durable state`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundThreadOperationStore(storage, Cipher())
    val active = active(
      T3VoiceBackgroundSnapshot(
        runtimeId = "runtime-1", readinessGeneration = 4,
        mode = T3VoiceBackgroundMode.THREAD, phase = T3VoiceBackgroundPhase.WAITING,
        operationId = "operation-1", operationGeneration = 4,
        dispatchAcknowledged = true, eventCursor = 3,
        playbackCursor = -1, highestAdvertisedSpeechSegment = 0,
      ),
    )
    store.writePrepared(active.claim)
    store.writeActive(active)
    storage.values.remove("thread_operation_runtime")
    val playing = T3VoiceBackgroundReducer.reduce(
      active.snapshot,
      T3VoiceBackgroundEvent.PlaybackStarted("operation-1", 0),
    ).snapshot

    val result = store.updateActive(active.claim.clientOperationId) {
      it.copy(snapshot = playing)
    }

    assertEquals(T3VoiceBackgroundThreadOperationUpdateResult.Locked, result)
    assertEquals(T3VoiceBackgroundPhase.WAITING, active.snapshot.phase)
    assertEquals(3L, active.snapshot.eventCursor)
  }

  private fun available(store: T3VoiceBackgroundThreadOperationStore) =
    (store.load() as T3VoiceBackgroundThreadOperationLoadResult.Available).state
  private fun store() = T3VoiceBackgroundThreadOperationStore(MemoryStore(), Cipher())
  private fun claim() = T3VoiceBackgroundThreadClaim("runtime-1", 4, "https://example.test",
    "project-1", "thread-1", "client-1")
  private fun active(snapshot: T3VoiceBackgroundSnapshot) =
    T3VoiceBackgroundThreadOperationState.Active(
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
  private class MemoryStore : T3VoiceBackgroundKeyValueStore {
    val values = mutableMapOf<String, String>()
    var putCount = 0
    override fun getString(key: String) = values[key]
    override fun put(values: Map<String, String?>): Boolean { values.forEach { (k, v) ->
      if (v == null) this.values.remove(k) else this.values[k] = v }; putCount += 1; return true }
    override fun clear(keys: Set<String>): Boolean { keys.forEach(values::remove); return true }
  }
}
