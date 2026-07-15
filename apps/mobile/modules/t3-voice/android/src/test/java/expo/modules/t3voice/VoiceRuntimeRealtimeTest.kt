package expo.modules.t3voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeRealtimeTest {
  @Test
  fun `create uses canonical route and full runtime fence`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val result = delegate(requests) { _ -> startResponse() }.start(
      ORIGIN,
      "runtime-secret",
      VoiceRuntimeRealtimeStartInput(runtimeFence(), "operation-create", realtimeTarget()),
    )

    assertTrue(result is VoiceRuntimeRealtimeResult.Success<*>)
    val value = (result as VoiceRuntimeRealtimeResult.Success<
      VoiceRuntimeRealtimeStartResult
    >).value
    assertEquals("session-1", value.state.sessionId)
    assertEquals(15, value.heartbeatIntervalSeconds)
    assertEquals("$BASE/session-1/webrtc-offer", value.signalingPath)
    val request = requests.single()
    assertEquals(BASE, request.path)
    assertEquals(VoiceRuntimeHttpMethod.POST, request.method)
    assertEquals("runtime-secret", request.sessionCredential.value)
    assertEquals(
      setOf(
        "runtimeId", "runtimeInstanceId", "generation", "modeSessionId", "clientOperationId", "target",
      ),
      body(request).keys().asSequence().toSet(),
    )
  }

  @Test
  fun `create response is exact and tokenless`() {
    val decoded = VoiceRuntimeRealtimeJson.decodeStart(startResponse())
    assertEquals(7, decoded.state.leaseGeneration)
    assertEquals(15, decoded.heartbeatIntervalSeconds)

    val legacy = JSONObject(startResponse().toString(Charsets.UTF_8))
    legacy.put("controlGrant", JSONObject().put("token", "old-secret"))
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeRealtimeJson.decodeStart(legacy.toString().toByteArray())
    }
    val legacyPath = JSONObject(startResponse().toString(Charsets.UTF_8))
    legacyPath.getJSONObject("transport").put(
      "signalingPath",
      "/api/voice/native/realtime-sessions/session-1/webrtc-offer",
    )
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeRealtimeJson.decodeStart(legacyPath.toString().toByteArray())
    }
  }

  @Test
  fun `offer heartbeat and close carry the full lease fence`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val delegate = delegate(requests) { request ->
      when {
        request.path.endsWith("webrtc-offer") -> answerResponse()
        request.path.endsWith("heartbeat") -> heartbeatResponse()
        else -> closeResponse()
      }
    }
    val lease = leaseFence()
    val answer = delegate.offer(
      ORIGIN,
      "control-secret",
      "session-1",
      VoiceRuntimeRealtimeOfferInput(lease, "operation-offer", "offer-sdp"),
    )
    val heartbeat = delegate.heartbeat(ORIGIN, "control-secret", "session-1", lease)
    val close = delegate.close(
      ORIGIN,
      "control-secret",
      "session-1",
      VoiceRuntimeRealtimeCloseInput(lease, "operation-close"),
    )

    assertTrue(answer is VoiceRuntimeRealtimeResult.Success<*>)
    assertTrue(heartbeat is VoiceRuntimeRealtimeResult.Success<*>)
    assertTrue(close is VoiceRuntimeRealtimeResult.Success<*>)
    assertEquals(
      listOf(
        "$BASE/session-1/webrtc-offer",
        "$BASE/session-1/heartbeat",
        "$BASE/session-1/close",
      ),
      requests.map { it.path },
    )
    assertEquals(
      setOf(
        "runtimeId", "runtimeInstanceId", "generation", "modeSessionId", "leaseGeneration",
        "clientOperationId", "sdp",
      ),
      body(requests[0]).keys().asSequence().toSet(),
    )
    assertEquals(leaseFields, body(requests[1]).keys().asSequence().toSet())
    assertEquals(leaseFields + "clientOperationId", body(requests[2]).keys().asSequence().toSet())
    assertTrue(requests.all { it.sessionCredential.value == "control-secret" })
  }

  @Test
  fun `actions poll is canonical bounded and strictly ordered`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val result = delegate(requests) { _ -> actionsResponse() }.actions(
      ORIGIN,
      "control-secret",
      "session-1",
      VoiceRuntimeRealtimeActionsQuery(leaseFence(), 3, 25_000),
    )

    val actions = (result as VoiceRuntimeRealtimeResult.Success<
      VoiceRuntimeRealtimeActionsResult
    >).value.actions
    assertEquals(4, actions.size)
    assertTrue(actions[0] is VoiceRuntimeRealtimeAction.NavigateThread)
    assertTrue(actions[1] is VoiceRuntimeRealtimeAction.HandoffToThreadVoice)
    assertTrue(actions[2] is VoiceRuntimeRealtimeAction.StopRealtimeVoice)
    assertTrue(actions[3] is VoiceRuntimeRealtimeAction.ConfirmationRequired)
    val request = requests.single()
    assertEquals("$BASE/session-1/actions", request.path)
    assertEquals(VoiceRuntimeHttpMethod.GET, request.method)
    assertEquals("3", request.queryParameters["afterSequence"])
    assertEquals("25000", request.queryParameters["waitMilliseconds"])
    assertEquals("instance-1", request.queryParameters["runtimeInstanceId"])
    assertEquals("mode-1", request.queryParameters["modeSessionId"])

    val unordered = JSONObject(actionsResponse().toString(Charsets.UTF_8))
    unordered.getJSONArray("actions").getJSONObject(1).put("sequence", 1)
    assertThrows(IllegalArgumentException::class.java) {
      VoiceRuntimeRealtimeJson.decodeActions(unordered.toString().toByteArray())
    }
  }

  @Test
  fun `action ack uses encoded action path and exact outcome`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val result = delegate(requests) { _ -> ackResponse() }.acknowledgeAction(
      ORIGIN,
      "control-secret",
      "session-1",
      "action:1",
      VoiceRuntimeRealtimeActionAckInput.NavigateThread(
        leaseFence(),
        "operation-ack",
        1,
        VoiceRuntimeRealtimeActionOutcome.SUCCEEDED,
      ),
    )

    assertTrue(result is VoiceRuntimeRealtimeResult.Success<*>)
    assertEquals("$BASE/session-1/actions/action%3A1/ack", requests.single().path)
    assertEquals("navigate-thread", body(requests.single()).getString("action"))
    assertEquals("succeeded", body(requests.single()).getString("outcome"))
    assertFalse(body(requests.single()).has("message"))
  }

  @Test
  fun `focus update preserves explicit nulls`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val input = VoiceRuntimeRealtimeFocusInput(
      leaseFence(),
      "operation-focus",
      VoiceRuntimeRealtimeFocus("project-1", null),
    )
    val result = delegate(requests) { _ -> focusResponse() }.updateFocus(
      ORIGIN,
      "control-secret",
      "session-1",
      input,
    )

    assertTrue(result is VoiceRuntimeRealtimeResult.Success<*>)
    assertEquals(VoiceRuntimeHttpMethod.PUT, requests.single().method)
    assertEquals("$BASE/session-1/focus", requests.single().path)
    assertTrue(body(requests.single()).getJSONObject("focus").isNull("threadId"))
  }

  @Test
  fun `handoff exchange validates one-use transition target`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val input = handoffInput()
    val result = delegate(requests) { _ -> handoffResponse() }.exchangeHandoff(
      ORIGIN,
      "control-secret",
      "session-1",
      "handoff:1",
      input,
    )

    val value = (result as VoiceRuntimeRealtimeResult.Success<
      VoiceRuntimeRealtimeHandoffExchangeResult
    >).value
    assertEquals(5, value.reservation.generation)
    assertEquals("thread-mode-1", value.reservation.modeSessionId)
    assertEquals("project-1", value.reservation.target.projectId)
    assertEquals("$BASE/session-1/handoffs/handoff%3A1/exchange", requests.single().path)
    assertEquals(
      leaseFields + setOf(
        "clientOperationId", "actionSequence", "nextGeneration", "threadModeSessionId",
        "environmentId", "speechPreset", "endpointPolicy", "speechEnabled", "rearmGuardMs",
      ),
      body(requests.single()).keys().asSequence().toSet(),
    )

    val mismatched = JSONObject(handoffResponse().toString(Charsets.UTF_8))
    mismatched.getJSONObject("reservation").put("generation", 6)
    val failed = delegate(mutableListOf()) { _ -> mismatched.toString().toByteArray() }.exchangeHandoff(
      ORIGIN, "control-secret", "session-1", "handoff:1", input,
    )
    assertTrue(failed is VoiceRuntimeRealtimeResult.Failure)
  }

  @Test
  fun `handoff commit uses session credential and exact reservation fence`() {
    val requests = mutableListOf<VoiceRuntimeHttpRequest>()
    val result = delegate(requests) { _ -> handoffCommitResponse() }.commitHandoff(
      ORIGIN,
      "transition-secret",
      "session-1",
      "handoff:1",
      VoiceRuntimeRealtimeHandoffCommitInput(
        leaseFence(),
        2,
        5,
        "thread-mode-1",
      ),
    )

    val value = (result as VoiceRuntimeRealtimeResult.Success<
      VoiceRuntimeRealtimeHandoffCommitResult
    >).value
    assertTrue(value.committed)
    assertFalse(value.replayed)
    val request = requests.single()
    assertEquals("$BASE/session-1/handoffs/handoff%3A1/commit", request.path)
    assertEquals(VoiceRuntimeHttpMethod.POST, request.method)
    assertEquals("transition-secret", request.sessionCredential.value)
    assertEquals(
      leaseFields + setOf("actionSequence", "nextGeneration", "threadModeSessionId"),
      body(request).keys().asSequence().toSet(),
    )
  }

  @Test
  fun `malformed success and transport failure remain classified`() {
    val malformed = delegate(mutableListOf()) { _ -> "{".toByteArray() }.start(
      ORIGIN, "runtime-secret", VoiceRuntimeRealtimeStartInput(
        runtimeFence(), "operation", realtimeTarget(),
      ),
    )
    assertEquals(
      VoiceRuntimeHttpFailureKind.PERMANENT,
      (malformed as VoiceRuntimeRealtimeResult.Failure).kind,
    )
    val retryable = VoiceRuntimeRealtimeDelegate(
      VoiceRuntimeRealtimeHttp {
        VoiceRuntimeHttpResult.Failure(VoiceRuntimeHttpFailureKind.RETRYABLE, 503)
      },
    ).start(
      ORIGIN, "runtime-secret", VoiceRuntimeRealtimeStartInput(
        runtimeFence(), "operation", realtimeTarget(),
      ),
    ) as VoiceRuntimeRealtimeResult.Failure
    assertEquals(VoiceRuntimeHttpFailureKind.RETRYABLE, retryable.kind)
    assertEquals(503, retryable.statusCode)
  }

  private fun delegate(
    requests: MutableList<VoiceRuntimeHttpRequest>,
    response: (VoiceRuntimeHttpRequest) -> ByteArray,
  ) = VoiceRuntimeRealtimeDelegate(
    VoiceRuntimeRealtimeHttp { request ->
      requests += request
      VoiceRuntimeHttpResult.Success(200, "application/json; charset=utf-8", response(request))
    },
  )

  private fun body(request: VoiceRuntimeHttpRequest) =
    JSONObject(request.body!!.openStream().readBytes().toString(Charsets.UTF_8))

  private fun runtimeFence() =
    VoiceRealtimeTransportFence("runtime-1", "instance-1", 4, "mode-1")

  private fun realtimeTarget() =
    VoiceRuntimeTarget.Realtime("environment-1", "conversation-1")

  private fun leaseFence() = VoiceRuntimeRealtimeLeaseFence(runtimeFence(), 7)

  private fun handoffInput() = VoiceRuntimeRealtimeHandoffExchangeInput(
    leaseFence(),
    "operation-handoff",
    2,
    5,
    "thread-mode-1",
    "environment-1",
    "warm",
    VoiceRuntimeRealtimeEndpointPolicy(2_200, 120_000, 900_000),
    true,
    500,
  )

  private fun state(phase: String = "signaling", sequence: Long = 0) =
    """{
      "sessionId":"session-1","conversationId":"conversation-1","mode":"realtime-agent",
      "phase":"$phase","leaseGeneration":7,"sequence":$sequence
    }"""

  private fun startResponse() = """{
    "state":${state()},
    "transport":{"kind":"webrtc-sdp-v1","signalingPath":"$BASE/session-1/webrtc-offer"},
    "expiresAt":"2026-07-15T12:00:00Z","heartbeatIntervalSeconds":15
  }""".toByteArray()

  private fun answerResponse() =
    """{"sessionId":"session-1","leaseGeneration":7,"sdp":"answer-sdp","replayed":false}""".toByteArray()

  private fun heartbeatResponse() = """{
    "state":${state("idle", 1)},"disposition":"live","handoffPending":false,
    "expiresAt":"2026-07-15T12:00:00Z"
  }""".toByteArray()

  private fun actionsResponse() = """{
    "state":${state("listening", 4)},"actions":[
      {"sequence":1,"occurredAt":"2026-07-14T12:00:00Z","type":"navigate-thread",
       "actionId":"action:1","projectId":"project-1","threadId":"thread-1","expiresAt":"2026-07-14T12:01:00Z"},
      {"sequence":2,"occurredAt":"2026-07-14T12:00:01Z","type":"handoff-to-thread-voice",
       "actionId":"handoff:1","projectId":"project-1","threadId":"thread-1","autoRearm":true,
       "expiresAt":"2026-07-14T12:01:01Z"},
      {"sequence":3,"occurredAt":"2026-07-14T12:00:02Z","type":"stop-realtime-voice"},
      {"sequence":4,"occurredAt":"2026-07-14T12:00:03Z","type":"confirmation-required",
       "actionId":"confirm:1","confirmationId":"confirmation-1","toolCallId":"tool-call-1",
       "tool":"send-message","summary":"Send the message","expiresAt":"2026-07-14T12:01:03Z"}
    ]
  }""".toByteArray()

  private fun ackResponse() =
    """{"actionId":"action:1","actionSequence":1,"outcome":"succeeded","replayed":false}""".toByteArray()

  private fun focusResponse() = """{
    "state":${state("idle", 2)},"focus":{"projectId":"project-1","threadId":null},"replayed":false
  }""".toByteArray()

  private fun handoffResponse() = """{
    "actionId":"handoff:1","actionSequence":2,"projectId":"project-1","threadId":"thread-1",
    "autoRearm":true,"reservation":{
      "generation":5,
      "modeSessionId":"thread-mode-1","target":{"mode":"thread","environmentId":"environment-1",
        "projectId":"project-1","threadId":"thread-1","speechPreset":"warm","autoRearm":true,
        "endpointPolicy":{"endSilenceMs":2200,"noSpeechTimeoutMs":120000,"maximumUtteranceMs":900000},
        "speechEnabled":true,"rearmGuardMs":500}
    },"replayed":false
  }""".toByteArray()

  private fun handoffCommitResponse() =
    """{"actionId":"handoff:1","actionSequence":2,"committed":true,"replayed":false}"""
      .toByteArray()

  private fun closeResponse() =
    """{"state":${state("ended", 5)},"closed":true,"replayed":false}""".toByteArray()

  private companion object {
    const val ORIGIN = "https://environment.example.test"
    const val BASE = "/api/voice/runtime/realtime-sessions"
    val leaseFields = setOf(
      "runtimeId", "runtimeInstanceId", "generation", "modeSessionId", "leaseGeneration",
    )
  }
}
