package expo.modules.t3voice

internal data class T3VoiceSpeechSegment(
  val index: Int,
  val text: String,
  val finalSegment: Boolean,
) {
  init {
    require(index >= 0) { "Speech segment index must be non-negative." }
    require(text.isNotBlank()) { "Speech segment text must be non-empty." }
    require(text.toByteArray(Charsets.UTF_8).size <= MAXIMUM_TEXT_BYTES) {
      "Speech segment exceeds the voice contract byte limit."
    }
  }

  companion object {
    const val MAXIMUM_TEXT_BYTES = 8 * 1_024
  }
}

internal object T3VoiceSpeechSegmenter {
  fun segment(
    text: String,
    preferredMaximumChars: Int = DEFAULT_PREFERRED_MAXIMUM_CHARS,
    maximumBytes: Int = T3VoiceSpeechSegment.MAXIMUM_TEXT_BYTES,
  ): List<T3VoiceSpeechSegment> {
    require(text.isNotBlank()) { "Speech text must be non-empty." }
    require(preferredMaximumChars > 0) { "Preferred speech segment size must be positive." }
    require(maximumBytes > 0 && maximumBytes <= T3VoiceSpeechSegment.MAXIMUM_TEXT_BYTES) {
      "Invalid speech segment byte limit."
    }

    val chunks = mutableListOf<String>()
    var remaining = text.trim()
    while (remaining.isNotEmpty()) {
      val byteBoundary = utf8Boundary(remaining, maximumBytes)
      val preferredBoundary = safeUtf16Boundary(remaining, preferredMaximumChars)
      val maximumBoundary = minOf(byteBoundary, preferredBoundary)
      val boundary =
        if (maximumBoundary == remaining.length) {
          maximumBoundary
        } else {
          naturalBoundary(remaining, maximumBoundary)
        }
      val chunk = remaining.substring(0, boundary).trim()
      remaining = remaining.substring(boundary).trimStart()
      if (chunk.isNotEmpty()) chunks += chunk
    }
    return chunks.mapIndexed { index, chunk ->
      T3VoiceSpeechSegment(
        index = index,
        text = chunk,
        finalSegment = index == chunks.lastIndex,
      )
    }
  }

  private fun utf8Boundary(text: String, maximumBytes: Int): Int {
    var index = 0
    var bytes = 0
    while (index < text.length) {
      val codePoint = text.codePointAt(index)
      val width = Character.charCount(codePoint)
      val encodedBytes = String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8).size
      if (bytes + encodedBytes > maximumBytes) break
      bytes += encodedBytes
      index += width
    }
    check(index > 0) { "Speech byte limit cannot hold one Unicode code point." }
    return index
  }

  private fun safeUtf16Boundary(text: String, maximumChars: Int): Int {
    if (text.length <= maximumChars) return text.length
    var boundary = maximumChars
    if (boundary < text.length && Character.isLowSurrogate(text[boundary])) boundary -= 1
    return boundary.coerceAtLeast(1)
  }

  private fun naturalBoundary(text: String, maximum: Int): Int {
    val bounded = text.substring(0, maximum)
    val sentence = SENTENCE_BOUNDARY.findAll(bounded).lastOrNull()?.range?.last?.plus(1)
    if (sentence != null && sentence >= MINIMUM_NATURAL_BOUNDARY_CHARS) return sentence
    val newline = bounded.lastIndexOf('\n')
    if (newline >= MINIMUM_NATURAL_BOUNDARY_CHARS) return newline + 1
    val whitespace = bounded.indexOfLast(Char::isWhitespace)
    return if (whitespace >= MINIMUM_NATURAL_BOUNDARY_CHARS) whitespace + 1 else maximum
  }

  private const val DEFAULT_PREFERRED_MAXIMUM_CHARS = 240
  private const val MINIMUM_NATURAL_BOUNDARY_CHARS = 32
  private val SENTENCE_BOUNDARY = Regex("[.!?](?:[\\\"')\\]]*)\\s+")
}
