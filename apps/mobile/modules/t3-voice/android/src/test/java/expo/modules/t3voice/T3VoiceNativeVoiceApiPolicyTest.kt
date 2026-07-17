package expo.modules.t3voice

import org.junit.Assert.assertEquals
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
}
