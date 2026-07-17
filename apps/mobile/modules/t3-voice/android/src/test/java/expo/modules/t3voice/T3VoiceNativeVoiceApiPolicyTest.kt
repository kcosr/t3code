package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
