package expo.modules.t3voice

import android.util.JsonReader
import android.util.JsonToken
import java.io.FilterInputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.net.URI
import java.time.Instant
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection

internal data class VoiceRuntimeControlGrant(
  val token: String,
  val sessionId: String,
  val leaseGeneration: Long,
  val expiresAtEpochMillis: Long,
  val heartbeatIntervalMillis: Long,
  val failureGraceMillis: Long,
)

internal enum class T3VoiceNativeHeartbeatResult {
  SUCCESS,
  SESSION_TERMINAL,
  SESSION_TERMINAL_HANDOFF,
  TRANSIENT_FAILURE,
  TERMINAL_FAILURE,
}

internal enum class VoiceRuntimeControlTermination {
  SESSION_ENDED,
  HANDOFF_PENDING,
  CONTROL_REJECTED,
  TRANSIENT_FAILURE,
}

internal data class T3VoiceNativeHeartbeatSchedule(
  val initialDelayMillis: Long,
  val intervalMillis: Long,
)

internal object T3VoiceNativeHeartbeatSchedulePolicy {
  fun forGrant(grant: VoiceRuntimeControlGrant): T3VoiceNativeHeartbeatSchedule =
    T3VoiceNativeHeartbeatSchedule(
      initialDelayMillis = 0,
      intervalMillis = grant.heartbeatIntervalMillis,
    )
}

internal object T3VoiceNativeHeartbeatPolicy {
  fun classify(statusCode: Int): T3VoiceNativeHeartbeatResult =
    when (statusCode) {
      in 200..299 -> T3VoiceNativeHeartbeatResult.SUCCESS
      in 400..499 -> T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
      else -> T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE
    }

  fun shouldLoseControl(
    result: T3VoiceNativeHeartbeatResult,
    nowMillis: Long,
    lastSuccessMillis: Long,
    failureGraceMillis: Long,
    expiresAtMillis: Long,
  ): Boolean =
    result == T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE ||
      nowMillis >= expiresAtMillis ||
      (result == T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE &&
        nowMillis - lastSuccessMillis >= failureGraceMillis)
}

internal object T3VoiceNativeHeartbeatResponsePolicy {
  fun validate(
    sessionId: String?,
    leaseGeneration: Long?,
    disposition: String?,
    phase: String?,
    handoffPending: Boolean?,
    expiresAt: String?,
    seenFields: Set<String>,
    expectedSessionId: String,
    expectedLeaseGeneration: Long,
  ): T3VoiceNativeHeartbeatResult {
    if (seenFields != REQUIRED_FIELDS) return T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    if (sessionId != expectedSessionId || leaseGeneration != expectedLeaseGeneration) {
      return T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }
    if (expiresAt == null) {
      return T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }
    if (handoffPending == null) {
      return T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }
    if (runCatching { Instant.parse(expiresAt) }.isFailure) {
      return T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }
    return when {
      disposition == "live" && phase in LIVE_PHASES && handoffPending == false ->
        T3VoiceNativeHeartbeatResult.SUCCESS
      disposition == "terminal" && phase in TERMINAL_PHASES ->
        if (handoffPending == true) {
          T3VoiceNativeHeartbeatResult.SESSION_TERMINAL_HANDOFF
        } else {
          T3VoiceNativeHeartbeatResult.SESSION_TERMINAL
        }
      else -> T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }
  }

  val REQUIRED_FIELDS =
    setOf("sessionId", "leaseGeneration", "phase", "disposition", "handoffPending", "expiresAt")
  private val LIVE_PHASES =
    setOf(
      "creating",
      "signaling",
      "connecting",
      "idle",
      "listening",
      "thinking",
      "speaking",
      "confirming",
      "reconnecting",
      "ending",
    )
  private val TERMINAL_PHASES = setOf("ended", "error")
}

internal object VoiceRuntimeControlOriginPolicy {
  fun heartbeatUrl(origin: String, sessionId: String): String {
    val uri = URI(origin)
    require(uri.scheme.equals("https", ignoreCase = true)) { "Native voice control requires HTTPS." }
    require(!uri.host.isNullOrBlank() && uri.userInfo == null) { "Invalid native control origin." }
    return URI(
      "https",
      null,
      uri.host,
      uri.port,
      "/api/voice/sessions/$sessionId/native-heartbeat",
      null,
      null,
    ).toASCIIString()
  }

}

internal data class VoiceRealtimeHandoffAction(
  val actionId: String,
  val sessionId: String,
  val leaseGeneration: Long,
  val projectId: String,
  val threadId: String,
  val autoRearm: Boolean,
  val expiresAtEpochMillis: Long,
)

internal sealed interface VoiceRealtimeHandoffOutcome {
  data object Listening : VoiceRealtimeHandoffOutcome
  data class Failed(val stage: String, val reason: String) : VoiceRealtimeHandoffOutcome
}

internal object VoiceRealtimeHandoffPolicy {
  fun recordingId(actionId: String) = "voice-handoff-$actionId"

  fun matchesGrant(action: VoiceRealtimeHandoffAction, sessionId: String?, leaseGeneration: Long?): Boolean =
    action.sessionId == sessionId && action.leaseGeneration == leaseGeneration
}

internal fun interface T3VoiceNativeHeartbeatTransport {
  fun post(
    url: String,
    token: String,
    sessionId: String,
    leaseGeneration: Long,
  ): T3VoiceNativeHeartbeatResult
}

internal class T3VoiceHttpsNativeHeartbeatTransport : T3VoiceNativeHeartbeatTransport {
  override fun post(
    url: String,
    token: String,
    sessionId: String,
    leaseGeneration: Long,
  ): T3VoiceNativeHeartbeatResult {
    val connection = URI(url).toURL().openConnection() as HttpsURLConnection
    try {
      connection.requestMethod = "POST"
      connection.instanceFollowRedirects = false
      connection.connectTimeout = REQUEST_TIMEOUT_MILLIS
      connection.readTimeout = REQUEST_TIMEOUT_MILLIS
      connection.doOutput = true
      connection.setRequestProperty("content-type", "application/json")
      connection.setRequestProperty("x-t3-voice-control", token)
      connection.outputStream.use { output ->
        output.write("{\"leaseGeneration\":$leaseGeneration}".toByteArray(Charsets.UTF_8))
      }
      val classified = T3VoiceNativeHeartbeatPolicy.classify(connection.responseCode)
      if (classified != T3VoiceNativeHeartbeatResult.SUCCESS) {
        runCatching { connection.errorStream?.use { it.readNBytes(MAXIMUM_RESPONSE_BYTES) } }
        return classified
      }
      return connection.inputStream.use { input ->
        parseSuccessResponse(input, sessionId, leaseGeneration)
      }
    } catch (_: Exception) {
      return T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE
    } finally {
      connection.disconnect()
    }
  }

  private fun parseSuccessResponse(
    input: InputStream,
    expectedSessionId: String,
    expectedLeaseGeneration: Long,
  ): T3VoiceNativeHeartbeatResult =
    try {
      val seen = mutableSetOf<String>()
      var sessionId: String? = null
      var generation: Long? = null
      var phase: String? = null
      var disposition: String? = null
      var handoffPending: Boolean? = null
      var expiresAt: String? = null
      JsonReader(InputStreamReader(BoundedInputStream(input, MAXIMUM_RESPONSE_BYTES), Charsets.UTF_8)).use {
        reader ->
        reader.beginObject()
        while (reader.hasNext()) {
          val name = reader.nextName()
          check(seen.add(name) && name in T3VoiceNativeHeartbeatResponsePolicy.REQUIRED_FIELDS)
          when (name) {
            "sessionId" -> sessionId = reader.nextString()
            "leaseGeneration" -> generation = reader.nextLong()
            "phase" -> phase = reader.nextString()
            "disposition" -> disposition = reader.nextString()
            "handoffPending" -> handoffPending = reader.nextBoolean()
            "expiresAt" -> expiresAt = reader.nextString()
          }
        }
        reader.endObject()
        check(reader.peek() == JsonToken.END_DOCUMENT)
      }
      T3VoiceNativeHeartbeatResponsePolicy.validate(
        sessionId,
        generation,
        disposition,
        phase,
        handoffPending,
        expiresAt,
        seen,
        expectedSessionId,
        expectedLeaseGeneration,
      )
    } catch (_: Exception) {
      T3VoiceNativeHeartbeatResult.TERMINAL_FAILURE
    }

  private class BoundedInputStream(input: InputStream, private val maximumBytes: Int) :
    FilterInputStream(input) {
    private var consumed = 0

    override fun read(): Int {
      val result = super.read()
      check(consumed < maximumBytes || result == -1) { "Native heartbeat response is too large." }
      if (result != -1) consumed += 1
      return result
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      if (consumed == maximumBytes) return if (super.read() == -1) -1 else error("Native heartbeat response is too large.")
      val allowed = minOf(length, maximumBytes - consumed)
      return super.read(buffer, offset, allowed).also { if (it > 0) consumed += it }
    }
  }

  private companion object {
    const val REQUEST_TIMEOUT_MILLIS = 5_000
    const val MAXIMUM_RESPONSE_BYTES = 4_096
  }
}

internal class VoiceRuntimeControlHeartbeat(
  private val transport: T3VoiceNativeHeartbeatTransport = T3VoiceHttpsNativeHeartbeatTransport(),
  private val clockMillis: () -> Long = System::currentTimeMillis,
  private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
  private val onTerminated: (String, VoiceRuntimeControlTermination) -> Unit,
) {
  private val lock = Any()
  private var grant: VoiceRuntimeControlGrant? = null
  private var heartbeatUrl: String? = null
  private var lastSuccessMillis = 0L
  private var scheduled: ScheduledFuture<*>? = null

  fun start(origin: String, nextGrant: VoiceRuntimeControlGrant) {
    val url = VoiceRuntimeControlOriginPolicy.heartbeatUrl(origin, nextGrant.sessionId)
    synchronized(lock) {
      stopLocked()
      grant = nextGrant
      heartbeatUrl = url
      lastSuccessMillis = clockMillis()
      val schedule = T3VoiceNativeHeartbeatSchedulePolicy.forGrant(nextGrant)
      scheduled =
        executor.scheduleWithFixedDelay(
          ::heartbeat,
          schedule.initialDelayMillis,
          schedule.intervalMillis,
          TimeUnit.MILLISECONDS,
        )
    }
  }

  fun stop() = synchronized(lock) { stopLocked() }

  fun destroy() {
    stop()
    executor.shutdownNow()
  }

  private fun heartbeat() {
    val current: VoiceRuntimeControlGrant
    val url: String
    synchronized(lock) {
      current = grant ?: return
      url = heartbeatUrl ?: return
    }
    if (clockMillis() >= current.expiresAtEpochMillis) {
      synchronized(lock) {
        if (grant !== current) return
        stopLocked()
      }
      onTerminated(current.sessionId, VoiceRuntimeControlTermination.SESSION_ENDED)
      return
    }
    val result = transport.post(url, current.token, current.sessionId, current.leaseGeneration)
    val now = clockMillis()
    var termination: VoiceRuntimeControlTermination? = null
    synchronized(lock) {
      if (grant !== current) return
      if (result == T3VoiceNativeHeartbeatResult.SUCCESS) lastSuccessMillis = now
      if (
        result == T3VoiceNativeHeartbeatResult.SESSION_TERMINAL ||
          result == T3VoiceNativeHeartbeatResult.SESSION_TERMINAL_HANDOFF
      ) {
        termination =
          if (result == T3VoiceNativeHeartbeatResult.SESSION_TERMINAL_HANDOFF) {
            VoiceRuntimeControlTermination.HANDOFF_PENDING
          } else {
            VoiceRuntimeControlTermination.SESSION_ENDED
          }
        stopLocked()
      } else if (
        T3VoiceNativeHeartbeatPolicy.shouldLoseControl(
          result,
          now,
          lastSuccessMillis,
          current.failureGraceMillis,
          current.expiresAtEpochMillis,
        )
      ) {
        termination =
          if (result == T3VoiceNativeHeartbeatResult.TRANSIENT_FAILURE) {
            VoiceRuntimeControlTermination.TRANSIENT_FAILURE
          } else {
            VoiceRuntimeControlTermination.CONTROL_REJECTED
          }
        stopLocked()
      }
    }
    termination?.let { onTerminated(current.sessionId, it) }
  }

  private fun stopLocked() {
    scheduled?.cancel(true)
    scheduled = null
    grant = null
    heartbeatUrl = null
    lastSuccessMillis = 0L
  }
}
