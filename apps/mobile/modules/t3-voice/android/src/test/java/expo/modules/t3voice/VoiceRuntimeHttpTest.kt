package expo.modules.t3voice

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.URL
import java.security.Principal
import java.security.cert.Certificate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLPeerUnverifiedException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.concurrent.thread

internal class VoiceRuntimeHttpTest {
  @Test
  fun `origin policy accepts only credential-free HTTPS origins`() {
    assertEquals(
      "https://environment.example.test:8443",
      VoiceRuntimeOriginPolicy.normalize("https://environment.example.test:8443/"),
    )
    listOf(
      "http://environment.example.test",
      "https://user:password@environment.example.test",
      "https://environment.example.test/path",
      "https://environment.example.test?query=true",
      "https://environment.example.test#fragment",
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) {
        VoiceRuntimeOriginPolicy.normalize(invalid)
      }
    }
  }

  @Test
  fun `endpoint policy rejects traversal query and absolute paths`() {
    listOf(
      "/api/../secret",
      "/api/events?cursor=1",
      "//other.example.test/path",
      "https://other.example.test/path",
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) {
        VoiceRuntimeOriginPolicy.endpoint("https://environment.example.test", invalid)
      }
    }
  }

  @Test
  fun `transport disables redirects applies session credential and bounds bodies`() {
    val connection = FakeHttpsConnection(200, "response".toByteArray())
    val transport = VoiceRuntimeHttpTransport { connection }
    val result =
      transport.execute(
        VoiceRuntimeHttpRequest(
          origin = "https://environment.example.test",
          path = "/api/voice/native/thread-turns",
          method = VoiceRuntimeHttpMethod.POST,
          sessionCredential = VoiceRuntimeSessionCredential("secret-token"),
          body = VoiceRuntimeByteArrayBody("request".toByteArray(), "application/json"),
          maximumRequestBytes = 32,
          maximumResponseBytes = 32,
        ),
      ) as VoiceRuntimeHttpResult.Success

    assertFalse(connection.instanceFollowRedirects)
    assertFalse(connection.useCaches)
    assertEquals("Bearer secret-token", connection.getRequestProperty("Authorization"))
    assertArrayEquals("request".toByteArray(), connection.output.toByteArray())
    assertArrayEquals("response".toByteArray(), result.body)
    assertEquals(1, connection.disconnectCount)
  }

  @Test
  fun `transport never follows redirects and classifies them permanently`() {
    val connection = FakeHttpsConnection(307, ByteArray(0))
    val result =
      VoiceRuntimeHttpTransport { connection }.execute(request()) as
        VoiceRuntimeHttpResult.Failure

    assertEquals(VoiceRuntimeHttpFailureKind.PERMANENT, result.kind)
    assertFalse(connection.instanceFollowRedirects)
  }

  @Test
  fun `transport supports bounded PUT bodies`() {
    val connection = FakeHttpsConnection(204, ByteArray(0))
    val result =
      VoiceRuntimeHttpTransport { connection }.execute(
        request(
          method = VoiceRuntimeHttpMethod.PUT,
          body = VoiceRuntimeByteArrayBody("replace".toByteArray(), "application/json"),
        ),
      )
    assertTrue(result is VoiceRuntimeHttpResult.Success)
    assertEquals("PUT", connection.requestMethod)
    assertArrayEquals("replace".toByteArray(), connection.output.toByteArray())
  }

  @Test
  fun `oversized error body preserves status classification`() {
    val result =
      VoiceRuntimeHttpTransport {
        FakeHttpsConnection(503, ByteArray(4_097))
      }.execute(request()) as VoiceRuntimeHttpResult.Failure
    assertEquals(VoiceRuntimeHttpFailureKind.RETRYABLE, result.kind)
    assertEquals(503, result.statusCode)
  }

  @Test
  fun `cancelling a stalled upload disconnects the active call`() {
    val connection = StalledUploadConnection()
    val call =
      VoiceRuntimeHttpTransport { connection }.newCall(
        request(
          method = VoiceRuntimeHttpMethod.POST,
          body = VoiceRuntimeByteArrayBody(ByteArray(8), "application/octet-stream"),
        ),
      )
    val result = AtomicReference<VoiceRuntimeHttpResult>()
    val worker = thread(start = true, name = "background-http-cancellation-test") {
      result.set(call.execute())
    }
    assertTrue(connection.writeStarted.await(2, TimeUnit.SECONDS))

    call.cancel()
    worker.join(2_000)

    assertFalse(worker.isAlive)
    assertEquals(
      VoiceRuntimeHttpFailureKind.CANCELLED,
      (result.get() as VoiceRuntimeHttpResult.Failure).kind,
    )
    assertTrue(connection.disconnectCount > 0)
  }

  @Test
  fun `transport distinguishes revoked conflict and retryable authority`() {
    assertEquals(
      VoiceRuntimeHttpFailureKind.AUTHORITY_REJECTED,
      VoiceRuntimeHttpPolicy.classify(401),
    )
    assertEquals(
      VoiceRuntimeHttpFailureKind.CONFLICT,
      VoiceRuntimeHttpPolicy.classify(409),
    )
    assertEquals(
      VoiceRuntimeHttpFailureKind.RETRYABLE,
      VoiceRuntimeHttpPolicy.classify(503),
    )
  }

  @Test
  fun `runtime PCM response streams bounded chunks with protocol fencing`() {
    val pcm = ByteArray(160 * 1_024) { (it and 0xff).toByte() }
    val connection = StreamingPcmHttpsConnection(pcm)
    val call = VoiceRuntimeHttpTransport { connection }.newCall(
      VoiceRuntimeHttpRequest(
        origin = "https://environment.example.test",
        path = "/api/voice/runtime/thread-turns/operation-1/speech/0",
        method = VoiceRuntimeHttpMethod.GET,
        sessionCredential = VoiceRuntimeSessionCredential("secret-token"),
        maximumResponseBytes = pcm.size,
      ),
    )
    val chunks = mutableListOf<ByteArray>()

    val result = call.executeStreaming(chunks::add) as VoiceRuntimeHttpResult.Success

    assertTrue(result.body.isEmpty())
    assertTrue(chunks.size > 1)
    assertTrue(chunks.all { it.size <= 64 * 1_024 && it.size % 2 == 0 })
    assertArrayEquals(pcm, chunks.fold(ByteArray(0)) { all, chunk -> all + chunk })
    assertEquals("2", connection.getRequestProperty("x-t3-voice-runtime-protocol-major"))
    assertEquals("Bearer secret-token", connection.getRequestProperty("Authorization"))
  }

  @Test
  fun `bounded stream rejects a response over its declared maximum`() {
    val stream = T3VoiceBoundedInputStream(ByteArrayInputStream(ByteArray(5)), 4)
    assertThrows(IllegalStateException::class.java) { stream.readBytes() }
  }

  @Test
  fun `session credential is bounded and rejects header injection`() {
    VoiceRuntimeSessionCredential("a".repeat(8_192))
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeSessionCredential("a".repeat(8_193))
    }
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeSessionCredential("credential\r\nHeader: injected")
    }
  }

  private fun request(
    method: VoiceRuntimeHttpMethod = VoiceRuntimeHttpMethod.GET,
    body: VoiceRuntimeRequestBody? = null,
  ) =
    VoiceRuntimeHttpRequest(
      origin = "https://environment.example.test",
      path = "/api/voice/native/test",
      method = method,
      sessionCredential = VoiceRuntimeSessionCredential("secret-token"),
      body = body,
    )
}

private open class FakeHttpsConnection(
  private val status: Int,
  private val response: ByteArray,
) : HttpsURLConnection(URL("https://environment.example.test")) {
  val output = ByteArrayOutputStream()
  var disconnectCount = 0

  override fun getResponseCode(): Int = status

  override fun getInputStream(): InputStream = ByteArrayInputStream(response)

  override fun getErrorStream(): InputStream = ByteArrayInputStream(response)

  override fun getOutputStream(): OutputStream = output

  override fun getContentType(): String = "application/json"

  override fun disconnect() {
    disconnectCount += 1
  }

  override fun usingProxy(): Boolean = false

  override fun connect() = Unit

  override fun getCipherSuite(): String = "TLS_TEST"

  override fun getLocalCertificates(): Array<Certificate> = emptyArray()

  @Throws(SSLPeerUnverifiedException::class)
  override fun getServerCertificates(): Array<Certificate> = emptyArray()

  @Throws(SSLPeerUnverifiedException::class)
  override fun getPeerPrincipal(): Principal = Principal { "peer" }

  override fun getLocalPrincipal(): Principal = Principal { "local" }
}

private class StalledUploadConnection : FakeHttpsConnection(200, ByteArray(0)) {
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

private class StreamingPcmHttpsConnection(response: ByteArray) :
  FakeHttpsConnection(200, response) {
  override fun getContentType(): String = "audio/pcm"

  override fun getHeaderField(name: String?): String? =
    if (name.equals("x-t3-audio-format", ignoreCase = true)) {
      "s16le;rate=24000;channels=1"
    } else {
      super.getHeaderField(name)
    }
}
