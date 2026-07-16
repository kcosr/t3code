package expo.modules.t3voice

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class T3VoiceStateStoreTest {
  @Before fun resetStore() {
    T3VoiceBridgeCompletionStore.pendingRecordings(T3VoiceOperationOwnerDomain.COMPOSER_DICTATION)
      .forEach { T3VoiceBridgeCompletionStore.acknowledgeRecording(it.owner.domain, it.owner.operationId) }
    T3VoiceBridgeCompletionStore.pendingPlaybacks(T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK)
      .forEach { T3VoiceBridgeCompletionStore.acknowledgePlayback(it.owner.domain, it.owner.operationId) }
    T3VoiceStateStore.setInactive()
    T3VoiceStateStore.setServiceReady()
  }

  @After fun tearDown() = T3VoiceStateStore.setInactive()

  @Test fun realtimeOwnershipIsClaimedAtomically() {
    assertTrue(T3VoiceStateStore.claimRealtime("session-a"))
    assertFalse(T3VoiceStateStore.claimRealtime("session-b"))
  }

  @Test fun recordingCompletionIsDurableAndBlocksReplacementUntilAcknowledged() {
    val owner = checkNotNull(claimComposerRecording("recording-a", "operation-a"))
    val terminal = recordingTerminal("recording-a")
    assertTrue(T3VoiceStateStore.terminateRecording(owner, terminal))
    assertNull(claimComposerRecording("recording-b", "operation-b"))
    assertEquals(terminal, T3VoiceBridgeCompletionStore.pendingRecordings(owner.domain).single().terminal)
    assertNull(T3VoiceBridgeCompletionStore.acknowledgeRecording(owner.domain, "other"))
    assertNull(claimComposerRecording("recording-b", "operation-b"))
    T3VoiceBridgeCompletionStore.acknowledgeRecording(owner.domain, owner.operationId)
    assertTrue(claimComposerRecording("recording-b", "operation-b") != null)
  }

  @Test fun playbackCompletionIsDurableAndBlocksReplacementUntilAcknowledged() {
    val owner = checkNotNull(claimManualPlayback("playback-a", "operation-a"))
    val terminal = T3VoiceRuntimeEvent.PlaybackTerminated("playback-a", "completed")
    assertTrue(T3VoiceStateStore.terminatePlayback(owner, terminal))
    assertNull(claimManualPlayback("playback-b", "operation-b"))
    assertEquals(terminal, T3VoiceBridgeCompletionStore.pendingPlaybacks(owner.domain).single().terminal)
    T3VoiceBridgeCompletionStore.acknowledgePlayback(owner.domain, owner.operationId)
    assertTrue(claimManualPlayback("playback-b", "operation-b") != null)
  }

  @Test fun completionRecordsAreIsolatedByOperation() {
    val domain = T3VoiceOperationOwnerDomain.COMPOSER_DICTATION
    val first = T3VoiceOperationOwner("recording-a", domain, "operation-a")
    val second = T3VoiceOperationOwner("recording-b", domain, "operation-b")
    T3VoiceBridgeCompletionStore.putRecording(first, recordingTerminal(first.id))
    T3VoiceBridgeCompletionStore.putRecording(second, recordingTerminal(second.id))
    T3VoiceBridgeCompletionStore.acknowledgeRecording(domain, first.operationId)
    assertEquals(listOf(second.operationId), T3VoiceBridgeCompletionStore.pendingRecordings(domain).map { it.owner.operationId })
  }

  @Test fun recordingCompletionSupportsLookupByRecordingId() {
    val owner = T3VoiceOperationOwner("recording-a", T3VoiceOperationOwnerDomain.COMPOSER_DICTATION, "operation-a")
    T3VoiceBridgeCompletionStore.putRecording(owner, recordingTerminal(owner.id))
    assertEquals(owner, T3VoiceBridgeCompletionStore.recordingById(owner.id)?.owner)
  }

  @Test fun completionWakeContainsOnlyOwnerDomainAndOperationId() {
    assertEquals(
      mapOf("ownerDomain" to "COMPOSER_DICTATION", "operationId" to "operation-a"),
      T3VoiceRuntimeEvent.CompletionWake(
        T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
        "operation-a",
      ).toEventBody(),
    )
  }

  @Test fun serviceRestoreProtectsUnacknowledgedRecordingBeforeCacheSweep() {
    val owner = T3VoiceOperationOwner(
      "recording-a",
      T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
      "operation-a",
    )
    val recording = recordingTerminal(owner.id).recording!!
    T3VoiceBridgeCompletionStore.putRecording(owner, recordingTerminal(owner.id))
    val artifacts = mutableSetOf(recording.uri)
    val restored = mutableSetOf<String>()
    val calls = mutableListOf<String>()

    restoreBridgeRecordingCompletions(
      restoreCompleted = {
        calls += "restore:${it.recordingId}"
        restored += it.uri
      },
      sweepStaleCache = {
        calls += "sweep"
        artifacts.retainAll(restored)
      },
    )

    assertEquals(listOf("restore:recording-a", "sweep"), calls)
    assertTrue(recording.uri in artifacts)
  }

  @Test fun nativeThreadTerminalsDoNotOccupyBridgeCompletionStore() {
    val recording = checkNotNull(T3VoiceStateStore.claimRecording("thread-recording", T3VoiceOperationOwnerDomain.THREAD_MODE, "thread-operation"))
    assertTrue(T3VoiceStateStore.terminateRecording(recording, recordingTerminal(recording.id)))
    val playback = checkNotNull(T3VoiceStateStore.claimPlayback("thread-playback", T3VoiceOperationOwnerDomain.THREAD_MODE, "thread-operation"))
    assertTrue(T3VoiceStateStore.terminatePlayback(playback, T3VoiceRuntimeEvent.PlaybackTerminated(playback.id, "completed")))
    assertTrue(T3VoiceBridgeCompletionStore.pendingRecordings(T3VoiceOperationOwnerDomain.COMPOSER_DICTATION).isEmpty())
    assertTrue(T3VoiceBridgeCompletionStore.pendingPlaybacks(T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK).isEmpty())
  }

  private fun recordingTerminal(recordingId: String) = T3VoiceRuntimeEvent.RecordingTerminated(
    recordingId,
    T3VoiceRecordingResult(recordingId, "file:///$recordingId.m4a", 1_000, 4_096),
    "completed",
    "speech-ended",
  )

  private fun claimComposerRecording(recordingId: String, operationId: String) =
    T3VoiceStateStore.claimRecording(recordingId, T3VoiceOperationOwnerDomain.COMPOSER_DICTATION, operationId)

  private fun claimManualPlayback(playbackId: String, operationId: String) =
    T3VoiceStateStore.claimPlayback(playbackId, T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK, operationId)
}
