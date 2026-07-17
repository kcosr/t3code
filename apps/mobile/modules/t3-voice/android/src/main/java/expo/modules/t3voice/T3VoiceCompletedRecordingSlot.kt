package expo.modules.t3voice

/**
 * Owns at most one finalized temporary recording and makes deletion the only terminal operation.
 * The Thread runtime has no retry-upload/resume state, so every success, failure, and stop clears
 * this slot and deletes its file.
 */
internal class T3VoiceCompletedRecordingSlot(
  private val deleteRecording: (T3VoiceRecordingResult) -> Unit,
) {
  private val lock = Any()
  private var recording: T3VoiceRecordingResult? = null

  fun store(value: T3VoiceRecordingResult) {
    synchronized(lock) {
      check(recording == null) { "A completed voice recording is already owned." }
      recording = value
    }
  }

  fun current(): T3VoiceRecordingResult? = synchronized(lock) { recording }

  fun delete(expected: T3VoiceRecordingResult? = null): Boolean {
    val removed =
      synchronized(lock) {
        val current = recording ?: return false
        if (expected != null && current != expected) return false
        recording = null
        current
      }
    deleteRecording(removed)
    return true
  }
}
