package expo.modules.t3voice

import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

internal class VoiceRuntimeRealtimeCheckpointStoreTest {
  @Test
  fun `complete checkpoint and both credentials survive process restart encrypted`() {
    val storage = MemoryStore()
    val cipher = AuthenticatedTestCipher()
    val expected = checkpoint()

    VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher).save(expected)

    assertEquals(1, storage.putCount)
    assertEquals(setOf("canonical_realtime_checkpoint_v1"), storage.values.keys)
    assertFalse(storage.values.values.any { CONTROL_TOKEN in it })
    assertFalse(storage.values.values.any { TRANSITION_TOKEN in it })
    assertEquals(
      expected,
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher).load(),
    )
  }

  @Test
  fun `all pending action variants round trip with strict tagged schemas`() {
    val actions = listOf(
      VoiceRuntimeRealtimeAction.NavigateThread(
        12, 1_200, "action-nav", "project-1", "thread-1", 9_000,
      ),
      VoiceRuntimeRealtimeAction.HandoffToThreadVoice(
        12, 1_200, "action-handoff", "project-1", "thread-1", true, 9_000,
      ),
      VoiceRuntimeRealtimeAction.StopRealtimeVoice(12, 1_200),
      VoiceRuntimeRealtimeAction.ConfirmationRequired(
        12, 1_200, "action-confirm", "confirmation-1", "tool-call-1", "send_message",
        "Send a synchronous message", 9_000,
      ),
    )

    actions.forEach { action ->
      val storage = MemoryStore()
      val expected = checkpoint().copy(pendingAction = action)
      val repository =
        VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
      repository.save(expected)
      assertEquals(expected, repository.load())
    }
  }

  @Test
  fun `authenticated metadata tampering and malformed state fail closed`() {
    val storage = MemoryStore()
    val repository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    repository.save(checkpoint())
    val envelope = JSONObject(storage.values.getValue("canonical_realtime_checkpoint_v1"))
    val metadata = JSONObject(envelope.getString("metadata"))
      .put("phase", VoiceRealtimePhase.CONNECTED.name)
    storage.values["canonical_realtime_checkpoint_v1"] =
      envelope.put("metadata", metadata.toString()).toString()

    assertCorrupt { repository.load() }
    assertTrue(storage.values.containsKey("canonical_realtime_checkpoint_v1"))

    storage.values["canonical_realtime_checkpoint_v1"] = "{}"
    assertCorrupt { repository.load() }
    assertTrue(storage.values.containsKey("canonical_realtime_checkpoint_v1"))
  }

  @Test
  fun `clear requires the exact runtime and mode session fence`() {
    val storage = MemoryStore()
    val repository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    val expected = checkpoint()
    repository.save(expected)

    repository.clear(
      expected.fence.copy(
        identity = expected.fence.identity.copy(runtimeInstanceId = "another-process"),
      ),
    )
    assertEquals(expected, repository.load())

    repository.clear(expected.fence.copy(modeSessionId = "another-mode-session"))
    assertEquals(expected, repository.load())

    repository.clear(expected.fence)
    assertNull(repository.load())
  }

  @Test
  fun `checkpoint promotes atomically to encrypted finalization and survives terminal ack`() {
    val storage = MemoryStore()
    val cipher = AuthenticatedTestCipher()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher)
    val checkpoint = checkpoint()
    val expected = finalization(checkpoint)
    repository.save(checkpoint)

    repository.installFinalization(checkpoint, expected)

    assertNull(repository.load())
    assertEquals(expected, repository.loadFinalization())
    assertEquals(setOf("canonical_realtime_finalization_v1"), storage.values.keys)
    assertFalse(storage.values.values.any { CONTROL_TOKEN in it || TRANSITION_TOKEN in it })
    expectThrows<IllegalArgumentException> {
      repository.saveFinalization(expected.copy(closeOperationId = "different-close-operation"))
    }

    val summary = terminal(1, expiresAt = 10_000)
    repository.publishTerminal(summary)
    assertTrue(repository.acknowledgeTerminal(VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
      summary.identity,
      summary.modeSessionId,
    )))
    assertEquals(expected, repository.loadFinalization())

    val pending = expected.copy(
      attemptCount = 1,
      lastFailureCode = "network-unavailable",
      lastFailureRetryable = true,
      terminalPublication = VoiceRuntimeRealtimeTerminalPublication.CLEANUP_PENDING,
    )
    repository.saveFinalization(pending)
    val restarted = VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher)
    assertEquals(pending, restarted.loadFinalization())
    restarted.clearFinalization(pending.fence, pending.session.state.sessionId)
    assertNull(restarted.loadFinalization())
  }

  @Test
  fun `finalization tampering fails closed independently of terminal summaries`() {
    val storage = MemoryStore()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(
      storage,
      AuthenticatedTestCipher(),
    )
    val expected = finalization(checkpoint())
    repository.installFinalization(null, expected)
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    val envelope = JSONObject(storage.values.getValue("canonical_realtime_finalization_v1"))
    val metadata = JSONObject(envelope.getString("metadata"))
      .put("stage", VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING.name)
    storage.values["canonical_realtime_finalization_v1"] =
      envelope.put("metadata", metadata.toString()).toString()

    assertCorrupt { repository.loadFinalization() }
    assertEquals(1, repository.terminals(100).size)
  }

  @Test
  fun `exact legacy finalization fixture recovers and rewrites canonical shape`() {
    val storage = MemoryStore().also {
      it.values["canonical_realtime_finalization_v1"] = LEGACY_FINALIZATION_V1_FIXTURE
    }
    val cipher = AuthenticatedTestCipher()
    val expected = finalization(checkpoint()).copy(
      sourceAuthorityExpiresAtEpochMillis = 8_000,
    )

    val recovered = VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher)
      .loadFinalization()

    assertEquals(expected, recovered)
    assertEquals(1, storage.putCount)
    val rewritten = storage.values.getValue("canonical_realtime_finalization_v1")
    assertFalse(rewritten == LEGACY_FINALIZATION_V1_FIXTURE)
    assertEquals(
      8_000L,
      JSONObject(JSONObject(rewritten).getString("metadata"))
        .getLong("sourceAuthorityExpiresAtEpochMillis"),
    )
    assertFalse(CONTROL_TOKEN in rewritten || TRANSITION_TOKEN in rewritten)

    assertEquals(
      expected,
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher).loadFinalization(),
    )
    assertEquals(1, storage.putCount)
  }

  @Test
  fun `tampered legacy finalization fixture fails closed without rewrite`() {
    val envelope = JSONObject(LEGACY_FINALIZATION_V1_FIXTURE)
    val tampered = envelope.put(
      "metadata",
      JSONObject(envelope.getString("metadata")).put("reason", "tampered").toString(),
    ).toString()
    val storage = MemoryStore().also {
      it.values["canonical_realtime_finalization_v1"] = tampered
    }

    assertCorrupt {
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
        .loadFinalization()
    }

    assertEquals(tampered, storage.values.getValue("canonical_realtime_finalization_v1"))
    assertEquals(0, storage.putCount)
  }

  @Test
  fun `full terminal retention preserves every unacknowledged summary`() {
    val storage = MemoryStore()
    val repository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    repository.publishTerminal(terminal(0, expiresAt = 50))
    repeat(64) { index ->
      repository.publishTerminal(terminal(index + 1, expiresAt = 10_000))
    }
    repository.publishTerminal(
      terminal(64, expiresAt = 12_000).copy(reason = "replacement"),
    )
    assertFalse(repository.hasTerminalCapacity(
      VoiceRuntimeRealtimeFence(
        VoiceRuntimeIdentity("runtime-1", "process-1", 7),
        "mode-65",
      ),
      100,
    ))
    expectThrows<VoiceRuntimeRetentionCapacityException> {
      repository.publishTerminal(terminal(65, expiresAt = 12_000))
    }

    val restarted =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    val values = restarted.terminals(100)

    assertEquals(64, values.size)
    assertEquals(1, values.count { it.modeSessionId == "mode-64" })
    assertEquals("replacement", values.single { it.modeSessionId == "mode-64" }.reason)
    assertTrue(values.any { it.modeSessionId == "mode-1" })
    assertTrue(values.none { it.modeSessionId == "mode-65" })
    val acknowledged = values.single { it.modeSessionId == "mode-42" }
    assertTrue(restarted.acknowledgeTerminal(VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
      acknowledged.identity, acknowledged.modeSessionId,
    )))
    restarted.publishTerminal(terminal(66, expiresAt = 12_000))
    assertEquals(64, restarted.terminals(100).size)
    assertFalse(restarted.acknowledgeTerminal(VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
      acknowledged.identity.copy(runtimeInstanceId = "wrong-process"), acknowledged.modeSessionId,
    )))
    assertTrue(restarted.terminals(12_000).isEmpty())
    assertFalse(storage.values.values.any { CONTROL_TOKEN in it || TRANSITION_TOKEN in it })
  }

  @Test
  fun `finalization never evicts retained terminals and acknowledgement restores capacity`() {
    val storage = MemoryStore()
    val cipher = AuthenticatedTestCipher()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage, cipher, 2)
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    repository.publishTerminal(terminal(2, expiresAt = 10_000))
    val checkpoint = checkpoint()
    val finalization = finalization(checkpoint)
    repository.save(checkpoint)

    repository.installFinalization(checkpoint, finalization)

    assertEquals(listOf("mode-1", "mode-2"), repository.terminals(100).map { it.modeSessionId })
    assertFalse(repository.hasTerminalCapacity(
      VoiceRuntimeRealtimeFence(
        VoiceRuntimeIdentity("runtime-1", "process-1", 7),
        "mode-3",
      ),
      100,
    ))
    expectThrows<VoiceRuntimeRetentionCapacityException> {
      repository.publishTerminal(terminal(3, expiresAt = 10_000))
    }
    val acknowledged = repository.terminals(100).single { it.modeSessionId == "mode-1" }
    assertTrue(repository.acknowledgeTerminal(VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
      acknowledged.identity,
      acknowledged.modeSessionId,
    )))
    repository.publishTerminal(terminal(3, expiresAt = 10_000))
    repository.clearFinalization(finalization.fence, finalization.session.state.sessionId)
    repository.save(checkpoint.copy(rootCommandId = "future-start"))

    assertEquals(listOf("mode-2", "mode-3"), repository.terminals(100).map { it.modeSessionId })
    assertEquals("future-start", repository.load()?.rootCommandId)
    assertNull(repository.loadFinalization())
  }

  @Test
  fun `terminal corruption fails closed without affecting a valid checkpoint`() {
    val storage = MemoryStore()
    val repository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    repository.save(checkpoint())
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    storage.values["canonical_realtime_terminals_v1"] =
      JSONObject(storage.values.getValue("canonical_realtime_terminals_v1"))
        .put("unexpected", true)
        .toString()

    assertCorrupt { repository.terminals(100) }
    assertEquals(checkpoint(), repository.load())
  }

  private fun checkpoint(): VoiceRuntimeRealtimeCheckpoint {
    val identity = VoiceRuntimeIdentity("runtime-1", "process-1", 7)
    val target = VoiceRuntimeRealtimeThreadTarget(
      environmentId = "environment-1",
      projectId = "project-1",
      threadId = "thread-1",
      speechPreset = "default",
      autoRearm = true,
      endpointPolicy = VoiceRuntimeRealtimeEndpointPolicy(2_200, 60_000, 600_000),
      speechEnabled = true,
      rearmGuardMs = 500,
    )
    return VoiceRuntimeRealtimeCheckpoint(
      fence = VoiceRuntimeRealtimeFence(identity, "mode-realtime-1"),
      target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
      rootCommandId = "start-realtime-1",
      phase = VoiceRealtimePhase.DRAINING,
      serverSessionId = "session-1",
      leaseGeneration = 3,
      controlGrant = VoiceRuntimeRealtimeControlGrant(
        CONTROL_TOKEN,
        expiresAtEpochMillis = 8_000,
        heartbeatIntervalSeconds = 15,
        failureGraceSeconds = 45,
      ),
      lastActionSequence = 10,
      lastConnectedAtEpochMillis = 1_500,
      pendingAction = VoiceRuntimeRealtimeAction.ConfirmationRequired(
        11, 1_800, "action-confirm", "confirmation-1", "tool-call-1", "send_message",
        "Send a synchronous message", 9_000,
      ),
      pendingHandoffExchange = VoiceRuntimeRealtimeHandoffExchangeResult(
        actionId = "action-handoff",
        actionSequence = 10,
        projectId = "project-1",
        threadId = "thread-1",
        autoRearm = true,
        transitionGrant = VoiceRuntimeRealtimeTransitionGrant(
          token = TRANSITION_TOKEN,
          expiresAtEpochMillis = 8_500,
          generation = 8,
          modeSessionId = "mode-thread-1",
          target = target,
        ),
        replayed = false,
      ),
      drainDeadlineAtEpochMillis = 4_000,
    )
  }

  private fun terminal(index: Int, expiresAt: Long) = VoiceRuntimeRealtimeTerminalSummary(
    identity = VoiceRuntimeIdentity("runtime-$index", "process-$index", 1),
    modeSessionId = "mode-$index",
    environmentId = "environment-$index",
    conversationId = "conversation-$index",
    sessionId = "session-$index",
    outcome = VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
    reason = "completed",
    lastConnectedAtEpochMillis = 10,
    terminalAtEpochMillis = index.toLong() + 20,
    serverCleanupPending = false,
    expiresAtEpochMillis = expiresAt,
  )

  private fun finalization(checkpoint: VoiceRuntimeRealtimeCheckpoint) =
    VoiceRuntimeRealtimeFinalization(
      fence = checkpoint.fence,
      sourceTarget = checkpoint.target,
      sourceEnvironmentOrigin = "https://environment.example.test",
      sourceAuthorityExpiresAtEpochMillis = 120_000,
      rootCommandId = checkpoint.rootCommandId,
      session = VoiceRuntimeRealtimeStartResult(
        VoiceRuntimeRealtimeSessionState(
          requireNotNull(checkpoint.serverSessionId),
          checkpoint.target.conversationId,
          "signaling",
          requireNotNull(checkpoint.leaseGeneration),
          checkpoint.lastActionSequence,
        ),
        "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
        8_000,
        requireNotNull(checkpoint.controlGrant),
      ),
      closeOperationId = "${checkpoint.rootCommandId}.close.thread-handoff",
      outcome = VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
      reason = "thread-handoff",
      lastConnectedAtEpochMillis = checkpoint.lastConnectedAtEpochMillis,
      handoffExchange = checkpoint.pendingHandoffExchange,
      stage = VoiceRuntimeRealtimeFinalizationStage.HANDOFF_COMMIT_PENDING,
    )

  private fun assertCorrupt(block: () -> Unit) {
    try {
      block()
      fail("Expected durable Realtime state corruption.")
    } catch (_: VoiceRuntimeDurableStateCorruptionException) {
      // Expected: corrupted durable state is never treated as absent.
    }
  }

  private inline fun <reified T : Throwable> expectThrows(block: () -> Unit) {
    try {
      block()
      fail("Expected ${T::class.java.simpleName}")
    } catch (cause: Throwable) {
      if (cause !is T) throw cause
    }
  }

  private class MemoryStore : VoiceRuntimeKeyValueStore {
    val values = linkedMapOf<String, String>()
    var putCount = 0

    override fun getString(key: String): String? = values[key]

    override fun put(values: Map<String, String?>): Boolean {
      putCount += 1
      values.forEach { (key, value) ->
        if (value == null) this.values.remove(key) else this.values[key] = value
      }
      return true
    }

    override fun clear(keys: Set<String>): Boolean {
      keys.forEach(values::remove)
      return true
    }
  }

  private class AuthenticatedTestCipher : T3VoiceRuntimeGrantCipher {
    override fun encrypt(
      plaintext: ByteArray,
      authenticatedMetadata: ByteArray,
    ): T3VoiceEncryptedGrant {
      val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
      val protected = plaintext.mapIndexed { index, byte ->
        (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
      }.toByteArray()
      return T3VoiceEncryptedGrant(ByteArray(12), mask + protected)
    }

    override fun decrypt(
      encrypted: T3VoiceEncryptedGrant,
      authenticatedMetadata: ByteArray,
    ): ByteArray {
      val mask = MessageDigest.getInstance("SHA-256").digest(authenticatedMetadata)
      require(encrypted.ciphertext.size >= mask.size)
      require(encrypted.ciphertext.copyOfRange(0, mask.size).contentEquals(mask))
      return encrypted.ciphertext.copyOfRange(mask.size, encrypted.ciphertext.size)
        .mapIndexed { index, byte ->
          (byte.toInt() xor mask[index % mask.size].toInt()).toByte()
        }
        .toByteArray()
    }

    override fun deleteKey() = Unit
  }

  private companion object {
    const val CONTROL_TOKEN = "control-secret-token"
    const val TRANSITION_TOKEN = "handoff-secret-token"
    const val LEGACY_FINALIZATION_V1_FIXTURE = """{"version":"t3-voice-runtime-realtime-checkpoint-v1","metadata":"{\"version\":\"t3-voice-runtime-realtime-checkpoint-v1\",\"fence\":{\"runtimeId\":\"runtime-1\",\"runtimeInstanceId\":\"process-1\",\"generation\":7,\"modeSessionId\":\"mode-realtime-1\"},\"sourceTarget\":{\"environmentId\":\"environment-1\",\"conversationId\":\"conversation-1\"},\"sourceEnvironmentOrigin\":\"https://environment.example.test\",\"rootCommandId\":\"start-realtime-1\",\"session\":{\"state\":{\"sessionId\":\"session-1\",\"conversationId\":\"conversation-1\",\"phase\":\"signaling\",\"leaseGeneration\":3,\"sequence\":10},\"signalingPath\":\"/api/voice/runtime/realtime-sessions/session-1/webrtc-offer\",\"expiresAtEpochMillis\":8000,\"controlGrant\":{\"expiresAtEpochMillis\":8000,\"heartbeatIntervalSeconds\":15,\"failureGraceSeconds\":45}},\"closeOperationId\":\"start-realtime-1.close.thread-handoff\",\"outcome\":\"COMPLETED\",\"reason\":\"thread-handoff\",\"lastConnectedAtEpochMillis\":1500,\"handoffExchange\":{\"actionId\":\"action-handoff\",\"actionSequence\":10,\"projectId\":\"project-1\",\"threadId\":\"thread-1\",\"autoRearm\":true,\"transitionGrant\":{\"expiresAtEpochMillis\":8500,\"generation\":8,\"modeSessionId\":\"mode-thread-1\",\"target\":{\"environmentId\":\"environment-1\",\"projectId\":\"project-1\",\"threadId\":\"thread-1\",\"speechPreset\":\"default\",\"autoRearm\":true,\"endpointPolicy\":{\"endSilenceMs\":2200,\"noSpeechTimeoutMs\":60000,\"maximumUtteranceMs\":600000},\"speechEnabled\":true,\"rearmGuardMs\":500}},\"replayed\":false},\"stage\":\"HANDOFF_COMMIT_PENDING\",\"attemptCount\":0,\"lastFailureCode\":null,\"lastFailureRetryable\":true,\"terminalPublication\":\"NONE\"}","iv":"AAAAAAAAAAAAAAAA","ciphertext":"1QvBxCbNugXCRUB7apt0qD1zRTMKIkaTXbL62A/TBhauKaKrSLnIaq4CMhoE7yDHVhYrETAAJfwzxoi3Y/51c7Z5pLALudVupytiV0jzFcZZHCNVXlAn/S7bjrFgvVJ5vm6v5hzv0mSsIS8dDLYHzV4BIEcnVin4ONzYpQ=="}"""
  }
}
