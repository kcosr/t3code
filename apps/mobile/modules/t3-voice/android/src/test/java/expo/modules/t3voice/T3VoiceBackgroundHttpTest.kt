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

internal class T3VoiceBackgroundHttpTest {
  @Test
  fun `origin policy accepts only credential-free HTTPS origins`() {
    assertEquals(
      "https://environment.example.test:8443",
      T3VoiceBackgroundOriginPolicy.normalize("https://environment.example.test:8443/"),
    )
    listOf(
      "http://environment.example.test",
      "https://user:password@environment.example.test",
      "https://environment.example.test/path",
      "https://environment.example.test?query=true",
      "https://environment.example.test#fragment",
    ).forEach { invalid ->
      assertThrows(IllegalArgumentException::class.java) {
        T3VoiceBackgroundOriginPolicy.normalize(invalid)
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
        T3VoiceBackgroundOriginPolicy.endpoint("https://environment.example.test", invalid)
      }
    }
  }

  @Test
  fun `transport disables redirects applies authority and bounds bodies`() {
    val connection = FakeHttpsConnection(200, "response".toByteArray())
    val transport = T3VoiceBackgroundHttpTransport { connection }
    val result =
      transport.execute(
        T3VoiceBackgroundHttpRequest(
          origin = "https://environment.example.test",
          path = "/api/voice/native/thread-turns",
          method = T3VoiceBackgroundHttpMethod.POST,
          authority = T3VoiceBackgroundAuthority("x-test-runtime", "secret-token"),
          body = T3VoiceBackgroundByteArrayBody("request".toByteArray(), "application/json"),
          maximumRequestBytes = 32,
          maximumResponseBytes = 32,
        ),
      ) as T3VoiceBackgroundHttpResult.Success

    assertFalse(connection.instanceFollowRedirects)
    assertFalse(connection.useCaches)
    assertEquals("secret-token", connection.getRequestProperty("x-test-runtime"))
    assertArrayEquals("request".toByteArray(), connection.output.toByteArray())
    assertArrayEquals("response".toByteArray(), result.body)
    assertEquals(1, connection.disconnectCount)
  }

  @Test
  fun `transport never follows redirects and classifies them permanently`() {
    val connection = FakeHttpsConnection(307, ByteArray(0))
    val result =
      T3VoiceBackgroundHttpTransport { connection }.execute(request()) as
        T3VoiceBackgroundHttpResult.Failure

    assertEquals(T3VoiceBackgroundHttpFailureKind.PERMANENT, result.kind)
    assertFalse(connection.instanceFollowRedirects)
  }

  @Test
  fun `transport supports bounded PUT bodies`() {
    val connection = FakeHttpsConnection(204, ByteArray(0))
    val result =
      T3VoiceBackgroundHttpTransport { connection }.execute(
        request(
          method = T3VoiceBackgroundHttpMethod.PUT,
          body = T3VoiceBackgroundByteArrayBody("replace".toByteArray(), "application/json"),
        ),
      )
    assertTrue(result is T3VoiceBackgroundHttpResult.Success)
    assertEquals("PUT", connection.requestMethod)
    assertArrayEquals("replace".toByteArray(), connection.output.toByteArray())
  }

  @Test
  fun `oversized error body preserves status classification`() {
    val result =
      T3VoiceBackgroundHttpTransport {
        FakeHttpsConnection(503, ByteArray(4_097))
      }.execute(request()) as T3VoiceBackgroundHttpResult.Failure
    assertEquals(T3VoiceBackgroundHttpFailureKind.RETRYABLE, result.kind)
    assertEquals(503, result.statusCode)
  }

  @Test
  fun `cancelling a stalled upload disconnects the active call`() {
    val connection = StalledUploadConnection()
    val call =
      T3VoiceBackgroundHttpTransport { connection }.newCall(
        request(
          method = T3VoiceBackgroundHttpMethod.POST,
          body = T3VoiceBackgroundByteArrayBody(ByteArray(8), "application/octet-stream"),
        ),
      )
    val result = AtomicReference<T3VoiceBackgroundHttpResult>()
    val worker = thread(start = true, name = "background-http-cancellation-test") {
      result.set(call.execute())
    }
    assertTrue(connection.writeStarted.await(2, TimeUnit.SECONDS))

    call.cancel()
    worker.join(2_000)

    assertFalse(worker.isAlive)
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.CANCELLED,
      (result.get() as T3VoiceBackgroundHttpResult.Failure).kind,
    )
    assertTrue(connection.disconnectCount > 0)
  }

  @Test
  fun `transport distinguishes revoked conflict and retryable authority`() {
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.AUTHORITY_REJECTED,
      T3VoiceBackgroundHttpPolicy.classify(401),
    )
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.CONFLICT,
      T3VoiceBackgroundHttpPolicy.classify(409),
    )
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.RETRYABLE,
      T3VoiceBackgroundHttpPolicy.classify(503),
    )
  }

  @Test
  fun `bounded stream rejects a response over its declared maximum`() {
    val stream = T3VoiceBoundedInputStream(ByteArrayInputStream(ByteArray(5)), 4)
    assertThrows(IllegalStateException::class.java) { stream.readBytes() }
  }

  @Test
  fun `authority token is bounded by the contract maximum`() {
    T3VoiceBackgroundAuthority("x-test-runtime", "a".repeat(128))
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundAuthority("x-test-runtime", "a".repeat(129))
    }
  }

  private fun request(
    method: T3VoiceBackgroundHttpMethod = T3VoiceBackgroundHttpMethod.GET,
    body: T3VoiceBackgroundRequestBody? = null,
  ) =
    T3VoiceBackgroundHttpRequest(
      origin = "https://environment.example.test",
      path = "/api/voice/native/test",
      method = method,
      authority = T3VoiceBackgroundAuthority("x-test-runtime", "secret-token"),
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
