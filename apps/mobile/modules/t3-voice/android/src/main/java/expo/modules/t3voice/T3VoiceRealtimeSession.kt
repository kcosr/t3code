package expo.modules.t3voice

import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal data class T3VoiceRealtimeTerminalResult(
  val callback: T3VoiceRuntimeCallback?,
  val publishedBeforeQuiescence: Boolean,
)

/** Live Realtime control plane with independent media-event, heartbeat, focus, ACK, and close lanes. */
internal class T3VoiceRealtimeSession(
  val generation: Long,
  val target: T3VoiceRealtimeTarget,
  val sessionConfig: T3VoiceNativeSessionConfig,
  private val webRtc: T3VoiceRealtimeMedia,
  private val audioRouter: T3VoiceRealtimeAudioRouting,
  private val emit: (T3VoiceRuntimeCallback) -> Unit,
  private val onQuiesced: (T3VoiceRealtimeTerminalResult) -> Unit,
  private val api: T3VoiceRealtimeSessionApi = T3VoiceNativeVoiceApi(sessionConfig),
  private val nowEpochMillis: () -> Long = T3VoiceTime::nowEpochMillis,
  private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(),
  private val startupExecutor: ExecutorService = Executors.newSingleThreadExecutor(),
  private val terminalExecutor: ExecutorService = Executors.newSingleThreadExecutor(),
  private val terminalDeadlineScheduler: ScheduledExecutorService =
    Executors.newSingleThreadScheduledExecutor(),
  private val terminalOutcomeDeadlineMs: Long = DEFAULT_TERMINAL_OUTCOME_DEADLINE_MS,
) {
  private data class DesiredFocus(
    val revision: Long,
    val focus: T3VoiceRealtimeFocus?,
  )

  private val lock = Any()
  private val terminal = AtomicBoolean(false)
  private val cleanupStarted = AtomicBoolean(false)
  private val terminalCompleted = AtomicBoolean(false)
  private val terminalPublished = AtomicBoolean(false)
  private val connected = AtomicBoolean(false)
  private val terminalPublicationFinished = CountDownLatch(1)
  private val startupQuiescence = T3VoiceStartupQuiescence(::runStartup)
  private val eventExecutor = Executors.newSingleThreadExecutor()
  private val heartbeatExecutor = Executors.newSingleThreadExecutor()
  private val focusExecutor = Executors.newSingleThreadExecutor()
  private val acknowledgementExecutor = Executors.newFixedThreadPool(2)
  private val activeCalls = ConcurrentHashMap.newKeySet<T3VoiceHttpCallRegistry>()
  private val finalTranscript = ArrayDeque<T3VoiceRealtimeTranscriptTurn>()
  private val confirmationByToolCall = mutableMapOf<String, String>()
  private val actionExpirations =
    T3VoiceBoundedExpiryRegistry(
      maximumEntries = T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CLIENT_ACTIONS,
      scheduler = scheduler,
      nowEpochMillis = nowEpochMillis,
      onExpired = { actionId ->
        emitIfLive(T3VoiceRuntimeCallback.RealtimeClientActionResolved(actionId))
      },
    )
  private val confirmationExpirations =
    T3VoiceBoundedExpiryRegistry(
      maximumEntries = T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CONFIRMATIONS,
      scheduler = scheduler,
      nowEpochMillis = nowEpochMillis,
      onExpired = { confirmationId ->
        synchronized(lock) {
          confirmationByToolCall.entries.removeAll { it.value == confirmationId }
        }
        emitIfLive(T3VoiceRuntimeCallback.RealtimeConfirmationResolved(confirmationId))
      },
    )
  private var serverSession: T3VoiceApiRealtimeSession? = null
  private var eventSequence = 0L
  private var heartbeatFuture: ScheduledFuture<*>? = null
  private var heartbeatFailures = 0
  private var eventFailures = 0
  private var desiredFocus = DesiredFocus(0, target.focus)
  private var focusWorkerScheduled = false
  private var terminalCallback: T3VoiceRuntimeCallback? = null
  private var terminalDeadlineFuture: ScheduledFuture<*>? = null

  init {
    require(terminalOutcomeDeadlineMs > 0) { "terminalOutcomeDeadlineMs must be positive." }
  }

  fun start() {
    try {
      startupQuiescence.submit(startupExecutor)
    } catch (cause: Throwable) {
      if (!terminal.get()) {
        fail(cause, "realtime-start-failed", "The Realtime voice session could not start.")
      }
    }
  }

  private fun runStartup() {
    try {
      if (terminal.get()) return
      val created = executeCall { calls ->
        api.createRealtimeSession(calls, target, UUID.randomUUID().toString())
      }
      synchronized(lock) {
        serverSession = created
        eventSequence = created.state.sequence
      }
      if (terminal.get()) return
      startHeartbeat(created)
      eventExecutor.execute(::pollEvents)
      webRtc.prepare(
        sessionId = created.state.sessionId,
        diagnosticGeneration = generation,
        callback =
          object : T3VoiceWebRtcResultCallback<String> {
            override fun onSuccess(result: String) = offer(created, result)

            override fun onFailure(code: String, message: String, cause: Throwable?) {
              fail(
                cause ?: T3VoiceNativeApiException(code, retryable = true),
                code,
                "The Realtime media connection could not start.",
              )
            }
          },
      )
    } catch (cause: Throwable) {
      if (!terminal.get()) {
        fail(cause, "realtime-start-failed", "The Realtime voice session could not start.")
      }
    }
  }

  fun close() {
    if (!terminal.compareAndSet(false, true)) return
    synchronized(lock) {
      terminalCallback = T3VoiceRuntimeCallback.RealtimeClosed
    }
    beginTerminalCleanup()
  }

  fun forceRelease() {
    terminal.compareAndSet(false, true)
    beginTerminalCleanup()
  }

  fun setMuted(muted: Boolean) {
    val server = synchronized(lock) { serverSession } ?: return
    try {
      webRtc.setMuted(server.state.sessionId, muted)
    } catch (cause: Throwable) {
      fail(cause, "realtime-mute-failed", "Realtime microphone control failed.")
    }
  }

  fun setAudioRoute(routeId: String) {
    val server = synchronized(lock) { serverSession } ?: return
    try {
      webRtc.selectRoute(server.state.sessionId, routeId)
      emitRoutes()
    } catch (cause: Throwable) {
      fail(cause, "realtime-route-failed", "Realtime audio routing failed.")
    }
  }

  /** Synchronously reserves the newest focus before its independent network lane begins. */
  fun admitFocus(focus: T3VoiceRealtimeFocus?) {
    synchronized(lock) {
      desiredFocus = DesiredFocus(desiredFocus.revision + 1, focus)
      if (focusWorkerScheduled || terminal.get()) return
      focusWorkerScheduled = true
    }
    focusExecutor.execute(::drainFocusUpdates)
  }

  fun acknowledgeClientAction(
    actionId: String,
    outcome: T3VoiceClientActionOutcome,
    message: String?,
  ) {
    val expiration = actionExpirations.expiration(actionId) ?: return
    acknowledgementExecutor.execute {
      var delayMs = INITIAL_RETRY_DELAY_MS
      while (
        !terminal.get() &&
          nowEpochMillis() < expiration &&
          actionExpirations.expiration(actionId) == expiration
      ) {
        val server = synchronized(lock) { serverSession } ?: return@execute
        try {
          executeCall { calls ->
            api.acknowledgeRealtimeClientAction(
              calls,
              server.state.sessionId,
              server.state.leaseGeneration,
              actionId,
              outcome,
              message,
            )
          }
          actionExpirations.remove(actionId)
          return@execute
        } catch (cause: T3VoiceNativeApiException) {
          if (
            nowEpochMillis() >= expiration ||
              actionExpirations.expiration(actionId) != expiration
          ) {
            return@execute
          }
          if (!cause.retryable) {
            fail(cause, "realtime-action-ack-failed", "Realtime action acknowledgement failed.")
            return@execute
          }
        } catch (cause: Throwable) {
          if (
            nowEpochMillis() < expiration &&
              actionExpirations.expiration(actionId) == expiration
          ) {
            fail(cause, "realtime-action-ack-failed", "Realtime action acknowledgement failed.")
          }
          return@execute
        }
        sleepControl(delayMs)
        delayMs = (delayMs * 2).coerceAtMost(MAXIMUM_RETRY_DELAY_MS)
      }
      // Expiry is terminal for this action, not for the healthy Realtime media session.
      actionExpirations.remove(actionId)
    }
  }

  fun decideConfirmation(confirmationId: String, decision: T3VoiceConfirmationDecision) {
    val expiration = confirmationExpirations.expiration(confirmationId) ?: return
    acknowledgementExecutor.execute {
      var failures = 0
      while (
        !terminal.get() &&
          nowEpochMillis() < expiration &&
          confirmationExpirations.expiration(confirmationId) == expiration
      ) {
        try {
          val server = synchronized(lock) { serverSession }
            ?: return@execute
          executeCall { calls ->
            api.decideRealtimeConfirmation(
              calls,
              server.state.sessionId,
              confirmationId,
              decision,
            )
          }
          synchronized(lock) {
            confirmationByToolCall.entries.removeAll { it.value == confirmationId }
          }
          if (confirmationExpirations.remove(confirmationId)) {
            emitIfLive(T3VoiceRuntimeCallback.RealtimeConfirmationResolved(confirmationId))
          }
          return@execute
        } catch (cause: T3VoiceNativeApiException) {
          if (
            nowEpochMillis() >= expiration ||
              confirmationExpirations.expiration(confirmationId) != expiration
          ) {
            return@execute
          }
          failures += 1
          if (!cause.retryable || failures >= MAXIMUM_CONTROL_FAILURES) {
            fail(cause, "realtime-confirmation-failed", "Realtime confirmation failed.")
            return@execute
          }
          sleepControl(retryDelay(failures))
        } catch (cause: Throwable) {
          if (
            nowEpochMillis() < expiration &&
              confirmationExpirations.expiration(confirmationId) == expiration
          ) {
            fail(cause, "realtime-confirmation-failed", "Realtime confirmation failed.")
          }
          return@execute
        }
      }
    }
  }

  fun onWebRtcStateChanged(sessionId: String, connectionState: String) {
    val expected = synchronized(lock) { serverSession?.state?.sessionId } ?: return
    if (sessionId != expected || terminal.get()) return
    if (connectionState == "connected" && connected.compareAndSet(false, true)) {
      emitRoutes()
      emitIfLive(T3VoiceRuntimeCallback.RealtimeConnected)
    }
  }

  fun onWebRtcError(sessionId: String, code: String, recoverable: Boolean) {
    val expected = synchronized(lock) { serverSession?.state?.sessionId } ?: return
    if (sessionId != expected || terminal.get()) return
    fail(
      T3VoiceNativeApiException(code, retryable = recoverable),
      "realtime-media-failed",
      "The Realtime media connection failed.",
    )
  }

  fun onWebRtcTerminated(sessionId: String, code: String, retryable: Boolean) {
    val expected = synchronized(lock) { serverSession?.state?.sessionId } ?: return
    if (sessionId != expected || terminal.get()) return
    fail(
      T3VoiceNativeApiException(code, retryable = retryable),
      "realtime-media-ended",
      "The Realtime media connection ended.",
    )
  }

  fun onAudioRouteChanged() = emitRoutes()

  private fun offer(server: T3VoiceApiRealtimeSession, offerSdp: String) {
    if (terminal.get()) return
    startupExecutor.execute {
      try {
        val answer = executeCall { calls -> api.offerRealtimeSession(calls, server, offerSdp) }
        if (terminal.get()) return@execute
        webRtc.applyAnswer(
          server.state.sessionId,
          answer,
          object : T3VoiceWebRtcResultCallback<Unit> {
            override fun onSuccess(result: Unit) = Unit

            override fun onFailure(code: String, message: String, cause: Throwable?) {
              fail(
                cause ?: T3VoiceNativeApiException(code, retryable = true),
                code,
                "The Realtime media answer was rejected.",
              )
            }
          },
        )
      } catch (cause: Throwable) {
        if (!terminal.get()) {
          fail(cause, "realtime-signaling-failed", "Realtime signaling failed.")
        }
      }
    }
  }

  private fun startHeartbeat(server: T3VoiceApiRealtimeSession) {
    val intervalMs =
      TimeUnit.SECONDS.toMillis(server.heartbeatIntervalSeconds)
        .coerceIn(MINIMUM_HEARTBEAT_INTERVAL_MS, MAXIMUM_HEARTBEAT_INTERVAL_MS)
    scheduleHeartbeat(intervalMs)
  }

  private fun scheduleHeartbeat(delayMs: Long) {
    if (terminal.get()) return
    synchronized(lock) {
      heartbeatFuture =
        scheduler.schedule(
          { heartbeatExecutor.execute(::heartbeat) },
          delayMs,
          TimeUnit.MILLISECONDS,
        )
    }
  }

  private fun heartbeat() {
    if (terminal.get()) return
    val server = synchronized(lock) { serverSession } ?: return
    try {
      val state = executeCall { calls ->
        api.heartbeatRealtimeSession(
          calls,
          server.state.sessionId,
          server.state.leaseGeneration,
        )
      }
      requireLivePhase(state.phase)
      heartbeatFailures = 0
      scheduleHeartbeat(
        TimeUnit.SECONDS.toMillis(server.heartbeatIntervalSeconds)
          .coerceIn(MINIMUM_HEARTBEAT_INTERVAL_MS, MAXIMUM_HEARTBEAT_INTERVAL_MS),
      )
    } catch (cause: Throwable) {
      if (terminal.get()) return
      val retryable = (cause as? T3VoiceNativeApiException)?.retryable == true
      heartbeatFailures += 1
      if (!retryable || heartbeatFailures >= MAXIMUM_CONTROL_FAILURES) {
        fail(cause, "realtime-heartbeat-failed", "The Realtime session heartbeat failed.")
      } else {
        scheduleHeartbeat(retryDelay(heartbeatFailures))
      }
    }
  }

  private fun pollEvents() {
    while (!terminal.get()) {
      val server = synchronized(lock) { serverSession } ?: return
      val after = synchronized(lock) { eventSequence }
      try {
        val result = executeCall { calls ->
          api.realtimeEvents(
            calls,
            server.state.sessionId,
            server.state.leaseGeneration,
            after,
          )
        }
        eventFailures = 0
        handleEvents(result, after)
      } catch (cause: Throwable) {
        if (terminal.get()) return
        val retryable = (cause as? T3VoiceNativeApiException)?.retryable == true
        eventFailures += 1
        if (!retryable || eventFailures >= MAXIMUM_CONTROL_FAILURES) {
          fail(cause, "realtime-events-failed", "The Realtime event stream failed.")
          return
        }
        sleepControl(retryDelay(eventFailures))
      }
    }
  }

  private fun handleEvents(result: T3VoiceApiRealtimeEvents, afterSequence: Long) {
    requireLivePhase(result.state.phase)
    var cursor = afterSequence
    result.events.forEach { event ->
      require(event.sequence > cursor) { "Realtime events were not strictly ordered." }
      require(event.sequence <= result.state.sequence) {
        "Realtime event sequence exceeded server state."
      }
      cursor = event.sequence
      when (event) {
        is T3VoiceApiRealtimeEvent.State -> requireLivePhase(event.phase)
        is T3VoiceApiRealtimeEvent.Transcript -> if (event.final) appendFinalTranscript(event)
        is T3VoiceApiRealtimeEvent.ConfirmationRequired -> {
          val expiration =
            T3VoiceTime.parseIsoEpochMillis(
              event.confirmation.expiresAt,
              "confirmation expiration",
            )
          confirmationExpirations.register(event.confirmation.confirmationId, expiration) {
            synchronized(lock) {
              val existingToolCall =
                confirmationByToolCall.entries.firstOrNull {
                  it.value == event.confirmation.confirmationId
                }?.key
              check(existingToolCall == null || existingToolCall == event.toolCallId) {
                "A Realtime confirmation reused its identity."
              }
              check(
                confirmationByToolCall.containsKey(event.toolCallId) ||
                confirmationByToolCall.size <
                  T3VoiceRuntimeBounds.MAXIMUM_PENDING_REALTIME_CONFIRMATIONS
              ) { "The Realtime confirmation tracking limit was exceeded." }
              val previous = confirmationByToolCall.put(
                event.toolCallId,
                event.confirmation.confirmationId,
              )
              check(previous == null || previous == event.confirmation.confirmationId) {
                "A Realtime tool call reused its confirmation identity."
              }
            }
            emitIfLive(T3VoiceRuntimeCallback.RealtimeConfirmationReceived(event.confirmation))
          }
        }
        is T3VoiceApiRealtimeEvent.Tool -> {
          if (event.outcome != "pending-confirmation") {
            val confirmationId = synchronized(lock) {
              confirmationByToolCall.remove(event.toolCallId)
            }
            if (confirmationId != null) {
              confirmationExpirations.remove(confirmationId)
              emitIfLive(T3VoiceRuntimeCallback.RealtimeConfirmationResolved(confirmationId))
            }
          }
        }
        is T3VoiceApiRealtimeEvent.ClientAction -> {
          val expiration =
            T3VoiceTime.parseIsoEpochMillis(
              event.action.expiresAt,
              "client action expiration",
            )
          actionExpirations.register(event.action.actionId, expiration) {
            emitIfLive(T3VoiceRuntimeCallback.RealtimeClientActionReceived(event.action))
          }
        }
        is T3VoiceApiRealtimeEvent.LeaseFenced ->
          throw T3VoiceNativeApiException("realtime-lease-fenced", retryable = true)
        is T3VoiceApiRealtimeEvent.RotationRequired ->
          throw T3VoiceNativeApiException("realtime-rotation-required", retryable = true)
        is T3VoiceApiRealtimeEvent.Error ->
          throw T3VoiceNativeApiException(
            safeFailureCode(event.reason, "realtime-provider-error"),
            retryable = event.recoverable,
          )
        is T3VoiceApiRealtimeEvent.Ignored -> Unit
      }
    }
    synchronized(lock) { eventSequence = cursor }
  }

  private fun appendFinalTranscript(event: T3VoiceApiRealtimeEvent.Transcript) {
    require(event.text.length <= MAXIMUM_TRANSCRIPT_TURN_CHARS) {
      "Realtime transcript turn exceeded its native limit."
    }
    val turn = T3VoiceRealtimeTranscriptTurn(event.role, event.text)
    val snapshot =
      synchronized(lock) {
        finalTranscript.addLast(turn)
        while (finalTranscript.size > MAXIMUM_PUBLIC_TRANSCRIPT_TURNS) {
          finalTranscript.removeFirst()
        }
        finalTranscript.toList()
      }
    emitIfLive(T3VoiceRuntimeCallback.RealtimeTranscriptChanged(snapshot))
  }

  private fun drainFocusUpdates() {
    while (!terminal.get()) {
      val desired = synchronized(lock) { desiredFocus }
      try {
        retryControl {
          val server = synchronized(lock) { serverSession }
            ?: throw T3VoiceNativeApiException("realtime-session-missing", retryable = true)
          executeCall { calls ->
            api.updateRealtimeFocus(
              calls,
              server.state.sessionId,
              server.state.leaseGeneration,
              desired.focus,
            )
          }
        }
      } catch (cause: Throwable) {
        if (!terminal.get()) {
          fail(cause, "realtime-focus-failed", "Realtime focus update failed.")
        }
        return
      }
      synchronized(lock) {
        if (desiredFocus.revision == desired.revision) {
          focusWorkerScheduled = false
          return
        }
      }
    }
  }

  private fun <T> retryControl(action: () -> T): T {
    var failureCount = 0
    while (true) {
      try {
        return action()
      } catch (cause: T3VoiceNativeApiException) {
        failureCount += 1
        if (!cause.retryable || failureCount >= MAXIMUM_CONTROL_FAILURES || terminal.get()) {
          throw cause
        }
        sleepControl(retryDelay(failureCount))
      }
    }
  }

  private fun <T> executeCall(block: (T3VoiceHttpCallRegistry) -> T): T {
    check(!terminal.get()) { "Realtime voice session stopped." }
    val calls = T3VoiceHttpCallRegistry()
    activeCalls += calls
    return try {
      block(calls)
    } finally {
      activeCalls -= calls
    }
  }

  private fun requireLivePhase(phase: String) {
    if (phase == "ended" || phase == "error") {
      throw T3VoiceNativeApiException("realtime-session-ended", retryable = true)
    }
  }

  private fun emitRoutes() {
    if (!terminal.get()) {
      emit(T3VoiceRuntimeCallback.RealtimeAudioRoutesChanged(audioRouter.routes()))
    }
  }

  private fun emitIfLive(callback: T3VoiceRuntimeCallback) {
    if (!terminal.get()) emit(callback)
  }

  private fun fail(cause: Throwable, fallbackCode: String, message: String) {
    if (!terminal.compareAndSet(false, true)) return
    val apiFailure = cause as? T3VoiceNativeApiException
    synchronized(lock) {
      terminalCallback =
        T3VoiceRuntimeCallback.Failed(
          T3VoiceFailure(
            code = safeFailureCode(apiFailure?.code, fallbackCode),
            message = message,
            recoverable = apiFailure?.retryable ?: true,
          ),
        )
    }
    beginTerminalCleanup()
  }

  /**
   * Cancels immediately but completes ownership only after synchronous startup has crossed its
   * install fence. The caller never waits for a non-interruptible WebRTC prepare call.
   */
  private fun beginTerminalCleanup() {
    if (!cleanupStarted.compareAndSet(false, true)) return
    val server = synchronized(lock) { serverSession }
    // Fence startup before abandoning process-global audio focus. cancelStartup is lock-only;
    // potentially blocking JNI peer disposal remains isolated on the terminal worker.
    runCatching { server?.let { webRtc.cancelStartup(it.state.sessionId) } }
    audioRouter.stop()
    cancelLiveWork()
    terminalDeadlineFuture =
      terminalDeadlineScheduler.schedule(
        ::publishBoundedTerminalFailure,
        terminalOutcomeDeadlineMs,
        TimeUnit.MILLISECONDS,
      )
    shutdownLiveExecutors()
    terminalExecutor.execute {
      startupQuiescence.awaitUninterruptibly()
      val publishedServer = synchronized(lock) { serverSession }
      runCatching { publishedServer?.let { webRtc.stop(it.state.sessionId) } }
      audioRouter.stop()
      if (publishedServer != null) bestEffortServerClose(publishedServer)
      terminalDeadlineFuture?.cancel(false)
      terminalDeadlineScheduler.shutdownNow()
      terminalExecutor.shutdown()
      completeTerminalCleanup()
    }
  }

  private fun completeTerminalCleanup() {
    val result =
      synchronized(lock) {
        if (!terminalCompleted.compareAndSet(false, true)) return
        T3VoiceRealtimeTerminalResult(
          callback = terminalCallback,
          publishedBeforeQuiescence = terminalPublished.get(),
        )
      }
    if (result.publishedBeforeQuiescence) terminalPublicationFinished.awaitUninterruptibly()
    onQuiesced(result)
  }

  private fun publishBoundedTerminalFailure() {
    val callback =
      synchronized(lock) {
        if (terminalCompleted.get() || terminalPublished.get()) return
        val existing = terminalCallback
        val bounded =
          when (existing) {
            is T3VoiceRuntimeCallback.Failed -> existing.copy(releasePending = true)
            T3VoiceRuntimeCallback.RealtimeClosed,
            null,
            ->
              T3VoiceRuntimeCallback.Failed(
                failure =
                  T3VoiceFailure(
                    code = "realtime-shutdown-timeout",
                    message = "Realtime shutdown is still draining native media.",
                    recoverable = true,
                  ),
                releasePending = true,
              )
            else -> error("Unsupported Realtime terminal callback.")
          }
        terminalCallback = bounded
        check(terminalPublished.compareAndSet(false, true)) {
          "Realtime terminal publication ownership changed."
        }
        bounded
      }
    try {
      emit(callback)
    } finally {
      terminalPublicationFinished.countDown()
    }
  }

  private fun cancelLiveWork() {
    synchronized(lock) {
      heartbeatFuture?.cancel(false)
      heartbeatFuture = null
    }
    activeCalls.forEach(T3VoiceHttpCallRegistry::cancelAll)
    actionExpirations.clear()
    confirmationExpirations.clear()
  }

  private fun bestEffortServerClose(server: T3VoiceApiRealtimeSession) {
    val calls = T3VoiceHttpCallRegistry()
    val timeoutScheduler = Executors.newSingleThreadScheduledExecutor()
    val timeout = timeoutScheduler.schedule(calls::cancelAll, CLOSE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    try {
      api.closeRealtimeSession(
        calls,
        server.state.sessionId,
        server.state.leaseGeneration,
      )
    } catch (_: Throwable) {
      // Local ownership is already released and the server lease will expire if close is unavailable.
    } finally {
      timeout.cancel(false)
      timeoutScheduler.shutdownNow()
    }
  }

  private fun shutdownLiveExecutors() {
    startupQuiescence.cancelBeforeRun()
    scheduler.shutdownNow()
    startupExecutor.shutdownNow()
    eventExecutor.shutdownNow()
    heartbeatExecutor.shutdownNow()
    focusExecutor.shutdownNow()
    acknowledgementExecutor.shutdownNow()
  }

  private fun sleepControl(delayMs: Long) {
    if (terminal.get()) return
    Thread.sleep(delayMs)
    check(!terminal.get()) { "Realtime voice session stopped." }
  }

  private fun retryDelay(failureCount: Int): Long =
    (INITIAL_RETRY_DELAY_MS shl (failureCount - 1)).coerceAtMost(MAXIMUM_RETRY_DELAY_MS)

  private companion object {
    const val MAXIMUM_CONTROL_FAILURES = 3
    const val INITIAL_RETRY_DELAY_MS = 250L
    const val MAXIMUM_RETRY_DELAY_MS = 2_000L
    const val CLOSE_TIMEOUT_MS = 5_000L
    const val MINIMUM_HEARTBEAT_INTERVAL_MS = 1_000L
    const val MAXIMUM_HEARTBEAT_INTERVAL_MS = 60_000L
    const val MAXIMUM_PUBLIC_TRANSCRIPT_TURNS = 100
    const val MAXIMUM_TRANSCRIPT_TURN_CHARS = 65_536
    const val DEFAULT_TERMINAL_OUTCOME_DEADLINE_MS = 5_000L
  }
}
