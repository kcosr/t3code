package expo.modules.t3voice

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeAuthorityStoreTest {
  @Test
  fun `canonical authority persists tokenless and fails closed on tamper`() {
    val storage = MemoryRuntimeStorage()
    val expected = authority()
    VoiceRuntimeAuthorityStore(storage, TestCipher()).activate(expected) {}

    assertFalse(storage.values.values.filterNotNull().any { "credential" in it })
    assertEquals(
      expected,
      (VoiceRuntimeAuthorityStore(storage, TestCipher()).load()
        as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )

    storage.values["canonical_authority_target"] = "{}"
    assertEquals(
      VoiceRuntimeAuthorityLoadResult.Locked,
      VoiceRuntimeAuthorityStore(storage, TestCipher()).load(),
    )
  }

  @Test
  fun `readiness disable is fenced and durable`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeAuthorityStore(storage, TestCipher())
    val expected = authority()
    store.activate(expected) {}

    assertNull(store.disableReadiness(expected.runtimeId, expected.generation + 1))
    assertEquals(
      expected.copy(readinessEnabled = false),
      store.disableReadiness(expected.runtimeId, expected.generation),
    )
    assertFalse(
      ((VoiceRuntimeAuthorityStore(storage, TestCipher()).load()
        as VoiceRuntimeAuthorityLoadResult.Available).authority).readinessEnabled,
    )
  }

  @Test
  fun `prepared transition survives restart and activates atomically`() {
    val storage = MemoryRuntimeStorage()
    val source = authority()
    val target = authority(
      generation = source.generation + 1,
      target = VoiceRuntimeTarget.Thread(
        "environment-1", "project-1", "thread-2", "default", true,
        2_200, 60_000, 600_000, true, 500,
      ),
      readinessEnabled = false,
    )
    VoiceRuntimeAuthorityStore(storage, TestCipher()).run {
      activate(source) {}
      prepareTransition(target)
    }

    val restarted = VoiceRuntimeAuthorityStore(storage, TestCipher())
    assertEquals(target, restarted.inspectPreparedTransition())
    restarted.activatePreparedTransition(target) {}
    assertNull(restarted.inspectPreparedTransition())
    assertEquals(
      target,
      (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
  }

  @Test
  fun `failed transition activation restores source and prepared target`() {
    val storage = MemoryRuntimeStorage()
    val source = authority()
    val target = authority(generation = 8, readinessEnabled = false)
    val store = VoiceRuntimeAuthorityStore(storage, TestCipher())
    store.activate(source) {}
    store.prepareTransition(target)

    assertTrue(runCatching { store.activatePreparedTransition(target) { error("stop") } }.isFailure)
    assertEquals(source, (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
    assertEquals(target, store.inspectPreparedTransition())
  }

  @Test
  fun `legacy authority retirement preserves generation fence`() {
    val storage = MemoryRuntimeStorage()
    storage.values["canonical_authority_version"] = "t3-canonical-voice-authority-v2"
    storage.values["canonical_authority_runtime_id"] = "runtime-1"
    storage.values["canonical_authority_generation"] = "7"
    val store = VoiceRuntimeAuthorityStore(storage, TestCipher())

    val expected = VoiceRuntimeRetiredAuthorityFence("runtime-1", 7)
    assertEquals(expected, store.retireLegacyV2())
    assertEquals(expected, VoiceRuntimeAuthorityStore(storage, TestCipher()).retireLegacyV2())
    assertEquals(VoiceRuntimeAuthorityLoadResult.Missing, store.load())
  }

  private fun authority(
    generation: Long = 7,
    target: VoiceRuntimeTarget = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, 60_000, 600_000, true, 500,
    ),
    readinessEnabled: Boolean = true,
  ): VoiceRuntimePersistedAuthority {
    val targetIdentity = when (target) {
      is VoiceRuntimeTarget.Realtime -> VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(target)
      is VoiceRuntimeTarget.Thread -> VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)
    }
    return VoiceRuntimePersistedAuthority(
      "runtime-1",
      generation,
      T3VoiceRuntimeTargetIdentity.digest(targetIdentity),
      target,
      "https://termstation",
      readinessEnabled,
    )
  }
}

internal class VoiceRuntimeSessionCredentialStoreTest {
  @Test
  fun `credential set overwrite and restart preserve only latest encrypted value`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeSessionCredentialStore(storage, TestCipher())
    store.set("https://termstation/", "credential-one")
    store.set("https://termstation", "credential-two")

    assertFalse(storage.values.values.filterNotNull().any { "credential-two" in it })
    val loaded = VoiceRuntimeSessionCredentialStore(storage, TestCipher()).load()
      as VoiceRuntimeSessionCredentialLoadResult.Available
    assertEquals("https://termstation", loaded.value.environmentOrigin)
    assertEquals("credential-two", loaded.value.credential.value)
  }

  @Test
  fun `credential origin is authenticated and tamper fails closed`() {
    val storage = MemoryRuntimeStorage()
    VoiceRuntimeSessionCredentialStore(storage, TestCipher())
      .set("https://termstation", "credential-one")
    storage.values["runtime_session_credential_origin"] = "https://other.example"

    assertEquals(
      VoiceRuntimeSessionCredentialLoadResult.Locked,
      VoiceRuntimeSessionCredentialStore(storage, TestCipher()).load(),
    )
  }

  @Test
  fun `credential clear removes storage`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeSessionCredentialStore(storage, TestCipher())
    store.set("https://termstation", "credential-one")
    store.clear()
    assertEquals(VoiceRuntimeSessionCredentialLoadResult.Missing, store.load())
  }
}

private class TestCipher : T3VoiceRuntimeGrantCipher {
  override fun encrypt(
    plaintext: ByteArray,
    authenticatedMetadata: ByteArray,
  ): T3VoiceEncryptedGrant {
    val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
    return T3VoiceEncryptedGrant(
      ByteArray(12),
      mask + plaintext.mapIndexed { index, byte ->
        (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
      },
    )
  }

  override fun decrypt(
    encrypted: T3VoiceEncryptedGrant,
    authenticatedMetadata: ByteArray,
  ): ByteArray {
    val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
    require(encrypted.ciphertext.copyOfRange(0, mask.size).contentEquals(mask))
    return encrypted.ciphertext.copyOfRange(mask.size, encrypted.ciphertext.size)
      .mapIndexed { index, byte ->
        (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
      }.toByteArray()
  }

  override fun deleteKey() = Unit
}
