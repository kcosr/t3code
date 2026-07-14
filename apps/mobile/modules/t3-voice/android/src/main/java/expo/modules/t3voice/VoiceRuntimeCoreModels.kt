package expo.modules.t3voice

internal data class VoiceRuntimeIdentity(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val generation: Long,
)

internal data class VoiceRuntimeCursor(
  val runtimeId: String,
  val runtimeInstanceId: String,
  val generation: Long,
  val sequence: Long,
)

internal enum class VoiceRuntimeAvailability { UNAVAILABLE, LOCKED, READY }
internal enum class VoiceRuntimePresentation { FOREGROUND_ACTIVE, VISIBLE_INACTIVE, BACKGROUND }
internal enum class VoiceRuntimeElection { ELECTED, STANDBY }
internal enum class VoiceRuntimeMode { REALTIME, THREAD }

internal data class VoiceRuntimePresentationElection(
  val electedLeaseId: String?,
  val electedAttachOrdinal: Long?,
  val eligibleConsumerCount: Int,
  val changedAtEpochMillis: Long,
)

internal sealed interface VoiceRuntimeTarget {
  data class Realtime(val environmentId: String, val conversationId: String) : VoiceRuntimeTarget
  data class Thread(
    val environmentId: String,
    val projectId: String,
    val threadId: String,
    val speechPreset: String,
    val autoRearm: Boolean,
    val endSilenceMs: Long,
    val noSpeechTimeoutMs: Long?,
    val maximumUtteranceMs: Long,
    val speechEnabled: Boolean,
    val rearmGuardMs: Long,
  ) : VoiceRuntimeTarget
}

internal enum class VoiceRealtimePhase {
  PREPARING, NEGOTIATING, CUEING, CONNECTED, DRAINING, STOPPING, RETRYING, RECOVERING,
  COMPLETED, FAILED, CANCELLED,
}

internal enum class VoiceThreadOrdinaryPhase {
  ARMING, RECORDING, FINALIZING, UPLOADING, TRANSCRIBING, DISPATCHING, WAITING, PLAYING,
  PLAYBACK_DRAINED, GUARDING, REARMING, DRAFT_READY, RETRYING, RECOVERING, COMPLETED, FAILED,
  CANCELLED,
}

internal sealed interface VoiceThreadPhase {
  data class Ordinary(val phase: VoiceThreadOrdinaryPhase) : VoiceThreadPhase
  data class Paused(val reason: Reason) : VoiceThreadPhase {
    enum class Reason { USER, AUTHORITY, NETWORK }
  }
  data class AttentionRequired(val reason: Reason) : VoiceThreadPhase {
    enum class Reason { APPROVAL, USER_INPUT, INACCESSIBLE_TARGET, DRAFT_REVIEW, LOCAL_RETENTION }
  }
}

internal sealed interface VoiceRuntimeOperation {
  data object None : VoiceRuntimeOperation
  data class Realtime(
    val modeSessionId: String,
    val phase: VoiceRealtimePhase,
    val conversationId: String,
    val sessionId: String?,
    val muted: Boolean,
  ) : VoiceRuntimeOperation
  data class ThreadTurn(
    val modeSessionId: String,
    val phase: VoiceThreadPhase,
    val turnClientOperationId: String?,
    val turnOperationId: String?,
  ) : VoiceRuntimeOperation
}

internal sealed interface VoiceRuntimeMediaOwner {
  data object None : VoiceRuntimeMediaOwner
  data class Recorder(val owner: String, val operationId: String) : VoiceRuntimeMediaOwner
  data class Player(val owner: String, val operationId: String) : VoiceRuntimeMediaOwner
  data class RealtimePeer(val modeSessionId: String) : VoiceRuntimeMediaOwner
  data class Cue(val operationId: String) : VoiceRuntimeMediaOwner
}

internal sealed interface VoiceRuntimeReadiness {
  data object Disabled : VoiceRuntimeReadiness
  data class Ready(val mode: VoiceRuntimeMode) : VoiceRuntimeReadiness
  data class Active(val mode: VoiceRuntimeMode) : VoiceRuntimeReadiness
}

internal data class VoiceRuntimeSnapshot(
  val identity: VoiceRuntimeIdentity,
  val sequence: Long,
  val availability: VoiceRuntimeAvailability,
  val target: VoiceRuntimeTarget?,
  val operation: VoiceRuntimeOperation,
  val mediaOwner: VoiceRuntimeMediaOwner,
  val readiness: VoiceRuntimeReadiness,
  val inputRouteId: String?,
  val outputRouteId: String?,
  val failureCode: String?,
) {
  fun cursor() = VoiceRuntimeCursor(
    identity.runtimeId,
    identity.runtimeInstanceId,
    identity.generation,
    sequence,
  )
}

internal data class VoiceRuntimeEvent(
  val cursor: VoiceRuntimeCursor,
  val kind: String,
  val rootOperationId: String?,
  val causedByCommandId: String?,
  val occurredAtEpochMillis: Long = 0,
  val snapshot: VoiceRuntimeSnapshot? = null,
  val commandReceipt: VoiceRuntimeCommandReceipt? = null,
  val threadReceipt: VoiceRuntimeThreadReceipt? = null,
  val realtimeTerminalSummary: VoiceRuntimeRealtimeTerminalSummary? = null,
  val draftArtifact: VoiceRuntimeDraftHandle? = null,
  val presentationAction: VoiceRuntimePresentationAction? = null,
  val presentationElection: VoiceRuntimePresentationElection? = null,
)

internal data class VoiceRuntimeCommandReceipt(
  val commandId: String,
  val modeSessionId: String,
  val turnClientOperationId: String?,
  val replayed: Boolean,
  val outcome: VoiceRuntimeCommandOutcome,
  val cursor: VoiceRuntimeCursor,
)

internal sealed interface VoiceRuntimeRetainedRecordKey {
  val identity: VoiceRuntimeIdentity
  val modeSessionId: String

  data class ThreadReceipt(
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
    val turnClientOperationId: String,
  ) : VoiceRuntimeRetainedRecordKey

  data class RealtimeTerminal(
    override val identity: VoiceRuntimeIdentity,
    override val modeSessionId: String,
  ) : VoiceRuntimeRetainedRecordKey
}

internal sealed interface VoiceRuntimeCommandOutcome {
  data object Accepted : VoiceRuntimeCommandOutcome
  data class Rejected(val reason: String) : VoiceRuntimeCommandOutcome
  data class RebaseRequired(val rebase: VoiceRuntimeDelivery.Rebase) : VoiceRuntimeCommandOutcome
}

internal enum class VoiceRuntimeRebaseReason {
  CURSOR_TOO_OLD,
  RUNTIME_REPLACED,
  GENERATION_CHANGED,
}

internal sealed interface VoiceRuntimeDelivery {
  data class Events(val events: List<VoiceRuntimeEvent>) : VoiceRuntimeDelivery
  data class Rebase(
    val reason: VoiceRuntimeRebaseReason,
    val cursor: VoiceRuntimeCursor,
    val snapshot: VoiceRuntimeSnapshot,
    val threadReceipts: List<VoiceRuntimeThreadReceipt> = emptyList(),
    val realtimeTerminalSummaries: List<VoiceRuntimeRealtimeTerminalSummary> = emptyList(),
    val draftArtifacts: List<VoiceRuntimeDraftHandle> = emptyList(),
    val presentationActions: List<VoiceRuntimePresentationAction> = emptyList(),
  ) : VoiceRuntimeDelivery
}

internal class VoiceRuntimeFenceException(message: String) : IllegalStateException(message)
internal class VoiceRuntimeIdempotencyConflictException : IllegalStateException("Idempotency conflict.")
internal class VoiceRuntimeNotElectedException : IllegalStateException("Consumer is not elected.")
internal class VoiceRuntimeExpiredException : IllegalStateException("Resource expired.")
internal class VoiceRuntimeRetentionCapacityException(recordKind: String, capacity: Int) :
  IllegalStateException("Voice runtime $recordKind retention capacity $capacity is full.")
