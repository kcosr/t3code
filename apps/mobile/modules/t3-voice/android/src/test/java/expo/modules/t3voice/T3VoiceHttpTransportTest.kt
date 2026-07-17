package expo.modules.t3voice

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceHttpTransportTest {
  @Test
  fun `base URL supports LAN HTTP and HTTPS with root endpoint semantics`() {
    assertEquals(
      "http://192.168.50.51:3773/api/voice/test?after=a%20b",
      T3VoiceHttpBaseUrl.parse("http://192.168.50.51:3773/")
        .endpoint("/api/voice/test", mapOf("after" to "a b"))
        .toString(),
    )
    assertEquals(
      "https://environment.example.test/api/voice/test",
      T3VoiceHttpBaseUrl.parse("https://ENVIRONMENT.EXAMPLE.TEST:443/")
        .endpoint("/api/voice/test")
        .toString(),
    )
  }

  @Test
  fun `base URL rejects credentials unsafe schemes and non-root URL data`() {
    listOf(
      "ftp://environment.example.test/",
      "ws://environment.example.test/",
      "https://user:password@environment.example.test/",
      "https://environment.example.test/base",
      "https://environment.example.test/?query=true",
      "https://environment.example.test/#fragment",
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) {
        T3VoiceHttpBaseUrl.parse(invalid)
      }
    }
  }

  @Test
  fun `endpoint rejects authority query fragment and decoded traversal`() {
    val baseUrl = T3VoiceHttpBaseUrl.parse("https://environment.example.test/")
    listOf(
      "//other.example.test/path",
      "/api/events?cursor=1",
      "/api/events#part",
      "/api/../secret",
      "https://other.example.test/path",
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) { baseUrl.endpoint(invalid) }
    }
  }

  @Test
  fun `path segment encoder protects slash space percent and dot segments`() {
    assertEquals("thread%2Fone%20%25", T3VoiceHttpPathSegment.encode("thread/one %"))
    assertEquals("%2E%2E", T3VoiceHttpPathSegment.encode(".."))
    assertEquals(
      "https://environment.example.test/api/threads/thread%2Fone%20%25",
      T3VoiceHttpBaseUrl.parse("https://environment.example.test/")
        .endpoint("/api/threads/${T3VoiceHttpPathSegment.encode("thread/one %")}")
        .toString(),
    )
  }

  @Test
  fun `secret headers share strict visible ASCII validation and stay redacted`() {
    val connection = FakeHttpConnection(200, "{}".toByteArray())
    val bearer = T3VoiceBearerToken("bearer-secret")
    val ticket = T3VoiceMediaTicketToken("ticket-secret")

    bearer.applyTo(connection)
    ticket.applyTo(connection)

    assertEquals("Bearer bearer-secret", connection.getRequestProperty("authorization"))
    assertEquals("ticket-secret", connection.getRequestProperty("x-t3-voice-ticket"))
    assertFalse(bearer.toString().contains("bearer-secret"))
    assertFalse(ticket.toString().contains("ticket-secret"))
    listOf("", " ", "line\nbreak", "\u007f", "x".repeat(4_097)).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) { T3VoiceBearerToken(invalid) }
      assertThrows(IllegalArgumentException::class.java) { T3VoiceMediaTicketToken(invalid) }
    }
  }

  @Test
  fun `JSON helpers apply bearer bounds timeouts and disable redirects`() {
    val connection = FakeHttpConnection(200, "response".toByteArray())
    val requestedUrl = AtomicReference<URL>()
    val transport =
      T3VoiceHttpTransport(
        baseUrl = "http://192.168.50.51:3773/",
        bearerToken = "narrow-session-token",
        limits =
          T3VoiceHttpLimits(
            connectTimeoutMillis = 1_234,
            readTimeoutMillis = 5_678,
            maximumRequestBytes = 64,
            maximumJsonResponseBytes = 32,
            maximumStreamResponseBytes = 64,
          ),
        openConnection = {
          requestedUrl.set(it)
          connection
        },
      )

    val result =
      transport.postJson("/api/voice/test", "{\"ready\":true}").execute() as
        T3VoiceHttpResult.Success

    assertEquals("http://192.168.50.51:3773/api/voice/test", requestedUrl.get().toString())
    assertEquals("POST", connection.requestMethod)
    assertEquals("Bearer narrow-session-token", connection.getRequestProperty("authorization"))
    assertEquals("application/json", connection.getRequestProperty("accept"))
    assertEquals(
      "application/json; charset=utf-8",
      connection.getRequestProperty("content-type"),
    )
    assertEquals(1_234, connection.connectTimeout)
    assertEquals(5_678, connection.readTimeout)
    assertFalse(connection.instanceFollowRedirects)
    assertFalse(connection.useCaches)
    assertArrayEquals("{\"ready\":true}".toByteArray(), connection.output.toByteArray())
    assertArrayEquals("response".toByteArray(), result.body)
    assertEquals(1, connection.disconnectCount)
  }

  @Test
  fun `GET and DELETE helpers use the requested methods without bodies`() {
    val get = FakeHttpConnection(200, "{}".toByteArray())
    val delete = FakeHttpConnection(204, ByteArray(0))
    val connections = ArrayDeque(listOf(get, delete))
    val transport = transport(openConnection = { connections.removeFirst() })

    assertTrue(transport.getJson("/api/voice/test").execute() is T3VoiceHttpResult.Success)
    assertTrue(transport.deleteJson("/api/voice/test").execute() is T3VoiceHttpResult.Success)

    assertEquals("GET", get.requestMethod)
    assertFalse(get.doOutput)
    assertEquals("DELETE", delete.requestMethod)
    assertFalse(delete.doOutput)
  }

  @Test
  fun `multipart helper streams a bounded local file URI`() {
    val recording = File.createTempFile("t3-voice-http-", ".m4a")
    try {
      recording.writeBytes("audio-bytes".toByteArray())
      val connection =
        FakeHttpConnection(200, "{}".toByteArray(), "application/x-ndjson")
      val result =
        transport(openConnection = { connection })
          .uploadAudio(
            pathname = "/api/voice/transcriptions",
            fileUri = recording.toURI().toString(),
            mimeType = "audio/mp4",
            mediaTicket = "one-use-transcription-ticket",
            fields = mapOf("metadata" to "{\"format\":\"audio/mp4\"}"),
          ).execute()

      assertTrue(result is T3VoiceHttpResult.Success)
      val body = connection.output.toString(Charsets.UTF_8.name())
      assertTrue(connection.getRequestProperty("content-type").startsWith("multipart/form-data"))
      assertEquals(
        "one-use-transcription-ticket",
        connection.getRequestProperty("x-t3-voice-ticket"),
      )
      assertEquals(null, connection.getRequestProperty("authorization"))
      assertTrue(body.contains("name=\"metadata\""))
      assertTrue(body.contains("name=\"audio\"; filename=\"recording.m4a\""))
      assertTrue(body.contains("audio-bytes"))
    } finally {
      recording.delete()
    }
  }

  @Test
  fun `multipart helper rejects non-file URI and an oversized recording`() {
    assertThrows(IllegalArgumentException::class.java) {
      transport().uploadAudio(
        pathname = "/api/voice/transcriptions",
        fileUri = "content://recordings/one",
        mimeType = "audio/mp4",
        mediaTicket = "one-use-ticket",
      )
    }

    val recording = File.createTempFile("t3-voice-http-", ".m4a")
    try {
      recording.writeBytes(ByteArray(9))
      assertThrows(IllegalArgumentException::class.java) {
        transport(limits = limits(maximumRequestBytes = 8)).uploadAudio(
          pathname = "/api/voice/transcriptions",
          fileUri = recording.toURI().toString(),
          mimeType = "audio/mp4",
          mediaTicket = "one-use-ticket",
        )
      }
    } finally {
      recording.delete()
    }
  }

  @Test
  fun `PCM helper streams owned chunks and reports the byte count`() {
    val response = ByteArray(20_000) { (it % 127).toByte() }
    val connection =
      FakeHttpConnection(
        200,
        response,
        "audio/pcm",
        audioFormat = "s16le;rate=24000;channels=1",
      )
    val chunks = mutableListOf<ByteArray>()

    val result =
      transport(
        limits = limits(maximumStreamResponseBytes = response.size),
        openConnection = { connection },
      ).streamPcm(
        pathname = "/api/voice/speech",
        json = "{}",
        mediaTicket = "one-use-speech-ticket",
      ) { chunks += it }.execute() as
        T3VoiceHttpResult.Success

    assertEquals(response.size.toLong(), result.receivedBytes)
    assertEquals(0, result.body.size)
    assertEquals("application/octet-stream", connection.getRequestProperty("accept"))
    assertEquals("one-use-speech-ticket", connection.getRequestProperty("x-t3-voice-ticket"))
    assertEquals(null, connection.getRequestProperty("authorization"))
    assertArrayEquals(response, chunks.flatMap(ByteArray::asIterable).toByteArray())
  }

  @Test
  fun `PCM helper validates format header before delivering bytes`() {
    listOf(null, "s16le;rate=16000;channels=1").forEach { audioFormat ->
      var deliveredBytes = 0
      val result =
        transport(
          openConnection = {
            FakeHttpConnection(
              200,
              ByteArray(8),
              "audio/pcm",
              audioFormat = audioFormat,
            )
          },
        ).streamPcm(
          pathname = "/api/voice/speech",
          json = "{}",
          mediaTicket = "one-use-speech-ticket",
        ) { deliveredBytes += it.size }.execute() as T3VoiceHttpResult.Failure

      assertEquals(T3VoiceHttpFailureKind.UNEXPECTED_CONTENT_TYPE, result.kind)
      assertEquals(0, deliveredBytes)
    }
  }

  @Test
  fun `response bounds and HTTP statuses are classified without retries`() {
    val oversized = FakeHttpConnection(200, ByteArray(5))
    val boundedResult =
      transport(
        limits = limits(maximumJsonResponseBytes = 4),
        openConnection = { oversized },
      ).getJson("/api/voice/test").execute() as T3VoiceHttpResult.Failure
    assertEquals(T3VoiceHttpFailureKind.BOUNDS_EXCEEDED, boundedResult.kind)

    assertEquals(T3VoiceHttpFailureKind.AUTHENTICATION, T3VoiceHttpStatusPolicy.classify(401))
    assertEquals(T3VoiceHttpFailureKind.CONFLICT, T3VoiceHttpStatusPolicy.classify(409))
    assertEquals(T3VoiceHttpFailureKind.RETRYABLE, T3VoiceHttpStatusPolicy.classify(429))
    assertEquals(T3VoiceHttpFailureKind.RETRYABLE, T3VoiceHttpStatusPolicy.classify(503))
    assertEquals(T3VoiceHttpFailureKind.PERMANENT, T3VoiceHttpStatusPolicy.classify(307))
    assertEquals(null, T3VoiceHttpStatusPolicy.classify(204))
  }

  @Test
  fun `HTTP failure preserves only a bounded typed error body`() {
    val error = "{\"code\":\"voice_error\",\"reason\":\"takeover-required\"}"
    val result =
      transport(openConnection = { FakeHttpConnection(409, error.toByteArray()) })
        .postJson("/api/voice/sessions", "{}")
        .execute() as T3VoiceHttpResult.Failure

    assertEquals(T3VoiceHttpFailureKind.CONFLICT, result.kind)
    assertEquals("application/json", result.contentType)
    assertArrayEquals(error.toByteArray(), result.body)

    val oversized =
      transport(openConnection = { FakeHttpConnection(503, ByteArray(5_000)) })
        .getJson("/api/voice/test")
        .execute() as T3VoiceHttpResult.Failure
    assertEquals(T3VoiceHttpFailureKind.RETRYABLE, oversized.kind)
    assertEquals(4_096, oversized.body.size)
  }

  @Test
  fun `successful response with the wrong content type is rejected before decoding`() {
    val result =
      transport(openConnection = { FakeHttpConnection(200, "{}".toByteArray(), "text/html") })
        .getJson("/api/voice/test")
        .execute() as T3VoiceHttpResult.Failure

    assertEquals(T3VoiceHttpFailureKind.UNEXPECTED_CONTENT_TYPE, result.kind)
    assertEquals(200, result.statusCode)
  }

  @Test
  fun `cancelling an active call disconnects the connection`() {
    val connection = StalledUploadConnection()
    val call = transport(openConnection = { connection }).postJson("/api/voice/test", "{\"x\":1}")
    val result = AtomicReference<T3VoiceHttpResult>()
    val worker = thread(start = true, name = "voice-http-cancellation-test") {
      result.set(call.execute())
    }
    assertTrue(connection.writeStarted.await(2, TimeUnit.SECONDS))

    call.cancel()
    worker.join(2_000)

    assertFalse(worker.isAlive)
    assertEquals(
      T3VoiceHttpFailureKind.CANCELLED,
      (result.get() as T3VoiceHttpResult.Failure).kind,
    )
    assertTrue(connection.disconnectCount > 0)
  }

  @Test
  fun `bounded response stream accepts the limit and rejects one byte more`() {
    assertArrayEquals(
      ByteArray(4),
      T3VoiceBoundedResponseStream(ByteArrayInputStream(ByteArray(4)), 4).readBytes(),
    )
    assertThrows(T3VoiceHttpBoundsException::class.java) {
      T3VoiceBoundedResponseStream(ByteArrayInputStream(ByteArray(5)), 4).readBytes()
    }
  }

  private fun transport(
    limits: T3VoiceHttpLimits = limits(),
    openConnection: (URL) -> HttpURLConnection = { FakeHttpConnection(200, "{}".toByteArray()) },
  ): T3VoiceHttpTransport =
    T3VoiceHttpTransport(
      baseUrl = "https://environment.example.test/",
      bearerToken = "narrow-session-token",
      limits = limits,
      openConnection = openConnection,
    )

  private fun limits(
    maximumRequestBytes: Long = 1_024,
    maximumJsonResponseBytes: Int = 1_024,
    maximumStreamResponseBytes: Int = 64 * 1_024,
  ) =
    T3VoiceHttpLimits(
      maximumRequestBytes = maximumRequestBytes,
      maximumJsonResponseBytes = maximumJsonResponseBytes,
      maximumStreamResponseBytes = maximumStreamResponseBytes,
    )
}

private open class FakeHttpConnection(
  private val status: Int,
  private val response: ByteArray,
  private val responseContentType: String = "application/json",
  private val audioFormat: String? = null,
) : HttpURLConnection(URL("https://environment.example.test/")) {
  val output = ByteArrayOutputStream()
  var disconnectCount = 0

  override fun getResponseCode(): Int = status

  override fun getInputStream(): InputStream = ByteArrayInputStream(response)

  override fun getErrorStream(): InputStream = ByteArrayInputStream(response)

  override fun getOutputStream(): OutputStream = output

  override fun getContentType(): String = responseContentType

  override fun getHeaderField(name: String?): String? =
    if (name.equals("x-t3-audio-format", ignoreCase = true)) audioFormat else null

  override fun disconnect() {
    disconnectCount += 1
  }

  override fun usingProxy(): Boolean = false

  override fun connect() = Unit
}

private class StalledUploadConnection : FakeHttpConnection(200, ByteArray(0)) {
  val writeStarted = CountDownLatch(1)
  private val disconnected = CountDownLatch(1)

  override fun getOutputStream(): OutputStream =
    object : OutputStream() {
      override fun write(value: Int) = write(byteArrayOf(value.toByte()))

      override fun write(buffer: ByteArray, offset: Int, length: Int) {
        writeStarted.countDown()
        disconnected.await()
        throw IOException("Connection disconnected.")
      }
    }

  override fun disconnect() {
    super.disconnect()
    disconnected.countDown()
  }
}
