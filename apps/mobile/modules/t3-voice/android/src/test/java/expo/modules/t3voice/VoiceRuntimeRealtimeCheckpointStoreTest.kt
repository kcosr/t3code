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
      T3VoiceBackgroundRealtimeAction.NavigateThread(
        12, 1_200, "action-nav", "project-1", "thread-1", 9_000,
      ),
      T3VoiceBackgroundRealtimeAction.HandoffToThreadVoice(
        12, 1_200, "action-handoff", "project-1", "thread-1", true, 9_000,
      ),
      T3VoiceBackgroundRealtimeAction.StopRealtimeVoice(12, 1_200),
      T3VoiceBackgroundRealtimeAction.ConfirmationRequired(
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
  fun `terminal summaries survive restart prune expiry deduplicate and stay bounded`() {
    val storage = MemoryStore()
    val repository =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    repository.publishTerminal(terminal(0, expiresAt = 50))
    repeat(66) { index ->
      repository.publishTerminal(terminal(index + 1, expiresAt = 10_000))
    }
    repository.publishTerminal(
      terminal(66, expiresAt = 12_000).copy(reason = "replacement"),
    )

    val restarted =
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage, AuthenticatedTestCipher())
    val values = restarted.terminals(100)

    assertEquals(64, values.size)
    assertEquals(1, values.count { it.modeSessionId == "mode-66" })
    assertEquals("replacement", values.single { it.modeSessionId == "mode-66" }.reason)
    assertFalse(storage.values.values.any { CONTROL_TOKEN in it || TRANSITION_TOKEN in it })
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
    val target = T3VoiceBackgroundRealtimeThreadTarget(
      environmentId = "environment-1",
      projectId = "project-1",
      threadId = "thread-1",
      speechPreset = "default",
      autoRearm = true,
      endpointPolicy = T3VoiceBackgroundRealtimeEndpointPolicy(2_200, 60_000, 600_000),
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
      controlGrant = T3VoiceBackgroundRealtimeControlGrant(
        CONTROL_TOKEN,
        expiresAtEpochMillis = 8_000,
        heartbeatIntervalSeconds = 15,
        failureGraceSeconds = 45,
      ),
      lastActionSequence = 10,
      lastConnectedAtEpochMillis = 1_500,
      pendingAction = T3VoiceBackgroundRealtimeAction.ConfirmationRequired(
        11, 1_800, "action-confirm", "confirmation-1", "tool-call-1", "send_message",
        "Send a synchronous message", 9_000,
      ),
      pendingHandoffExchange = T3VoiceBackgroundRealtimeHandoffExchangeResult(
        actionId = "action-handoff",
        actionSequence = 10,
        projectId = "project-1",
        threadId = "thread-1",
        autoRearm = true,
        transitionGrant = T3VoiceBackgroundRealtimeTransitionGrant(
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
    conversationId = "conversation-$index",
    sessionId = "session-$index",
    outcome = VoiceRuntimeRealtimeTerminalOutcome.COMPLETED,
    reason = "completed",
    lastConnectedAtEpochMillis = 10,
    terminalAtEpochMillis = index.toLong() + 20,
    serverCleanupPending = false,
    expiresAtEpochMillis = expiresAt,
  )

  private fun assertCorrupt(block: () -> Unit) {
    try {
      block()
      fail("Expected durable Realtime state corruption.")
    } catch (_: VoiceRuntimeDurableStateCorruptionException) {
      // Expected: corrupted durable state is never treated as absent.
    }
  }

  private class MemoryStore : T3VoiceBackgroundKeyValueStore {
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
  }
}
