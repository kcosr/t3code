package expo.modules.t3voice.net

import expo.modules.t3voice.kernel.VoiceRuntimeTarget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeThreadTurnTest {
  @Test
  fun `snapshot and event codecs accept the complete exact contract`() {
    val result =
      VoiceRuntimeThreadTurnJson.decodeEvents(
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
    assertTrue(result.events[0] is VoiceRuntimeThreadTurnEvent.Phase)
    assertTrue(result.events[1] is VoiceRuntimeThreadTurnEvent.DispatchCorrelation)
    assertTrue(result.events[2] is VoiceRuntimeThreadTurnEvent.SpeechReady)
    assertTrue(result.events[3] is VoiceRuntimeThreadTurnEvent.SpeechTerminal)
    assertTrue(result.events[4] is VoiceRuntimeThreadTurnEvent.AttentionRequired)
    assertTrue(result.events[5] is VoiceRuntimeThreadTurnEvent.Failure)
    assertTrue(result.events[6] is VoiceRuntimeThreadTurnEvent.Terminal)

    val create = VoiceRuntimeThreadTurnJson.decodeCreate(createResponse())
    assertEquals("operation-1", create.snapshot.operationId)
  }

  @Test
  fun `codecs reject excess malformed and internally inconsistent fields`() {
    val excessRoot = JSONObject(createResponse().toString(Charsets.UTF_8)).put("extra", true)
    assertDecodeRejected { VoiceRuntimeThreadTurnJson.decodeCreate(excessRoot.bytes()) }

    val excessSnapshot = JSONObject(createResponse().toString(Charsets.UTF_8))
    excessSnapshot.getJSONObject("snapshot").put("extra", true)
    assertDecodeRejected { VoiceRuntimeThreadTurnJson.decodeCreate(excessSnapshot.bytes()) }

    val excessEvent = event(1, "phase").put("phase", "created").put("extra", true)
    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeEvents(eventsResponse(JSONArray().put(excessEvent), 1))
    }

    val fractionalGeneration = JSONObject(createResponse().toString(Charsets.UTF_8))
    fractionalGeneration.getJSONObject("snapshot").put("generation", 1.5)
    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeCreate(fractionalGeneration.bytes())
    }

    val cursorAhead = JSONObject(createResponse().toString(Charsets.UTF_8))
    cursorAhead.getJSONObject("snapshot").put("lastSequence", 1).put("acknowledgedSequence", 2)
    assertDecodeRejected { VoiceRuntimeThreadTurnJson.decodeCreate(cursorAhead.bytes()) }

    val unsafeInteger = JSONObject(createResponse().toString(Charsets.UTF_8))
    unsafeInteger.getJSONObject("snapshot").put("generation", 9_007_199_254_740_992L)
    assertDecodeRejected { VoiceRuntimeThreadTurnJson.decodeCreate(unsafeInteger.bytes()) }
  }

  @Test
  fun `events must be strictly ordered bounded and covered by their snapshot`() {
    val duplicate =
      JSONArray()
        .put(event(2, "phase").put("phase", "waiting"))
        .put(event(2, "phase").put("phase", "speaking"))
    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeEvents(eventsResponse(duplicate, 2))
    }

    val descending =
      JSONArray()
        .put(event(2, "phase").put("phase", "waiting"))
        .put(event(1, "phase").put("phase", "dispatching"))
    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeEvents(eventsResponse(descending, 2))
    }

    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeEvents(
        eventsResponse(JSONArray().put(event(2, "phase").put("phase", "waiting")), 1),
      )
    }

    val excessive = JSONArray()
    repeat(101) { index ->
      excessive.put(event(index + 1L, "phase").put("phase", "waiting"))
    }
    assertDecodeRejected {
      VoiceRuntimeThreadTurnJson.decodeEvents(eventsResponse(excessive, 101))
    }
  }

  @Test
  fun `delegate uses exact routes methods authorities queries and request bodies`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val delegate =
      VoiceRuntimeThreadTurnDelegate(
        VoiceRuntimeThreadTurnHttp { request ->
          requests += request
          when {
            request.path == "/api/voice/runtime/thread-turns" -> jsonSuccess(createResponse())
            request.path.endsWith("/audio") -> jsonSuccess(audioResponse())
            request.path.endsWith("/disposition") ->
              jsonSuccess(
                JSONObject().put(
                  "snapshot",
                  snapshot(0).put("submissionPolicy", "draft"),
                ).bytes(),
              )
            request.path.endsWith("/events") -> jsonSuccess(eventsResponse(JSONArray(), 0))
            request.path.endsWith("/events/ack") -> jsonSuccess(acknowledgementResponse())
            request.path.contains("/speech/") ->
              VoiceRuntimeHttpResult.Success(
                200, "audio/pcm", byteArrayOf(1, 0, 2, 0),
                mapOf("x-t3-audio-format" to "s16le;rate=24000;channels=1"),
              )
            request.path.endsWith("/draft/consume") -> jsonSuccess(draftConsumeResponse())
            request.path.endsWith("/draft") -> jsonSuccess(draftResponse())
            request.path.endsWith("/cancel") -> jsonSuccess(cancelResponse())
            else -> error("Unexpected request: ${request.path}")
          }
        },
      )

    assertTrue(
      delegate.create(
        ORIGIN,
        "session-secret",
        createInput(),
      ) is VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.newDraftDispositionCall(
        ORIGIN,
        "session-secret",
        "operation-1",
      ).execute() is VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.uploadAudio(
        ORIGIN,
        "session-secret",
        "operation-1",
        VoiceRuntimeByteArrayBody(byteArrayOf(1, 2, 3), "audio/mp4"),
      ) is VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.events(ORIGIN, "session-secret", "operation-1", 12, 30_000) is
        VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.acknowledge(
        ORIGIN, "session-secret", "operation-1", 12, "speech-1", null, null, emptyList(),
      ) is
        VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.speech(ORIGIN, "session-secret", "operation-1", 4) is
        VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.newDraftCall(ORIGIN, "session-secret", "operation-1").execute() is
        VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.newConsumeDraftCall(ORIGIN, "session-secret", "operation-1").execute() is
        VoiceRuntimeThreadTurnResult.Success,
    )
    assertTrue(
      delegate.cancel(ORIGIN, "session-secret", "operation-1") is
        VoiceRuntimeThreadTurnResult.Success,
    )

    assertEquals(
      listOf(
        VoiceRuntimeHttpMethod.POST,
        VoiceRuntimeHttpMethod.POST,
        VoiceRuntimeHttpMethod.PUT,
        VoiceRuntimeHttpMethod.GET,
        VoiceRuntimeHttpMethod.POST,
        VoiceRuntimeHttpMethod.GET,
        VoiceRuntimeHttpMethod.GET,
        VoiceRuntimeHttpMethod.POST,
        VoiceRuntimeHttpMethod.POST,
      ),
      requests.map(VoiceRuntimeHttpRequest::method),
    )
    assertTrue(requests.all { it.sessionCredential.value == "session-secret" })
    assertEquals(
      listOf(
        "/api/voice/runtime/thread-turns",
        "/api/voice/runtime/thread-turns/operation-1/disposition",
        "/api/voice/runtime/thread-turns/operation-1/audio",
        "/api/voice/runtime/thread-turns/operation-1/events",
        "/api/voice/runtime/thread-turns/operation-1/events/ack",
        "/api/voice/runtime/thread-turns/operation-1/speech/4",
        "/api/voice/runtime/thread-turns/operation-1/draft",
        "/api/voice/runtime/thread-turns/operation-1/draft/consume",
        "/api/voice/runtime/thread-turns/operation-1/cancel",
      ),
      requests.map(VoiceRuntimeHttpRequest::path),
    )
    assertEquals(
      mapOf("afterSequence" to "12", "waitMilliseconds" to "30000"),
      requests[3].queryParameters,
    )
    assertEquals("application/json", requests[1].body?.contentType)
    assertEquals(setOf("submissionPolicy"), bodyFields(requests[1]))
    assertEquals("audio/mp4", requests[2].body?.contentType)
    assertEquals(
      setOf(
        "runtimeId", "runtimeInstanceId", "generation", "modeSessionId",
        "turnClientOperationId", "submissionPolicy", "speechPlanId", "target",
      ),
      bodyFields(requests[0]),
    )
    assertEquals(
      setOf(
        "acknowledgedSequence", "speechPlanId", "highestStartedSegment",
        "highestDrainedSegment", "segmentDispositions",
      ),
      bodyFields(requests[4]),
    )
    assertEquals(emptySet<String>(), bodyFields(requests[7]))
    assertEquals(setOf("reason"), bodyFields(requests[8]))
    assertEquals(64L * 1_024L * 1_024L, requests[2].maximumRequestBytes)
    assertEquals(16 * 1_024 * 1_024, requests[5].maximumResponseBytes)
  }

  @Test
  fun `query endpoint encodes once sorts parameters and validates input`() {
    val url =
      VoiceRuntimeOriginPolicy.endpoint(
        ORIGIN,
        "/api/voice/runtime/thread-turns/operation-1/events",
        mapOf("z" to "a b+c/?", "afterSequence" to "12"),
      )

    assertEquals(
      "https://environment.example.test/api/voice/runtime/thread-turns/operation-1/events" +
        "?afterSequence=12&z=a%20b%2Bc%2F%3F",
      url.toString(),
    )
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeOriginPolicy.endpoint(ORIGIN, "/events", mapOf("bad name" to "1"))
    }
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeOriginPolicy.endpoint(ORIGIN, "/events", mapOf("cursor" to "x".repeat(257)))
    }
  }

  @Test
  fun `delegate rejects wrong response types malformed JSON and invalid PCM`() {
    val wrongJson =
      VoiceRuntimeThreadTurnDelegate(
        VoiceRuntimeThreadTurnHttp {
          VoiceRuntimeHttpResult.Success(200, "text/plain", createResponse())
        },
      ).create(
        ORIGIN,
        "runtime-secret",
        createInput(generation = 1),
      ) as VoiceRuntimeThreadTurnResult.Failure
    assertEquals(VoiceRuntimeHttpFailureKind.PERMANENT, wrongJson.kind)

    val malformedJson =
      VoiceRuntimeThreadTurnDelegate(
        VoiceRuntimeThreadTurnHttp { jsonSuccess("{".toByteArray()) },
      ).create(
        ORIGIN,
        "runtime-secret",
        createInput(generation = 1),
      ) as VoiceRuntimeThreadTurnResult.Failure
    assertEquals(VoiceRuntimeHttpFailureKind.PERMANENT, malformedJson.kind)

    listOf(
      VoiceRuntimeHttpResult.Success(200, "application/octet-stream", byteArrayOf(1, 0)),
      VoiceRuntimeHttpResult.Success(200, "audio/pcm", ByteArray(0)),
      VoiceRuntimeHttpResult.Success(200, "audio/pcm", byteArrayOf(1)),
      VoiceRuntimeHttpResult.Success(200, "audio/pcm", ByteArray(16 * 1_024 * 1_024 + 2)),
    ).forEach { response ->
      val result =
        VoiceRuntimeThreadTurnDelegate(VoiceRuntimeThreadTurnHttp { response })
          .speech(ORIGIN, "operation-secret", "operation-1", 0)
      assertEquals(
        VoiceRuntimeHttpFailureKind.PERMANENT,
        (result as VoiceRuntimeThreadTurnResult.Failure).kind,
      )
    }
  }

  @Test
  fun `delegate preserves transport failures and validates request bounds`() {
    val failure =
      VoiceRuntimeThreadTurnDelegate(
        VoiceRuntimeThreadTurnHttp {
          VoiceRuntimeHttpResult.Failure(VoiceRuntimeHttpFailureKind.RETRYABLE, 503)
        },
      ).events(ORIGIN, "operation-secret", "operation-1", 0, 0) as
        VoiceRuntimeThreadTurnResult.Failure
    assertEquals(VoiceRuntimeHttpFailureKind.RETRYABLE, failure.kind)
    assertEquals(503, failure.statusCode)

    val delegate = VoiceRuntimeThreadTurnDelegate(VoiceRuntimeThreadTurnHttp { error("unused") })
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
        VoiceRuntimeByteArrayBody(byteArrayOf(1), "audio/wav"),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeThreadTurnJson.encodeCreate(
        createInput(runtimeId = "r".repeat(129), generation = 1),
      )
    }
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeThreadTurnJson.encodeAcknowledgement(
        9_007_199_254_740_992L, "speech-1", null, null, emptyList(),
      )
    }
    assertFalse(VoiceRuntimeThreadTurnJson.encodeCancel().toString(Charsets.UTF_8).contains("token"))
  }

  private fun bodyFields(request: VoiceRuntimeHttpRequest): Set<String> =
    JSONObject(request.body!!.openStream().readBytes().toString(Charsets.UTF_8))
      .keys()
      .asSequence()
      .toSet()

  private fun assertDecodeRejected(block: () -> Unit) {
    assertThrows(RuntimeException::class.java, block)
  }

  private fun jsonSuccess(bytes: ByteArray) =
    VoiceRuntimeHttpResult.Success(200, "application/json; charset=utf-8", bytes)

  private fun createResponse(): ByteArray =
    JSONObject()
      .put("snapshot", snapshot())
      .bytes()

  private fun audioResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).put("disposition", "processing").bytes()

  private fun acknowledgementResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).bytes()

  private fun cancelResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).put("cancelled", true).bytes()

  private fun draftResponse(): ByteArray = JSONObject()
    .put("operationId", "operation-1")
    .put("transcript", "draft transcript")
    .put("expiresAt", "2026-08-13T12:30:00Z")
    .bytes()

  private fun draftConsumeResponse(): ByteArray =
    JSONObject().put("snapshot", snapshot()).put("consumed", true).bytes()

  private fun eventsResponse(events: JSONArray, lastSequence: Long): ByteArray =
    JSONObject()
      .put("snapshot", snapshot(lastSequence = lastSequence))
      .put("events", events)
      .bytes()

  private fun snapshot(lastSequence: Long = 0): JSONObject =
    JSONObject()
      .put("operationId", "operation-1")
      .put("runtimeId", "runtime-1")
      .put("runtimeInstanceId", "instance-1")
      .put("generation", 3)
      .put("modeSessionId", "mode-1")
      .put("turnClientOperationId", "client-operation-1")
      .put("submissionPolicy", "auto-submit")
      .put("speechPlanId", "speech-1")
      .put("projectId", "project-1")
      .put("threadId", "thread-1")
      .put("speechPreset", "default")
      .put("autoRearm", true)
      .put("phase", "created")
      .put("userMessageId", JSONObject.NULL)
      .put("turnId", JSONObject.NULL)
      .put("assistantMessageIds", JSONArray())
      .put("highestAdvertisedSegment", JSONObject.NULL)
      .put("highestStartedSegment", JSONObject.NULL)
      .put("highestDrainedSegment", JSONObject.NULL)
      .put("segmentDispositions", JSONArray())
      .put("lastSequence", lastSequence)
      .put("acknowledgedSequence", 0)
      .put("speechTerminal", JSONObject.NULL)
      .put("dispatchAccepted", false)
      .put("detachedAt", JSONObject.NULL)
      .put("operationTokenExpiresAt", "2026-07-13T12:30:00Z")
      .put("retentionExpiresAt", "2026-08-13T12:30:00Z")

  private fun createInput(
    runtimeId: String = "runtime-1",
    generation: Long = 3,
  ) = VoiceRuntimeThreadTurnCreateInput(
    runtimeId,
    "instance-1",
    generation,
    "mode-1",
    "client-operation-1",
    "auto-submit",
    "speech-1",
    VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, 60_000, 600_000, true, 500,
    ),
  )

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
