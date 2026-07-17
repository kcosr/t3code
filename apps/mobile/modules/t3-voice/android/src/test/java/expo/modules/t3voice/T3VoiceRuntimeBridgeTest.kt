package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRuntimeBridgeTest {
  @Test
  fun idleSnapshotCarriesDirectAtomicAttachIdentity() {
    val body = T3VoiceControllerSnapshot(T3VoiceControllerState.Idle, 3, 7).toBridgeBody()

    assertEquals("idle", body["mode"])
    assertEquals(3.0, body["generation"])
    assertEquals(7.0, body["sequence"])
    assertFalse(body.containsKey("snapshot"))
  }

  @Test
  fun realtimeSnapshotIncludesContextAndNeverIncludesSessionCredential() {
    val settings = settings()
    val target =
      T3VoiceRealtimeTarget(
        environmentId = "environment-a",
        conversation =
          T3VoiceConversationSelection.New(
            retention = T3VoiceConversationRetention.DURABLE,
            title = "Voice",
          ),
        focus = T3VoiceRealtimeFocus("project-a", "thread-a"),
        threadSettings = settings,
      )
    val body =
      T3VoiceControllerSnapshot(
        state =
          T3VoiceControllerState.Realtime(
            stage = T3VoiceRealtimeStage.CONNECTED,
            target = target,
            muted = false,
            pendingClientActions = emptyList(),
            audioRoutes = emptyList(),
            transcript = emptyList(),
            pendingConfirmations = emptyList(),
          ),
        generation = 1,
        sequence = 2,
      ).toBridgeBody()

    @Suppress("UNCHECKED_CAST")
    val targetBody = body["target"] as Map<String, Any?>
    assertEquals("environment-a", targetBody["environmentId"])
    assertTrue(targetBody["threadSettings"] is Map<*, *>)
    assertFalse(body.toString().contains("accessToken"))
  }

  @Test
  fun threadSnapshotMapsNativeUploadingStageToSemanticTranscribing() {
    val body =
      T3VoiceControllerSnapshot(
        state =
          T3VoiceControllerState.Thread(
            stage = T3VoiceThreadStage.UPLOADING,
            target = threadTarget(),
            settings = settings(),
            transcript = null,
            attention = T3VoiceThreadAttention.APPROVAL_REQUIRED,
          ),
        generation = 4,
        sequence = 12,
      ).toBridgeBody()

    assertEquals("thread", body["mode"])
    assertEquals("transcribing", body["phase"])
    assertEquals("approval-required", body["attention"])
    assertNull(body["transcript"])
    @Suppress("UNCHECKED_CAST")
    val target = body["target"] as Map<String, Any?>
    assertEquals(
      mapOf<String, Any>("instanceId" to "codex", "model" to "gpt-5.4"),
      target["modelSelection"],
    )
  }

  @Test
  fun threadToRealtimeSwitchSnapshotRetainsBothTargetsWithoutCredentials() {
    val threadStart = T3VoiceThreadStart(threadTarget(), settings())
    val realtimeTarget =
      T3VoiceRealtimeTarget(
        environmentId = "environment-a",
        conversation =
          T3VoiceConversationSelection.New(
            retention = T3VoiceConversationRetention.DURABLE,
            title = "Voice",
          ),
        focus = T3VoiceRealtimeFocus("project-a", "thread-a"),
        threadSettings = threadStart.settings,
      )
    val body =
      T3VoiceControllerSnapshot(
        state =
          T3VoiceControllerState.SwitchingToRealtime(
            threadStart = threadStart,
            realtimeTarget = realtimeTarget,
          ),
        generation = 4,
        sequence = 12,
      ).toBridgeBody()

    assertEquals("switching-to-realtime", body["mode"])
    assertFalse(body.containsKey("phase"))
    @Suppress("UNCHECKED_CAST")
    val source = body["source"] as Map<String, Any?>
    assertEquals("thread-a", source["threadId"])
    @Suppress("UNCHECKED_CAST")
    val target = body["target"] as Map<String, Any?>
    assertEquals("environment-a", target["environmentId"])
    assertFalse(body.toString().contains("accessToken"))
  }

  @Test
  fun failedSnapshotPreservesItsEnvironmentIdentity() {
    val body =
      T3VoiceControllerSnapshot(
        state =
          T3VoiceControllerState.Failed(
            environmentId = "environment-a",
            operation = T3VoiceOperation.THREAD,
            failure = T3VoiceFailure("thread-failed", "Thread failed.", true),
          ),
        generation = 4,
        sequence = 14,
      ).toBridgeBody()

    assertEquals("failed", body["mode"])
    assertEquals("environment-a", body["environmentId"])
  }

  @Test
  fun reviewingSnapshotPublishesTheAuthoritativeEditedTranscript() {
    val body =
      T3VoiceControllerSnapshot(
        state =
          T3VoiceControllerState.Thread(
            stage = T3VoiceThreadStage.REVIEWING,
            target = threadTarget(),
            settings = settings(),
            transcript = "edited review buffer",
            attention = null,
            reviewId = 13,
          ),
        generation = 4,
        sequence = 13,
      ).toBridgeBody()

    assertEquals("reviewing", body["phase"])
    assertEquals("edited review buffer", body["transcript"])
    assertEquals(4.0, body["generation"])
    assertEquals(13.0, body["reviewId"])
  }

  private fun threadTarget() =
    T3VoiceThreadTarget(
      environmentId = "environment-a",
      projectId = "project-a",
      threadId = "thread-a",
      modelSelection =
        T3VoiceModelSelection(
          instanceId = "codex",
          model = "gpt-5.4",
          options = null,
        ),
      runtimeMode = T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS,
      interactionMode = T3VoiceThreadInteractionMode.DEFAULT,
    )

  private fun settings() =
    T3VoiceThreadSettings(
      submissionPolicy = T3VoiceThreadSubmissionPolicy.REVIEW,
      playResponses = true,
      autoRearm = true,
      endpointDetection =
        T3VoiceThreadEndpointDetection(
          endSilenceMs = 900,
          noSpeechTimeoutMs = 10_000,
          maximumUtteranceMs = 120_000,
        ),
      rearmDelayMs = 750,
      transcriptionTimeoutMs = 600_000,
      submissionTimeoutMs = 30_000,
      responseTimeoutMs = 600_000,
    )
}
