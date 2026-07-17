package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

internal class T3VoiceNativeVoiceApiPolicyTest {
  @Test
  fun `JSON integer parser rejects fractions non-finite values and overflow`() {
    assertEquals(1L, t3VoiceExactJsonLong(1, "sequence"))
    assertEquals(1L, t3VoiceExactJsonLong(1.0, "leaseGeneration"))
    assertNull(t3VoiceExactJsonLong(1.5, "sequence"))
    assertNull(t3VoiceExactJsonLong(Double.NaN, "sequence"))
    assertNull(t3VoiceExactJsonLong(Double.POSITIVE_INFINITY, "sequence"))
    assertNull(t3VoiceExactJsonLong("1", "sequence"))
    assertNull(t3VoiceExactJsonLong("9223372036854775808".toBigInteger(), "sequence"))
  }

  @Test
  fun `Thread turn dispatch sends the canonical model selection`() {
    val selection =
      T3VoiceModelSelection(
        instanceId = "codex_personal",
        model = "gpt-5.4",
        options =
          listOf(
            T3VoiceModelOption(
              "reasoningEffort",
              T3VoiceModelOptionValue.StringValue("high"),
            ),
            T3VoiceModelOption(
              "fastMode",
              T3VoiceModelOptionValue.BooleanValue(true),
            ),
          ),
      )

    assertEquals(
      mapOf(
        "instanceId" to "codex_personal",
        "model" to "gpt-5.4",
        "options" to
          listOf(
            mapOf("id" to "reasoningEffort", "value" to "high"),
            mapOf("id" to "fastMode", "value" to true),
          ),
      ),
      selection.toCanonicalWireBody(),
    )
  }

  @Test
  fun `Realtime SDP validation preserves framing whitespace`() {
    val answerSdp = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\n"

    assertEquals(answerSdp, t3VoiceValidatedSdp(answerSdp))
    assertThrows(IllegalArgumentException::class.java) {
      t3VoiceValidatedSdp(" \r\n\t")
    }
  }

  @Test
  fun `Realtime terminal capabilities follow native Thread settings`() {
    val focus = T3VoiceRealtimeFocus("project-a", "thread-a")

    assertEquals(
      listOf("stop-realtime"),
      t3VoiceRealtimeTerminalActions(T3VoiceRealtimeContext(focus, null)),
    )
    assertEquals(
      listOf("stop-realtime", "switch-to-thread"),
      t3VoiceRealtimeTerminalActions(T3VoiceRealtimeContext(focus, THREAD_SETTINGS)),
    )
  }

  @Test
  fun `Realtime context payload derives switch capability independently of focus`() {
    val focus = T3VoiceRealtimeFocus("project-a", "thread-a")

    val withSwitch =
      t3VoiceRealtimeContextFields(T3VoiceRealtimeContext(focus, THREAD_SETTINGS), leaseGeneration = 7)
    assertEquals(7L, withSwitch["leaseGeneration"])
    assertEquals("project-a", withSwitch["projectId"])
    assertEquals("thread-a", withSwitch["threadId"])
    assertEquals(
      listOf("stop-realtime", "switch-to-thread"),
      withSwitch["terminalActions"],
    )

    val withoutSwitch =
      t3VoiceRealtimeContextFields(T3VoiceRealtimeContext(focus, null), leaseGeneration = 8)
    assertEquals(listOf("stop-realtime"), withoutSwitch["terminalActions"])

    val withoutFocus =
      t3VoiceRealtimeContextFields(T3VoiceRealtimeContext(null, null), leaseGeneration = 9)
    assertFalse(withoutFocus.containsKey("projectId"))
    assertFalse(withoutFocus.containsKey("threadId"))
    assertEquals(listOf("stop-realtime"), withoutFocus["terminalActions"])
  }

  private companion object {
    val THREAD_SETTINGS =
      T3VoiceThreadSettings(
        submissionPolicy = T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT,
        playResponses = true,
        autoRearm = true,
        endpointDetection = T3VoiceThreadEndpointDetection(900, 10_000, 120_000),
        rearmDelayMs = 750,
        transcriptionTimeoutMs = 600_000,
        submissionTimeoutMs = 30_000,
        responseTimeoutMs = 600_000,
      )
  }
}
