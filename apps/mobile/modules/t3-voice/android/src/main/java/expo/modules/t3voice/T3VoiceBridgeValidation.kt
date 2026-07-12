package expo.modules.t3voice

internal object T3VoiceBridgeValidation {
  const val MAXIMUM_IDENTIFIER_LENGTH = 128
  const val MAXIMUM_URI_LENGTH = 4_096
  const val MAXIMUM_SDP_LENGTH = 2 * 1_024 * 1_024
  const val MAXIMUM_PCM_BASE64_LENGTH = 350_000

  fun requireText(input: Map<String, *>, key: String, maximumLength: Int): String {
    val value = input[key] as? String
    require(!value.isNullOrBlank()) { "$key must be a non-empty string." }
    require(value.length <= maximumLength) { "$key exceeds its maximum length." }
    return value
  }

  fun requireInt(input: Map<String, *>, key: String): Int {
    val value = input[key] as? Number ?: error("$key must be a number.")
    val doubleValue = value.toDouble()
    require(
      doubleValue.isFinite() &&
        doubleValue % 1.0 == 0.0 &&
        doubleValue >= Int.MIN_VALUE &&
        doubleValue <= Int.MAX_VALUE
    ) { "$key must be an exact 32-bit integer." }
    return doubleValue.toInt()
  }
}
