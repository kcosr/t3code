package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBackgroundRealtimeCleanupTest {
  @Test
  fun `network failed close remains fenced and retries with bounded backoff`() {
    val retryable =
      T3VoiceBackgroundRealtimeResult.Failure(
        T3VoiceBackgroundHttpFailureKind.RETRYABLE,
        null,
      )

    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(retryable),
    )
    assertEquals(250L, T3VoiceBackgroundRealtimeCleanupPolicy.retryDelayMillis(1))
    assertEquals(10_000L, T3VoiceBackgroundRealtimeCleanupPolicy.retryDelayMillis(100))
    assertFalse(T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(marker(), false))
    assertFalse(T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(null, true))
    assertTrue(T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(null, false))
  }

  @Test
  fun `authoritative retryable start failure keeps cleanup fenced until retry succeeds`() {
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY,
      T3VoiceBackgroundRealtimeCleanupPolicy.startFailure(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.RETRYABLE,
          503,
        ),
      ),
    )
    assertFalse(T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(marker(), false))
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY,
      T3VoiceBackgroundRealtimeCleanupPolicy.startFailure(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.CONFLICT,
          409,
        ),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE,
      T3VoiceBackgroundRealtimeCleanupPolicy.startFailure(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT,
          404,
        ),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Success(closeResult(closed = true, phase = "ended")),
      ),
    )
  }

  @Test
  fun `unverifiable terminal outcomes require authority reconciliation`() {
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED,
          401,
        ),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT,
          404,
        ),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.BLOCKED,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Failure(
          T3VoiceBackgroundHttpFailureKind.PERMANENT,
          400,
        ),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.RETRY,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Success(closeResult(closed = false, phase = "ending")),
      ),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupDecision.COMPLETE,
      T3VoiceBackgroundRealtimeCleanupPolicy.closeResult(
        T3VoiceBackgroundRealtimeResult.Success(closeResult(closed = true, phase = "ended")),
      ),
    )
    val readiness = T3VoiceReadinessConfig(enabled = true, generation = 7)
    val reconciliation = T3VoiceBackgroundRealtimeReconciliationPolicy.fence(readiness, marker())
    assertFalse(reconciliation.readiness.enabled)
    assertEquals(8L, reconciliation.readiness.generation)
    assertEquals(
      T3VoicePendingRuntimeRevocation("runtime-1", "https://environment.example.test"),
      reconciliation.pendingRevocation,
    )
  }

  @Test
  fun `process restore retains exact cleanup identity without credentials`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundRealtimeCleanupStore(storage)
    val marker = marker()

    store.write(marker)
    assertEquals(
      T3VoiceBackgroundRealtimeCleanupLoadResult.Available(marker),
      store.load(),
    )
    assertTrue(storage.values.values.none { it == "runtime-secret" || it == "control-secret" })

    store.clear(marker)
    assertEquals(T3VoiceBackgroundRealtimeCleanupLoadResult.Missing, store.load())
  }

  @Test
  fun `partial or corrupt cleanup state stays locked`() {
    val storage = MemoryStore()
    val store = T3VoiceBackgroundRealtimeCleanupStore(storage)
    store.write(marker())
    storage.values.remove(storage.values.keys.single { it.endsWith("conversation_id") })

    assertEquals(T3VoiceBackgroundRealtimeCleanupLoadResult.Locked, store.load())
    assertFalse(storage.values.isEmpty())
    assertFalse(T3VoiceBackgroundRealtimeCleanupPolicy.canStartNewSession(null, true))
  }

  @Test
  fun `missing or mismatched grant cannot erase cleanup fence`() {
    assertNull(
      T3VoiceBackgroundRealtimeCleanupPolicy.authority(
        marker(),
        T3VoiceRuntimeGrantLoadResult.Missing,
      ),
    )
    assertNull(
      T3VoiceBackgroundRealtimeCleanupPolicy.authority(
        marker(),
        T3VoiceRuntimeGrantLoadResult.Available(
          grant().copy(metadata = grant().metadata.copy(runtimeId = "runtime-other")),
        ),
      ),
    )
  }

  @Test
  fun `primary cannot queue a surprise restart and stop clears restore request`() {
    val restore = T3VoiceBackgroundRealtimeRestartRequest.RESTORE_INTERRUPTED_SESSION
    assertEquals(
      restore,
      T3VoiceBackgroundRealtimeRestartPolicy.afterControl(restore, T3VoiceControlCommand.PRIMARY),
    )
    assertEquals(
      T3VoiceBackgroundRealtimeRestartRequest.NONE,
      T3VoiceBackgroundRealtimeRestartPolicy.afterControl(restore, T3VoiceControlCommand.STOP),
    )
    assertTrue(T3VoiceBackgroundRealtimeRestartPolicy.shouldRestart(restore))
    assertFalse(T3VoiceBackgroundRealtimeRestartPolicy.shouldRestart(T3VoiceBackgroundRealtimeRestartRequest.NONE))
  }

  private fun marker() =
    T3VoiceBackgroundRealtimeCleanupMarker(
      runtimeId = "runtime-1",
      readinessGeneration = 7,
      environmentOrigin = "https://environment.example.test",
      operationId = "realtime-operation-1",
      conversationId = "conversation-1",
    )

  private fun grant() =
    T3VoiceRuntimeGrant(
      metadata =
        T3VoiceRuntimeGrantMetadata(
          runtimeId = "runtime-1",
          readinessGeneration = 7,
          environmentOrigin = "https://environment.example.test",
          operation = T3VoiceRuntimeGrantOperation.REALTIME_START,
          targetIdentityDigest = "a".repeat(64),
          expiresAtEpochMillis = 1_900_000_000_000,
        ),
      token = "runtime-secret",
    )

  private fun closeResult(closed: Boolean, phase: String) =
    T3VoiceBackgroundRealtimeCloseResult(
      state =
        T3VoiceBackgroundRealtimeSessionState(
          sessionId = "session-1",
          conversationId = "conversation-1",
          phase = phase,
          leaseGeneration = 4,
          sequence = 0,
        ),
      closed = closed,
    )

  private class MemoryStore : T3VoiceBackgroundKeyValueStore {
    val values = mutableMapOf<String, String>()

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
}
