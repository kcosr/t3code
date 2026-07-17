package expo.modules.t3voice

internal object T3VoiceBridgeValidation {
  const val MAXIMUM_BRIDGE_TEXT_LENGTH = 16_384
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

internal fun Map<String, *>.requireBridgeObject(key: String): Map<String, Any?> =
  (this[key] as? Map<*, *>)?.toStringKeyMap(key) ?: error("$key must be an object.")

internal fun Map<String, *>.optionalBridgeObject(key: String): Map<String, Any?>? {
  val value = this[key] ?: return null
  return (value as? Map<*, *>)?.toStringKeyMap(key) ?: error("$key must be an object or null.")
}

internal fun Map<String, *>.optionalBridgeObjectList(key: String): List<Map<String, Any?>>? {
  if (!containsKey(key)) return null
  val values = this[key] as? List<*> ?: error("$key must be an array.")
  return values.mapIndexed { index, value ->
    (value as? Map<*, *>)?.toStringKeyMap("$key[$index]")
      ?: error("$key[$index] must be an object.")
  }
}

private fun Map<*, *>.toStringKeyMap(name: String): Map<String, Any?> {
  check(keys.all { it is String }) { "$name must use string field names." }
  @Suppress("UNCHECKED_CAST")
  return this as Map<String, Any?>
}

internal fun Map<String, *>.requireBridgeIdentifier(key: String): String =
  requireBridgeText(key, T3VoiceBridgeValidation.MAXIMUM_IDENTIFIER_LENGTH)

internal fun Map<String, *>.requireBridgeText(
  key: String,
  maximumLength: Int = T3VoiceBridgeValidation.MAXIMUM_BRIDGE_TEXT_LENGTH,
): String {
  val value = requireBridgeString(key, maximumLength)
  check(value.isNotBlank()) { "$key must be non-empty." }
  return value
}

internal fun Map<String, *>.requireBridgeArgumentIdentifier(key: String): String =
  requireBridgeArgumentText(key, T3VoiceBridgeValidation.MAXIMUM_IDENTIFIER_LENGTH)

internal fun Map<String, *>.requireBridgeArgumentText(key: String, maximumLength: Int): String =
  T3VoiceBridgeValidation.requireText(this, key, maximumLength)

internal fun Map<String, *>.requireBridgeString(key: String, maximumLength: Int): String {
  val value = this[key] as? String ?: error("$key must be a string.")
  check(value.length <= maximumLength) { "$key is too long." }
  return value
}

internal fun Map<String, *>.requireBridgeBoolean(key: String): Boolean =
  this[key] as? Boolean ?: error("$key must be a boolean.")

internal fun Map<String, *>.requireBridgeInt(key: String): Int =
  T3VoiceBridgeValidation.requireInt(this, key)

internal fun Map<*, *>.requireBridgeLong(key: String): Long =
  optionalBridgeLong(key) ?: error("$key must be an integer.")

internal fun Map<*, *>.optionalBridgeLong(key: String): Long? {
  val value = this[key] ?: return null
  val number = value as? Number ?: error("$key must be an integer or null.")
  val double = number.toDouble()
  val long = number.toLong()
  check(double.isFinite() && double == long.toDouble()) { "$key must be an integer." }
  return long
}

internal fun Map<*, *>.requireExactBridgeKeys(name: String, expected: Set<String>) {
  check(keys == expected) {
    "$name fields must be exactly ${expected.sorted().joinToString()}."
  }
}

internal fun Map<*, *>.requireAllowedBridgeKeys(
  name: String,
  required: Set<String>,
  allowed: Set<String>,
) {
  check(keys.containsAll(required) && allowed.containsAll(keys)) {
    "$name fields are invalid."
  }
}
