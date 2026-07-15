package expo.modules.t3voice

internal class VoiceRuntimeRealtimeBinderOffload(
  private val startPost: (Runnable) -> Unit,
  private val controlPost: (Runnable) -> Unit,
) {
  fun submitStart(body: () -> Unit): VoiceRuntimeRealtimeCommandResult.Accepted {
    startPost(Runnable(body))
    return admittedResult()
  }

  fun submitControl(body: () -> Unit): VoiceRuntimeRealtimeCommandResult.Accepted {
    controlPost(Runnable(body))
    return admittedResult()
  }

  private fun admittedResult() = VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false)
}
