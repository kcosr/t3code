package expo.modules.t3voice

import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

internal enum class T3VoiceRuntimePhase {
  INACTIVE,
  IDLE,
  ARMING,
  RECORDING,
  PLAYING,
  REALTIME,
}

internal data class T3VoiceOperationOwner(
  val id: String,
  val generation: Long,
)

internal data class T3VoiceRuntimeState(
  val phase: T3VoiceRuntimePhase,
  val isForeground: Boolean,
  val activeRecordingId: String?,
  val activeRecordingGeneration: Long?,
  val activePlaybackId: String?,
  val activePlaybackGeneration: Long?,
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

  data class AudioRouteChanged(
    val nativeSessionId: String,
    val routeId: String,
    val routeType: String,
    val reason: String,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "nativeSessionId" to nativeSessionId,
        "routeId" to routeId,
        "routeType" to routeType,
        "reason" to reason,
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

  data class ThreadVoiceHandoff(
    val actionId: String,
    val projectId: String,
    val threadId: String,
    val recordingId: String,
    val autoRearm: Boolean,
    val environmentOrigin: String,
    val expiresAtEpochMillis: Long,
  ) : T3VoiceRuntimeEvent {
    override fun toEventBody(): Map<String, Any> =
      mapOf(
        "actionId" to actionId,
        "projectId" to projectId,
        "threadId" to threadId,
        "recordingId" to recordingId,
        "autoRearm" to autoRearm,
        "environmentOrigin" to environmentOrigin,
        "expiresAtEpochMillis" to expiresAtEpochMillis,
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
}

internal object T3VoiceStateStore {
  private val mutableState =
    MutableStateFlow(
      T3VoiceRuntimeState(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activeRecordingGeneration = null,
        activePlaybackId = null,
        activePlaybackGeneration = null,
        activeRealtimeSessionId = null,
        realtimeConnectionState = null,
        realtimeMuted = false,
        realtimeInputReady = false,
        sequence = 0,
      ),
    )
  private val mutableEvents = MutableSharedFlow<T3VoiceRuntimeEvent>(extraBufferCapacity = 64)
  private val nextOperationGeneration = AtomicLong(0)
  private val mutableRealtimeTermination =
    MutableStateFlow<T3VoiceRuntimeEvent.RealtimeTerminated?>(null)
  private val mutableRecordingTermination =
    MutableStateFlow<T3VoiceRuntimeEvent.RecordingTerminated?>(null)
  private val mutablePlaybackTermination =
    MutableStateFlow<T3VoiceRuntimeEvent.PlaybackTerminated?>(null)
  private val mutableThreadVoiceHandoff =
    MutableStateFlow<T3VoiceRuntimeEvent.ThreadVoiceHandoff?>(null)
  private val adoptedThreadVoiceHandoffRecordingIds = mutableSetOf<String>()

  val state: StateFlow<T3VoiceRuntimeState> = mutableState.asStateFlow()
  val events: SharedFlow<T3VoiceRuntimeEvent> = mutableEvents.asSharedFlow()
  val realtimeTermination: StateFlow<T3VoiceRuntimeEvent.RealtimeTerminated?> =
    mutableRealtimeTermination.asStateFlow()
  val recordingTermination: StateFlow<T3VoiceRuntimeEvent.RecordingTerminated?> =
    mutableRecordingTermination.asStateFlow()
  val playbackTermination: StateFlow<T3VoiceRuntimeEvent.PlaybackTerminated?> =
    mutablePlaybackTermination.asStateFlow()
  val threadVoiceHandoff: StateFlow<T3VoiceRuntimeEvent.ThreadVoiceHandoff?> =
    mutableThreadVoiceHandoff.asStateFlow()

  @Synchronized
  fun publishThreadVoiceHandoff(event: T3VoiceRuntimeEvent.ThreadVoiceHandoff) {
    adoptedThreadVoiceHandoffRecordingIds.remove(event.recordingId)
    mutableThreadVoiceHandoff.value = event
  }

  @Synchronized
  fun clearThreadVoiceHandoff(actionId: String) {
    val current = mutableThreadVoiceHandoff.value?.takeIf { it.actionId == actionId } ?: return
    adoptedThreadVoiceHandoffRecordingIds.remove(current.recordingId)
    mutableThreadVoiceHandoff.compareAndSet(current, null)
  }

  @Synchronized
  fun markThreadVoiceHandoffAdopted(actionId: String): Boolean {
    val current = mutableThreadVoiceHandoff.value?.takeIf { it.actionId == actionId } ?: return false
    adoptedThreadVoiceHandoffRecordingIds.add(current.recordingId)
    return true
  }

  @Synchronized
  fun isThreadVoiceHandoffAdopted(actionId: String): Boolean {
    val current = mutableThreadVoiceHandoff.value?.takeIf { it.actionId == actionId } ?: return false
    return current.recordingId in adoptedThreadVoiceHandoffRecordingIds
  }

  @Synchronized
  fun isThreadVoiceHandoffRecordingProtected(recordingId: String): Boolean {
    return mutableThreadVoiceHandoff.value?.recordingId == recordingId ||
      recordingId in adoptedThreadVoiceHandoffRecordingIds
  }

  @Synchronized
  fun pendingThreadVoiceHandoff(): T3VoiceRuntimeEvent.ThreadVoiceHandoff? {
    val current = mutableThreadVoiceHandoff.value ?: return null
    val recordingStillAdoptable =
      mutableState.value.activeRecordingId == current.recordingId ||
        mutableRecordingTermination.value?.recordingId == current.recordingId
    if (recordingStillAdoptable) return current
    adoptedThreadVoiceHandoffRecordingIds.remove(current.recordingId)
    mutableThreadVoiceHandoff.compareAndSet(current, null)
    return null
  }

  fun claimRealtime(sessionId: String): Boolean {
    while (true) {
      val current = mutableState.value
      if (current.phase != T3VoiceRuntimePhase.IDLE) return false
      val next =
        current.copy(
          phase = T3VoiceRuntimePhase.REALTIME,
          activeRecordingId = null,
          activeRecordingGeneration = null,
          activePlaybackId = null,
          activePlaybackGeneration = null,
          activeRealtimeSessionId = sessionId,
          realtimeConnectionState = "preparing",
          realtimeMuted = false,
          realtimeInputReady = false,
          sequence = current.sequence + 1,
        )
      if (mutableState.compareAndSet(current, next)) {
        mutableRealtimeTermination.value = null
        return true
      }
    }
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
        activeRecordingGeneration = null,
        activePlaybackId = null,
        activePlaybackGeneration = null,
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
  fun claimRecording(recordingId: String): T3VoiceOperationOwner? {
    if (mutableRecordingTermination.value != null) return null
    val owner = T3VoiceOperationOwner(recordingId, nextOperationGeneration.incrementAndGet())
    return owner.takeIf {
      claimIdle {
        it.copy(
          phase = T3VoiceRuntimePhase.ARMING,
          activeRecordingId = recordingId,
          activeRecordingGeneration = owner.generation,
          activePlaybackId = null,
          activePlaybackGeneration = null,
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
      T3VoiceRuntimeState::activeRecordingGeneration,
    ) {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activeRecordingId = null,
        activeRecordingGeneration = null,
      )
    }

  fun markRecordingStarted(owner: T3VoiceOperationOwner): Boolean =
    updateIfOperationOwner(
      owner,
      T3VoiceRuntimeState::activeRecordingId,
      T3VoiceRuntimeState::activeRecordingGeneration,
    ) {
      it.copy(phase = T3VoiceRuntimePhase.RECORDING)
    }

  @Synchronized
  fun terminateRecording(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.RecordingTerminated,
  ): Boolean {
    val terminated = releaseRecording(owner)
    if (terminated) mutableRecordingTermination.value = event
    return terminated
  }

  @Synchronized
  fun clearRecordingTermination(recordingId: String) {
    mutableRecordingTermination.compareAndSet(
      mutableRecordingTermination.value?.takeIf { it.recordingId == recordingId },
      null,
    )
    val handoff = mutableThreadVoiceHandoff.value?.takeIf { it.recordingId == recordingId }
    if (handoff != null) mutableThreadVoiceHandoff.compareAndSet(handoff, null)
    adoptedThreadVoiceHandoffRecordingIds.remove(recordingId)
  }

  @Synchronized
  fun claimPlayback(playbackId: String): T3VoiceOperationOwner? {
    if (mutablePlaybackTermination.value != null) return null
    val owner = T3VoiceOperationOwner(playbackId, nextOperationGeneration.incrementAndGet())
    return owner.takeIf {
      claimIdle {
        it.copy(
          phase = T3VoiceRuntimePhase.PLAYING,
          activeRecordingId = null,
          activeRecordingGeneration = null,
          activePlaybackId = playbackId,
          activePlaybackGeneration = owner.generation,
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
      T3VoiceRuntimeState::activePlaybackGeneration,
    ) {
      it.copy(
        phase = T3VoiceRuntimePhase.IDLE,
        activePlaybackId = null,
        activePlaybackGeneration = null,
      )
    }

  @Synchronized
  fun terminatePlayback(
    owner: T3VoiceOperationOwner,
    event: T3VoiceRuntimeEvent.PlaybackTerminated,
  ): Boolean {
    val terminated = releasePlayback(owner)
    if (terminated) mutablePlaybackTermination.value = event
    return terminated
  }

  fun clearPlaybackTermination(playbackId: String) {
    mutablePlaybackTermination.compareAndSet(
      mutablePlaybackTermination.value?.takeIf { it.playbackId == playbackId },
      null,
    )
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
        activeRecordingGeneration = null,
        activePlaybackId = null,
        activePlaybackGeneration = null,
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
    if (terminated) mutableRealtimeTermination.value = event
    return terminated
  }

  fun setInactive() {
    update {
      it.copy(
        phase = T3VoiceRuntimePhase.INACTIVE,
        isForeground = false,
        activeRecordingId = null,
        activeRecordingGeneration = null,
        activePlaybackId = null,
        activePlaybackGeneration = null,
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
    mutableState.update { current ->
      val next = transform(current)
      if (next == current) current else next.copy(sequence = current.sequence + 1)
    }
  }

  private fun updateIfRealtimeOwner(
    sessionId: String,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    return updateIfOwner(sessionId, T3VoiceRuntimeState::activeRealtimeSessionId, transform)
  }

  private fun claimIdle(transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState): Boolean {
    while (true) {
      val current = mutableState.value
      if (current.phase != T3VoiceRuntimePhase.IDLE) return false
      val transformed = transform(current)
      val next = transformed.copy(sequence = current.sequence + 1)
      if (mutableState.compareAndSet(current, next)) return true
    }
  }

  private fun updateIfOwner(
    ownerId: String,
    selectedOwner: (T3VoiceRuntimeState) -> String?,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    while (true) {
      val current = mutableState.value
      if (selectedOwner(current) != ownerId) return false
      val transformed = transform(current)
      val next = if (transformed == current) current else transformed.copy(sequence = current.sequence + 1)
      if (next == current || mutableState.compareAndSet(current, next)) return true
    }
  }

  private fun updateIfOperationOwner(
    owner: T3VoiceOperationOwner,
    selectedId: (T3VoiceRuntimeState) -> String?,
    selectedGeneration: (T3VoiceRuntimeState) -> Long?,
    transform: (T3VoiceRuntimeState) -> T3VoiceRuntimeState,
  ): Boolean {
    while (true) {
      val current = mutableState.value
      if (selectedId(current) != owner.id || selectedGeneration(current) != owner.generation) {
        return false
      }
      val transformed = transform(current)
      val next = if (transformed == current) current else transformed.copy(sequence = current.sequence + 1)
      if (next == current || mutableState.compareAndSet(current, next)) return true
    }
  }
}
