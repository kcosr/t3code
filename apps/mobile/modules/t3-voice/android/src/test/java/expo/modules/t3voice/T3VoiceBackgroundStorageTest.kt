package expo.modules.t3voice

import java.security.MessageDigest
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBackgroundStorageTest {
  @Test
  fun `runtime grant persists ciphertext without plaintext token`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceRuntimeGrantStore(storage, TestGrantCipher(), clockMillis = { 1_000 })
    val grant = runtimeGrant(generation = 7, token = "runtime-secret-token")

    store.provision(grant)

    assertTrue(storage.values.values.filterNotNull().none { "runtime-secret-token" in it })
    assertTrue(storage.values.values.filterNotNull().none { "thread:project-1:thread-1" in it })
    assertEquals(T3VoiceRuntimeGrantLoadResult.Available(grant), store.load())
  }

  @Test
  fun `authenticated metadata tampering locks the grant`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceRuntimeGrantStore(storage, TestGrantCipher(), clockMillis = { 1_000 })
    store.provision(runtimeGrant(generation = 7, token = "runtime-secret-token"))
    val generationKey = storage.values.keys.single { it.endsWith("readiness_generation") }
    storage.values[generationKey] = "8"

    assertEquals(T3VoiceRuntimeGrantLoadResult.Locked, store.load())
  }

  @Test
  fun `target identity digest tampering locks the grant`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceRuntimeGrantStore(storage, TestGrantCipher(), clockMillis = { 1_000 })
    store.provision(runtimeGrant(generation = 7, token = "runtime-secret-token"))
    val targetDigestKey = storage.values.keys.single { it.endsWith("target_identity_sha256") }
    storage.values[targetDigestKey] = "0".repeat(64)

    assertEquals(T3VoiceRuntimeGrantLoadResult.Locked, store.load())
  }

  @Test
  fun `expired grants do not authorize work`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceRuntimeGrantStore(storage, TestGrantCipher(), clockMillis = { 20_000 })
    val grant = runtimeGrant(generation = 7, token = "runtime-secret-token", expiresAt = 10_000)
    store.provision(grant)

    assertEquals(T3VoiceRuntimeGrantLoadResult.Expired(grant.metadata), store.load())
    assertEquals("native-runtime-1", store.validatedRuntimeId())
  }

  @Test
  fun `validated runtime identity is unavailable when authenticated metadata is corrupt`() {
    val storage = MemoryBackgroundStorage()
    val store = T3VoiceRuntimeGrantStore(storage, TestGrantCipher(), clockMillis = { 1_000 })
    store.provision(runtimeGrant(generation = 7, token = "runtime-secret-token"))
    val runtimeKey = storage.values.keys.single { it.endsWith("runtime_id") }
    storage.values[runtimeKey] = "tampered-runtime"

    assertEquals(null, store.validatedRuntimeId())
  }

  @Test
  fun `credential refresh preserves authority while target changes require a new generation`() {
    val store =
      T3VoiceRuntimeGrantStore(MemoryBackgroundStorage(), TestGrantCipher(), clockMillis = { 1_000 })
    val first = runtimeGrant(generation = 7, token = "first-token")
    store.provision(first)
    store.provision(first)

    store.provision(runtimeGrant(generation = 7, token = "refreshed-token", expiresAt = 40_000))
    assertEquals(
      "refreshed-token",
      (store.load() as T3VoiceRuntimeGrantLoadResult.Available).grant.token,
    )
    val changedAuthority =
      runtimeGrant(generation = 7, token = "wrong-authority").copy(
        metadata = first.metadata.copy(operation = T3VoiceRuntimeGrantOperation.REALTIME_START),
      )
    assertThrows(IllegalArgumentException::class.java) { store.provision(changedAuthority) }
    assertThrows(IllegalArgumentException::class.java) {
      store.provision(
        runtimeGrant(
          generation = 7,
          token = "wrong-target",
          targetIdentity = "thread:project-1:thread-2",
        ),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      store.provision(runtimeGrant(generation = 6, token = "stale-token"))
    }
    store.provision(
      runtimeGrant(
        generation = 8,
        token = "replacement-token",
        targetIdentity = "thread:project-1:thread-2",
      ),
    )
    assertTrue(
      store.loadForTarget("thread:project-1:thread-1") is
        T3VoiceRuntimeGrantLoadResult.TargetReplaced,
    )
    assertTrue(
      store.loadForTarget("thread:project-1:thread-2") is
        T3VoiceRuntimeGrantLoadResult.Available,
    )
    assertEquals(
      "replacement-token",
      (store.load() as T3VoiceRuntimeGrantLoadResult.Available).grant.token,
    )
  }

  @Test
  fun `clear deletes grant ciphertext and optionally its key`() {
    val storage = MemoryBackgroundStorage()
    val cipher = TestGrantCipher()
    val store = T3VoiceRuntimeGrantStore(storage, cipher, clockMillis = { 1_000 })
    store.provision(runtimeGrant(generation = 7, token = "runtime-secret-token"))

    store.clear(deleteKey = true)

    assertTrue(storage.values.isEmpty())
    assertTrue(cipher.deleted)
    assertEquals(T3VoiceRuntimeGrantLoadResult.Missing, store.load())
  }

  @Test
  fun `grant metadata requires a positive readiness generation`() {
    assertThrows(IllegalArgumentException::class.java) {
      runtimeGrant(generation = 0, token = "runtime-secret-token")
    }
  }

  @Test
  fun `grant token is bounded by the contract maximum`() {
    val store =
      T3VoiceRuntimeGrantStore(MemoryBackgroundStorage(), TestGrantCipher(), clockMillis = { 1_000 })
    store.provision(runtimeGrant(generation = 1, token = "a".repeat(128)))
    assertThrows(IllegalArgumentException::class.java) {
      store.provision(runtimeGrant(generation = 2, token = "a".repeat(129)))
    }
  }

  @Test
  fun `target identity is hashed natively and bounded`() {
    assertEquals(
      "98b2fd1dda06a51b7afbe90a9da4e4dd6b1fa8a7271b410a3725bdbe3fd28d16",
      T3VoiceRuntimeTargetIdentity.digest("thread:project-1:thread-1"),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeTargetIdentity.digest(" ")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeTargetIdentity.digest("a".repeat(4_097))
    }
  }

  private fun runtimeGrant(
    generation: Long,
    token: String,
    expiresAt: Long = 30_000,
    targetIdentity: String = "thread:project-1:thread-1",
  ) =
    T3VoiceRuntimeGrant(
      metadata =
        T3VoiceRuntimeGrantMetadata(
          runtimeId = "native-runtime-1",
          readinessGeneration = generation,
          environmentOrigin = "https://environment.example.test",
          operation = T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
          targetIdentityDigest = T3VoiceRuntimeTargetIdentity.digest(targetIdentity),
          expiresAtEpochMillis = expiresAt,
        ),
      token = token,
    )
}

internal class MemoryBackgroundStorage : T3VoiceBackgroundKeyValueStore {
  val values = mutableMapOf<String, String?>()

  override fun getString(key: String): String? = values[key]

  override fun put(values: Map<String, String?>): Boolean {
    values.forEach { (key, value) ->
      if (value === null) this.values.remove(key) else this.values[key] = value
    }
    return true
  }

  override fun clear(keys: Set<String>): Boolean {
    keys.forEach(values::remove)
    return true
  }
}

private class TestGrantCipher : T3VoiceRuntimeGrantCipher {
  var deleted = false

  override fun encrypt(
    plaintext: ByteArray,
    authenticatedMetadata: ByteArray,
  ): T3VoiceEncryptedGrant {
    val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
    return T3VoiceEncryptedGrant(
      initializationVector = ByteArray(12) { it.toByte() },
      ciphertext =
        mask +
          plaintext.mapIndexed { index, byte -> byte xor mask[index % mask.size] }.toByteArray(),
    )
  }

  override fun decrypt(
    encrypted: T3VoiceEncryptedGrant,
    authenticatedMetadata: ByteArray,
  ): ByteArray {
    assertArrayEquals(ByteArray(12) { it.toByte() }, encrypted.initializationVector)
    val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
    if (!mask.contentEquals(encrypted.ciphertext.copyOfRange(0, mask.size))) {
      throw SecurityException("Authenticated metadata mismatch.")
    }
    return encrypted.ciphertext
      .copyOfRange(mask.size, encrypted.ciphertext.size)
      .mapIndexed { index, byte -> byte xor mask[index % mask.size] }
      .toByteArray()
      .also { plaintext ->
        assertFalse(plaintext.isEmpty())
      }
  }

  override fun deleteKey() {
    deleted = true
  }

  private infix fun Byte.xor(other: Byte): Byte = (toInt() xor other.toInt()).toByte()
}
