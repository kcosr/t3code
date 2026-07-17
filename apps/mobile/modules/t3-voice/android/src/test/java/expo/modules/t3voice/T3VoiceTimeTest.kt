package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

internal class T3VoiceTimeTest {
  @Test
  fun `ISO parser is strict and normalizes offsets without java time`() {
    val utc = T3VoiceTime.parseIsoEpochMillis("2026-07-16T12:34:56.789Z", "value")
    assertEquals(
      utc,
      T3VoiceTime.parseIsoEpochMillis("2026-07-16T14:34:56.789+02:00", "value"),
    )
    assertEquals(
      utc,
      T3VoiceTime.parseIsoEpochMillis("2026-07-16T07:04:56.789-05:30", "value"),
    )
    assertEquals(
      utc,
      T3VoiceTime.parseIsoEpochMillis("2026-07-16T12:34:56.789123456Z", "value"),
    )
  }

  @Test
  fun `ISO parser rejects invalid dates and offset shapes`() {
    listOf(
      "2026-02-30T00:00:00Z",
      "2026-07-16 12:34:56Z",
      "2026-07-16T12:34:56",
      "2026-07-16T12:34:56+24:00",
    ).forEach { value ->
      assertThrows(IllegalArgumentException::class.java) {
        T3VoiceTime.parseIsoEpochMillis(value, "value")
      }
    }
  }
}
