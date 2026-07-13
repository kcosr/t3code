package expo.modules.t3voice

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceBackgroundThreadTurnTest {
  @Test
  fun `snapshot and event codecs accept the complete exact contract`() {
    val result =
      T3VoiceBackgroundThreadTurnJson.decodeEvents(
        eventsResponse(
          JSONArray()
            .put(event(1, "phase").put("phase", "transcribing"))
            .put(
              event(2, "dispatch-correlation")
                .put("commandId", "command-1")
                .put("messageId", "message-1")
                .put("turnId", JSONObject.NULL),
            )
            .put(event(3, "speech-ready").put("segmentIndex", 0).put("finalSegment", false))
            .put(event(4, "speech-terminal").put("outcome", "completed"))
            .put(event(5, "attention-required").put("attention", "approval"))
            .put(event(6, "failure").put("code", "turn-failed").put("retryable", true))
            .put(event(7, "terminal").put("outcome", "completed")),
          lastSequence = 7,
        ),
      )

    assertEquals("operation-1", result.snapshot.operationId)
    assertEquals("runtime-1", result.snapshot.runtimeId)
    assertEquals(7, result.snapshot.lastSequence)
    assertEquals(7, result.events.size)
    assertTrue(result.events[0] is T3VoiceBackgroundThreadTurnEvent.Phase)
    assertTrue(result.events[1] is T3VoiceBackgroundThreadTurnEvent.DispatchCorrelation)
    assertTrue(result.events[2] is T3VoiceBackgroundThreadTurnEvent.SpeechReady)
    assertTrue(result.events[3] is T3VoiceBackgroundThreadTurnEvent.SpeechTerminal)
    assertTrue(result.events[4] is T3VoiceBackgroundThreadTurnEvent.AttentionRequired)
    assertTrue(result.events[5] is T3VoiceBackgroundThreadTurnEvent.Failure)
    assertTrue(result.events[6] is T3VoiceBackgroundThreadTurnEvent.Terminal)

    val create = T3VoiceBackgroundThreadTurnJson.decodeCreate(createResponse())
    assertEquals("operation-secret", create.operationGrant.token)
    assertEquals(1_783_945_800_000, create.operationGrant.expiresAtEpochMillis)
  }

  @Test
  fun `codecs reject excess malformed and internally inconsistent fields`() {
    val excessRoot = JSONObject(createResponse().toString(Charsets.UTF_8)).put("extra", true)
    assertDecodeRejected { T3VoiceBackgroundThreadTurnJson.decodeCreate(excessRoot.bytes()) }

    val excessSnapshot = JSONObject(createResponse().toString(Charsets.UTF_8))
    excessSnapshot.getJSONObject("snapshot").put("extra", true)
    assertDecodeRejected { T3VoiceBackgroundThreadTurnJson.decodeCreate(excessSnapshot.bytes()) }

    val excessEvent = event(1, "phase").put("phase", "created").put("extra", true)
    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeEvents(eventsResponse(JSONArray().put(excessEvent), 1))
    }

    val fractionalGeneration = JSONObject(createResponse().toString(Charsets.UTF_8))
    fractionalGeneration.getJSONObject("snapshot").put("generation", 1.5)
    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeCreate(fractionalGeneration.bytes())
    }

    val cursorAhead = JSONObject(createResponse().toString(Charsets.UTF_8))
    cursorAhead.getJSONObject("snapshot").put("lastSequence", 1).put("acknowledgedSequence", 2)
    assertDecodeRejected { T3VoiceBackgroundThreadTurnJson.decodeCreate(cursorAhead.bytes()) }

    val unsafeInteger = JSONObject(createResponse().toString(Charsets.UTF_8))
    unsafeInteger.getJSONObject("snapshot").put("generation", 9_007_199_254_740_992L)
    assertDecodeRejected { T3VoiceBackgroundThreadTurnJson.decodeCreate(unsafeInteger.bytes()) }
  }

  @Test
  fun `events must be strictly ordered bounded and covered by their snapshot`() {
    val duplicate =
      JSONArray()
        .put(event(2, "phase").put("phase", "waiting"))
        .put(event(2, "phase").put("phase", "speaking"))
    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeEvents(eventsResponse(duplicate, 2))
    }

    val descending =
      JSONArray()
        .put(event(2, "phase").put("phase", "waiting"))
        .put(event(1, "phase").put("phase", "dispatching"))
    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeEvents(eventsResponse(descending, 2))
    }

    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeEvents(
        eventsResponse(JSONArray().put(event(2, "phase").put("phase", "waiting")), 1),
      )
    }

    val excessive = JSONArray()
    repeat(101) { index ->
      excessive.put(event(index + 1L, "phase").put("phase", "waiting"))
    }
    assertDecodeRejected {
      T3VoiceBackgroundThreadTurnJson.decodeEvents(eventsResponse(excessive, 101))
    }
  }

  @Test
  fun `delegate uses exact routes methods authorities queries and request bodies`() {
    val requests = mutableListOf<T3VoiceBackgroundHttpRequest>()
    val delegate =
      T3VoiceBackgroundThreadTurnDelegate(
        T3VoiceBackgroundThreadTurnHttp { request ->
          requests += request
          when {
            request.path == "/api/voice/native/thread-turns" -> jsonSuccess(createResponse())
            request.path.endsWith("/audio") -> jsonSuccess(audioResponse())
            request.path.endsWith("/events") -> jsonSuccess(eventsResponse(JSONArray(), 0))
            request.path.endsWith("/events/ack") -> jsonSuccess(acknowledgementResponse())
            request.path.contains("/speech/") ->
              T3VoiceBackgroundHttpResult.Success(200, "audio/pcm", byteArrayOf(1, 0, 2, 0))
            request.path.endsWith("/cancel") -> jsonSuccess(cancelResponse())
            else -> error("Unexpected request: ${request.path}")
          }
        },
      )

    assertTrue(
      delegate.create(
        ORIGIN,
        "runtime-secret",
        T3VoiceBackgroundThreadTurnCreateInput("runtime-1", 3, "client-operation-1"),
      ) is T3VoiceBackgroundThreadTurnResult.Success,
    )
    assertTrue(
      delegate.uploadAudio(
        ORIGIN,
        "operation-secret",
        "operation-1",
        T3VoiceBackgroundByteArrayBody(byteArrayOf(1, 2, 3), "audio/mp4"),
      ) is T3VoiceBackgroundThreadTurnResult.Success,
    )
    assertTrue(
      delegate.events(ORIGIN, "operation-secret", "operation-1", 12, 30_000) is
        T3VoiceBackgroundThreadTurnResult.Success,
    )
    assertTrue(
      delegate.acknowledge(ORIGIN, "operation-secret", "operation-1", 12) is
        T3VoiceBackgroundThreadTurnResult.Success,
    )
    assertTrue(
      delegate.speech(ORIGIN, "operation-secret", "operation-1", 4) is
        T3VoiceBackgroundThreadTurnResult.Success,
    )
    assertTrue(
      delegate.cancel(ORIGIN, "operation-secret", "operation-1") is
        T3VoiceBackgroundThreadTurnResult.Success,
    )

    assertEquals(
      listOf(
        T3VoiceBackgroundHttpMethod.POST,
        T3VoiceBackgroundHttpMethod.PUT,
        T3VoiceBackgroundHttpMethod.GET,
        T3VoiceBackgroundHttpMethod.POST,
        T3VoiceBackgroundHttpMethod.GET,
        T3VoiceBackgroundHttpMethod.POST,
      ),
      requests.map(T3VoiceBackgroundHttpRequest::method),
    )
    assertEquals("x-t3-voice-runtime", requests[0].authority.headerName)
    assertEquals("runtime-secret", requests[0].authority.token)
    assertTrue(requests.drop(1).all { it.authority.headerName == "x-t3-voice-operation" })
    assertTrue(requests.drop(1).all { it.authority.token == "operation-secret" })
    assertEquals(
      listOf(
        "/api/voice/native/thread-turns",
        "/api/voice/native/thread-turns/operation-1/audio",
        "/api/voice/native/thread-turns/operation-1/events",
        "/api/voice/native/thread-turns/operation-1/events/ack",
        "/api/voice/native/thread-turns/operation-1/speech/4",
        "/api/voice/native/thread-turns/operation-1/cancel",
      ),
      requests.map(T3VoiceBackgroundHttpRequest::path),
    )
    assertEquals(
      mapOf("afterSequence" to "12", "waitMilliseconds" to "30000"),
      requests[2].queryParameters,
    )
    assertEquals("audio/mp4", requests[1].body?.contentType)
    assertEquals(
      setOf("runtimeId", "generation", "clientOperationId"),
      bodyFields(requests[0]),
    )
    assertEquals(setOf("acknowledgedSequence"), bodyFields(requests[3]))
    assertEquals(setOf("reason"), bodyFields(requests[5]))
    assertEquals(64L * 1_024L * 1_024L, requests[1].maximumRequestBytes)
    assertEquals(16 * 1_024 * 1_024, requests[4].maximumResponseBytes)
  }

  @Test
  fun `query endpoint encodes once sorts parameters and validates input`() {
    val url =
      T3VoiceBackgroundOriginPolicy.endpoint(
        ORIGIN,
        "/api/voice/native/thread-turns/operation-1/events",
        mapOf("z" to "a b+c/?", "afterSequence" to "12"),
      )

    assertEquals(
      "https://environment.example.test/api/voice/native/thread-turns/operation-1/events" +
        "?afterSequence=12&z=a%20b%2Bc%2F%3F",
      url.toString(),
    )
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundOriginPolicy.endpoint(ORIGIN, "/events", mapOf("bad name" to "1"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundOriginPolicy.endpoint(ORIGIN, "/events", mapOf("cursor" to "x".repeat(257)))
    }
  }

  @Test
  fun `delegate rejects wrong response types malformed JSON and invalid PCM`() {
    val wrongJson =
      T3VoiceBackgroundThreadTurnDelegate(
        T3VoiceBackgroundThreadTurnHttp {
          T3VoiceBackgroundHttpResult.Success(200, "text/plain", createResponse())
        },
      ).create(
        ORIGIN,
        "runtime-secret",
        T3VoiceBackgroundThreadTurnCreateInput("runtime-1", 1, "client-operation-1"),
      ) as T3VoiceBackgroundThreadTurnResult.Failure
    assertEquals(T3VoiceBackgroundHttpFailureKind.PERMANENT, wrongJson.kind)

    val malformedJson =
      T3VoiceBackgroundThreadTurnDelegate(
        T3VoiceBackgroundThreadTurnHttp { jsonSuccess("{".toByteArray()) },
      ).create(
        ORIGIN,
        "runtime-secret",
        T3VoiceBackgroundThreadTurnCreateInput("runtime-1", 1, "client-operation-1"),
      ) as T3VoiceBackgroundThreadTurnResult.Failure
    assertEquals(T3VoiceBackgroundHttpFailureKind.PERMANENT, malformedJson.kind)

    listOf(
      T3VoiceBackgroundHttpResult.Success(200, "application/octet-stream", byteArrayOf(1, 0)),
      T3VoiceBackgroundHttpResult.Success(200, "audio/pcm", ByteArray(0)),
      T3VoiceBackgroundHttpResult.Success(200, "audio/pcm", byteArrayOf(1)),
      T3VoiceBackgroundHttpResult.Success(200, "audio/pcm", ByteArray(16 * 1_024 * 1_024 + 2)),
    ).forEach { response ->
      val result =
        T3VoiceBackgroundThreadTurnDelegate(T3VoiceBackgroundThreadTurnHttp { response })
          .speech(ORIGIN, "operation-secret", "operation-1", 0)
      assertEquals(
        T3VoiceBackgroundHttpFailureKind.PERMANENT,
        (result as T3VoiceBackgroundThreadTurnResult.Failure).kind,
      )
    }
  }

  @Test
  fun `delegate preserves transport failures and validates request bounds`() {
    val failure =
      T3VoiceBackgroundThreadTurnDelegate(
        T3VoiceBackgroundThreadTurnHttp {
          T3VoiceBackgroundHttpResult.Failure(T3VoiceBackgroundHttpFailureKind.RETRYABLE, 503)
        },
      ).events(ORIGIN, "operation-secret", "operation-1", 0, 0) as
        T3VoiceBackgroundThreadTurnResult.Failure
    assertEquals(T3VoiceBackgroundHttpFailureKind.RETRYABLE, failure.kind)
    assertEquals(503, failure.statusCode)

    val delegate = T3VoiceBackgroundThreadTurnDelegate(T3VoiceBackgroundThreadTurnHttp { error("unused") })
    assertThrows(IllegalArgumentException::class.java) {
      delegate.events(ORIGIN, "operation-secret", "operation-1", -1, 0)
    }
    assertThrows(IllegalArgumentException::class.java) {
      delegate.events(ORIGIN, "operation-secret", "operation-1", 0, 30_001)
    }
    assertThrows(IllegalArgumentException::class.java) {
      delegate.speech(ORIGIN, "operation-secret", "operation-1", -1)
    }
    assertThrows(IllegalArgumentException::class.java) {
      delegate.cancel(ORIGIN, "operation-secret", "../operation")
    }
    assertThrows(IllegalArgumentException::class.java) {
      delegate.uploadAudio(
        ORIGIN,
        "operation-secret",
        "operation-1",
        T3VoiceBackgroundByteArrayBody(byteArrayOf(1), "audio/wav"),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundThreadTurnJson.encodeCreate(
        T3VoiceBackgroundThreadTurnCreateInput("r".repeat(129), 1, "client-operation-1"),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      T3VoiceBackgroundThreadTurnJson.encodeAcknowledgement(9_007_199_254_740_992L)
    }
    assertFalse(T3VoiceBackgroundThreadTurnJson.encodeCancel().toString(Charsets.UTF_8).contains("token"))
  }

  private fun bodyFields(request: T3VoiceBackgroundHttpRequest): Set<String> =
    JSONObject(request.body!!.openStream().readBytes().toString(Charsets.UTF_8))
      .keys()
      .asSequence()
      .toSet()

  private fun assertDecodeRejected(block: () -> Unit) {
    assertThrows(RuntimeException::class.java, block)
  }

  private fun jsonSuccess(bytes: ByteArray) =
    T3VoiceBackgroundHttpResult.Success(200, "application/json; charset=utf-8", bytes)

  private fun createResponse(): ByteArray =
    JSONObject()
      .put("snapshot", snapshot())
      .put(
        "operationGrant",
        JSONObject()
          .put("token", "operation-secret")
          .put("expiresAt", "2026-07-13T12:30:00Z"),
      )
      .bytes()

  private fun audioResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).put("disposition", "processing").bytes()

  private fun acknowledgementResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).bytes()

  private fun cancelResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).put("cancelled", true).bytes()

  private fun eventsResponse(events: JSONArray, lastSequence: Long): ByteArray =
    JSONObject()
      .put("snapshot", snapshot(lastSequence = lastSequence))
      .put("events", events)
      .bytes()

  private fun snapshot(lastSequence: Long = 0): JSONObject =
    JSONObject()
      .put("operationId", "operation-1")
      .put("runtimeId", "runtime-1")
      .put("generation", 3)
      .put("projectId", "project-1")
      .put("threadId", "thread-1")
      .put("speechPreset", "default")
      .put("autoRearm", true)
      .put("phase", "created")
      .put("messageId", JSONObject.NULL)
      .put("turnId", JSONObject.NULL)
      .put("lastSequence", lastSequence)
      .put("acknowledgedSequence", 0)
      .put("speechTerminal", JSONObject.NULL)
      .put("dispatchAccepted", false)
      .put("expiresAt", "2026-07-13T12:30:00Z")

  private fun event(sequence: Long, type: String): JSONObject =
    JSONObject()
      .put("type", type)
      .put("sequence", sequence)
      .put("occurredAt", "2026-07-13T12:00:00Z")

  private fun JSONObject.bytes(): ByteArray = toString().toByteArray(Charsets.UTF_8)

  private companion object {
    const val ORIGIN = "https://environment.example.test"
  }
}
