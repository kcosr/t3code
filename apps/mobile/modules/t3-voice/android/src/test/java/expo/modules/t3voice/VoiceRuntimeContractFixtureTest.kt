package expo.modules.t3voice

import java.io.File
import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

internal class VoiceRuntimeContractFixtureTest {
  @Test
  fun `Android parses and emits the shared Thread contract fixtures exactly`() {
    val fixture = JSONObject(fixtureFile().readText())
    @Suppress("UNCHECKED_CAST")
    val commandMap = jsonValue(fixture.getJSONObject("command")) as Map<String, Any?>
    val command = (VoiceRuntimeBridge.parseCommand(commandMap) as VoiceRuntimeNativeCommand.Thread)
      .command as VoiceRuntimeThreadCommand.Start
    assertEquals("turn-client-1", command.turnClientOperationId)
    assertEquals("auto-submit", command.submissionPolicy)

    val target = VoiceRuntimeTarget.Thread(
      "environment-1", "project-1", "thread-1", "default", true,
      2_200, null, 600_000, true, 500,
    )
    val targetIdentity =
      "{\"autoRearm\":true,\"endpointPolicy\":{\"endSilenceMs\":2200," +
        "\"maximumUtteranceMs\":600000,\"noSpeechTimeoutMs\":null}," +
        "\"environmentId\":\"environment-1\",\"mode\":\"thread\"," +
        "\"projectId\":\"project-1\",\"rearmGuardMs\":500,\"speechEnabled\":true," +
        "\"speechPreset\":\"default\",\"threadId\":\"thread-1\"}"
    assertEquals(targetIdentity, VoiceRuntimeBridge.canonicalThreadTargetIdentity(target))
    assertEquals(
      "815e74c5baee5fd386c8e6c3c145373b0a94f2b1b45b5fe1cdc9f8dcbcad1350",
      T3VoiceRuntimeTargetIdentity.digest(targetIdentity),
    )
    val snapshot = VoiceRuntimeSnapshot(
      VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
      8,
      VoiceRuntimeAvailability.READY,
      target,
      VoiceRuntimeOperation.ThreadTurn(
        "mode-1", VoiceThreadPhase.Ordinary(VoiceThreadOrdinaryPhase.RECORDING),
        "turn-client-1", "operation-1",
      ),
      VoiceRuntimeMediaOwner.Recorder("thread-mode", "operation-1"),
      VoiceRuntimeReadiness.Active(VoiceRuntimeMode.THREAD),
      null,
      null,
      null,
    )
    val receipt = receipt()
    val event = VoiceRuntimeEvent(
      VoiceRuntimeCursor("runtime-1", "instance-1", 4, 9),
      "thread-receipt",
      "mode-1",
      null,
      Instant.parse("2026-07-14T00:00:01Z").toEpochMilli(),
      threadReceipt = receipt,
    )
    val eventBody = (VoiceRuntimeBridge.deliveryBody(
      VoiceRuntimeDelivery.Events(listOf(event)),
    )["events"] as List<*>).single()

    assertEquals(canonical(fixture.getJSONObject("snapshot")), canonical(VoiceRuntimeBridge.snapshotBody(snapshot)))
    assertEquals(canonical(fixture.getJSONObject("receipt")), canonical(VoiceRuntimeBridge.threadReceiptBody(receipt)))
    assertEquals(canonical(fixture.getJSONObject("event")), canonical(eventBody))
  }

  private fun receipt() = VoiceRuntimeThreadReceipt(
    VoiceRuntimeIdentity("runtime-1", "instance-1", 4),
    "mode-1", "turn-client-1", "operation-1", "environment-1", "project-1", "thread-1",
    "message-1", "turn-1", listOf("assistant-1"), "speech-1", 1, 1, 1,
    listOf(VoiceRuntimeSpeechDisposition(1, "drained")),
    "completed", "completed",
    Instant.parse("2026-07-14T00:00:00Z").toEpochMilli(),
    Instant.parse("2026-08-14T00:00:00Z").toEpochMilli(),
  )

  private fun fixtureFile(): File {
    var directory = File(System.getProperty("user.dir")).absoluteFile
    repeat(12) {
      val candidate = File(directory, "packages/contracts/src/fixtures/voice-runtime-thread.json")
      if (candidate.isFile) return candidate
      directory = directory.parentFile ?: return@repeat
    }
    error("Could not locate shared voice runtime fixture.")
  }

  private fun jsonValue(value: Any?): Any? = when (value) {
    JSONObject.NULL -> null
    is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
    is JSONArray -> buildList(value.length()) { for (index in 0 until value.length()) add(jsonValue(value.get(index))) }
    else -> value
  }

  private fun canonical(value: Any?): String = when (value) {
    null, JSONObject.NULL -> "null"
    is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") {
      "${JSONObject.quote(it)}:${canonical(value.get(it))}"
    }
    is Map<*, *> -> value.entries.sortedBy { it.key.toString() }.joinToString(",", "{", "}") {
      "${JSONObject.quote(it.key.toString())}:${canonical(it.value)}"
    }
    is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
    is Iterable<*> -> value.joinToString(",", "[", "]") { canonical(it) }
    is Number -> value.toDouble().let { number ->
      if (number % 1.0 == 0.0) number.toLong().toString() else number.toString()
    }
    is String -> JSONObject.quote(value)
    is Boolean -> value.toString()
    else -> error("Unsupported canonical fixture value: ${value::class.java.name}")
  }
}
