package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceRealtimePlayoutDrainPolicyTest {
  @Test
  fun `silent playout drains after four hundred milliseconds`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 1_000)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(1_399, null))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.DRAINED, policy.observe(1_400, null))
  }

  @Test
  fun `audible playout restarts the silence window`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 1_000)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(1_700, 1_500))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(1_899, 1_500))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.DRAINED, policy.observe(1_900, 1_500))
  }

  @Test
  fun `continuously active playout times out after five seconds`() {
    val policy = T3VoiceRealtimePlayoutDrainPolicy(startedAtMillis = 10_000)

    assertEquals(T3VoiceRealtimePlayoutDrainDecision.WAIT, policy.observe(14_999, 14_999))
    assertEquals(T3VoiceRealtimePlayoutDrainDecision.TIMED_OUT, policy.observe(15_000, 15_000))
  }

  @Test
  fun `playout monitor accepts only audible complete pcm16 samples`() {
    val monitor = T3VoiceRealtimePlayoutMonitor()

    monitor.observePcm16LittleEndian(byteArrayOf(0, 0, 32, 0, 1), 100)
    assertEquals(null, monitor.lastAudibleAtMillis())
    monitor.observePcm16LittleEndian(byteArrayOf(33, 0), 200)
    assertEquals(200L, monitor.lastAudibleAtMillis())
    monitor.observePcm16LittleEndian(byteArrayOf(0, 0), 300)
    assertEquals(200L, monitor.lastAudibleAtMillis())
  }
}
