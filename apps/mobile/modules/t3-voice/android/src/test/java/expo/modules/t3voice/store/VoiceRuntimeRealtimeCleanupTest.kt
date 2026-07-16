package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.T3VoiceControlCommand
import expo.modules.t3voice.kernel.T3VoicePendingRuntimeRevocation
import expo.modules.t3voice.kernel.T3VoiceReadinessConfig
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCleanupDecision
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCleanupMarker
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeCleanupPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeReconciliationPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeRestartPolicy
import expo.modules.t3voice.kernel.VoiceRuntimeRealtimeRestartRequest
import expo.modules.t3voice.net.VoiceRuntimeHttpFailureKind
import expo.modules.t3voice.net.VoiceRuntimeRealtimeCloseResult
import expo.modules.t3voice.net.VoiceRuntimeRealtimeResult
import expo.modules.t3voice.net.VoiceRuntimeRealtimeSessionState

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeCleanupTest {
  @Test
  fun `network failed close remains fenced and retries with bounded backoff`() {
    val retryable =
      VoiceRuntimeRealtimeResult.Failure(
        VoiceRuntimeHttpFailureKind.RETRYABLE,
        null,
      )

    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.RETRY,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(retryable),
    )
    assertEquals(250L, VoiceRuntimeRealtimeCleanupPolicy.retryDelayMillis(1))
    assertEquals(10_000L, VoiceRuntimeRealtimeCleanupPolicy.retryDelayMillis(100))
    assertFalse(VoiceRuntimeRealtimeCleanupPolicy.canStartNewSession(marker(), false))
    assertFalse(VoiceRuntimeRealtimeCleanupPolicy.canStartNewSession(null, true))
    assertTrue(VoiceRuntimeRealtimeCleanupPolicy.canStartNewSession(null, false))
  }

  @Test
  fun `authoritative retryable start failure keeps cleanup fenced until retry succeeds`() {
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.RETRY,
      VoiceRuntimeRealtimeCleanupPolicy.startFailure(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.RETRYABLE,
          503,
        ),
      ),
    )
    assertFalse(VoiceRuntimeRealtimeCleanupPolicy.canStartNewSession(marker(), false))
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.RETRY,
      VoiceRuntimeRealtimeCleanupPolicy.startFailure(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.CONFLICT,
          409,
        ),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.COMPLETE,
      VoiceRuntimeRealtimeCleanupPolicy.startFailure(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.PERMANENT,
          404,
        ),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.COMPLETE,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Success(closeResult(closed = true, phase = "ended")),
      ),
    )
  }

  @Test
  fun `unverifiable terminal outcomes require authority reconciliation`() {
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.BLOCKED,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.AUTHORITY_REJECTED,
          401,
        ),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.COMPLETE,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.PERMANENT,
          404,
        ),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.BLOCKED,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Failure(
          VoiceRuntimeHttpFailureKind.PERMANENT,
          400,
        ),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.RETRY,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Success(closeResult(closed = false, phase = "ending")),
      ),
    )
    assertEquals(
      VoiceRuntimeRealtimeCleanupDecision.COMPLETE,
      VoiceRuntimeRealtimeCleanupPolicy.closeResult(
        VoiceRuntimeRealtimeResult.Success(closeResult(closed = true, phase = "ended")),
      ),
    )
    val readiness = T3VoiceReadinessConfig(enabled = true, generation = 7)
    val reconciliation = VoiceRuntimeRealtimeReconciliationPolicy.fence(readiness, marker())
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
    val store = VoiceRuntimeRealtimeCleanupStore(storage)
    val marker = marker()

    store.write(marker)
    assertEquals(
      VoiceRuntimeRealtimeCleanupLoadResult.Available(marker),
      store.load(),
    )
    assertTrue(storage.values.values.none { it == "runtime-secret" || it == "control-secret" })

    store.clear(marker)
    assertEquals(VoiceRuntimeRealtimeCleanupLoadResult.Missing, store.load())
  }

  @Test
  fun `partial or corrupt cleanup state stays locked`() {
    val storage = MemoryStore()
    val store = VoiceRuntimeRealtimeCleanupStore(storage)
    store.write(marker())
    storage.values.remove(storage.values.keys.single { it.endsWith("conversation_id") })

    assertEquals(VoiceRuntimeRealtimeCleanupLoadResult.Locked, store.load())
    assertFalse(storage.values.isEmpty())
    assertFalse(VoiceRuntimeRealtimeCleanupPolicy.canStartNewSession(null, true))
  }

  @Test
  fun `missing or mismatched grant cannot erase cleanup fence`() {
    assertNull(
      VoiceRuntimeRealtimeCleanupPolicy.authority(
        marker(),
        T3VoiceRuntimeGrantLoadResult.Missing,
      ),
    )
    assertNull(
      VoiceRuntimeRealtimeCleanupPolicy.authority(
        marker(),
        T3VoiceRuntimeGrantLoadResult.Available(
          grant().copy(metadata = grant().metadata.copy(runtimeId = "runtime-other")),
        ),
      ),
    )
  }

  @Test
  fun `primary cannot queue a surprise restart and stop clears restore request`() {
    val restore = VoiceRuntimeRealtimeRestartRequest.RESTORE_INTERRUPTED_SESSION
    assertEquals(
      restore,
      VoiceRuntimeRealtimeRestartPolicy.afterControl(restore, T3VoiceControlCommand.PRIMARY),
    )
    assertEquals(
      VoiceRuntimeRealtimeRestartRequest.NONE,
      VoiceRuntimeRealtimeRestartPolicy.afterControl(restore, T3VoiceControlCommand.STOP),
    )
    assertTrue(VoiceRuntimeRealtimeRestartPolicy.shouldRestart(restore))
    assertFalse(VoiceRuntimeRealtimeRestartPolicy.shouldRestart(VoiceRuntimeRealtimeRestartRequest.NONE))
  }

  private fun marker() =
    VoiceRuntimeRealtimeCleanupMarker(
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
    VoiceRuntimeRealtimeCloseResult(
      state =
        VoiceRuntimeRealtimeSessionState(
          sessionId = "session-1",
          conversationId = "conversation-1",
          phase = phase,
          leaseGeneration = 4,
          sequence = 0,
        ),
      closed = closed,
      replayed = false,
    )

  private class MemoryStore : VoiceRuntimeKeyValueStore {
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
