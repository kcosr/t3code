package expo.modules.t3voice

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

internal object T3VoiceBackgroundOriginPolicy {
  fun normalize(origin: String): String {
    val uri = URI(origin)
    require(uri.scheme.equals("https", ignoreCase = true)) {
      "Background voice execution requires HTTPS."
    }
    require(!uri.host.isNullOrBlank() && uri.userInfo === null) {
      "Invalid background voice origin."
    }
    require(uri.rawQuery === null && uri.rawFragment === null) {
      "Background voice origins cannot contain a query or fragment."
    }
    require(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") {
      "Background voice origins cannot contain a path."
    }
    require(uri.port in -1..65535) { "Invalid background voice origin port." }
    return URI("https", null, uri.host, uri.port, null, null, null).toASCIIString()
  }

  fun endpoint(
    origin: String,
    path: String,
    queryParameters: Map<String, String> = emptyMap(),
  ): URL {
    val normalized = URI(normalize(origin))
    val pathUri = URI(path)
    require(
      path.startsWith("/") &&
        pathUri.scheme === null &&
        pathUri.rawAuthority === null &&
        pathUri.rawQuery === null &&
        pathUri.rawFragment === null &&
        pathUri.normalize().rawPath == pathUri.rawPath &&
        pathUri.rawPath.split('/').none { it == "." || it == ".." },
    ) { "Invalid background voice endpoint path." }
    queryParameters.forEach { (name, value) ->
      require(name.matches(QUERY_NAME_PATTERN) && value.length <= MAXIMUM_QUERY_VALUE_LENGTH) {
        "Invalid background voice query parameter."
      }
    }
    val query =
      queryParameters.entries
        .sortedBy(Map.Entry<String, String>::key)
        .joinToString("&") { (name, value) ->
          "$name=${URLEncoder.encode(value, Charsets.UTF_8).replace("+", "%20")}"
        }
        .ifEmpty { null }
    val endpoint =
      buildString {
        append(normalized.toASCIIString())
        append(pathUri.rawPath)
        if (query !== null) {
          append('?')
          append(query)
        }
      }
    return URI(endpoint).toURL()
  }

  private val QUERY_NAME_PATTERN = Regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$")
  private const val MAXIMUM_QUERY_VALUE_LENGTH = 256
}

internal enum class T3VoiceBackgroundHttpMethod {
  GET,
  POST,
  PUT,
}

internal data class T3VoiceBackgroundAuthority(
  val headerName: String,
  val token: String,
) {
  init {
    require(headerName.matches(HEADER_NAME_PATTERN)) { "Invalid background authority header." }
    require(token.isNotBlank() && token.length <= 128 && token.none(Char::isWhitespace)) {
      "Invalid background authority token."
    }
  }

  private companion object {
    val HEADER_NAME_PATTERN = Regex("^[A-Za-z0-9!#$%&'*+.^_`|~-]+$")
  }
}

internal interface T3VoiceBackgroundRequestBody {
  val contentType: String
  val contentLength: Long

  fun openStream(): InputStream
}

internal data class T3VoiceBackgroundByteArrayBody(
  private val bytes: ByteArray,
  override val contentType: String,
) : T3VoiceBackgroundRequestBody {
  override val contentLength: Long = bytes.size.toLong()

  override fun openStream(): InputStream = ByteArrayInputStream(bytes)
}

internal data class T3VoiceBackgroundHttpRequest(
  val origin: String,
  val path: String,
  val method: T3VoiceBackgroundHttpMethod,
  val authority: T3VoiceBackgroundAuthority,
  val body: T3VoiceBackgroundRequestBody? = null,
  val maximumRequestBytes: Long = DEFAULT_MAXIMUM_REQUEST_BYTES,
  val maximumResponseBytes: Int = DEFAULT_MAXIMUM_RESPONSE_BYTES,
  val queryParameters: Map<String, String> = emptyMap(),
) {
  init {
    T3VoiceBackgroundOriginPolicy.endpoint(origin, path, queryParameters)
    require(maximumRequestBytes in 0..ABSOLUTE_MAXIMUM_REQUEST_BYTES) {
      "Invalid background request limit."
    }
    require(maximumResponseBytes in 1..ABSOLUTE_MAXIMUM_RESPONSE_BYTES) {
      "Invalid background response limit."
    }
    require((method != T3VoiceBackgroundHttpMethod.GET) || body === null) {
      "GET background requests cannot contain a body."
    }
    require(body === null || body.contentLength in 0..maximumRequestBytes) {
      "Background request body exceeds its limit."
    }
    require(body === null || validContentType(body.contentType)) {
      "Invalid background request content type."
    }
  }

  companion object {
    const val DEFAULT_MAXIMUM_REQUEST_BYTES = 32L * 1024L * 1024L
    const val DEFAULT_MAXIMUM_RESPONSE_BYTES = 1024 * 1024
    const val ABSOLUTE_MAXIMUM_REQUEST_BYTES = 64L * 1024L * 1024L
    const val ABSOLUTE_MAXIMUM_RESPONSE_BYTES = 16 * 1024 * 1024

    private fun validContentType(value: String): Boolean =
      value.isNotBlank() && value.length <= 128 && value.none { it == '\r' || it == '\n' }
  }
}

internal enum class T3VoiceBackgroundHttpFailureKind {
  AUTHORITY_REJECTED,
  CONFLICT,
  RETRYABLE,
  PERMANENT,
  CANCELLED,
}

internal sealed interface T3VoiceBackgroundHttpResult {
  data class Success(
    val statusCode: Int,
    val contentType: String?,
    val body: ByteArray,
    val headers: Map<String, String> = emptyMap(),
  ) : T3VoiceBackgroundHttpResult

  data class Failure(
    val kind: T3VoiceBackgroundHttpFailureKind,
    val statusCode: Int?,
  ) : T3VoiceBackgroundHttpResult
}

internal object T3VoiceBackgroundHttpPolicy {
  fun classify(statusCode: Int): T3VoiceBackgroundHttpFailureKind? =
    when (statusCode) {
      in 200..299 -> null
      HttpURLConnection.HTTP_UNAUTHORIZED,
      HttpURLConnection.HTTP_FORBIDDEN,
      -> T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED
      HttpURLConnection.HTTP_CONFLICT -> T3VoiceBackgroundHttpFailureKind.CONFLICT
      HttpURLConnection.HTTP_CLIENT_TIMEOUT,
      425,
      429,
      in 500..599,
      -> T3VoiceBackgroundHttpFailureKind.RETRYABLE
      else -> T3VoiceBackgroundHttpFailureKind.PERMANENT
    }
}

internal class T3VoiceBoundedInputStream(
  input: InputStream,
  private val maximumBytes: Int,
) : FilterInputStream(input) {
  private var consumed = 0

  override fun read(): Int {
    val value = super.read()
    check(consumed < maximumBytes || value == -1) { "Background response exceeded its limit." }
    if (value != -1) consumed += 1
    return value
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (consumed == maximumBytes) {
      return if (super.read() == -1) -1 else error("Background response exceeded its limit.")
    }
    val allowed = minOf(length, maximumBytes - consumed)
    return super.read(buffer, offset, allowed).also { read -> if (read > 0) consumed += read }
  }
}

internal class T3VoiceBackgroundHttpTransport(
  private val openConnection: (URL) -> HttpsURLConnection = {
    it.openConnection() as HttpsURLConnection
  },
) {
  fun newCall(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpCall =
    T3VoiceBackgroundHttpCall(request, openConnection)

  fun execute(request: T3VoiceBackgroundHttpRequest): T3VoiceBackgroundHttpResult =
    newCall(request).execute()
}

internal class T3VoiceBackgroundHttpCall(
  private val request: T3VoiceBackgroundHttpRequest,
  private val openConnection: (URL) -> HttpsURLConnection,
) {
  private val cancelled = AtomicBoolean(false)
  private val executed = AtomicBoolean(false)
  private val activeConnection = AtomicReference<HttpsURLConnection?>()

  fun cancel() {
    cancelled.set(true)
    activeConnection.get()?.disconnect()
  }

  fun execute(): T3VoiceBackgroundHttpResult {
    check(executed.compareAndSet(false, true)) { "A background HTTP call can execute only once." }
    if (cancelled.get()) return cancelledResult()
    val connection =
      try {
        openConnection(
          T3VoiceBackgroundOriginPolicy.endpoint(
            request.origin,
            request.path,
            request.queryParameters,
          ),
        )
      } catch (_: Exception) {
        return if (cancelled.get()) cancelledResult() else retryableResult()
      }
    activeConnection.set(connection)
    if (cancelled.get()) {
      connection.disconnect()
      activeConnection.compareAndSet(connection, null)
      return cancelledResult()
    }
    return try {
      connection.requestMethod = request.method.name
      connection.instanceFollowRedirects = false
      connection.connectTimeout = CONNECT_TIMEOUT_MILLIS
      connection.readTimeout = READ_TIMEOUT_MILLIS
      connection.useCaches = false
      connection.setRequestProperty("accept", "application/json, application/octet-stream")
      connection.setRequestProperty(request.authority.headerName, request.authority.token)
      request.body?.let { body ->
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(body.contentLength)
        connection.setRequestProperty("content-type", body.contentType)
        body.openStream().use { input ->
          connection.outputStream.use { output ->
            copyBounded(input, output, request.maximumRequestBytes)
          }
        }
      }
      if (cancelled.get()) return cancelledResult()
      val statusCode = connection.responseCode
      val failure = T3VoiceBackgroundHttpPolicy.classify(statusCode)
      if (failure != null) {
        discardErrorBody(connection.errorStream)
        if (cancelled.get()) cancelledResult() else T3VoiceBackgroundHttpResult.Failure(failure, statusCode)
      } else {
        val body =
          connection.inputStream.use { input ->
            T3VoiceBoundedInputStream(input, request.maximumResponseBytes).use(::readAll)
          }
        if (cancelled.get()) {
          cancelledResult()
        } else {
          T3VoiceBackgroundHttpResult.Success(
            statusCode,
            connection.contentType?.takeIf { it.length <= 256 && '\r' !in it && '\n' !in it },
            body,
            listOf("x-t3-audio-format").mapNotNull { name ->
              connection.getHeaderField(name)?.takeIf {
                it.length <= 128 && '\r' !in it && '\n' !in it
              }?.let { name to it }
            }.toMap(),
          )
        }
      }
    } catch (_: IllegalArgumentException) {
      if (cancelled.get()) cancelledResult() else permanentResult()
    } catch (_: IllegalStateException) {
      if (cancelled.get()) cancelledResult() else permanentResult()
    } catch (_: ArithmeticException) {
      if (cancelled.get()) cancelledResult() else permanentResult()
    } catch (_: Exception) {
      if (cancelled.get()) cancelledResult() else retryableResult()
    } finally {
      activeConnection.compareAndSet(connection, null)
      connection.disconnect()
    }
  }

  private fun copyBounded(input: InputStream, output: java.io.OutputStream, maximumBytes: Long) {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read == -1) break
      if (cancelled.get()) throw T3VoiceBackgroundHttpCancelledException
      total = Math.addExact(total, read.toLong())
      check(total <= maximumBytes) { "Background request body exceeds its limit." }
      output.write(buffer, 0, read)
    }
  }

  private fun readAll(input: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    input.copyTo(output)
    return output.toByteArray()
  }

  private fun discardErrorBody(input: InputStream?) {
    try {
      input?.let {
        T3VoiceBoundedInputStream(it, MAXIMUM_ERROR_BYTES).use { bounded ->
          val buffer = ByteArray(1024)
          while (bounded.read(buffer) != -1) Unit
        }
      }
    } catch (_: Exception) {
      // The status code is authoritative; a diagnostic error body cannot change its classification.
    }
  }

  private fun cancelledResult() =
    T3VoiceBackgroundHttpResult.Failure(T3VoiceBackgroundHttpFailureKind.CANCELLED, null)

  private fun permanentResult() =
    T3VoiceBackgroundHttpResult.Failure(T3VoiceBackgroundHttpFailureKind.PERMANENT, null)

  private fun retryableResult() =
    T3VoiceBackgroundHttpResult.Failure(T3VoiceBackgroundHttpFailureKind.RETRYABLE, null)

  private companion object {
    const val CONNECT_TIMEOUT_MILLIS = 5_000
    const val READ_TIMEOUT_MILLIS = 30_000
    const val MAXIMUM_ERROR_BYTES = 4_096
  }
}

private data object T3VoiceBackgroundHttpCancelledException : IllegalStateException()
