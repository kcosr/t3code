package expo.modules.t3voice

internal object T3VoiceRuntimeLifecyclePolicy {
  fun needsForeground(state: T3VoiceControllerState): Boolean =
    state !is T3VoiceControllerState.Idle

  fun shouldHoldWakeLock(state: T3VoiceControllerState): Boolean =
    state !is T3VoiceControllerState.Idle && state !is T3VoiceControllerState.Failed
}

internal object T3VoiceServiceOwnershipPolicy {
  fun canStop(
    operationIdle: Boolean,
    readiness: T3VoiceReadinessSnapshot,
  ): Boolean = operationIdle && !readiness.retainsService()
}

internal data class T3VoiceReadinessLaunch(
  val operationGeneration: Long,
  val readinessGeneration: Long,
)

internal enum class T3VoiceReadinessFailureDisposition {
  NONE,
  NEEDS_REFRESH,
  UNAVAILABLE,
}

internal object T3VoiceReadinessFailurePolicy {
  fun disposition(
    snapshot: T3VoiceControllerSnapshot,
    readiness: T3VoiceReadinessSnapshot,
    launch: T3VoiceReadinessLaunch?,
  ): T3VoiceReadinessFailureDisposition {
    val failed = snapshot.state as? T3VoiceControllerState.Failed
      ?: return T3VoiceReadinessFailureDisposition.NONE
    if (
      launch == null ||
      launch.operationGeneration != snapshot.generation ||
      launch.readinessGeneration != readiness.generation
    ) {
      return T3VoiceReadinessFailureDisposition.NONE
    }
    return when (failed.operation) {
      T3VoiceOperation.REALTIME ->
        when (failed.failure.code) {
          "native-session-expired",
          "takeover-required",
          "voice_conversation_not_found",
          -> T3VoiceReadinessFailureDisposition.NEEDS_REFRESH
          else -> T3VoiceReadinessFailureDisposition.NONE
        }
      T3VoiceOperation.THREAD ->
        when (failed.failure.code) {
          "native-session-expired" -> T3VoiceReadinessFailureDisposition.NEEDS_REFRESH
          "thread_not_found" -> T3VoiceReadinessFailureDisposition.UNAVAILABLE
          else -> T3VoiceReadinessFailureDisposition.NONE
        }
      T3VoiceOperation.SWITCHING_TO_THREAD,
      T3VoiceOperation.SWITCHING_TO_REALTIME,
      -> T3VoiceReadinessFailureDisposition.NONE
    }
  }
}

internal object T3VoiceRuntimeAdmissionPolicy {
  fun canStartSemantic(hasLegacyMediaOwner: Boolean): Boolean = !hasLegacyMediaOwner

  fun canStartLegacy(semanticState: T3VoiceControllerState): Boolean =
    !semanticState.needsForeground()
}

internal enum class T3VoiceSemanticStartIntentDecision {
  ACTIVATE,
  IGNORE_STALE,
  STOP_IDLE_SERVICE,
}

internal object T3VoiceSemanticStartIntentPolicy {
  fun decide(
    requestedGeneration: Long,
    snapshot: T3VoiceControllerSnapshot,
    serviceCanStop: Boolean,
  ): T3VoiceSemanticStartIntentDecision {
    val matchingStart =
      requestedGeneration == snapshot.generation &&
        when (val state = snapshot.state) {
          is T3VoiceControllerState.Realtime -> state.stage == T3VoiceRealtimeStage.STARTING
          is T3VoiceControllerState.Thread -> state.stage == T3VoiceThreadStage.STARTING
          else -> false
        }
    return when {
      matchingStart -> T3VoiceSemanticStartIntentDecision.ACTIVATE
      serviceCanStop -> T3VoiceSemanticStartIntentDecision.STOP_IDLE_SERVICE
      else -> T3VoiceSemanticStartIntentDecision.IGNORE_STALE
    }
  }
}

internal enum class T3VoiceSemanticStartFailureDecision {
  RETAIN_FOREGROUND_FAILURE,
  STOP_UNPROMOTED_START,
}

internal object T3VoiceSemanticStartFailurePolicy {
  fun decide(foregroundAcquired: Boolean): T3VoiceSemanticStartFailureDecision =
    if (foregroundAcquired) {
      T3VoiceSemanticStartFailureDecision.RETAIN_FOREGROUND_FAILURE
    } else {
      T3VoiceSemanticStartFailureDecision.STOP_UNPROMOTED_START
    }
}

internal fun T3VoiceControllerState.needsForeground(): Boolean =
  T3VoiceRuntimeLifecyclePolicy.needsForeground(this)
