package expo.modules.t3voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBackgroundRealtimeTest {
  @Test
  fun `start codec accepts only the exact bounded contract`() {
    val decoded = T3VoiceBackgroundRealtimeJson.decodeStart(startResponse())

    assertEquals("session-1", decoded.state.sessionId)
    assertEquals("conversation-1", decoded.state.conversationId)
    assertEquals(7, decoded.state.leaseGeneration)
    assertEquals("control-secret", decoded.controlGrant.token)
    assertEquals(15, decoded.controlGrant.heartbeatIntervalSeconds)
    assertEquals(
      "/api/voice/native/realtime-sessions/session-1/webrtc-offer",
      decoded.signalingPath,
    )

    val withExtra = JSONObject(startResponse().toString(Charsets.UTF_8)).put("unexpected", true)
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundRealtimeJson.decodeStart(withExtra.toString().toByteArray())
    }
    val mismatchedGrant = JSONObject(startResponse().toString(Charsets.UTF_8))
    mismatchedGrant.getJSONObject("nativeControlGrant").put("leaseGeneration", 8)
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundRealtimeJson.decodeStart(mismatchedGrant.toString().toByteArray())
    }
    val wrongPath = JSONObject(startResponse().toString(Charsets.UTF_8))
    wrongPath.getJSONObject("transport").put("signalingPath", "/api/voice/native/other")
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundRealtimeJson.decodeStart(wrongPath.toString().toByteArray())
    }
  }

  @Test
  fun `start delegate uses only the runtime authority and bounded endpoint`() {
    val requests = mutableListOf<T3VoiceBackgroundHttpRequest>()
    val delegate =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp { request ->
          requests += request
          success(startResponse())
        },
      )

    val result =
      delegate.start(
        origin = "https://environment.example.test",
        runtimeGrantToken = "runtime-secret",
        input = T3VoiceBackgroundRealtimeStartInput("runtime-1", 4, "operation-1"),
      )

    assertTrue(result is T3VoiceBackgroundRealtimeResult.Success)
    val request = requests.single()
    assertEquals("/api/voice/native/realtime-sessions", request.path)
    assertEquals(T3VoiceBackgroundHttpMethod.POST, request.method)
    assertEquals("x-t3-voice-runtime", request.authority.headerName)
    assertEquals("runtime-secret", request.authority.token)
    assertEquals(2_048, request.maximumRequestBytes)
    assertEquals(
      setOf("runtimeId", "generation", "clientOperationId"),
      JSONObject(request.body!!.openStream().readBytes().toString(Charsets.UTF_8))
        .keys()
        .asSequence()
        .toSet(),
    )
  }

  @Test
  fun `offer and close use the child control authority and exact session`() {
    val requests = mutableListOf<T3VoiceBackgroundHttpRequest>()
    val delegate =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp { request ->
          requests += request
          when {
            request.path.endsWith("webrtc-offer") ->
              success(
                """{"sessionId":"session-1","leaseGeneration":7,"sdp":"answer-sdp"}"""
                  .toByteArray(),
              )
            else -> success(closeResponse())
          }
        },
      )
    val start = T3VoiceBackgroundRealtimeJson.decodeStart(startResponse())

    val answer = delegate.offer("https://environment.example.test", "control-secret", start, "offer-sdp")
    val close = delegate.close("https://environment.example.test", "control-secret", start)

    assertTrue(answer is T3VoiceBackgroundRealtimeResult.Success)
    assertTrue(close is T3VoiceBackgroundRealtimeResult.Success)
    assertEquals(
      listOf(
        "/api/voice/native/realtime-sessions/session-1/webrtc-offer",
        "/api/voice/native/realtime-sessions/session-1/close",
      ),
      requests.map(T3VoiceBackgroundHttpRequest::path),
    )
    assertTrue(requests.all { it.authority.headerName == "x-t3-voice-control" })
    assertTrue(requests.all { it.authority.token == "control-secret" })
    assertEquals(
      setOf("sessionId", "leaseGeneration", "sdp"),
      bodyFields(requests[0]),
    )
    assertEquals(setOf("leaseGeneration"), bodyFields(requests[1]))
  }

  @Test
  fun `delegate rejects malformed successful responses without leaking their bodies`() {
    val malformed =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp { success("{".toByteArray()) },
      ).start(
        "https://environment.example.test",
        "runtime-secret",
        T3VoiceBackgroundRealtimeStartInput("runtime-1", 4, "operation-1"),
      )
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.PERMANENT,
      (malformed as T3VoiceBackgroundRealtimeResult.Failure).kind,
    )

    val wrongContentType =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp {
          T3VoiceBackgroundHttpResult.Success(200, "text/plain", startResponse())
        },
      ).start(
        "https://environment.example.test",
        "runtime-secret",
        T3VoiceBackgroundRealtimeStartInput("runtime-1", 4, "operation-1"),
      )
    assertEquals(
      T3VoiceBackgroundHttpFailureKind.PERMANENT,
      (wrongContentType as T3VoiceBackgroundRealtimeResult.Failure).kind,
    )
  }

  @Test
  fun `delegate preserves transport failure classification`() {
    val delegate =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp {
          T3VoiceBackgroundHttpResult.Failure(
            T3VoiceBackgroundHttpFailureKind.RETRYABLE,
            503,
          )
        },
      )

    val result =
      delegate.start(
        "https://environment.example.test",
        "runtime-secret",
        T3VoiceBackgroundRealtimeStartInput("runtime-1", 4, "operation-1"),
      ) as T3VoiceBackgroundRealtimeResult.Failure

    assertEquals(T3VoiceBackgroundHttpFailureKind.RETRYABLE, result.kind)
    assertEquals(503, result.statusCode)
  }

  @Test
  fun `offer rejects a successful answer for a different lease`() {
    val start = T3VoiceBackgroundRealtimeJson.decodeStart(startResponse())
    val result =
      T3VoiceBackgroundRealtimeDelegate(
        T3VoiceBackgroundRealtimeHttp {
          success(
            """{"sessionId":"session-1","leaseGeneration":8,"sdp":"answer-sdp"}"""
              .toByteArray(),
          )
        },
      ).offer("https://environment.example.test", "control-secret", start, "offer-sdp")

    assertEquals(
      T3VoiceBackgroundHttpFailureKind.PERMANENT,
      (result as T3VoiceBackgroundRealtimeResult.Failure).kind,
    )
  }

  @Test
  fun `codec rejects unsafe identifiers and non integral numbers`() {
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundRealtimeStartInput("runtime/unsafe", 1, "operation-1")
    }
    T3VoiceBackgroundRealtimeStartInput("runtime:android-main", 1, "operation:realtime-1")
    val fractional = JSONObject(startResponse().toString(Charsets.UTF_8))
    fractional.getJSONObject("state").put("leaseGeneration", 7.5)
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundRealtimeJson.decodeStart(fractional.toString().toByteArray())
    }
    assertFalse(
      T3VoiceBackgroundRealtimeJson.encodeClose(7).toString(Charsets.UTF_8).contains("token"),
    )
  }

  private fun bodyFields(request: T3VoiceBackgroundHttpRequest): Set<String> =
    JSONObject(request.body!!.openStream().readBytes().toString(Charsets.UTF_8))
      .keys()
      .asSequence()
      .toSet()

  private fun success(bytes: ByteArray) =
    T3VoiceBackgroundHttpResult.Success(200, "application/json; charset=utf-8", bytes)

  private fun startResponse(): ByteArray =
    """
      {
        "state": {
          "sessionId": "session-1",
          "conversationId": "conversation-1",
          "mode": "realtime-agent",
          "phase": "signaling",
          "leaseGeneration": 7,
          "sequence": 0
        },
        "transport": {
          "kind": "webrtc-sdp-v1",
          "signalingPath": "/api/voice/native/realtime-sessions/session-1/webrtc-offer"
        },
        "expiresAt": "2026-07-13T12:00:00Z",
        "heartbeatIntervalSeconds": 15,
        "nativeControlGrant": {
          "token": "control-secret",
          "sessionId": "session-1",
          "leaseGeneration": 7,
          "expiresAt": "2026-07-13T12:00:00Z",
          "heartbeatIntervalSeconds": 15,
          "failureGraceSeconds": 45
        }
      }
    """.trimIndent().toByteArray()

  private fun closeResponse(): ByteArray =
    """
      {
        "state": {
          "sessionId": "session-1",
          "conversationId": "conversation-1",
          "mode": "realtime-agent",
          "phase": "ended",
          "leaseGeneration": 7,
          "sequence": 4
        },
        "closed": true
      }
    """.trimIndent().toByteArray()
}
