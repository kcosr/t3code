package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceControllerCommandsTest {
  @Test
  fun `command is replayed until matching generation completes it`() {
    val commands = T3VoiceControllerCommands()
    commands.register(7)
    val first = commands.requestPrimary(11, microphonePermissionGranted = true)!!
    assertEquals(first, commands.requestPrimary(11, microphonePermissionGranted = true))
    assertFalse(commands.complete(first.commandId, 6, "success"))
    assertEquals(first, commands.pending.value)
    assertTrue(commands.complete(first.commandId, 7, "failure"))
    assertNull(commands.pending.value)
  }

  @Test
  fun `stale unregister cannot detach current controller`() {
    val commands = T3VoiceControllerCommands()
    commands.register(4)
    commands.register(5)
    commands.unregister(4)
    assertTrue(commands.isAttached())
  }

  @Test
  fun `lower opaque generation replaces dead higher generation`() {
    val commands = T3VoiceControllerCommands()
    commands.register(100)
    val stale = commands.requestPrimary(4, microphonePermissionGranted = true)!!

    commands.register(2)

    assertNull(commands.pending.value)
    assertFalse(commands.complete(stale.commandId, 100, "success"))
    commands.unregister(100)
    assertTrue(commands.isAttached())
    val current = commands.requestPrimary(5, microphonePermissionGranted = true)!!
    assertEquals(2, current.controllerGeneration)
  }

  @Test
  fun `readiness replacement invalidates queued command`() {
    val commands = T3VoiceControllerCommands()
    commands.register(3)
    commands.requestPrimary(8, microphonePermissionGranted = true)
    commands.invalidateReadiness()
    assertNull(commands.pending.value)
  }

  @Test
  fun `missing microphone permission does not queue start`() {
    val commands = T3VoiceControllerCommands()
    commands.register(2)
    assertNull(commands.requestPrimary(3, microphonePermissionGranted = false))
  }
}
