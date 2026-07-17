package expo.modules.t3voice

import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.Locale

/** A credential-free, root-scoped environment URL used by the native voice runtime. */
internal class T3VoiceHttpBaseUrl private constructor(
  val normalized: String,
) {
  fun endpoint(
    pathname: String,
    queryParameters: Map<String, String> = emptyMap(),
  ): URL {
    val path = URI(pathname)
    val rawSegments = path.rawPath.orEmpty().split('/')
    require(
      pathname.startsWith('/') &&
        !pathname.startsWith("//") &&
        path.scheme == null &&
        path.rawAuthority == null &&
        path.rawQuery == null &&
        path.rawFragment == null &&
        path.rawPath == path.normalize().rawPath &&
        rawSegments.none { it == "." || it == ".." } &&
        '\\' !in path.rawPath,
    ) { "Invalid native voice endpoint path." }

    val query = encodeQuery(queryParameters)
    val endpoint = normalized.dropLast(1) + path.rawPath + query
    require(endpoint.length <= MAXIMUM_ENDPOINT_LENGTH) { "Native voice endpoint is too long." }
    return URI(endpoint).toURL()
  }

  override fun toString(): String = normalized

  companion object {
    fun parse(value: String): T3VoiceHttpBaseUrl {
      require(value == value.trim()) { "Invalid native voice environment URL." }
      val uri = URI(value)
      val scheme = uri.scheme?.lowercase(Locale.ROOT)
      require(scheme == "http" || scheme == "https") {
        "Native voice environment URL must use HTTP or HTTPS."
      }
      require(!uri.host.isNullOrBlank() && uri.rawUserInfo == null) {
        "Invalid native voice environment URL."
      }
      require(uri.rawQuery == null && uri.rawFragment == null) {
        "Native voice environment URL cannot contain a query or fragment."
      }
      require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") {
        "Native voice environment URL must use the root path."
      }
      require(uri.port == -1 || uri.port in 0..65_535) {
        "Invalid native voice environment port."
      }

      val port =
        when {
          scheme == "http" && uri.port == 80 -> -1
          scheme == "https" && uri.port == 443 -> -1
          else -> uri.port
        }
      val normalized =
        URI(
          scheme,
          null,
          uri.host.lowercase(Locale.ROOT),
          port,
          "/",
          null,
          null,
        ).toASCIIString()
      return T3VoiceHttpBaseUrl(normalized)
    }

    private fun encodeQuery(parameters: Map<String, String>): String {
      if (parameters.isEmpty()) return ""
      val encoded =
        parameters.entries
          .sortedBy(Map.Entry<String, String>::key)
          .joinToString("&") { (name, value) ->
            require(QUERY_NAME.matches(name)) { "Invalid native voice query parameter name." }
            require(value.length <= MAXIMUM_QUERY_VALUE_LENGTH) {
              "Native voice query parameter is too long."
            }
            val encodedValue =
              URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
            "$name=$encodedValue"
          }
      return "?$encoded"
    }

    private const val MAXIMUM_ENDPOINT_LENGTH = 8_192
    private const val MAXIMUM_QUERY_VALUE_LENGTH = 1_024
    private val QUERY_NAME = Regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$")
  }
}

internal object T3VoiceHttpPathSegment {
  fun encode(value: String): String {
    require(value.isNotEmpty() && value == value.trim()) {
      "Native voice path identifiers must be non-empty trimmed strings."
    }
    return buildString {
      value.toByteArray(Charsets.UTF_8).forEach { byte ->
        val unsigned = byte.toInt() and 0xff
        if (isUnreserved(unsigned)) {
          append(unsigned.toChar())
        } else {
          append('%')
          append(HEX[unsigned ushr 4])
          append(HEX[unsigned and 0x0f])
        }
      }
    }
  }

  private fun isUnreserved(value: Int): Boolean =
    value in 'a'.code..'z'.code ||
      value in 'A'.code..'Z'.code ||
      value in '0'.code..'9'.code ||
      value == '-'.code ||
      value == '_'.code ||
      value == '~'.code

  private const val HEX = "0123456789ABCDEF"
}

internal class T3VoiceBearerToken(value: String) {
  private val headerValue: String

  init {
    require(value.isNotBlank() && value.length <= MAXIMUM_TOKEN_LENGTH) {
      "Invalid native voice bearer token."
    }
    require(value.all { it.code in VISIBLE_ASCII_RANGE }) {
      "Invalid native voice bearer token."
    }
    headerValue = "Bearer $value"
  }

  fun applyTo(connection: HttpURLConnection) {
    connection.setRequestProperty("authorization", headerValue)
  }

  override fun toString(): String = "T3VoiceBearerToken(<redacted>)"

  private companion object {
    const val MAXIMUM_TOKEN_LENGTH = 4_096
    val VISIBLE_ASCII_RANGE = 0x21..0x7e
  }
}

internal class T3VoiceMediaTicketToken(value: String) {
  private val headerValue: String

  init {
    require(value.isNotBlank() && value.length <= MAXIMUM_TOKEN_LENGTH) {
      "Invalid native voice media ticket."
    }
    require(value.all { it.code in VISIBLE_ASCII_RANGE }) {
      "Invalid native voice media ticket."
    }
    headerValue = value
  }

  fun applyTo(connection: HttpURLConnection) {
    connection.setRequestProperty("x-t3-voice-ticket", headerValue)
  }

  override fun toString(): String = "T3VoiceMediaTicketToken(<redacted>)"

  private companion object {
    const val MAXIMUM_TOKEN_LENGTH = 4_096
    val VISIBLE_ASCII_RANGE = 0x21..0x7e
  }
}

internal data class T3VoiceHttpLimits(
  val connectTimeoutMillis: Int = DEFAULT_CONNECT_TIMEOUT_MILLIS,
  val readTimeoutMillis: Int = DEFAULT_READ_TIMEOUT_MILLIS,
  val maximumRequestBytes: Long = DEFAULT_MAXIMUM_REQUEST_BYTES,
  val maximumJsonResponseBytes: Int = DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES,
  val maximumStreamResponseBytes: Int = DEFAULT_MAXIMUM_STREAM_RESPONSE_BYTES,
) {
  init {
    require(connectTimeoutMillis in 1..MAXIMUM_TIMEOUT_MILLIS) {
      "Invalid native voice connect timeout."
    }
    require(readTimeoutMillis in 1..MAXIMUM_TIMEOUT_MILLIS) {
      "Invalid native voice read timeout."
    }
    require(maximumRequestBytes in 1..ABSOLUTE_MAXIMUM_REQUEST_BYTES) {
      "Invalid native voice request limit."
    }
    require(maximumJsonResponseBytes in 1..ABSOLUTE_MAXIMUM_RESPONSE_BYTES) {
      "Invalid native voice JSON response limit."
    }
    require(maximumStreamResponseBytes in 1..ABSOLUTE_MAXIMUM_RESPONSE_BYTES) {
      "Invalid native voice stream response limit."
    }
  }

  companion object {
    const val DEFAULT_CONNECT_TIMEOUT_MILLIS = 5_000
    const val DEFAULT_READ_TIMEOUT_MILLIS = 30_000
    const val DEFAULT_MAXIMUM_REQUEST_BYTES = 32L * 1_024L * 1_024L
    const val DEFAULT_MAXIMUM_JSON_RESPONSE_BYTES = 1 * 1_024 * 1_024
    const val DEFAULT_MAXIMUM_STREAM_RESPONSE_BYTES = 64 * 1_024 * 1_024
    const val ABSOLUTE_MAXIMUM_REQUEST_BYTES = 64L * 1_024L * 1_024L
    const val ABSOLUTE_MAXIMUM_RESPONSE_BYTES = 128 * 1_024 * 1_024
    private const val MAXIMUM_TIMEOUT_MILLIS = 120_000
  }
}

internal enum class T3VoiceHttpFailureKind {
  AUTHENTICATION,
  CONFLICT,
  RETRYABLE,
  PERMANENT,
  BOUNDS_EXCEEDED,
  UNEXPECTED_CONTENT_TYPE,
  CANCELLED,
}

internal object T3VoiceHttpStatusPolicy {
  fun classify(statusCode: Int): T3VoiceHttpFailureKind? =
    when (statusCode) {
      in 200..299 -> null
      HttpURLConnection.HTTP_UNAUTHORIZED,
      HttpURLConnection.HTTP_FORBIDDEN,
      -> T3VoiceHttpFailureKind.AUTHENTICATION
      HttpURLConnection.HTTP_CONFLICT -> T3VoiceHttpFailureKind.CONFLICT
      HttpURLConnection.HTTP_CLIENT_TIMEOUT,
      425,
      429,
      in 500..599,
      -> T3VoiceHttpFailureKind.RETRYABLE
      else -> T3VoiceHttpFailureKind.PERMANENT
    }
}

internal class T3VoiceBoundedResponseStream(
  input: InputStream,
  private val maximumBytes: Int,
) : FilterInputStream(input) {
  private var consumed = 0

  init {
    require(maximumBytes > 0) { "Native voice response limit must be positive." }
  }

  override fun read(): Int {
    val value = super.read()
    if (value == -1) return -1
    if (consumed == maximumBytes) throw T3VoiceHttpBoundsException
    consumed += 1
    return value
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (consumed == maximumBytes) {
      return if (super.read() == -1) -1 else throw T3VoiceHttpBoundsException
    }
    val allowed = minOf(length, maximumBytes - consumed)
    return super.read(buffer, offset, allowed).also { read ->
      if (read > 0) consumed += read
    }
  }
}

internal data object T3VoiceHttpBoundsException : IllegalStateException(
  "Native voice HTTP payload exceeded its limit.",
)

internal data object T3VoiceHttpCancelledException : IllegalStateException(
  "Native voice HTTP call was cancelled.",
)
