package expo.modules.t3voice

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeAuthorityStoreTest {
  @Test
  fun `exact canonical authority and encrypted token survive restart`() {
    val storage = MemoryBackgroundStorage()
    val cipher = AuthorityTestCipher()
    val expected = authority()
    VoiceRuntimeAuthorityStore(storage, cipher) { 1_000 }.write(expected)

    assertFalse(storage.values.values.filterNotNull().any { "secret-token" in it })
    val loaded = VoiceRuntimeAuthorityStore(storage, cipher) { 1_000 }.load()
      as VoiceRuntimeAuthorityLoadResult.Available
    assertEquals(expected, loaded.authority)
  }

  @Test
  fun `expired or tampered canonical authority fails closed`() {
    val storage = MemoryBackgroundStorage()
    val cipher = AuthorityTestCipher()
    VoiceRuntimeAuthorityStore(storage, cipher) { 1_000 }.write(authority())
    assertEquals(
      VoiceRuntimeAuthorityLoadResult.Locked,
      VoiceRuntimeAuthorityStore(storage, cipher) { 5_000 }.load(),
    )

    storage.values.entries.first { it.key.endsWith("target") }.setValue("{}")
    assertEquals(
      VoiceRuntimeAuthorityLoadResult.Locked,
      VoiceRuntimeAuthorityStore(storage, cipher) { 1_000 }.load(),
    )
  }

  @Test
  fun `authority can be re-fenced to a new process instance`() {
    val expected = authority()
    val installed = VoiceRuntimeInstalledAuthority(
      expected.runtimeId,
      expected.generation,
      expected.targetDigest,
      expected.token,
      expected.expiresAtEpochMillis,
    )
    val controller = VoiceRuntimeActiveThreadController(
      expected.runtimeId,
      "new-process-instance",
      { 1_000 },
      { installed },
      NoopThreadExecution(),
    )
    val snapshot = controller.configureAuthority(
      VoiceRuntimeAuthorityReservation(
        VoiceRuntimeIdentity(expected.runtimeId, "new-process-instance", expected.generation),
        "restore-new-process-instance",
        expected.generation - 1,
        expected.targetDigest,
        expected.token,
        expected.issuedAtEpochMillis,
        expected.expiresAtEpochMillis,
      ),
      expected.target as VoiceRuntimeTarget.Thread,
      "restore-fingerprint",
    )
    assertEquals(VoiceRuntimeAvailability.READY, snapshot.availability)
    assertEquals("new-process-instance", snapshot.identity.runtimeInstanceId)
  }

  @Test
  fun `attached-only authority survives active detach and rejects idle detached start`() {
    assertTrue(VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(false, 1))
    assertFalse(VoiceRuntimeAuthorityLifecyclePolicy.canDispatch(false, 0))
    assertFalse(VoiceRuntimeAuthorityLifecyclePolicy.shouldClear(false, 0, false))
    assertTrue(VoiceRuntimeAuthorityLifecyclePolicy.shouldClear(false, 0, true))
    assertFalse(VoiceRuntimeAuthorityLifecyclePolicy.shouldClear(true, 0, true))
  }

  private fun authority(): VoiceRuntimePersistedAuthority {
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, 60_000, 600_000, true, 500,
    )
    return VoiceRuntimePersistedAuthority(
      "runtime-1",
      7,
      "provision-runtime-1-7",
      T3VoiceRuntimeTargetIdentity.digest(VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)),
      target,
      "https://termstation",
      true,
      "secret-token",
      500,
      5_000,
    )
  }

  private class NoopThreadExecution : VoiceRuntimeThreadExecution {
    override fun start(modeSessionId: String, turnClientOperationId: String, submissionPolicy: String,
      draftContext: VoiceRuntimeDraftContext?) = true
    override fun finish(outcome: String, draftContext: VoiceRuntimeDraftContext?) = true
    override fun cancel() = true
    override fun stop(policy: String) = true
    override fun acknowledgeDraft(artifactId: String, outcome: String) = true
  }

  private class AuthorityTestCipher : T3VoiceRuntimeGrantCipher {
    override fun encrypt(plaintext: ByteArray, authenticatedMetadata: ByteArray): T3VoiceEncryptedGrant {
      val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
      return T3VoiceEncryptedGrant(
        ByteArray(12),
        mask + plaintext.mapIndexed { index, byte ->
          (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
        },
      )
    }

    override fun decrypt(encrypted: T3VoiceEncryptedGrant, authenticatedMetadata: ByteArray): ByteArray {
      val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
      require(encrypted.ciphertext.copyOfRange(0, mask.size).contentEquals(mask))
      return encrypted.ciphertext.copyOfRange(mask.size, encrypted.ciphertext.size)
        .mapIndexed { index, byte ->
          (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
        }.toByteArray()
    }

    override fun deleteKey() = Unit
  }
}
