package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRuntimeBridgeInputTest {
  @Test
  fun parsesTheExactRealtimeStartShapeWithoutExposingCredentials() {
    val command =
      T3VoiceRuntimeBridgeInput.startRealtime(
        mapOf(
          "target" to
            mapOf(
              "environmentId" to "environment-a",
              "conversation" to
                mapOf(
                  "type" to "new",
                  "retention" to "ephemeral",
                ),
              "focus" to focus,
              "threadSwitch" to threadStart,
            ),
          "session" to session,
        ),
      )

    assertEquals("environment-a", command.target.environmentId)
    assertEquals("thread-a", command.target.focus?.threadId)
    assertEquals("thread-a", command.target.threadSwitch?.target?.threadId)
    val modelSelection = checkNotNull(command.target.threadSwitch?.target?.modelSelection)
    assertEquals("codex", modelSelection.instanceId)
    assertEquals("gpt-5.4", modelSelection.model)
    assertEquals(
      listOf(
        T3VoiceModelOption(
          "reasoningEffort",
          T3VoiceModelOptionValue.StringValue("high"),
        ),
        T3VoiceModelOption("fastMode", T3VoiceModelOptionValue.BooleanValue(true)),
      ),
      modelSelection.options,
    )
    assertFalse(command.session.toString().contains("secret-token"))
    assertTrue(command.session.toString().contains("redacted"))
  }

  @Test
  fun parsesExplicitlyNullRealtimeContextFields() {
    val command =
      T3VoiceRuntimeBridgeInput.startRealtime(
        mapOf(
          "target" to
            mapOf(
              "environmentId" to "environment-a",
              "conversation" to
                mapOf(
                  "type" to "new",
                  "retention" to "ephemeral",
                ),
              "focus" to null,
              "threadSwitch" to null,
            ),
          "session" to session,
        ),
      )

    assertEquals(null, command.target.focus)
    assertEquals(null, command.target.threadSwitch)
  }

  @Test
  fun parsesTheExactThreadToRealtimeSwitchShape() {
    val command =
      T3VoiceRuntimeBridgeInput.switchThreadToRealtime(
        mapOf(
          "target" to
            mapOf(
              "environmentId" to "environment-a",
              "conversation" to mapOf("type" to "new", "retention" to "durable"),
              "focus" to focus,
              "threadSwitch" to threadStart,
            ),
          "session" to session,
        ),
      )

    assertEquals("environment-a", command.target.environmentId)
    assertEquals("thread-a", command.target.focus?.threadId)
    assertFalse(command.session.toString().contains("secret-token"))
  }

  @Test
  fun rejectsUnknownFieldsAtEveryBridgeBoundary() {
    val input =
      mapOf<String, Any?>(
        "input" to threadStart,
        "session" to session,
        "legacySessionId" to "obsolete",
      )

    assertThrows(IllegalStateException::class.java) {
      T3VoiceRuntimeBridgeInput.startThread(input)
    }
  }

  @Test
  fun rejectsThreadSwitchThatDoesNotMatchRealtimeFocus() {
    val mismatched =
      mapOf<String, Any?>(
        "focus" to focus,
        "threadSwitch" to
          threadStart.toMutableMap().apply {
            this["target"] =
              (threadStart.getValue("target") as Map<*, *>).toMutableMap().apply {
                this["threadId"] = "thread-b"
              }
          },
      )

    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeBridgeInput.realtimeContext(mismatched)
    }
  }

  @Test
  fun rejectsLegacyOrNonCanonicalThreadModelSelections() {
    fun startWith(modelSelection: Any?) {
      val target =
        (threadStart.getValue("target") as Map<*, *>).toMutableMap().apply {
          if (modelSelection == null) {
            remove("modelSelection")
          } else {
            this["modelSelection"] = modelSelection
          }
        }
      val input =
        mapOf<String, Any?>(
          "input" to threadStart.toMutableMap().apply { this["target"] = target },
          "session" to session,
        )
      T3VoiceRuntimeBridgeInput.startThread(input)
    }

    assertThrows(IllegalStateException::class.java) { startWith(null) }
    assertThrows(IllegalStateException::class.java) {
      startWith(mapOf("provider" to "codex", "model" to "gpt-5.4"))
    }
    assertThrows(IllegalStateException::class.java) {
      startWith(
        mapOf(
          "instanceId" to "codex",
          "model" to "gpt-5.4",
          "options" to mapOf("fastMode" to true),
        ),
      )
    }
    assertThrows(IllegalStateException::class.java) {
      startWith(
        mapOf(
          "instanceId" to "codex",
          "model" to "gpt-5.4",
          "options" to listOf(mapOf("id" to "effort", "value" to 3)),
        ),
      )
    }
  }

  @Test
  fun threadTranscriptUsesTheSharedSemanticBound() {
    val maximum = "a".repeat(T3VoiceRuntimeBounds.MAXIMUM_THREAD_TRANSCRIPT_CHARS)
    T3VoiceRuntimeCommand.SubmitThreadTranscript(1, 2, maximum)
    T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, 2, maximum)
    T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, 2, "")
    T3VoiceRuntimeCallback.ThreadTranscriptReady(maximum)

    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeCommand.SubmitThreadTranscript(1, 2, maximum + "a")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeCommand.UpdateThreadReviewTranscript(1, 2, maximum + "a")
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceRuntimeCallback.ThreadTranscriptReady(maximum + "a")
    }
  }

  @Test
  fun parsesGenerationFencedReviewUpdateAndSubmitShapes() {
    val update =
      T3VoiceRuntimeBridgeInput.updateThreadReviewTranscript(
        mapOf(
          "expectedGeneration" to 7.0,
          "expectedReviewId" to 11.0,
          "transcript" to "",
        ),
      )
    assertEquals(7L, update.expectedGeneration)
    assertEquals(11L, update.expectedReviewId)
    assertEquals("", update.transcript)

    val submit =
      T3VoiceRuntimeBridgeInput.submitThreadTranscript(
        mapOf(
          "expectedGeneration" to 7.0,
          "expectedReviewId" to 11.0,
          "transcript" to "edited transcript",
        ),
      )
    assertEquals(7L, submit.expectedGeneration)
    assertEquals(11L, submit.expectedReviewId)
    assertEquals("edited transcript", submit.transcript)

    assertThrows(IllegalStateException::class.java) {
      T3VoiceRuntimeBridgeInput.updateThreadReviewTranscript(
        mapOf(
          "expectedGeneration" to 7.0,
          "expectedReviewId" to 11.0,
          "transcript" to "edit",
          "legacyGeneration" to 6.0,
        ),
      )
    }
    assertThrows(IllegalStateException::class.java) {
      T3VoiceRuntimeBridgeInput.submitThreadTranscript(
        mapOf(
          "expectedGeneration" to 7.0,
          "expectedReviewId" to 11.0,
          "transcript" to "",
        ),
      )
    }
  }

  @Test
  fun endpointSettingsRejectUtterancesLongerThanThirtyMinutes() {
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceThreadEndpointDetection(
        endSilenceMs = 2_200,
        noSpeechTimeoutMs = null,
        maximumUtteranceMs = T3VoiceRuntimeBounds.MAXIMUM_UTTERANCE_MS + 1,
      )
    }
  }

  private val focus =
    mapOf<String, Any?>(
      "projectId" to "project-a",
      "threadId" to "thread-a",
    )
  private val threadStart =
    mapOf<String, Any?>(
      "target" to
        mapOf(
          "environmentId" to "environment-a",
          "projectId" to "project-a",
          "threadId" to "thread-a",
          "modelSelection" to
            mapOf(
              "instanceId" to "codex",
              "model" to "gpt-5.4",
              "options" to
                listOf(
                  mapOf("id" to "reasoningEffort", "value" to "high"),
                  mapOf("id" to "fastMode", "value" to true),
                ),
            ),
          "runtimeMode" to "full-access",
          "interactionMode" to "default",
        ),
      "settings" to
        mapOf(
          "submission" to "review",
          "playResponses" to true,
          "autoRearm" to true,
          "endpointDetection" to
            mapOf(
              "endSilenceMs" to 500.0,
              "noSpeechTimeoutMs" to null,
              "maximumUtteranceMs" to 30_000.0,
            ),
          "rearmDelayMs" to 250.0,
          "transcriptionTimeoutMs" to 10_000.0,
          "submissionTimeoutMs" to 10_000.0,
          "responseTimeoutMs" to 30_000.0,
        ),
    )
  private val session =
    mapOf<String, Any?>(
      "baseUrl" to "https://example.test/",
      "accessToken" to "secret-token",
      "expiresAt" to "2026-07-16T20:00:00.000Z",
    )
}
