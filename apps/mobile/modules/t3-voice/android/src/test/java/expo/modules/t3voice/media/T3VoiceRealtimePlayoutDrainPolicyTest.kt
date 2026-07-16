package expo.modules.t3voice.media

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceRealtimePlayoutDrainPolicyTest {
  @Test
  fun `drains after the initial silence window when no audio arrives`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 1_000)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(1_000, null))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(1_399, null))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.DRAINED, policy.observe(1_400, null))
  }

  @Test
  fun `waits for silence after local audible playout`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 0)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(300, 300))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(699, 300))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.DRAINED, policy.observe(700, 300))
  }

  @Test
  fun `a delayed first playout sample starts a fresh silence window`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 0)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(399, null))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(500, 450))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(849, 450))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.DRAINED, policy.observe(850, 450))
  }

  @Test
  fun `bounds continuously active playout`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 10_000)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(10_000, 10_000))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(12_400, 12_400))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.TIMED_OUT, policy.observe(12_500, 12_500))
  }

  @Test
  fun `playout monitor records only audible complete pcm16 samples`() {
    val monitor = T3VoiceRealtimePlayoutMonitor()

    monitor.observePcm16LittleEndian(byteArrayOf(0, 0, 32, 0, 1), 100)
    assertEquals(null, monitor.lastAudibleAtMillis())
    monitor.observePcm16LittleEndian(byteArrayOf(33, 0), 200)
    assertEquals(200L, monitor.lastAudibleAtMillis())
    monitor.observePcm16LittleEndian(byteArrayOf(0, 0), 300)
    assertEquals(200L, monitor.lastAudibleAtMillis())
  }
}
