package expo.modules.t3voice

import java.text.SimpleDateFormat
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone

/** API-24-safe ISO instant parsing and formatting used by the native-only credential lifetime. */
internal object T3VoiceTime {
  fun nowEpochMillis(): Long = System.currentTimeMillis()

  fun nowIso(): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).run {
      isLenient = false
      timeZone = UTC
      format(java.util.Date(nowEpochMillis()))
    }

  fun parseIsoEpochMillis(value: String, name: String): Long {
    val match = ISO_INSTANT.matchEntire(value)
      ?: throw IllegalArgumentException("$name must be an ISO-8601 instant.")
    val components = match.groupValues
    val fraction = components[7]
    val millis = fraction.take(3).padEnd(3, '0').ifEmpty { "0" }.toInt()
    val calendar =
      GregorianCalendar(UTC, Locale.US).apply {
        isLenient = false
        clear()
        set(GregorianCalendar.YEAR, components[1].toInt())
        set(GregorianCalendar.MONTH, components[2].toInt() - 1)
        set(GregorianCalendar.DAY_OF_MONTH, components[3].toInt())
        set(GregorianCalendar.HOUR_OF_DAY, components[4].toInt())
        set(GregorianCalendar.MINUTE, components[5].toInt())
        set(GregorianCalendar.SECOND, components[6].toInt())
        set(GregorianCalendar.MILLISECOND, millis)
      }
    val localAsUtc =
      runCatching { calendar.timeInMillis }.getOrElse {
        throw IllegalArgumentException("$name must be an ISO-8601 instant.", it)
      }
    val zone = components[8]
    if (zone == "Z") return localAsUtc
    val direction = if (zone[0] == '+') 1 else -1
    val offsetHours = zone.substring(1, 3).toInt()
    val offsetMinutes = zone.substring(4, 6).toInt()
    require(offsetHours <= 23 && offsetMinutes <= 59) {
      "$name must be an ISO-8601 instant."
    }
    val offsetMillis =
      direction *
        ((offsetHours * 60L + offsetMinutes) * 60L * 1_000L)
    return Math.subtractExact(localAsUtc, offsetMillis)
  }

  private val UTC = TimeZone.getTimeZone("UTC")
  private val ISO_INSTANT =
    Regex(
      "^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})" +
        "(?:\\.(\\d{1,9}))?(Z|[+-]\\d{2}:\\d{2})$",
    )
}
