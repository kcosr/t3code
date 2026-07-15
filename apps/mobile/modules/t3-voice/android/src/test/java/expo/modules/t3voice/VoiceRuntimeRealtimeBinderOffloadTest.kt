package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceRuntimeRealtimeBinderOffloadTest {
  @Test
  fun receiptDoesNotDependOnOffloadedNetworkResult() {
    val starts = ArrayDeque<Runnable>()
    val controls = ArrayDeque<Runnable>()
    val offload = VoiceRuntimeRealtimeBinderOffload(starts::addLast, controls::addLast)
    val server = FakeServer(result = false)
    val engine = FakeEngine(server)

    val startResult = offload.submitStart { engine.start() }
    val controlResult = offload.submitControl { engine.updateFocus() }

    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false), startResult)
    assertEquals(VoiceRuntimeRealtimeCommandResult.Accepted(adopted = false), controlResult)
    assertFalse(server.called)

    starts.removeFirst().run()
    controls.removeFirst().run()
    assertTrue(server.called)
  }

  private class FakeEngine(private val server: FakeServer) {
    fun start(): Boolean = server.execute()

    fun updateFocus(): Boolean = server.execute()
  }

  private class FakeServer(private val result: Boolean) {
    var called = false
      private set

    fun execute(): Boolean {
      called = true
      return result
    }
  }
}
