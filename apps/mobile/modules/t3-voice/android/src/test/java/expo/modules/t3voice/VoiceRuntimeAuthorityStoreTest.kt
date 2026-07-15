package expo.modules.t3voice

import java.security.MessageDigest
import java.nio.charset.StandardCharsets
import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeAuthorityStoreTest {
  @Test
  fun `legacy v2 authority is retired once while preserving the server generation fence`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    val legacy = authority()
    storage.values.putAll(legacyV2Values(legacy, cipher))
    val store = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 })

    val retired = store.retireLegacyV2()

    assertEquals(VoiceRuntimeRetiredAuthorityFence(legacy.runtimeId, legacy.generation), retired)
    assertEquals(retired, VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 }).retireLegacyV2())
    assertEquals(VoiceRuntimeAuthorityLoadResult.Missing, store.load())
    val controller = VoiceRuntimeActiveThreadController(
      legacy.runtimeId,
      "upgrade-process",
      { 1_000 },
      { null },
      NoopThreadExecution(),
      initialGeneration = requireNotNull(retired).generation,
    )
    assertEquals(legacy.generation, controller.snapshot().identity.generation)

    val replacement = legacy.copy(readinessEnabled = false)
    store.prepareAttachedAuthority(fence(replacement), attachedReadiness())
    store.activate(replacement) {}
    assertNull(store.retiredFence())
    assertEquals(
      replacement,
      (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
  }

  @Test
  fun `exact canonical authority and encrypted token survive restart`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    val expected = authority()
    VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 }).run {
      prepareRefreshCredential(fence(), true)
      activate(expected) {}
    }

    assertFalse(storage.values.values.filterNotNull().any { "secret-token" in it })
    val loaded = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 }).load()
      as VoiceRuntimeAuthorityLoadResult.Available
    assertEquals(expected, loaded.authority)
  }

  @Test
  fun `expired or tampered canonical authority fails closed`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 }).run {
      prepareRefreshCredential(fence(), true)
      activate(authority()) {}
    }
    assertEquals(
      VoiceRuntimeAuthorityLoadResult.Locked,
      VoiceRuntimeAuthorityStore(storage, cipher, now = { 5_000 }).load(),
    )

    storage.values.entries.first { it.key.endsWith("target") }.setValue("{}")
    assertEquals(
      VoiceRuntimeAuthorityLoadResult.Locked,
      VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 }).load(),
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

  @Test
  fun `attached reservation survives process death after server grant issuance`() {
    val storage = MemoryRuntimeStorage()
    val initial = VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })
    val expected = VoiceRuntimePreparedAttachedAuthority(fence(), attachedReadiness())

    assertEquals(
      expected,
      initial.prepareAttachedAuthority(expected.fence, expected.readiness),
    )

    val restarted = VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })
    assertEquals(expected, restarted.inspectPreparedAttachedAuthority())
    val issuedGrant = authority().copy(readinessEnabled = false)
    restarted.activate(issuedGrant) {}

    assertNull(restarted.inspectPreparedAttachedAuthority())
    assertEquals(
      issuedGrant,
      (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
  }

  @Test
  fun `failed attached activation restores the exact durable reservation`() {
    val storage = MemoryRuntimeStorage()
    val expected = VoiceRuntimePreparedAttachedAuthority(fence(), attachedReadiness())
    VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })
      .prepareAttachedAuthority(expected.fence, expected.readiness)
    val restarted = VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })

    runCatching {
      restarted.activate(authority().copy(readinessEnabled = false)) {
        error("controller activation interrupted")
      }
    }

    assertEquals(VoiceRuntimeAuthorityLoadResult.Missing, restarted.load())
    assertEquals(expected, restarted.inspectPreparedAttachedAuthority())
    assertTrue(runCatching {
      restarted.prepareAttachedAuthority(
        expected.fence.copy(provisioningOperationId = "different-reservation"),
        expected.readiness,
      )
    }.isFailure)
  }

  @Test
  fun `restart requires revocation before replacing an attached reservation`() {
    val storage = MemoryRuntimeStorage()
    val original = VoiceRuntimePreparedAttachedAuthority(fence(), attachedReadiness())
    VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })
      .prepareAttachedAuthority(original.fence, original.readiness)
    val restarted = VoiceRuntimeAuthorityStore(storage, AuthorityTestCipher(), now = { 1_000 })
    val replacementFence = original.fence.copy(
      provisioningOperationId = "replacement-after-revocation",
    )

    assertTrue(runCatching {
      restarted.prepareAttachedAuthority(replacementFence, original.readiness)
    }.isFailure)

    // Service cleanup records the old runtime id for server revocation before clearing this store.
    restarted.clear()
    assertEquals(
      VoiceRuntimePreparedAttachedAuthority(replacementFence, original.readiness),
      restarted.prepareAttachedAuthority(replacementFence, original.readiness),
    )
  }

  @Test
  fun `opposing preparation types reject without mutating the first reservation`() {
    val persistentStorage = MemoryRuntimeStorage()
    val persistentStore = refreshStore(persistentStorage)
    val persistent = requireNotNull(persistentStore.prepareRefreshCredential(fence(), true))
    val persistentBefore = persistentStorage.values.toMap()
    assertTrue(runCatching {
      persistentStore.prepareAttachedAuthority(fence(), attachedReadiness())
    }.isFailure)
    assertEquals(persistentBefore, persistentStorage.values)
    assertEquals(persistent, persistentStore.inspectPreparedRefreshCredential())

    val attachedStorage = MemoryRuntimeStorage()
    val attachedStore = refreshStore(attachedStorage)
    val attached = attachedStore.prepareAttachedAuthority(fence(), attachedReadiness())
    val attachedBefore = attachedStorage.values.toMap()
    assertTrue(runCatching {
      attachedStore.prepareRefreshCredential(fence(), true)
    }.isFailure)
    assertEquals(attachedBefore, attachedStorage.values)
    assertEquals(attached, attachedStore.inspectPreparedAttachedAuthority())
  }

  @Test
  fun `failed candidate activation restores exact current authority`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    val store = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 })
    val current = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(current) {}
    val candidate = current.copy(
      generation = current.generation + 1,
      provisioningOperationId = "candidate",
      token = "candidate-secret",
    )
    store.prepareRefreshCredential(fence(candidate), true)
    val previousBytes = storage.values.toMap()

    runCatching {
      store.activate(candidate) { error("generation CAS rejected") }
    }

    assertEquals(previousBytes, storage.values)
    assertEquals(
      current,
      (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
  }

  @Test
  fun `handoff authority is encrypted and durable before atomic promotion`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    val store = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 })
    val current = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(current) {}
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-2", "thread-2", "default", true,
      2_200, null, 600_000, true, 500,
    )
    val prepared = current.copy(
      generation = current.generation + 1,
      provisioningOperationId = "handoff-action-1",
      targetDigest = T3VoiceRuntimeTargetIdentity.digest(
        VoiceRuntimeBridge.canonicalThreadTargetIdentity(target),
      ),
      target = target,
      readinessEnabled = false,
      token = "transition-secret-token",
      issuedAtEpochMillis = 0,
    )

    store.prepareTransition(prepared)

    assertEquals(current, (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
    assertFalse(storage.values.values.filterNotNull().any { it == prepared.token })
    val restarted = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 })
    runCatching { restarted.activatePreparedTransition(prepared) { error("not admitted") } }
    assertEquals(current, (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
    restarted.activatePreparedTransition(prepared) {}
    assertEquals(prepared, (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
  }

  @Test
  fun `handoff authority is discarded only for the exact prepared transition`() {
    val storage = MemoryRuntimeStorage()
    val cipher = AuthorityTestCipher()
    val store = VoiceRuntimeAuthorityStore(storage, cipher, now = { 1_000 })
    val current = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(current) {}
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-2", "thread-2", "default", true,
      2_200, null, 600_000, true, 500,
    )
    val prepared = current.copy(
      generation = current.generation + 1,
      provisioningOperationId = "handoff-action-1",
      targetDigest = T3VoiceRuntimeTargetIdentity.digest(
        VoiceRuntimeBridge.canonicalThreadTargetIdentity(target),
      ),
      target = target,
      readinessEnabled = false,
      token = "transition-secret-token",
      issuedAtEpochMillis = 0,
    )
    store.prepareTransition(prepared)

    assertFalse(store.discardPreparedTransition(prepared.copy(token = "other-token")))
    store.activatePreparedTransition(prepared) {}
    assertEquals(prepared, (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)

    store.clear()
    store.prepareRefreshCredential(fence(), true)
    store.activate(current) {}
    store.prepareTransition(prepared)
    assertTrue(store.discardPreparedTransition(prepared))
    assertFalse(store.discardPreparedTransition(prepared))
    assertEquals(current, (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
  }

  @Test
  fun `readiness preparation persists only encrypted raw refresh authority`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val expectedFence = fence()

    val prepared = requireNotNull(store.prepareRefreshCredential(expectedFence, true))

    assertTrue(prepared.credentialHash.matches(Regex("^[0-9a-f]{64}$")))
    assertFalse(storage.values.values.filterNotNull().any { it.contains("AQEBAQ") })
    assertEquals(
      prepared,
      refreshStore(storage).inspectPreparedRefreshCredential(expectedFence),
    )
  }

  @Test
  fun `disabled readiness creates no refresh authority`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    store.prepareRefreshCredential(fence(), true)

    assertNull(store.prepareRefreshCredential(fence(), false))
    assertFalse(store.hasPendingRefresh())
    assertNull(store.inspectPreparedRefreshCredential(fence()))
  }

  @Test
  fun `candidate survives process death and lost response retries exact request`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority().copy(refreshRotationCounter = 0)
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}

    val first = store.beginRefresh()
    val recovered = refreshStore(storage).beginRefresh()

    assertEquals(first, recovered)
    assertTrue(first.currentCredential.matches(Regex("^[A-Za-z0-9_-]{43}$")))
    assertTrue(first.candidateCredentialHash.matches(Regex("^[0-9a-f]{64}$")))
    assertFalse(storage.values.values.filterNotNull().any { it == first.currentCredential })
  }

  @Test
  fun `refresh promotion atomically replaces grant candidate and counter after expiry`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage, now = { 1_000 })
    val initial = authority().copy(expiresAtEpochMillis = 1_500)
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}
    val attempt = store.beginRefresh()
    val refreshed = initial.copy(
      token = "rotated-runtime-token",
      issuedAtEpochMillis = 2_000,
      expiresAtEpochMillis = 9_000,
      refreshRotationCounter = 1,
    )

    refreshStore(storage, now = { 2_000 }).promoteRefresh(attempt, refreshed) {}

    val reloaded = refreshStore(storage, now = { 2_000 })
    assertEquals(refreshed, (reloaded.load() as VoiceRuntimeAuthorityLoadResult.Available).authority)
    assertFalse(reloaded.hasPendingRefresh())
    assertEquals(1, reloaded.beginRefresh().expectedRotationCounter)
  }

  @Test
  fun `notification disable durably erases refresh authority while retaining active parent`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}

    val disabled = store.disableReadiness(initial.runtimeId, initial.generation)

    assertEquals(initial.copy(readinessEnabled = false), disabled)
    assertEquals(
      initial.copy(readinessEnabled = false),
      (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
    assertFalse(store.hasPendingRefresh())
    assertTrue(runCatching { store.beginRefresh() }.isFailure)
  }

  @Test
  fun `disabled realtime parent remains available for handoff until terminal cleanup`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val realtimeTarget = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1")
    val realtime = authority().copy(
      target = realtimeTarget,
      targetDigest = T3VoiceRuntimeTargetIdentity.digest(
        VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(realtimeTarget),
      ),
    )
    val realtimeFence = VoiceRuntimeAuthorityFence(
      realtime.runtimeId,
      realtime.generation,
      realtime.provisioningOperationId,
      realtime.targetDigest,
      realtime.target,
      T3VoiceRuntimeGrantOperation.REALTIME_START,
      realtime.environmentOrigin,
    )
    store.prepareRefreshCredential(realtimeFence, true)
    store.activate(realtime) {}
    val inFlightRefresh = store.beginRefresh()
    val disabled = requireNotNull(
      store.disableReadiness(realtime.runtimeId, realtime.generation),
    )
    val threadTarget = VoiceRuntimeTarget.Thread(
      "environment-1", "project-2", "thread-2", "default", false,
      2_200, null, 600_000, true, 0,
    )
    val transition = disabled.copy(
      generation = disabled.generation + 1,
      provisioningOperationId = "handoff-after-disable",
      target = threadTarget,
      targetDigest = T3VoiceRuntimeTargetIdentity.digest(
        VoiceRuntimeBridge.canonicalThreadTargetIdentity(threadTarget),
      ),
      token = "handoff-token",
    )

    store.prepareTransition(transition)

    assertEquals(transition, store.inspectPreparedTransition())
    assertEquals(
      disabled,
      (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
    assertEquals(inFlightRefresh, requireNotNull(store.resumeDisabledRefresh()).second)
  }

  @Test
  fun `in flight refresh retains rotated authority behind durable disable fence`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}
    val attempt = store.beginRefresh()
    val refreshed = initial.copy(
      token = "rotated-runtime-token",
      issuedAtEpochMillis = 2_000,
      expiresAtEpochMillis = 9_000,
      refreshRotationCounter = 1,
    )
    store.disableReadiness(initial.runtimeId, initial.generation)
    val restarted = refreshStore(storage)
    val recovered = requireNotNull(restarted.resumeDisabledRefresh())

    assertTrue(runCatching { store.promoteRefresh(attempt, refreshed) {} }.isFailure)
    assertEquals(initial.copy(readinessEnabled = false), recovered.first)
    assertEquals(attempt, recovered.second)
    assertEquals(
      refreshed.copy(readinessEnabled = false),
      restarted.promoteDisabledRefresh(recovered.second, refreshed),
    )
    assertEquals(
      refreshed.copy(readinessEnabled = false),
      (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
    assertFalse(restarted.hasPendingRefresh())
  }

  @Test
  fun `rejected disabled refresh is consumed and cannot replay after restart`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}
    val attempt = store.beginRefresh()
    val disabled = requireNotNull(
      store.disableReadiness(initial.runtimeId, initial.generation),
    )

    store.rejectDisabledRefresh(attempt)

    val restarted = refreshStore(storage)
    assertNull(restarted.resumeDisabledRefresh())
    assertFalse(restarted.hasPendingRefresh())
    assertEquals(
      disabled,
      (restarted.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
    assertFalse(restarted.isRefreshRejected())
  }

  @Test
  fun `old disabled refresh cannot overwrite a newly provisioned generation`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}
    val staleAttempt = store.beginRefresh()
    val staleResult = initial.copy(
      token = "stale-rotated-token",
      refreshRotationCounter = 1,
    )
    store.clear()
    val replacement = initial.copy(
      generation = 8,
      provisioningOperationId = "provision-runtime-1-8",
      token = "replacement-token",
    )
    store.prepareRefreshCredential(fence(replacement), true)
    store.activate(replacement) {}

    assertTrue(runCatching {
      store.promoteDisabledRefresh(staleAttempt, staleResult)
    }.isFailure)
    assertEquals(
      replacement,
      (store.load() as VoiceRuntimeAuthorityLoadResult.Available).authority,
    )
  }

  @Test
  fun `permanent refresh rejection fences starts and clears waiting state`() {
    val storage = MemoryRuntimeStorage()
    val store = refreshStore(storage)
    val initial = authority()
    store.prepareRefreshCredential(fence(), true)
    store.activate(initial) {}
    val attempt = store.beginRefresh()

    store.rejectRefresh(attempt)

    assertFalse(store.hasPendingRefresh())
    assertTrue(store.isRefreshRejected())
    assertEquals(VoiceRuntimeAuthorityLoadResult.Locked, store.load())
    assertNull(store.loadForRefresh())
    assertEquals(initial, store.loadRejectedAuthority())
  }

  private fun refreshStore(
    storage: MemoryRuntimeStorage,
    now: () -> Long = { 1_000 },
  ) = VoiceRuntimeAuthorityStore(
    storage,
    AuthorityTestCipher(),
    now,
    { bytes -> bytes.fill(1) },
    { "refresh-request-1" },
  )

  private fun fence(expected: VoiceRuntimePersistedAuthority = authority()): VoiceRuntimeAuthorityFence {
    return VoiceRuntimeAuthorityFence(
      expected.runtimeId,
      expected.generation,
      expected.provisioningOperationId,
      expected.targetDigest,
      expected.target,
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      expected.environmentOrigin,
    )
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

  private fun attachedReadiness() = T3VoiceReadinessConfig(
    enabled = false,
    mode = T3VoiceReadinessMode.THREAD,
    targetId = "project-1/thread-1",
    audioRouteId = "system",
    autoRearm = true,
    microphonePermissionGranted = true,
    notificationPermissionGranted = true,
    generation = 7,
  )

  private fun legacyV2Values(
    authority: VoiceRuntimePersistedAuthority,
    cipher: T3VoiceRuntimeGrantCipher,
  ): Map<String, String> {
    val target = when (val value = authority.target) {
      is VoiceRuntimeTarget.Realtime -> VoiceRuntimeBridge.canonicalRealtimeTargetIdentity(value)
      is VoiceRuntimeTarget.Thread -> VoiceRuntimeBridge.canonicalThreadTargetIdentity(value)
    }
    val metadata = listOf(
      "t3-canonical-voice-authority-v2",
      authority.runtimeId,
      authority.generation,
      authority.provisioningOperationId,
      authority.targetDigest,
      target,
      authority.environmentOrigin,
      authority.readinessEnabled,
      authority.issuedAtEpochMillis,
      authority.expiresAtEpochMillis,
    ).joinToString("\n").toByteArray(StandardCharsets.UTF_8)
    val encrypted = cipher.encrypt(authority.token.toByteArray(StandardCharsets.UTF_8), metadata)
    return mapOf(
      "canonical_authority_version" to "t3-canonical-voice-authority-v2",
      "canonical_authority_runtime_id" to authority.runtimeId,
      "canonical_authority_generation" to authority.generation.toString(),
      "canonical_authority_provisioning_operation_id" to authority.provisioningOperationId,
      "canonical_authority_target_digest" to authority.targetDigest,
      "canonical_authority_target" to target,
      "canonical_authority_environment_origin" to authority.environmentOrigin,
      "canonical_authority_readiness_enabled" to authority.readinessEnabled.toString(),
      "canonical_authority_issued_at" to authority.issuedAtEpochMillis.toString(),
      "canonical_authority_expires_at" to authority.expiresAtEpochMillis.toString(),
      "canonical_authority_iv" to Base64.getEncoder().encodeToString(encrypted.initializationVector),
      "canonical_authority_ciphertext" to Base64.getEncoder().encodeToString(encrypted.ciphertext),
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
