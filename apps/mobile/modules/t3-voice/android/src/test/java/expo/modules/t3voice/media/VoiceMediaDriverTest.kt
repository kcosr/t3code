package expo.modules.t3voice.media

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceMediaDriverTest {
  @Test
  fun `driver is constructible with fake listener and keeps realtime lazy`() {
    val events = mutableListOf<VoiceMediaDriverEvent>()
    val factory = FakeFactory()
    val driver = VoiceMediaDriver(
      VoiceMediaDriverListener { _, event -> events += event },
      factory,
    )

    assertEquals(listOf("cues", "recorder", "player", "focus"), factory.created)
    assertFalse(factory.created.contains("realtime"))

    assertEquals("realtime", driver.realtime)
    assertEquals(listOf("cues", "recorder", "player", "focus", "router", "realtime"), factory.created)

    driver.release()
    assertEquals(listOf("recorder", "player", "cues", "focus", "realtime"), factory.released)
    assertTrue(events.isEmpty())
  }

  private class FakeFactory : VoiceMediaDriverFactory<String, String, String, String, String, String> {
    val created = mutableListOf<String>()
    val released = mutableListOf<String>()

    override fun createRecorder(listener: VoiceRawMediaDriverListener) = create("recorder")
    override fun createPlayer(listener: VoiceRawMediaDriverListener) = create("player")
    override fun createFocus(listener: VoiceRawMediaDriverListener) = create("focus")
    override fun createCues() = create("cues")
    override fun createRouter(listener: VoiceRawMediaDriverListener) = create("router")
    override fun createRealtime(router: String, listener: VoiceRawMediaDriverListener) = create("realtime")
    override fun releaseRecorder(recorder: String) = release("recorder")
    override fun releasePlayer(player: String) = release("player")
    override fun releaseCues(cues: String) = release("cues")
    override fun releaseFocus(focus: String) = release("focus")
    override fun releaseRealtime(realtime: String) = release("realtime")

    private fun create(name: String) = name.also(created::add)
    private fun release(name: String) = Unit.also { released += name }
  }
}
