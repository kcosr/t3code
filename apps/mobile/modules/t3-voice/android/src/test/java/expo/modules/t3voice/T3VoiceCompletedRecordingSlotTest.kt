package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

internal class T3VoiceCompletedRecordingSlotTest {
  private val recording =
    T3VoiceRecordingResult(
      recordingId = "recording-one",
      uri = "file:///cache/recording-one.m4a",
      durationMs = 1_000,
      byteLength = 64,
    )

  @Test
  fun `success failure and stop cleanup delete a finalized file exactly once`() {
    val deleted = mutableListOf<T3VoiceRecordingResult>()
    val slot = T3VoiceCompletedRecordingSlot(deleted::add)

    slot.store(recording)
    assertTrue(slot.delete(recording))
    assertFalse(slot.delete(recording))
    assertNull(slot.current())
    assertEquals(listOf(recording), deleted)

    slot.store(recording)
    assertTrue(slot.delete())
    assertEquals(listOf(recording, recording), deleted)
  }

  @Test
  fun `mismatched completion cannot delete a newly owned recording`() {
    val slot = T3VoiceCompletedRecordingSlot { }
    val stale = recording.copy(recordingId = "stale")
    slot.store(recording)

    assertFalse(slot.delete(stale))
    assertEquals(recording, slot.current())
  }
}
