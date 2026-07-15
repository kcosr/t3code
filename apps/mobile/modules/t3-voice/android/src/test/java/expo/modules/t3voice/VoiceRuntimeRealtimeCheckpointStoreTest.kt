package expo.modules.t3voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

internal class VoiceRuntimeRealtimeCheckpointStoreTest {
  @Test
  fun `checkpoint persists session coordination without credentials`() {
    val storage = MemoryRuntimeStorage()
    val expected = checkpoint()
    VoiceRuntimeDurableRealtimeCheckpointRepository(storage).save(expected)

    assertEquals(expected, VoiceRuntimeDurableRealtimeCheckpointRepository(storage).load())
    assertTrue(storage.values.values.filterNotNull().none { "credential" in it || "token" in it })
  }

  @Test
  fun `checkpoint clear is fenced`() {
    val storage = MemoryRuntimeStorage()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
    val expected = checkpoint()
    repository.save(expected)
    repository.clear(expected.fence.copy(modeSessionId = "other"))
    assertEquals(expected, repository.load())
    repository.clear(expected.fence)
    assertNull(repository.load())
  }

  @Test
  fun `finalization atomically replaces checkpoint and survives restart`() {
    val storage = MemoryRuntimeStorage()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
    val checkpoint = checkpoint()
    val finalization = finalization()
    repository.save(checkpoint)
    repository.installFinalization(checkpoint, finalization)

    val restarted = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
    assertNull(restarted.load())
    assertEquals(finalization, restarted.loadFinalization())
  }

  @Test
  fun `tampered checkpoint fails closed`() {
    val storage = MemoryRuntimeStorage()
    VoiceRuntimeDurableRealtimeCheckpointRepository(storage).save(checkpoint())
    storage.values.entries.first { "checkpoint" in it.key }.setValue("{}")

    assertTrue(runCatching {
      VoiceRuntimeDurableRealtimeCheckpointRepository(storage).load()
    }.exceptionOrNull() is VoiceRuntimeDurableStateCorruptionException)
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
      val storage = MemoryRuntimeStorage()
      val expected = checkpoint().copy(pendingAction = action)
      val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
      repository.save(expected)
      assertEquals(expected, repository.load())
    }
  }

  @Test
  fun `finalization tampering fails closed independently of terminal summaries`() {
    val storage = MemoryRuntimeStorage()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
    repository.installFinalization(null, finalization())
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    storage.values["canonical_realtime_finalization_v1"] = JSONObject(
      storage.values.getValue("canonical_realtime_finalization_v1")!!,
    ).put("unexpected", true).toString()

    assertCorrupt { repository.loadFinalization() }
    assertEquals(1, repository.terminals(100).size)
  }

  @Test
  fun `terminal retention remains full until exact acknowledgement`() {
    val storage = MemoryRuntimeStorage()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage, terminalCapacity = 2)
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    repository.publishTerminal(terminal(2, expiresAt = 10_000))
    val thirdFence = VoiceRuntimeRealtimeFence(
      VoiceRuntimeIdentity("runtime-3", "process-3", 1),
      "mode-3",
    )

    assertFalse(repository.hasTerminalCapacity(thirdFence, 100))
    expectThrows<VoiceRuntimeRetentionCapacityException> {
      repository.publishTerminal(terminal(3, expiresAt = 10_000))
    }
    assertFalse(repository.acknowledgeTerminal(
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
        VoiceRuntimeIdentity("runtime-1", "wrong-process", 1),
        "mode-1",
      ),
    ))
    assertTrue(repository.acknowledgeTerminal(
      VoiceRuntimeRetainedRecordKey.RealtimeTerminal(
        VoiceRuntimeIdentity("runtime-1", "process-1", 1),
        "mode-1",
      ),
    ))
    repository.publishTerminal(terminal(3, expiresAt = 10_000))
    assertEquals(listOf("mode-2", "mode-3"), repository.terminals(100).map { it.modeSessionId })
  }

  @Test
  fun `terminal corruption fails closed without affecting a valid checkpoint`() {
    val storage = MemoryRuntimeStorage()
    val repository = VoiceRuntimeDurableRealtimeCheckpointRepository(storage)
    repository.save(checkpoint())
    repository.publishTerminal(terminal(1, expiresAt = 10_000))
    storage.values["canonical_realtime_terminals_v1"] = JSONObject(
      storage.values.getValue("canonical_realtime_terminals_v1")!!,
    ).put("unexpected", true).toString()

    assertCorrupt { repository.terminals(100) }
    assertEquals(checkpoint(), repository.load())
  }

  private fun checkpoint() = VoiceRuntimeRealtimeCheckpoint(
    fence = fence(),
    target = target(),
    rootCommandId = "start-1",
    phase = VoiceRealtimePhase.CONNECTED,
    serverSessionId = "session-1",
    leaseGeneration = 3,
    expiresAtEpochMillis = 9_000,
    heartbeatIntervalSeconds = 15,
    lastConnectedAtEpochMillis = 1_000,
  )

  private fun finalization() = VoiceRuntimeRealtimeFinalization(
    fence = fence(),
    sourceTarget = target(),
    sourceEnvironmentOrigin = "https://environment.example.test",
    rootCommandId = "start-1",
    session = VoiceRuntimeRealtimeStartResult(
      VoiceRuntimeRealtimeSessionState(
        "session-1", "conversation-1", "connected", 3, 1,
      ),
      "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
      9_000,
      15,
    ),
    closeOperationId = "start-1.close",
    outcome = VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
    reason = "process-restarted",
    lastConnectedAtEpochMillis = 1_000,
    handoffExchange = null,
    stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
  )

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

  private fun assertCorrupt(block: () -> Unit) {
    try {
      block()
      fail("Expected durable Realtime state corruption.")
    } catch (_: VoiceRuntimeDurableStateCorruptionException) {
      // Corrupted durable state must never be treated as absent.
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

  private fun fence() = VoiceRuntimeRealtimeFence(
    VoiceRuntimeIdentity("runtime-1", "process-1", 7),
    "mode-1",
  )

  private fun target() = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1")
}
