package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceCanonicalReadinessPolicyTest {
  @Test
  fun `transient off authority can be replaced by persistent on authority`() {
    val transient = T3VoiceCanonicalReadinessPolicy.transient(
      T3VoiceReadinessConfig(generation = 0),
      authority(
        generation = 1,
        readinessEnabled = false,
        target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
      ),
    )

    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        "runtime-1",
        1,
        transient.generation,
        listOf("runtime-1" to 1),
        nativeVoiceActive = false,
      ),
    )
    val persistent = T3VoiceReadinessReservationPolicy.reserve(
      transient,
      prepared = null,
      desired = transient.copy(enabled = true),
      proposedRuntimeId = "runtime-2",
      environmentOrigin = "https://environment.example.test",
      operation = T3VoiceRuntimeGrantOperation.REALTIME_START,
      targetIdentityDigest = "b".repeat(64),
    )
    assertEquals(2L, persistent.config.generation)
  }

  @Test
  fun `persistent on authority clears readiness without inventing a generation`() {
    val enabled = T3VoiceReadinessConfig(
      enabled = true,
      mode = T3VoiceReadinessMode.THREAD,
      targetId = "project-1/thread-1",
      generation = 9,
    )

    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(enabled, canonicalGeneration = 9)

    assertFalse(disabled.enabled)
    assertEquals(9L, disabled.generation)
    assertEquals(enabled.mode, disabled.mode)
    assertEquals(enabled.targetId, disabled.targetId)
  }

  @Test
  fun `notification disable preserves the exact canonical cleanup fence`() {
    val authority = authority(
      generation = 9,
      readinessEnabled = true,
      target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    )
    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
      T3VoiceReadinessConfig(enabled = true, generation = 9),
      canonicalGeneration = 9,
    )

    val ownershipFence = requireNotNull(
      T3VoiceRuntimeOwnershipPolicy.canonicalFence(
        disabled,
        activeReadiness = null,
        persistedAuthority = authority,
      ),
    )
    assertEquals(
      T3VoiceRuntimeOwnershipFence("runtime-1", 9, authority.environmentOrigin),
      ownershipFence,
    )
    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        ownershipFence.runtimeId,
        ownershipFence.generation,
        canonicalGeneration = 9,
        authorityIdentities = listOf("runtime-1" to 9),
        nativeVoiceActive = false,
      ),
    )
  }

  @Test
  fun `recovery disable reserves the next canonical generation`() {
    val disabled = T3VoiceCanonicalReadinessPolicy.disabled(
      T3VoiceReadinessConfig(enabled = true, generation = 12),
      canonicalGeneration = 7,
    )

    val reservation = T3VoiceReadinessReservationPolicy.reserve(
      disabled,
      prepared = null,
      desired = disabled.copy(enabled = true),
      proposedRuntimeId = "runtime-2",
      environmentOrigin = "https://environment.example.test",
      operation = T3VoiceRuntimeGrantOperation.REALTIME_START,
      targetIdentityDigest = "b".repeat(64),
    )

    assertEquals(7L, disabled.generation)
    assertEquals(8L, reservation.config.generation)
  }

  @Test
  fun `transient restart restores canonical readiness before enabling controls`() {
    val authority = authority(
      generation = 7,
      readinessEnabled = false,
      target = threadTarget(),
    )
    val restored = T3VoiceCanonicalReadinessPolicy.transient(
      T3VoiceReadinessConfig(
        enabled = true,
        mode = T3VoiceReadinessMode.REALTIME,
        targetId = "stale-conversation",
        generation = 2,
      ),
      authority,
    )

    assertFalse(restored.enabled)
    assertEquals(T3VoiceReadinessMode.THREAD, restored.mode)
    assertEquals("project-1/thread-1", restored.targetId)
    assertEquals(7L, restored.generation)
    val ownershipFence = requireNotNull(
      T3VoiceRuntimeOwnershipPolicy.canonicalFence(
        restored,
        activeReadiness = null,
        persistedAuthority = authority,
      ),
    )
    assertEquals(
      T3VoiceRuntimeOwnershipFence(
        "runtime-1",
        7,
        "https://environment.example.test",
      ),
      ownershipFence,
    )
    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        ownershipFence.runtimeId,
        ownershipFence.generation,
        restored.generation,
        listOf("runtime-1" to 7),
        nativeVoiceActive = false,
      ),
    )
    val persistent = T3VoiceReadinessReservationPolicy.reserve(
      restored,
      prepared = null,
      desired = restored.copy(enabled = true),
      proposedRuntimeId = "runtime-2",
      environmentOrigin = "https://environment.example.test",
      operation = T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      targetIdentityDigest = "b".repeat(64),
    )
    assertEquals(8L, persistent.config.generation)
  }

  @Test
  fun `prepared attached reservation remains an exact idle ownership fence after restart`() {
    val readiness = T3VoiceReadinessConfig(
      enabled = false,
      mode = T3VoiceReadinessMode.THREAD,
      targetId = "project-1/thread-1",
      generation = 7,
    )
    val prepared = T3VoicePreparedReadiness(
      readiness,
      "runtime-1",
      "https://environment.example.test",
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      "a".repeat(64),
    )

    assertEquals(
      T3VoiceRuntimeOwnershipFence(
        "runtime-1",
        6,
        "https://environment.example.test",
      ),
      T3VoiceRuntimeOwnershipPolicy.canonicalFence(
        readiness,
        activeReadiness = null,
        persistedAuthority = null,
        preparedAttached = prepared,
      ),
    )
    assertTrue(
      T3VoiceConditionalDisablePolicy.canDisable(
        expectedRuntimeId = "runtime-1",
        expectedGeneration = 6,
        canonicalGeneration = 6,
        authorityIdentities = listOf("runtime-1" to 6),
        nativeVoiceActive = false,
      ),
    )
  }

  @Test
  fun `opposing preparation requests reject before either reservation is mutated`() {
    val persistentState = mutableListOf("persistent-reservation")
    val persistentBefore = persistentState.toList()
    assertTrue(runCatching {
      T3VoicePreparationExclusionPolicy.requireCompatible(
        readinessEnabled = false,
        persistentPrepared = true,
        attachedPrepared = false,
      )
      persistentState.clear()
      persistentState += "attached-reservation"
    }.isFailure)
    assertEquals(persistentBefore, persistentState)

    val attachedState = mutableListOf("attached-reservation")
    val attachedBefore = attachedState.toList()
    assertTrue(runCatching {
      T3VoicePreparationExclusionPolicy.requireCompatible(
        readinessEnabled = true,
        persistentPrepared = false,
        attachedPrepared = true,
      )
      attachedState.clear()
      attachedState += "persistent-reservation"
    }.isFailure)
    assertEquals(attachedBefore, attachedState)
  }

  @Test
  fun `prepared persistent reservation uses expected-current generation for cleanup`() {
    val readiness = T3VoiceReadinessConfig(enabled = false, generation = 7)
    val prepared = T3VoicePreparedReadiness(
      readiness.copy(enabled = true),
      "runtime-1",
      "https://environment.example.test",
      T3VoiceRuntimeGrantOperation.REALTIME_START,
      "a".repeat(64),
    )
    val fence = requireNotNull(T3VoiceRuntimeOwnershipPolicy.canonicalFence(
      readiness,
      activeReadiness = null,
      persistedAuthority = null,
      preparedPersistent = prepared,
    ))

    assertEquals(6, fence.generation)
    assertTrue(T3VoiceConditionalDisablePolicy.canDisable(
      fence.runtimeId,
      fence.generation,
      canonicalGeneration = 6,
      authorityIdentities = listOf("runtime-1" to 6),
      nativeVoiceActive = false,
    ))
  }

  @Test
  fun `persistent preparation restart restores generation floor before reprovision`() {
    val prepared = T3VoicePreparedReadiness(
      T3VoiceReadinessConfig(enabled = true, generation = 7),
      "runtime-1",
      "https://environment.example.test",
      T3VoiceRuntimeGrantOperation.REALTIME_START,
      "a".repeat(64),
    )
    val startup = requireNotNull(
      T3VoiceStartupAuthorityFencePolicy.persistentPreparation(prepared, null),
    )
    val controller = VoiceRuntimeActiveThreadController(
      startup.runtimeId,
      "restarted-process",
      { 1_000 },
      { null },
      NoopThreadExecution(),
      initialGeneration = startup.expectedCurrentGeneration,
    )

    assertEquals(6L, controller.snapshot().identity.generation)
    assertTrue(T3VoiceConditionalDisablePolicy.canDisable(
      "runtime-1",
      6,
      controller.snapshot().identity.generation,
      listOf("runtime-1" to 6),
      nativeVoiceActive = false,
    ))
    assertEquals(
      7L,
      T3VoiceReadinessReservationPolicy.reserve(
        T3VoiceReadinessConfig(generation = controller.snapshot().identity.generation),
        null,
        T3VoiceReadinessConfig(enabled = true),
        "runtime-1",
        "https://environment.example.test",
        T3VoiceRuntimeGrantOperation.REALTIME_START,
        "b".repeat(64),
      ).config.generation,
    )
  }

  @Test
  fun `startup persistent preparation validates refresh fence and runtime sources exactly`() {
    val target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1")
    val prepared = T3VoicePreparedReadiness(
      T3VoiceReadinessConfig(enabled = true, generation = 7),
      "runtime-1",
      "https://environment.example.test",
      T3VoiceRuntimeGrantOperation.REALTIME_START,
      "a".repeat(64),
    )
    val refresh = VoiceRuntimePreparedRefreshCredential(
      VoiceRuntimeAuthorityFence(
        "runtime-1", 7, "provision-7", "a".repeat(64), target,
        T3VoiceRuntimeGrantOperation.REALTIME_START,
        "https://environment.example.test",
      ),
      "b".repeat(64),
    )

    val startup = requireNotNull(
      T3VoiceStartupAuthorityFencePolicy.persistentPreparation(prepared, refresh),
    )
    assertEquals("runtime-1", T3VoiceStartupAuthorityFencePolicy.selectRuntimeId(
      startup.runtimeId,
      "runtime-1",
    ))
    assertTrue(runCatching {
      T3VoiceStartupAuthorityFencePolicy.persistentPreparation(
        prepared,
        refresh.copy(fence = refresh.fence.copy(generation = 8)),
      )
    }.isFailure)
    assertTrue(runCatching {
      T3VoiceStartupAuthorityFencePolicy.selectRuntimeId("runtime-1", "runtime-2")
    }.isFailure)
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "runtime-1", 10, true),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        startup,
        T3VoiceRecoveredAuthorityFence("runtime-1", 10),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "runtime-1", 7, true),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        startup,
        T3VoiceRecoveredAuthorityFence("runtime-1", 5),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(startup, "runtime-1", 6, false),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        startup,
        T3VoiceRecoveredAuthorityFence("runtime-1", 6),
        T3VoiceRecoveredAuthorityFence("runtime-1", 6),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "runtime-2", 6, true),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        startup,
        T3VoiceRecoveredAuthorityFence("runtime-2", 6),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "runtime-1", 10, false),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        null,
        T3VoiceRecoveredAuthorityFence("runtime-1", 7),
        T3VoiceRecoveredAuthorityFence("runtime-1", 10),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "runtime-1", 6, true),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        null,
        T3VoiceRecoveredAuthorityFence("runtime-1", 6),
        T3VoiceRecoveredAuthorityFence("runtime-2", 9),
      ),
    )
    assertEquals(
      T3VoiceStartupAuthorityResolution(null, "retired-runtime", 9, true),
      T3VoiceStartupAuthorityFencePolicy.resolve(
        null,
        T3VoiceRecoveredAuthorityFence("retired-runtime", 9),
        T3VoiceRecoveredAuthorityFence("readiness-runtime", 6),
      ),
    )
    assertTrue(runCatching {
      T3VoiceStartupAuthorityFencePolicy.selectPreparation(
        startup,
        VoiceRuntimePreparedAttachedAuthority(refresh.fence, prepared.config),
      )
    }.isFailure)
    assertTrue(runCatching {
      T3VoiceStartupAuthorityFencePolicy.persistentPreparation(
        prepared.copy(config = prepared.config.copy(generation = 0)),
        null,
      )
    }.isFailure)
  }

  @Test
  fun `refresh admission is fenced by exact durable readiness generation`() {
    val authority = authority(
      generation = 7,
      readinessEnabled = true,
      target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    )
    val disabledFence = T3VoiceDisabledAuthorityFence("runtime-1", 7)
    var pendingUiDisableGeneration: Long? = 7
    pendingUiDisableGeneration = null // React acknowledged the preference-reconciliation event.
    assertNull(pendingUiDisableGeneration)
    assertTrue(T3VoiceAuthorityRefreshAdmissionPolicy.canRefresh(
      authority,
      T3VoiceReadinessConfig(enabled = true, generation = 7),
      null,
    ))
    assertFalse(T3VoiceAuthorityRefreshAdmissionPolicy.canRefresh(
      authority,
      T3VoiceReadinessConfig(enabled = false, generation = 7),
      disabledFence,
    ))
    assertTrue(T3VoiceAuthorityRefreshAdmissionPolicy.isDurablyDisabled(
      authority,
      T3VoiceReadinessConfig(enabled = false, generation = 7),
      disabledFence,
    ))
    assertEquals(
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.DISABLED_RECOVERY,
      T3VoiceAuthorityRefreshAdmissionPolicy.mode(
        authority.copy(readinessEnabled = false),
        T3VoiceReadinessConfig(enabled = false, generation = 7),
        disabledFence,
        hasPendingRefresh = true,
      ),
    )
    assertEquals(
      T3VoiceAuthorityRefreshAdmissionPolicy.Mode.REJECT,
      T3VoiceAuthorityRefreshAdmissionPolicy.mode(
        authority.copy(readinessEnabled = false),
        T3VoiceReadinessConfig(enabled = false, generation = 7),
        disabledFence,
        hasPendingRefresh = false,
      ),
    )
    // The worker uses this same admission both before beginning refresh and after
    // a successful response/schedule, so either race observes the durable tombstone.
    assertFalse(T3VoiceAuthorityRefreshAdmissionPolicy.canRefresh(
      authority,
      T3VoiceReadinessConfig(enabled = false, generation = 7),
      disabledFence,
    ))
    assertFalse(T3VoiceAuthorityRefreshAdmissionPolicy.canRefresh(
      authority,
      T3VoiceReadinessConfig(enabled = true, generation = 8),
      null,
    ))
    assertFalse(T3VoiceAuthorityRefreshAdmissionPolicy.isDurablyDisabled(
      authority,
      T3VoiceReadinessConfig(enabled = true, generation = 8),
      null,
    ))
  }

  @Test
  fun `disabled parent is retained through active child and cleared only at terminal`() {
    val disabled = authority(
      generation = 7,
      readinessEnabled = false,
      target = VoiceRuntimeTarget.Realtime("environment-1", "conversation-1"),
    )
    val disabledFence = T3VoiceDisabledAuthorityFence("runtime-1", 7)

    assertFalse(T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      disabled,
      disabledFence = disabledFence,
      canonicalIdle = false,
    ))
    assertTrue(T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      disabled,
      disabledFence = disabledFence,
      canonicalIdle = true,
    ))
    assertFalse(T3VoiceDisabledAuthorityRetentionPolicy.shouldClearAtTerminal(
      disabled.copy(readinessEnabled = true),
      disabledFence = disabledFence,
      canonicalIdle = true,
    ))
  }

  @Test
  fun `disabled terminal cleanup preserves durable parent when controller clear fails`() {
    val calls = mutableListOf<String>()
    assertFalse(T3VoiceDisabledTerminalCleanupCoordinator.run(
      canonicalIdle = true,
      clearController = {
        calls += "controller"
        false
      },
      clearAuthority = { calls += "authority" },
      clearEngine = { calls += "engine" },
    ))
    assertEquals(listOf("controller"), calls)

    calls.clear()
    assertTrue(T3VoiceDisabledTerminalCleanupCoordinator.run(
      canonicalIdle = true,
      clearController = {
        calls += "controller"
        true
      },
      clearAuthority = { calls += "authority" },
      clearEngine = { calls += "engine" },
    ))
    assertEquals(listOf("controller", "authority", "engine"), calls)
  }

  private fun authority(
    generation: Long,
    readinessEnabled: Boolean,
    target: VoiceRuntimeTarget,
  ) = VoiceRuntimePersistedAuthority(
    runtimeId = "runtime-1",
    generation = generation,
    provisioningOperationId = "provision-1",
    targetDigest = "a".repeat(64),
    target = target,
    environmentOrigin = "https://environment.example.test",
    readinessEnabled = readinessEnabled,
    token = "runtime-token",
    issuedAtEpochMillis = 1,
    expiresAtEpochMillis = 10_000,
  )

  private fun threadTarget() = VoiceRuntimeTarget.Thread(
    environmentId = "environment-1",
    projectId = "project-1",
    threadId = "thread-1",
    speechPreset = "default",
    autoRearm = false,
    endSilenceMs = 2_200,
    noSpeechTimeoutMs = null,
    maximumUtteranceMs = 600_000,
    speechEnabled = true,
    rearmGuardMs = 0,
  )

  private class NoopThreadExecution : VoiceRuntimeThreadExecution {
    override fun start(modeSessionId: String, turnClientOperationId: String,
      submissionPolicy: String, draftContext: VoiceRuntimeDraftContext?) = true
    override fun finish(outcome: String, draftContext: VoiceRuntimeDraftContext?) = true
    override fun cancel() = true
    override fun stop(policy: String) = true
    override fun acknowledgeDraft(artifactId: String, outcome: String) = true
  }
}
