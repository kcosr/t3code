package expo.modules.t3voice

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal enum class T3VoiceHttpMethod {
  GET,
  POST,
  DELETE,
}

internal sealed interface T3VoiceHttpResult {
  data class Success(
    val statusCode: Int,
    val contentType: String?,
    val body: ByteArray,
    val receivedBytes: Long,
    val headers: Map<String, String>,
  ) : T3VoiceHttpResult

  data class Failure(
    val kind: T3VoiceHttpFailureKind,
    val statusCode: Int?,
    val contentType: String? = null,
    val body: ByteArray = ByteArray(0),
  ) : T3VoiceHttpResult
}

internal fun interface T3VoiceHttpChunkCallback {
  /** The byte array belongs to the receiver and may be retained after this call returns. */
  fun onChunk(bytes: ByteArray)
}

internal interface T3VoiceHttpRequestBody {
  val contentType: String
  val contentLength: Long

  fun writeTo(output: OutputStream, isCancelled: () -> Boolean)
}

private class T3VoiceByteArrayRequestBody(
  bytes: ByteArray,
  override val contentType: String,
) : T3VoiceHttpRequestBody {
  private val value = bytes.copyOf()
  override val contentLength: Long = value.size.toLong()

  override fun writeTo(output: OutputStream, isCancelled: () -> Boolean) {
    if (isCancelled()) throw T3VoiceHttpCancelledException
    ByteArrayInputStream(value).use { input -> copyRequest(input, output, contentLength, isCancelled) }
  }
}

private class T3VoiceMultipartAudioRequestBody(
  fileUri: String,
  mimeType: String,
  fields: Map<String, String>,
  fieldName: String,
  filename: String,
  maximumFileBytes: Long,
  boundary: String = "t3-voice-${UUID.randomUUID()}",
) : T3VoiceHttpRequestBody {
  private val file = fileFromUri(fileUri)
  private val fileLength = file.length()
  private val prefix: ByteArray
  private val suffix: ByteArray

  override val contentType: String
  override val contentLength: Long

  init {
    require(validToken(boundary) && boundary.length <= 70) { "Invalid multipart boundary." }
    require(validFieldName(fieldName)) { "Invalid multipart audio field name." }
    require(validFilename(filename)) { "Invalid multipart audio filename." }
    require(validContentType(mimeType)) { "Invalid multipart audio content type." }
    require(file.isFile && fileLength in 0..maximumFileBytes) {
      "Native voice recording is unavailable or exceeds its upload limit."
    }
    fields.forEach { (name, value) ->
      require(validFieldName(name)) { "Invalid multipart field name." }
      require(value.toByteArray(Charsets.UTF_8).size <= MAXIMUM_FIELD_BYTES) {
        "Multipart field value is too large."
      }
    }

    prefix = multipartPrefix(boundary, fields, fieldName, filename, mimeType)
    suffix = "\r\n--$boundary--\r\n".toByteArray(Charsets.US_ASCII)
    contentType = "multipart/form-data; boundary=$boundary"
    contentLength = Math.addExact(Math.addExact(prefix.size.toLong(), fileLength), suffix.size.toLong())
  }

  override fun writeTo(output: OutputStream, isCancelled: () -> Boolean) {
    if (isCancelled()) throw T3VoiceHttpCancelledException
    output.write(prefix)
    FileInputStream(file).use { input -> copyRequest(input, output, fileLength, isCancelled) }
    if (isCancelled()) throw T3VoiceHttpCancelledException
    output.write(suffix)
  }

  private companion object {
    const val MAXIMUM_FIELD_BYTES = 256 * 1_024
    val FIELD_NAME = Regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$")
    val FILENAME = Regex("^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
    val TOKEN = Regex("^[A-Za-z0-9'()+_,-./:=?]{1,70}$")

    fun fileFromUri(value: String): File {
      val uri = URI(value)
      require(
        uri.scheme.equals("file", ignoreCase = true) &&
          uri.rawAuthority == null &&
          uri.rawQuery == null &&
          uri.rawFragment == null,
      ) { "Native voice recording must use a local file URI." }
      return File(uri)
    }

    fun validFieldName(value: String): Boolean = FIELD_NAME.matches(value)

    fun validFilename(value: String): Boolean = FILENAME.matches(value)

    fun validToken(value: String): Boolean = TOKEN.matches(value)

    fun validContentType(value: String): Boolean =
      value.isNotBlank() && value.length <= 128 && value.none { it == '\r' || it == '\n' }

    fun multipartPrefix(
      boundary: String,
      fields: Map<String, String>,
      fieldName: String,
      filename: String,
      mimeType: String,
    ): ByteArray =
      buildString {
        fields.toSortedMap().forEach { (name, value) ->
          append("--$boundary\r\n")
          append("Content-Disposition: form-data; name=\"$name\"\r\n")
          append("Content-Type: text/plain; charset=utf-8\r\n\r\n")
          append(value)
          append("\r\n")
        }
        append("--$boundary\r\n")
        append("Content-Disposition: form-data; name=\"$fieldName\"; filename=\"$filename\"\r\n")
        append("Content-Type: $mimeType\r\n\r\n")
      }.toByteArray(Charsets.UTF_8)
  }
}

internal sealed interface T3VoiceResponseMode {
  data object Buffered : T3VoiceResponseMode

  data class Streaming(
    val callback: T3VoiceHttpChunkCallback,
  ) : T3VoiceResponseMode
}

internal data class T3VoiceHttpRequest(
  val url: URL,
  val method: T3VoiceHttpMethod,
  val accept: String,
  val body: T3VoiceHttpRequestBody?,
  val maximumRequestBytes: Long,
  val maximumResponseBytes: Int,
  val responseMode: T3VoiceResponseMode,
  val mediaTicket: T3VoiceMediaTicketToken?,
  val expectedContentTypes: Set<String>,
  val requiredResponseHeaders: Map<String, String>,
) {
  init {
    require(method != T3VoiceHttpMethod.GET || body == null) { "GET requests cannot contain a body." }
    require(body == null || body.contentLength in 0..maximumRequestBytes) {
      "Native voice request exceeds its limit."
    }
  }
}

/**
 * Blocking, process-local HTTP transport for a live native voice session.
 *
 * The bearer credential is kept only by this instance. Calls perform no retries and expose a
 * cancellation handle so the owning runtime generation can disconnect in-flight work.
 */
internal class T3VoiceHttpTransport(
  baseUrl: String,
  bearerToken: String,
  private val limits: T3VoiceHttpLimits = T3VoiceHttpLimits(),
  private val openConnection: (URL) -> HttpURLConnection = {
    it.openConnection() as HttpURLConnection
  },
) {
  private val environment = T3VoiceHttpBaseUrl.parse(baseUrl)
  private val credential = T3VoiceBearerToken(bearerToken)

  fun getJson(
    pathname: String,
    queryParameters: Map<String, String> = emptyMap(),
  ): T3VoiceHttpCall =
    newCall(
      pathname = pathname,
      queryParameters = queryParameters,
      method = T3VoiceHttpMethod.GET,
      accept = JSON_ACCEPT,
      expectedContentTypes = JSON_CONTENT_TYPES,
    )

  fun postJson(
    pathname: String,
    json: String,
    queryParameters: Map<String, String> = emptyMap(),
  ): T3VoiceHttpCall =
    newCall(
      pathname = pathname,
      queryParameters = queryParameters,
      method = T3VoiceHttpMethod.POST,
      accept = JSON_ACCEPT,
      body = jsonBody(json),
      expectedContentTypes = JSON_CONTENT_TYPES,
    )

  fun deleteJson(
    pathname: String,
    json: String? = null,
    queryParameters: Map<String, String> = emptyMap(),
  ): T3VoiceHttpCall =
    newCall(
      pathname = pathname,
      queryParameters = queryParameters,
      method = T3VoiceHttpMethod.DELETE,
      accept = JSON_ACCEPT,
      body = json?.let(::jsonBody),
      expectedContentTypes = JSON_CONTENT_TYPES,
    )

  fun uploadAudio(
    pathname: String,
    fileUri: String,
    mimeType: String,
    mediaTicket: String,
    fields: Map<String, String> = emptyMap(),
    queryParameters: Map<String, String> = emptyMap(),
    fieldName: String = "audio",
    filename: String = "recording.m4a",
  ): T3VoiceHttpCall =
    newCall(
      pathname = pathname,
      queryParameters = queryParameters,
      method = T3VoiceHttpMethod.POST,
      accept = NDJSON_ACCEPT,
      body =
        T3VoiceMultipartAudioRequestBody(
          fileUri = fileUri,
          mimeType = mimeType,
          fields = fields,
          fieldName = fieldName,
          filename = filename,
          maximumFileBytes = limits.maximumRequestBytes,
        ),
      mediaTicket = T3VoiceMediaTicketToken(mediaTicket),
      expectedContentTypes = NDJSON_CONTENT_TYPES,
    )

  fun streamPcm(
    pathname: String,
    json: String,
    mediaTicket: String,
    queryParameters: Map<String, String> = emptyMap(),
    onChunk: T3VoiceHttpChunkCallback,
  ): T3VoiceHttpCall =
    newCall(
      pathname = pathname,
      queryParameters = queryParameters,
      method = T3VoiceHttpMethod.POST,
      accept = PCM_ACCEPT,
      body = jsonBody(json),
      maximumResponseBytes = limits.maximumStreamResponseBytes,
      responseMode = T3VoiceResponseMode.Streaming(onChunk),
      mediaTicket = T3VoiceMediaTicketToken(mediaTicket),
      expectedContentTypes = PCM_CONTENT_TYPES,
      requiredResponseHeaders = mapOf("x-t3-audio-format" to PCM_FORMAT),
    )

  private fun jsonBody(value: String): T3VoiceHttpRequestBody {
    val bytes = value.toByteArray(Charsets.UTF_8)
    require(bytes.size.toLong() <= limits.maximumRequestBytes) {
      "Native voice JSON request exceeds its limit."
    }
    return T3VoiceByteArrayRequestBody(bytes, JSON_CONTENT_TYPE)
  }

  private fun newCall(
    pathname: String,
    queryParameters: Map<String, String>,
    method: T3VoiceHttpMethod,
    accept: String,
    body: T3VoiceHttpRequestBody? = null,
    maximumResponseBytes: Int = limits.maximumJsonResponseBytes,
    responseMode: T3VoiceResponseMode = T3VoiceResponseMode.Buffered,
    mediaTicket: T3VoiceMediaTicketToken? = null,
    expectedContentTypes: Set<String>,
    requiredResponseHeaders: Map<String, String> = emptyMap(),
  ): T3VoiceHttpCall =
    T3VoiceHttpCall(
      request =
        T3VoiceHttpRequest(
          url = environment.endpoint(pathname, queryParameters),
          method = method,
          accept = accept,
          body = body,
          maximumRequestBytes = limits.maximumRequestBytes,
          maximumResponseBytes = maximumResponseBytes,
          responseMode = responseMode,
          mediaTicket = mediaTicket,
          expectedContentTypes = expectedContentTypes,
          requiredResponseHeaders = requiredResponseHeaders,
        ),
      credential = credential,
      limits = limits,
      openConnection = openConnection,
    )

  private companion object {
    const val JSON_ACCEPT = "application/json"
    const val NDJSON_ACCEPT = "application/x-ndjson, application/json"
    const val JSON_CONTENT_TYPE = "application/json; charset=utf-8"
    const val PCM_ACCEPT = "application/octet-stream"
    val JSON_CONTENT_TYPES = setOf("application/json")
    val NDJSON_CONTENT_TYPES = setOf("application/x-ndjson")
    val PCM_CONTENT_TYPES = setOf("audio/pcm")
    const val PCM_FORMAT = "s16le;rate=24000;channels=1"
  }
}

internal class T3VoiceHttpCall(
  private val request: T3VoiceHttpRequest,
  private val credential: T3VoiceBearerToken,
  private val limits: T3VoiceHttpLimits,
  private val openConnection: (URL) -> HttpURLConnection,
) {
  private val cancelled = AtomicBoolean(false)
  private val executed = AtomicBoolean(false)
  private val activeConnection = AtomicReference<HttpURLConnection?>()

  fun cancel() {
    cancelled.set(true)
    activeConnection.get()?.disconnect()
  }

  fun execute(): T3VoiceHttpResult {
    check(executed.compareAndSet(false, true)) { "A native voice HTTP call can execute only once." }
    if (cancelled.get()) return cancelledResult()
    val connection = openConnectionOrFailure() ?: return failureAfterOpen()
    activeConnection.set(connection)
    if (cancelled.get()) {
      connection.disconnect()
      activeConnection.compareAndSet(connection, null)
      return cancelledResult()
    }
    return execute(connection)
  }

  private fun execute(connection: HttpURLConnection): T3VoiceHttpResult {
    return try {
      configure(connection)
      writeBody(connection)
      if (cancelled.get()) return cancelledResult()
      val statusCode = connection.responseCode
      val failure = T3VoiceHttpStatusPolicy.classify(statusCode)
      if (failure == null) {
        readSuccess(connection, statusCode)
      } else {
        val contentType = safeHeader(connection.contentType, 256)
        val errorBody = readErrorBody(connection.errorStream)
        if (cancelled.get()) {
          cancelledResult(statusCode)
        } else {
          T3VoiceHttpResult.Failure(failure, statusCode, contentType, errorBody)
        }
      }
    } catch (_: T3VoiceHttpBoundsException) {
      if (cancelled.get()) cancelledResult() else boundsResult()
    } catch (_: T3VoiceHttpCancelledException) {
      cancelledResult()
    } catch (_: IllegalArgumentException) {
      if (cancelled.get()) cancelledResult() else permanentResult()
    } catch (_: IllegalStateException) {
      if (cancelled.get()) cancelledResult() else permanentResult()
    } catch (_: Exception) {
      if (cancelled.get()) cancelledResult() else retryableResult()
    } finally {
      activeConnection.compareAndSet(connection, null)
      connection.disconnect()
    }
  }

  private fun openConnectionOrFailure(): HttpURLConnection? =
    try {
      openConnection(request.url)
    } catch (_: Exception) {
      null
    }

  private fun failureAfterOpen(): T3VoiceHttpResult =
    if (cancelled.get()) cancelledResult() else retryableResult()

  private fun configure(connection: HttpURLConnection) {
    connection.requestMethod = request.method.name
    connection.instanceFollowRedirects = false
    connection.connectTimeout = limits.connectTimeoutMillis
    connection.readTimeout = limits.readTimeoutMillis
    connection.useCaches = false
    connection.doInput = true
    connection.setRequestProperty("accept", request.accept)
    request.mediaTicket?.applyTo(connection) ?: credential.applyTo(connection)
  }

  private fun writeBody(connection: HttpURLConnection) {
    val body = request.body ?: return
    connection.doOutput = true
    connection.setFixedLengthStreamingMode(body.contentLength)
    connection.setRequestProperty("content-type", body.contentType)
    connection.outputStream.use { output ->
      body.writeTo(output, cancelled::get)
      output.flush()
    }
  }

  private fun readSuccess(
    connection: HttpURLConnection,
    statusCode: Int,
  ): T3VoiceHttpResult {
    val declaredLength = connection.contentLengthLong
    if (declaredLength > request.maximumResponseBytes) throw T3VoiceHttpBoundsException
    val contentType = safeHeader(connection.contentType, 256)
    val mediaType = contentType?.substringBefore(';')?.trim()?.lowercase()
    if (mediaType !in request.expectedContentTypes) {
      connection.inputStream.close()
      return T3VoiceHttpResult.Failure(
        T3VoiceHttpFailureKind.UNEXPECTED_CONTENT_TYPE,
        statusCode,
      )
    }
    val headers =
      listOf("x-t3-audio-format").mapNotNull { name ->
        safeHeader(connection.getHeaderField(name), 128)?.let { name to it }
      }.toMap()
    if (request.requiredResponseHeaders.any { (name, value) -> headers[name] != value }) {
      connection.inputStream.close()
      return T3VoiceHttpResult.Failure(
        T3VoiceHttpFailureKind.UNEXPECTED_CONTENT_TYPE,
        statusCode,
      )
    }
    return connection.inputStream.use { input ->
      val bounded = T3VoiceBoundedResponseStream(input, request.maximumResponseBytes)
      when (val mode = request.responseMode) {
        T3VoiceResponseMode.Buffered -> {
          val body = readAll(bounded)
          T3VoiceHttpResult.Success(statusCode, contentType, body, body.size.toLong(), headers)
        }
        is T3VoiceResponseMode.Streaming -> {
          val receivedBytes = stream(bounded, mode.callback)
          T3VoiceHttpResult.Success(statusCode, contentType, ByteArray(0), receivedBytes, headers)
        }
      }
    }
  }

  private fun stream(input: InputStream, callback: T3VoiceHttpChunkCallback): Long {
    val buffer = ByteArray(STREAM_BUFFER_BYTES)
    var received = 0L
    while (true) {
      if (cancelled.get()) throw T3VoiceHttpCancelledException
      val read = input.read(buffer)
      if (read == -1) break
      received = Math.addExact(received, read.toLong())
      callback.onChunk(buffer.copyOf(read))
    }
    return received
  }

  private fun readAll(input: InputStream): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(STREAM_BUFFER_BYTES)
    while (true) {
      if (cancelled.get()) throw T3VoiceHttpCancelledException
      val read = input.read(buffer)
      if (read == -1) break
      output.write(buffer, 0, read)
    }
    return output.toByteArray()
  }

  private fun readErrorBody(input: InputStream?): ByteArray =
    try {
      input?.use { source ->
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(1_024)
        while (!cancelled.get() && output.size() < MAXIMUM_ERROR_BYTES) {
          val read = source.read(buffer, 0, minOf(buffer.size, MAXIMUM_ERROR_BYTES - output.size()))
          if (read == -1) break
          output.write(buffer, 0, read)
        }
        output.toByteArray()
      } ?: ByteArray(0)
    } catch (_: Exception) {
      // The status code remains authoritative when a bounded diagnostic body cannot be read.
      ByteArray(0)
    }

  private fun safeHeader(value: String?, maximumLength: Int): String? =
    value?.takeIf { it.length <= maximumLength && '\r' !in it && '\n' !in it }

  private fun cancelledResult(statusCode: Int? = null) =
    T3VoiceHttpResult.Failure(T3VoiceHttpFailureKind.CANCELLED, statusCode)

  private fun boundsResult() =
    T3VoiceHttpResult.Failure(T3VoiceHttpFailureKind.BOUNDS_EXCEEDED, null)

  private fun permanentResult() =
    T3VoiceHttpResult.Failure(T3VoiceHttpFailureKind.PERMANENT, null)

  private fun retryableResult() =
    T3VoiceHttpResult.Failure(T3VoiceHttpFailureKind.RETRYABLE, null)

  private companion object {
    const val MAXIMUM_ERROR_BYTES = 4_096
    const val STREAM_BUFFER_BYTES = 16 * 1_024
  }

}

private fun copyRequest(
  input: InputStream,
  output: OutputStream,
  expectedBytes: Long,
  isCancelled: () -> Boolean,
) {
  val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
  var copied = 0L
  while (copied < expectedBytes) {
    if (isCancelled()) throw T3VoiceHttpCancelledException
    val maximumRead = minOf(buffer.size.toLong(), expectedBytes - copied).toInt()
    val read = input.read(buffer, 0, maximumRead)
    if (read == -1) throw IllegalStateException("Native voice request source changed during upload.")
    copied = Math.addExact(copied, read.toLong())
    output.write(buffer, 0, read)
  }
  if (input.read() != -1) throw T3VoiceHttpBoundsException
}
