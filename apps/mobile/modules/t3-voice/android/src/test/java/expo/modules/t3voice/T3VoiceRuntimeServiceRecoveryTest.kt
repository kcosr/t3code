package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceRuntimeServiceRecoveryTest {
  @Test
  fun `process death after disable recovers checkpoint from child grant without canonical authority`() {
    val checkpoint = checkpoint()

    assertEquals(
      "runtime-1",
      T3VoiceRecoveredRealtimeAuthorityPolicy.runtimeId(
        null,
        null,
        checkpoint,
        null,
        null,
      ),
    )
    val recovered = T3VoiceRecoveredRealtimeAuthorityPolicy.authority(
      null,
      checkpoint,
      "https://environment.example.test",
    )

    assertEquals(checkpoint.fence.identity, recovered?.identity)
    assertEquals("child-control-token", recovered?.runtimeToken)
    assertEquals("https://environment.example.test", recovered?.environmentOrigin)
    assertNull(T3VoiceRecoveredRealtimeAuthorityPolicy.authority(null, checkpoint, null))
  }

  @Test
  fun `checkpoint recovery compares ownership with the current process identity`() {
    val recovered = requireNotNull(T3VoiceRecoveredRealtimeAuthorityPolicy.authority(
      null,
      checkpoint(),
      "https://environment.example.test",
    ))
    val current = VoiceRuntimeIdentity("runtime-1", "process-current", 4)

    assertEquals(
      current,
      T3VoiceRecoveredRealtimeAuthorityPolicy.recoveryIdentity(recovered, current),
    )
    assertTrue(recovered.identity.runtimeInstanceId != current.runtimeInstanceId)
  }

  @Test
  fun `finalization recovery uses durable child authority and embedded origin`() {
    val finalization = finalization()

    val recovered = T3VoiceRecoveredRealtimeAuthorityPolicy.authority(
      finalization,
      null,
      null,
    )

    assertEquals(finalization.fence.identity, recovered?.identity)
    assertEquals(finalization.sourceEnvironmentOrigin, recovered?.environmentOrigin)
    assertEquals(finalization.session.controlGrant.token, recovered?.runtimeToken)
  }

  @Test
  fun `stale idle callback cannot converge while recovered work remains`() {
    assertFalse(T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle(
      hasFinalization = false,
      hasCheckpoint = true,
    ))
    assertFalse(T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle(
      hasFinalization = true,
      hasCheckpoint = false,
    ))
    assertTrue(T3VoiceRealtimeFinalizationCallbackPolicy.shouldConvergeIdle(
      hasFinalization = false,
      hasCheckpoint = false,
    ))
  }

  @Test
  fun `handoff is accepted only after exact thread capture is armed`() {
    val authority = threadAuthority()
    val attempt = VoiceRuntimeThreadAttempt(authority, "handoff-turn-action-1").apply {
      operationId = "operation-1"
    }
    val owner = T3VoiceOperationOwner(
      "operation-1",
      1,
      T3VoiceOperationOwnerDomain.THREAD_MODE,
      "operation-1",
    )

    assertFalse(T3VoiceRuntimeHandoffCapturePolicy.isArmed(
      attempt.clientOperationId, attempt, owner, T3VoiceRuntimePhase.ARMING,
    ))
    assertFalse(T3VoiceRuntimeHandoffCapturePolicy.isArmed(
      "different-client-operation", attempt, owner, T3VoiceRuntimePhase.RECORDING,
    ))
    assertTrue(T3VoiceRuntimeHandoffCapturePolicy.isArmed(
      attempt.clientOperationId, attempt, owner, T3VoiceRuntimePhase.RECORDING,
    ))
  }

  @Test
  fun `undispatched thread create uses latest exact token and retries stale rejection once refreshed`() {
    val expected = threadAuthority()
    val original = VoiceRuntimeThreadAuthorization(expected, "token-1")
    val refreshed = VoiceRuntimeThreadAuthorization(expected, "token-2")
    val differentTarget = VoiceRuntimeThreadAuthorization(
      expected.copy(selectedThreadId = "thread-2"),
      "token-3",
    )

    assertEquals("token-2", T3VoiceRuntimeThreadCreateAuthorityPolicy.token(expected, refreshed))
    assertTrue(T3VoiceRuntimeThreadCreateAuthorityPolicy.shouldRetryRejected(
      original.runtimeGrantToken,
      expected,
      refreshed,
    ))
    assertFalse(T3VoiceRuntimeThreadCreateAuthorityPolicy.shouldRetryRejected(
      refreshed.runtimeGrantToken,
      expected,
      refreshed,
    ))
    assertNull(T3VoiceRuntimeThreadCreateAuthorityPolicy.token(expected, differentTarget))
  }

  private fun checkpoint() = VoiceRuntimeRealtimeCheckpoint(
    fence = VoiceRuntimeRealtimeFence(
      VoiceRuntimeIdentity("runtime-1", "process-old", 4),
      "mode-1",
    ),
    target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    rootCommandId = "root-1",
    phase = VoiceRealtimePhase.CONNECTED,
    serverSessionId = "session-1",
    leaseGeneration = 7,
    controlGrant = VoiceRuntimeRealtimeControlGrant(
      "child-control-token",
      8_000,
      5,
      30,
    ),
  )

  private fun finalization(): VoiceRuntimeRealtimeFinalization {
    val checkpoint = checkpoint()
    return VoiceRuntimeRealtimeFinalization(
      fence = checkpoint.fence,
      sourceTarget = checkpoint.target,
      sourceEnvironmentOrigin = "https://environment.example.test",
      rootCommandId = checkpoint.rootCommandId,
      session = VoiceRuntimeRealtimeStartResult(
        VoiceRuntimeRealtimeSessionState(
          "session-1",
          "conversation-1",
          "signaling",
          7,
          0,
        ),
        "/api/voice/runtime/realtime-sessions/session-1/webrtc-offer",
        9_000,
        requireNotNull(checkpoint.controlGrant),
      ),
      closeOperationId = "root-1.close.recover",
      outcome = VoiceRuntimeRealtimeTerminalOutcome.INTERRUPTED,
      reason = "process-restarted",
      lastConnectedAtEpochMillis = 1_000,
      handoffExchange = null,
      stage = VoiceRuntimeRealtimeFinalizationStage.SOURCE_CLOSE_PENDING,
    )
  }

  private fun threadAuthority() = VoiceRuntimeThreadAuthority(
    "runtime-1",
    5,
    "https://environment.example.test",
    "project-1",
    "thread-1",
    true,
  )
}
