package expo.modules.t3voice.kernel

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceKernelHostIntentActionTest {
  @Test
  fun mediaControlCommandsMapToHostIntentActions() {
    assertEquals(
      VoiceKernelHostIntentAction.ACTION_PRIMARY,
      T3VoiceControlCommand.PRIMARY.toVoiceKernelHostIntentAction(),
    )
    assertEquals(
      VoiceKernelHostIntentAction.ACTION_STOP,
      T3VoiceControlCommand.STOP.toVoiceKernelHostIntentAction(),
    )
    assertEquals(
      VoiceKernelHostIntentAction.ACTION_TOGGLE_MUTE,
      T3VoiceControlCommand.TOGGLE_MUTE.toVoiceKernelHostIntentAction(),
    )
  }
}
