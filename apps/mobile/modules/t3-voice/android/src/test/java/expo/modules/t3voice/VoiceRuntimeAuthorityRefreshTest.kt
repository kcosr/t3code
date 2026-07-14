package expo.modules.t3voice

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.URL
import java.security.Principal
import java.security.cert.Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLPeerUnverifiedException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeAuthorityRefreshTest {
  @Test
  fun `refresh sends exact protocol credential and canonical JSON fields`() {
    val response = responseJson().toByteArray()
    val connection = RefreshHttpsConnection(200, response)
    val authority = authority()
    val attempt = attempt(authority)

    val result = VoiceRuntimeAuthorityRefreshClient(
      VoiceRuntimeHttpTransport { connection },
    ).refresh(authority, attempt) as VoiceRuntimeRefreshResult.Success

    assertEquals("POST", connection.requestMethod)
    assertEquals("1", connection.getRequestProperty("x-t3-voice-runtime-protocol-major"))
    assertEquals("old-refresh-credential", connection.getRequestProperty("x-t3-voice-refresh"))
    val request = JSONObject(connection.output.toString(Charsets.UTF_8))
    assertEquals(REQUEST_FIELDS, request.keys().asSequence().toSet())
    assertEquals("refresh-request-1", request.getString("refreshRequestId"))
    assertEquals(4, request.getLong("expectedRotationCounter"))
    assertEquals(5, result.authority.refreshRotationCounter)
    assertEquals("rotated-runtime-token", result.authority.token)
  }

  @Test
  fun `refresh rejects changed target and counter responses`() {
    val changed = JSONObject(responseJson()).put("refreshRotationCounter", 6).toString().toByteArray()
    val result = VoiceRuntimeAuthorityRefreshClient(
      VoiceRuntimeHttpTransport { RefreshHttpsConnection(200, changed) },
    ).refresh(authority(), attempt(authority()))

    assertTrue(result is VoiceRuntimeRefreshResult.Rejected)
  }

  @Test
  fun `scheduler refreshes before expiry and retries immediately when overdue`() {
    val day = 24L * 60L * 60L * 1_000L
    assertEquals(day, VoiceRuntimeAuthorityRefreshScheduler.delayMillis(3 * day, day))
    assertEquals(1_000, VoiceRuntimeAuthorityRefreshScheduler.delayMillis(day, day))
  }

  private fun authority(): VoiceRuntimePersistedAuthority {
    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, 60_000, 600_000, true, 500,
    )
    return VoiceRuntimePersistedAuthority(
      "runtime-1",
      7,
      "provision-runtime-1-7",
      T3VoiceRuntimeTargetIdentity.digest(VoiceRuntimeBridge.canonicalThreadTargetIdentity(target)),
      target,
      "https://environment.example.test",
      true,
      "current-runtime-token",
      500,
      5_000,
      4,
    )
  }

  private fun attempt(authority: VoiceRuntimePersistedAuthority) = VoiceRuntimeRefreshAttempt(
    VoiceRuntimeAuthorityFence(
      authority.runtimeId,
      authority.generation,
      authority.provisioningOperationId,
      authority.targetDigest,
      authority.target,
      T3VoiceRuntimeGrantOperation.THREAD_TURN_START,
      authority.environmentOrigin,
    ),
    "refresh-request-1",
    4,
    "old-refresh-credential",
    "c".repeat(64),
  )

  private fun responseJson(): String {
    val current = authority()
    return JSONObject()
      .put("token", "rotated-runtime-token")
      .put("runtimeId", current.runtimeId)
      .put("generation", current.generation)
      .put("provisioningOperationId", current.provisioningOperationId)
      .put("targetDigest", current.targetDigest)
      .put("target", JSONObject(VoiceRuntimeBridge.canonicalThreadTargetIdentity(
        current.target as VoiceRuntimeTarget.Thread,
      )))
      .put("operation", "thread-turn-start")
      .put("readinessEnabled", true)
      .put("refreshRotationCounter", 5)
      .put("issuedAt", "2026-07-14T00:00:00.000Z")
      .put("expiresAt", "2026-08-13T00:00:00.000Z")
      .toString()
  }

  private companion object {
    val REQUEST_FIELDS = setOf(
      "refreshRequestId", "provisioningOperationId", "generation", "operation", "targetDigest",
      "expectedRotationCounter", "candidateCredentialHash",
    )
  }
}

private class RefreshHttpsConnection(
  private val status: Int,
  private val response: ByteArray,
) : HttpsURLConnection(URL("https://environment.example.test")) {
  val output = ByteArrayOutputStream()
  override fun getResponseCode(): Int = status
  override fun getInputStream(): InputStream = ByteArrayInputStream(response)
  override fun getErrorStream(): InputStream = ByteArrayInputStream(response)
  override fun getOutputStream(): OutputStream = output
  override fun getContentType(): String = "application/json"
  override fun disconnect() = Unit
  override fun usingProxy(): Boolean = false
  override fun connect() = Unit
  override fun getCipherSuite(): String = "TLS_TEST"
  override fun getLocalCertificates(): Array<Certificate> = emptyArray()
  @Throws(SSLPeerUnverifiedException::class)
  override fun getServerCertificates(): Array<Certificate> = emptyArray()
  override fun getPeerPrincipal(): Principal = Principal { "peer" }
  override fun getLocalPrincipal(): Principal = Principal { "local" }
}
