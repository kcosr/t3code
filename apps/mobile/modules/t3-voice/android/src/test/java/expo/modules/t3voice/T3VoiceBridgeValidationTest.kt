package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class T3VoiceBridgeValidationTest {
  @Test
  fun acceptsExactIntegerBoundaries() {
    assertEquals(Int.MIN_VALUE, T3VoiceBridgeValidation.requireInt(mapOf("value" to Int.MIN_VALUE), "value"))
    assertEquals(Int.MAX_VALUE, T3VoiceBridgeValidation.requireInt(mapOf("value" to Int.MAX_VALUE), "value"))
  }

  @Test
  fun rejectsLossyAndNonFiniteNumbers() {
    listOf(Double.NaN, Double.POSITIVE_INFINITY, 1.5, Int.MAX_VALUE.toDouble() + 1).forEach { value ->
      assertThrows(IllegalArgumentException::class.java) {
        T3VoiceBridgeValidation.requireInt(mapOf("value" to value), "value")
      }
    }
  }

  @Test
  fun enforcesTextLength() {
    assertEquals("abcd", T3VoiceBridgeValidation.requireText(mapOf("id" to "abcd"), "id", 4))
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBridgeValidation.requireText(mapOf("id" to "abcde"), "id", 4)
    }
  }
}
