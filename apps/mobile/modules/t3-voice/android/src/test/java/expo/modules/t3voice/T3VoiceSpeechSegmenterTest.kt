package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceSpeechSegmenterTest {
  @Test
  fun `segments complete text at sentence boundaries in order`() {
    val text =
      "This is the first complete sentence. " +
        "The second sentence contains enough words to cross the preferred boundary. " +
        "The final sentence is preserved."

    val segments = T3VoiceSpeechSegmenter.segment(text, preferredMaximumChars = 70)

    assertEquals(text, segments.joinToString(" ") { it.text })
    assertEquals(segments.indices.toList(), segments.map { it.index })
    assertTrue(segments.dropLast(1).all { !it.finalSegment })
    assertTrue(segments.last().finalSegment)
  }

  @Test
  fun `UTF-8 byte limit never splits a Unicode code point`() {
    val text = "🙂".repeat(20)
    val segments =
      T3VoiceSpeechSegmenter.segment(
        text,
        preferredMaximumChars = 1_000,
        maximumBytes = 17,
      )

    assertEquals(text, segments.joinToString("") { it.text })
    assertTrue(segments.all { it.text.toByteArray(Charsets.UTF_8).size <= 17 })
    assertTrue(segments.all { !it.text.contains('\uFFFD') })
  }

  @Test
  fun `hard split falls back safely when text has no natural boundary`() {
    val text = "a".repeat(700)
    val segments = T3VoiceSpeechSegmenter.segment(text, preferredMaximumChars = 240)

    assertEquals(text, segments.joinToString("") { it.text })
    assertEquals(listOf(240, 240, 220), segments.map { it.text.length })
  }
}
