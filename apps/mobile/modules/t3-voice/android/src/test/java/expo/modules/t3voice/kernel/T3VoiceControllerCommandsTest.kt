package expo.modules.t3voice.kernel

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class T3VoiceControllerCommandsTest {
  @Test
  fun `controller commands remain detached without a bridge registration surface`() {
    val commands = T3VoiceControllerCommands()

    assertFalse(commands.isAttached())
    assertNull(commands.requestPrimary(3, microphonePermissionGranted = true))
    assertNull(commands.pending.value)
  }

  @Test
  fun `readiness invalidation remains safe while detached`() {
    val commands = T3VoiceControllerCommands()

    commands.invalidateReadiness()

    assertNull(commands.pending.value)
  }
}
