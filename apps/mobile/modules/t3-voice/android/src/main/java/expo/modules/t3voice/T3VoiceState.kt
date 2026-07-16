package expo.modules.t3voice

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow

internal enum class T3VoiceRuntimePhase {
  INACTIVE,
  IDLE,
  ARMING,
  RECORDING,
  PLAYING,
  REALTIME,
}

internal enum class T3VoiceOperationOwnerDomain {
  COMPOSER_DICTATION,
  MANUAL_PLAYBACK,
  THREAD_MODE,
  CUE,
}

internal data class T3VoiceOperationOwner(
  val id: String,
  val domain: T3VoiceOperationOwnerDomain,
  val operationId: String,
)

internal data class T3VoiceRuntimeState(
  val phase: T3VoiceRuntimePhase,
  val isForeground: Boolean,
  val activeRecordingId: String?,
  val activePlaybackId: String?,
  val activeRealtimeSessionId: String?,
  val realtimeConnectionState: String?,
  val realtimeMuted: Boolean,
  val realtimeInputReady: Boolean,
  val sequence: Long,
) {
  fun toEventBody(): Map<String, Any?> =
    mapOf(
      "phase" to phase.name.lowercase(),
      "isForeground" to isForeground,
      "activeRecordingId" to activeRecordingId,
      "activePlaybackId" to activePlaybackId,
      "activeRealtimeSessionId" to activeRealtimeSessionId,
      "realtimeConnectionState" to realtimeConnectionState,
      "realtimeMuted" to realtimeMuted,
      "realtimeInputReady" to realtimeInputReady,
      "sequence" to sequence.toDouble(),
    )
}

internal sealed interface T3VoiceRuntimeEvent {
  fun toEventBody(): Map<String, Any?>

  data class PlaybackChunkConsumed(
    val playbackId: String,
    val chunkIndex: Int,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "playbackId" to playbackId,
        "chunkIndex" to chunkIndex,
      )
  }

  data class PlaybackTerminated(
    val playbackId: String,
    val outcome: String,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "playbackId" to playbackId,
        "outcome" to outcome,
      )
  }

  data class RecordingTerminated(
    val recordingId: String,
    val recording: T3VoiceRecordingResult?,
    val outcome: String,
    val reason: String,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any?> =
      mapOf(
        "recordingId" to recordingId,
        "recording" to recording?.toResultBody(),
        "outcome" to outcome,
        "reason" to reason,
      )
  }

  data class CompletionWake(
    val ownerDomain: T3VoiceOperationOwnerDomain,
    val operationId: String,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "ownerDomain" to ownerDomain.name,
        "operationId" to operationId,
      )
  }

  data class RuntimeError(
    val operation: String,
    val code: String,
    val message: String,
    val recoverable: Boolean,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "operation" to operation,
        "code" to code,
        "message" to message,
        "recoverable" to recoverable,
      )
  }

  data class RealtimeTerminated(
    val nativeSessionId: String,
    val outcome: String,
    val code: String,
    val retryable: Boolean,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "nativeSessionId" to nativeSessionId,
        "outcome" to outcome,
        "code" to code,
        "retryable" to retryable,
      )
  }

  data class ReadinessDisabled(
    val readinessGeneration: Long,
    val reason: String,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "readinessGeneration" to readinessGeneration.toDouble(),
        "reason" to reason,
      )
  }

  data class VoiceRuntimeWake(
    val runtimeId: String,
    val runtimeInstanceId: String,
    val generation: Long,
    val sequence: Long,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> = mapOf(
      "runtimeId" to runtimeId,
      "runtimeInstanceId" to runtimeInstanceId,
      "generation" to generation.toDouble(),
      "sequence" to sequence.toDouble(),
    )
  }
}

internal data class T3VoiceRecordingCompletion(
  val owner: T3VoiceOperationOwner,
  val terminal: T3VoiceRuntimeEvent.RecordingTerminated,
) {
  fun toEventBody(): Map<String, Any?> = terminal.toEventBody() + mapOf(
    "ownerDomain" to owner.domain.name,
    "operationId" to owner.operationId,
  )
}

internal data class T3VoicePlaybackCompletion(
  val owner: T3VoiceOperationOwner,
  val terminal: T3VoiceRuntimeEvent.PlaybackTerminated,
) {
  fun toEventBody(): Map<String, Any> = terminal.toEventBody() + mapOf(
    "ownerDomain" to owner.domain.name,
    "operationId" to owner.operationId,
  )
}

internal object T3VoiceBridgeCompletionStore {
  private val recordings =
    linkedMapOf<Pair<T3VoiceOperationOwnerDomain, String>, T3VoiceRecordingCompletion>()
  private val playbacks =
    linkedMapOf<Pair<T3VoiceOperationOwnerDomain, String>, T3VoicePlaybackCompletion>()

  @Synchronized
  fun putRecording(
    owner: T3VoiceOperationOwner,
    terminal: T3VoiceRuntimeEvent.RecordingTerminated,
  ) {
    recordings[owner.domain to owner.operationId] = T3VoiceRecordingCompletion(owner, terminal)
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.CompletionWake(owner.domain, owner.operationId))
  }

  @Synchronized
  fun putPlayback(
    owner: T3VoiceOperationOwner,
    terminal: T3VoiceRuntimeEvent.PlaybackTerminated,
  ) {
    playbacks[owner.domain to owner.operationId] = T3VoicePlaybackCompletion(owner, terminal)
    T3VoiceStateStore.emit(T3VoiceRuntimeEvent.CompletionWake(owner.domain, owner.operationId))
  }

  @Synchronized
  fun pendingRecordings(domain: T3VoiceOperationOwnerDomain) =
    recordings.values.filter { it.owner.domain == domain }
  @Synchronized
  fun pendingPlaybacks(domain: T3VoiceOperationOwnerDomain) =
    playbacks.values.filter { it.owner.domain == domain }
  @Synchronized
  fun recordingById(recordingId: String) =
    recordings.values.firstOrNull { it.terminal.recordingId == recordingId }

  @Synchronized
  fun hasRecording(domain: T3VoiceOperationOwnerDomain) = recordings.keys.any { it.first == domain }

  @Synchronized
  fun hasPlayback(domain: T3VoiceOperationOwnerDomain) = playbacks.keys.any { it.first == domain }

  @Synchronized
  fun acknowledgeRecording(domain: T3VoiceOperationOwnerDomain, operationId: String) =
    recordings.remove(domain to operationId)

  @Synchronized
  fun acknowledgePlayback(domain: T3VoiceOperationOwnerDomain, operationId: String) =
    playbacks.remove(domain to operationId)
}

internal object T3VoiceBridgeCompletionActions {
  fun acknowledgeRecording(operationId: String) {
    T3VoiceBridgeCompletionStore.acknowledgeRecording(
      T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
      operationId,
    )
  }

  fun discardRecording(
    operationId: String,
    deleteRecording: (recordingId: String, uri: String) -> Unit,
  ): Boolean {
    val completion = T3VoiceBridgeCompletionStore.pendingRecordings(
      T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
    ).firstOrNull { it.owner.operationId == operationId } ?: return false
    completion.terminal.recording?.let { recording ->
      deleteRecording(completion.terminal.recordingId, recording.uri)
    }
    T3VoiceBridgeCompletionStore.acknowledgeRecording(
      completion.owner.domain,
      completion.owner.operationId,
    )
    return true
  }
}

internal fun restoreBridgeRecordingCompletions(
  restoreCompleted: (T3VoiceRecordingResult) -> Unit,
  sweepStaleCache: () -> Unit,
) {
  T3VoiceBridgeCompletionStore.pendingRecordings(
    T3VoiceOperationOwnerDomain.COMPOSER_DICTATION,
  ).mapNotNull { it.terminal.recording }.forEach(restoreCompleted)
  sweepStaleCache()
}

internal object T3VoiceStateStore {
  private val mutableState =
    MutableStateFlow(
      T3VoiceRuntimeState(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        realtimeInputReady = false,
        sequence = 0,
      ),
    )
  private val mutableEvents = MutableSharedFlow<T3VoiceRuntimeEvent>(extraBufferCapacity = 64)
  val state: StateFlow<T3VoiceRuntimeState> = mutableState.asStateFlow()
  val events: SharedFlow<T3VoiceRuntimeEvent> = mutableEvents.asSharedFlow()
  fun claimRealtime(sessionId: String): Boolean {
    val current = mutableState.value
    if (current.phase != T3VoiceRuntimePhase.IDLE) return false
    mutableState.value =
      current.copy(
          phase = T3VoiceRuntimePhase.REALTIME,
          activeRecordingId = null,
          activePlaybackId = null,
          activeRealtimeSessionId = sessionId,
          realtimeConnectionState = "preparing",
          realtimeMuted = false,
          realtimeInputReady = false,
          sequence = current.sequence + 1,
        )
    return true
  }

  fun releaseRealtimeClaim(sessionId: String) {
    updateIfRealtimeOwner(sessionId) {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        realtimeInputReady = false,
      )
    }
  }

  fun setServiceReady() {
    update {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        realtimeInputReady = false,
      )
    }
  }

  fun setForeground(isForeground: Boolean) {
    update { it.copy(isForeground = isForeground) }
  }

  @Synchronized
  fun claimRecording(
    recordingId: String,
    domain: T3VoiceOperationOwnerDomain,
    operationId: String,
  ): T3VoiceOperationOwner? {
    if (domain == T3VoiceOperationOwnerDomain.COMPOSER_DICTATION &&
      T3VoiceBridgeCompletionStore.hasRecording(domain)) return null
    val owner = T3VoiceOperationOwner(
      recordingId,
      domain,
      operationId,
    )
    return owner.takeIf {
      claimIdle {
        it.copy(
          phase = T3VoiceRuntimePhase.ARMING,
          activeRecordingId = recordingId,
          activePlaybackId = null,
          activeRealtimeSessionId = null,
          realtimeConnectionState = null,
          realtimeMuted = false,
          realtimeInputReady = false,
        )
      }
    }
  }

  fun releaseRecording(owner: T3VoiceOperationOwner): Boolean =
    updateIfOperationOwner(
      owner,
      T3VoiceRuntimeState::activeRecordingId,
    ) {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activeRecordingId = null,
      )
    }

  fun markRecordingStarted(owner: T3VoiceOperationOwner): Boolean =
    updateIfOperationOwner(
      owner,
      T3VoiceRuntimeState::activeRecordingId,
    ) {
      it.copy(phase = T3VoiceRuntimePhase.RECORDING)
    }

  @Synchronized
  fun terminateRecording(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
  ): Boolean {
    val terminated = releaseRecording(owner)
    if (terminated) {
      when (owner.domain) {
        T3VoiceOperationOwnerDomain.COMPOSER_DICTATION -> T3VoiceBridgeCompletionStore.putRecording(owner, event)
        else -> Unit
      }
    }
    return terminated
  }

  @Synchronized
  fun claimPlayback(
    playbackId: String,
    domain: T3VoiceOperationOwnerDomain,
    operationId: String,
  ): T3VoiceOperationOwner? {
    if (domain == T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK &&
      T3VoiceBridgeCompletionStore.hasPlayback(domain)) return null
    val owner = T3VoiceOperationOwner(
      playbackId,
      domain,
      operationId,
    )
    return owner.takeIf {
      claimIdle {
        it.copy(
          phase = T3VoiceRuntimePhase.PLAYING,
          activeRecordingId = null,
          activePlaybackId = playbackId,
          activeRealtimeSessionId = null,
          realtimeConnectionState = null,
          realtimeMuted = false,
          realtimeInputReady = false,
        )
      }
    }
  }

  fun releasePlayback(owner: T3VoiceOperationOwner): Boolean =
    updateIfOperationOwner(
      owner,
      T3VoiceRuntimeState::activePlaybackId,
    ) {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activePlaybackId = null,
      )
    }

  @Synchronized
  fun terminatePlayback(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.PlaybackTerminated,
  ): Boolean {
    val terminated = releasePlayback(owner)
    if (terminated && owner.domain == T3VoiceOperationOwnerDomain.MANUAL_PLAYBACK) {
      T3VoiceBridgeCompletionStore.putPlayback(owner, event)
    }
    return terminated
  }

  fun setRealtime(
    sessionId: String,
    connectionState: String,
    muted: Boolean,
    inputReady: Boolean,
  ) {
    updateIfRealtimeOwner(sessionId) {
      it.copy(
        phase = T3VoiceRuntimePhase.REALTIME,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = sessionId,
        realtimeConnectionState = connectionState,
        realtimeMuted = muted,
        realtimeInputReady = inputReady,
      )
    }
  }

  fun terminateRealtime(event: T3VoiceRuntimeEvent.RealtimeTerminated): Boolean {
    val connectionState = if (event.outcome == "ended") "closed" else "failed"
    val terminated =
      updateIfRealtimeOwner(event.nativeSessionId) {
        it.copy(
          phase = T3VoiceRuntimePhase.IDLE,
          activeRealtimeSessionId = null,
          realtimeConnectionState = connectionState,
          realtimeMuted = false,
          realtimeInputReady = false,
        )
      }
    return terminated
  }

  fun setInactive() {
    update {
      it.copy(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activePlaybackId = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        realtimeInputReady = false,
      )
    }
  }

  fun emit(event: T3VoiceRuntimeEvent) {
    mutableEvents.tryEmit(event)
  }

  private fun update(transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState) {
    val current = mutableState.value
    val next = transform(current)
    mutableState.value = if (next == current) current else next.copy(sequence = current.sequence + 1)
  }

  private fun updateIfRealtimeOwner(
    sessionId: String,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    return updateIfOwner(sessionId, T3VoiceRuntimeState::activeRealtimeSessionId, transform)
  }

  private fun claimIdle(transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState): Boolean {
    val current = mutableState.value
    if (current.phase != T3VoiceRuntimePhase.IDLE) return false
    mutableState.value = transform(current).copy(sequence = current.sequence + 1)
    return true
  }

  private fun updateIfOwner(
    ownerId: String,
    selectedOwner: (T3VoiceRuntimeState) -> String?,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    val current = mutableState.value
    if (selectedOwner(current) != ownerId) return false
    val transformed = transform(current)
    mutableState.value =
      if (transformed == current) current else transformed.copy(sequence = current.sequence + 1)
    return true
  }

  private fun updateIfOperationOwner(
    owner: T3VoiceOperationOwner,
    selectedId: (T3VoiceRuntimeState) -> String?,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    val current = mutableState.value
    if (selectedId(current) != owner.id) return false
    val transformed = transform(current)
    mutableState.value =
      if (transformed == current) current else transformed.copy(sequence = current.sequence + 1)
    return true
  }
}
