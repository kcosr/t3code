package expo.modules.t3voice

import java.util.ArrayDeque
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceHostDriverTest {
  @Test
  fun `host effects execute through main dispatcher and record results`() {
    val dispatcher = FakeDispatcher()
    val effects = RecordingEffects()
    val results = mutableListOf<String>()
    val driver = VoiceHostDriver(
      dispatcher,
      effects,
      VoiceKernelDriverResultSink { results += it.resultKind },
      { VoiceKernelEpoch("test", 1, "operation", 1) },
    )

    driver.setWakeLock(true)
    driver.keepStarted("start", "operation")
    driver.stopSelfIfIdle(7)
    assertEquals(emptyList<String>(), effects.events)

    dispatcher.runAll()

    assertEquals(listOf("wake-true", "keep-start-operation", "stop-7"), effects.events)
    assertEquals(listOf("set-wake-lock", "keep-started", "stop-self-if-idle"), results)
  }

  private class FakeDispatcher : VoiceHostMainDispatcher {
    private val queue = ArrayDeque<Runnable>()
    override fun isMainThread() = false
    override fun post(runnable: Runnable) = queue.add(runnable)
    fun runAll() {
      while (queue.isNotEmpty()) queue.removeFirst().run()
    }
  }

  private class RecordingEffects : VoiceHostEffects {
    val events = mutableListOf<String>()
    override fun setForeground(types: Int, snapshot: T3VoiceNotificationSnapshot) = Unit
    override fun removeForeground() = Unit
    override fun notify(snapshot: T3VoiceNotificationSnapshot) = Unit
    override fun setWakeLock(on: Boolean) { events += "wake-$on" }
    override fun setMediaSession(model: VoiceHostMediaSessionModel) = Unit
    override fun releaseMediaSession() = Unit
    override fun keepStarted(action: String, operationId: String) {
      events += "keep-$action-$operationId"
    }
    override fun stopSelfIfIdle(startId: Int?) { events += "stop-$startId" }
  }
}
