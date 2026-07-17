package expo.modules.t3voice

internal object T3VoiceRuntimeLifecyclePolicy {
  fun needsForeground(state: T3VoiceControllerState): Boolean =
    state !is T3VoiceControllerState.Idle

  fun shouldHoldWakeLock(state: T3VoiceControllerState): Boolean =
    state !is T3VoiceControllerState.Idle && state !is T3VoiceControllerState.Failed
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
    serviceCompletelyIdle: Boolean,
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
      serviceCompletelyIdle -> T3VoiceSemanticStartIntentDecision.STOP_IDLE_SERVICE
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
