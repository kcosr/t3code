package expo.modules.t3voice.store

import expo.modules.t3voice.kernel.VoiceRuntimeExecutionEvent
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionMode
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionReducer
import expo.modules.t3voice.kernel.VoiceRuntimeExecutionSnapshot
import expo.modules.t3voice.kernel.VoiceRuntimeIdentity
import expo.modules.t3voice.kernel.VoiceRuntimePhase
import expo.modules.t3voice.net.VoiceRuntimeSpeechDisposition

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeThreadOperationStoreTest {
  @Test
  fun `prepared claim persists across restart`() {
    val storage = MemoryRuntimeStorage()
    VoiceRuntimeThreadOperationStore(storage).writePrepared(claim())

    assertEquals(
      VoiceRuntimeThreadOperationState.Prepared(claim()),
      available(VoiceRuntimeThreadOperationStore(storage)),
    )
  }

  @Test
  fun `active operation persists tokenless across restart`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeThreadOperationStore(storage)
    store.writePrepared(claim())
    val expected = active(snapshot())
    store.writeActive(expected)

    assertEquals(expected, available(VoiceRuntimeThreadOperationStore(storage)))
    assertTrue(storage.values.keys.none { "token" in it.lowercase() })
  }

  @Test
  fun `active update is fenced by client operation identity`() {
    val store = VoiceRuntimeThreadOperationStore(MemoryRuntimeStorage())
    store.writePrepared(claim())
    store.writeActive(active(snapshot()))

    assertEquals(
      VoiceRuntimeThreadOperationUpdateResult.IdentityMismatch,
      store.updateActive("other") { it.copy(acknowledgedCursor = 1) },
    )
    val updated = store.updateActive("client-1") { it.copy(detached = true) }
      as VoiceRuntimeThreadOperationUpdateResult.Updated
    assertTrue(updated.state.detached)
  }

  @Test
  fun `tampered active state fails closed`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeThreadOperationStore(storage)
    store.writePrepared(claim())
    store.writeActive(active(snapshot()))
    storage.values.entries.first { it.key.endsWith("snapshot") }.setValue("{}")

    assertEquals(
      VoiceRuntimeThreadOperationLoadResult.Locked,
      VoiceRuntimeThreadOperationStore(storage).load(),
    )
  }

  @Test
  fun `clear requires exact client operation identity`() {
    val store = VoiceRuntimeThreadOperationStore(MemoryRuntimeStorage())
    store.writePrepared(claim())
    assertTrue(!store.clear("other"))
    assertTrue(store.clear("client-1"))
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Missing, store.load())
  }

  @Test
  fun `pending receipt survives restart until exact durable update clears it`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeThreadOperationStore(storage)
    val receipt = VoiceRuntimeThreadReceipt(
      identity = VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
      modeSessionId = "mode-1",
      turnClientOperationId = "client-1",
      turnOperationId = "operation-1",
      environmentId = "environment-1",
      projectId = "project-1",
      threadId = "thread-1",
      userMessageId = "message-1",
      turnId = "turn-1",
      assistantMessageIds = listOf("assistant-1"),
      speechPlanId = "speech-1",
      highestAdvertisedSegment = 0,
      highestStartedSegment = 0,
      highestDrainedSegment = 0,
      segmentDispositions = listOf(VoiceRuntimeSpeechDisposition(0, "drained")),
      speechTerminal = "completed",
      terminalOutcome = "completed",
      createdAtEpochMillis = 1_000,
      expiresAtEpochMillis = 5_000,
    )
    store.writePrepared(claim())
    store.writeActive(active(snapshot()).copy(pendingReceipt = receipt))

    assertEquals(
      receipt,
      (available(VoiceRuntimeThreadOperationStore(storage))
        as VoiceRuntimeThreadOperationState.Active).pendingReceipt,
    )
    store.updateActive("client-1") { it.copy(pendingReceipt = null) }
    assertEquals(
      null,
      (available(VoiceRuntimeThreadOperationStore(storage))
        as VoiceRuntimeThreadOperationState.Active).pendingReceipt,
    )
  }

  @Test
  fun `locked state clears only through authority revocation cleanup`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeThreadOperationStore(storage)
    store.writePrepared(claim())
    storage.values.remove("thread_operation_runtime")

    assertEquals(VoiceRuntimeThreadOperationLoadResult.Locked, store.load())
    assertTrue(store.clearLockedAfterAuthorityRevocation())
    assertEquals(VoiceRuntimeThreadOperationLoadResult.Missing, store.load())
  }

  @Test
  fun `started playback survives restart as an interrupted disposition`() {
    val storage = MemoryRuntimeStorage()
    val store = VoiceRuntimeThreadOperationStore(storage)
    val initial = active(snapshot().copy(
      dispatchAcknowledged = true,
      highestAdvertisedSpeechSegment = 1,
    ))
    store.writePrepared(claim())
    store.writeActive(initial)
    val started = VoiceRuntimeExecutionReducer.reduce(
      initial.snapshot,
      VoiceRuntimeExecutionEvent.PlaybackStarted("operation-1", 0),
    ).snapshot
    store.updateActive("client-1") { it.copy(snapshot = started) }

    val recovered = available(VoiceRuntimeThreadOperationStore(storage))
      as VoiceRuntimeThreadOperationState.Active
    assertEquals(0, recovered.snapshot.highestStartedSpeechSegment)
    val reconciled = VoiceRuntimeExecutionReducer.reduce(
      recovered.snapshot,
      VoiceRuntimeExecutionEvent.ProcessRestored,
    ).snapshot
    assertEquals(0, reconciled.playbackCursor)
    assertEquals(
      listOf(VoiceRuntimeSpeechDisposition(0, "interrupted")),
      reconciled.speechSegmentDispositions,
    )
  }

  private fun available(store: VoiceRuntimeThreadOperationStore) =
    (store.load() as VoiceRuntimeThreadOperationLoadResult.Available).state

  private fun claim() = VoiceRuntimeThreadClaim(
    runtimeId = "runtime-1",
    runtimeInstanceId = "instance-1",
    readinessGeneration = 4,
    modeSessionId = "mode-1",
    environmentOrigin = "https://example.test",
    projectId = "project-1",
    threadId = "thread-1",
    clientOperationId = "client-1",
    submissionPolicy = "auto-submit",
    speechPlanId = "speech-1",
    draftContext = null,
  )

  private fun active(snapshot: VoiceRuntimeExecutionSnapshot) =
    VoiceRuntimeThreadOperationState.Active(
      claim = claim(),
      operationId = "operation-1",
      expiresAtEpochMillis = 1_900_000_000_000,
      acknowledgedCursor = 0,
      snapshot = snapshot,
    )

  private fun snapshot() = VoiceRuntimeExecutionSnapshot(
    runtimeId = "runtime-1",
    readinessGeneration = 4,
    operationGeneration = 4,
    operationId = "operation-1",
    mode = VoiceRuntimeExecutionMode.THREAD,
    phase = VoiceRuntimePhase.WAITING,
    eventCursor = 1,
  )
}
