package expo.modules.t3voice

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import java.io.File

internal data class T3VoiceRecordingResult(
  val recordingId: String,
  val uri: String,
  val durationMs: Long,
  val byteLength: Long,
) {
  fun toResultBody(): Map<String, Any> =
    mapOf(
      "recordingId" to recordingId,
      "uri" to uri,
      "mimeType" to MIME_TYPE,
      "durationMs" to durationMs.toDouble(),
      "byteLength" to byteLength.toDouble(),
    )

  companion object {
    const val MIME_TYPE = "audio/mp4"
  }
}

internal class T3VoiceRecorder(private val context: Context) {
  private data class ActiveRecording(
    val recordingId: String,
    val recorder: MediaRecorder,
    val file: File,
    val startedAtMs: Long,
  )

  private var active: ActiveRecording? = null
  private val completed = mutableMapOf<String, File>()

  @Synchronized
  fun start(recordingId: String) {
    check(active == null) { "A voice recording is already active." }
    val outputFile = File.createTempFile(FILE_PREFIX, FILE_SUFFIX, context.cacheDir)
    val recorder = createMediaRecorder()
    try {
      recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioSamplingRate(RECORDING_SAMPLE_RATE)
      recorder.setAudioChannels(1)
      recorder.setAudioEncodingBitRate(RECORDING_BIT_RATE)
      recorder.setOutputFile(outputFile.absolutePath)
      recorder.prepare()
      recorder.start()
    } catch (cause: Throwable) {
      recorder.release()
      outputFile.delete()
      throw cause
    }
    active =
      ActiveRecording(
        recordingId = recordingId,
        recorder = recorder,
        file = outputFile,
        startedAtMs = SystemClock.elapsedRealtime(),
      )
  }

  @Synchronized
  fun stop(recordingId: String): T3VoiceRecordingResult {
    val recording = requireActive(recordingId)
    active = null
    try {
      recording.recorder.stop()
    } catch (cause: RuntimeException) {
      recording.file.delete()
      throw IllegalStateException("The recording was too short or could not be finalized.", cause)
    } finally {
      recording.recorder.release()
    }
    completed[recording.recordingId] = recording.file
    return T3VoiceRecordingResult(
      recordingId = recording.recordingId,
      uri = Uri.fromFile(recording.file).toString(),
      durationMs = SystemClock.elapsedRealtime() - recording.startedAtMs,
      byteLength = recording.file.length(),
    )
  }

  @Synchronized
  fun cancel(recordingId: String) {
    val recording = requireActive(recordingId)
    active = null
    try {
      recording.recorder.stop()
    } catch (_: RuntimeException) {
      // A short recording may not contain a complete MPEG-4 sample.
    } finally {
      recording.recorder.release()
      recording.file.delete()
    }
  }

  @Synchronized
  fun delete(recordingId: String, uri: String) {
    val ownedFile = completed[recordingId] ?: error("Recording $recordingId is not owned by T3 voice.")
    val requestedFile = Uri.parse(uri).path?.let(::File) ?: error("Recording URI is invalid.")
    val canonicalOwned = ownedFile.canonicalFile
    val canonicalRequested = requestedFile.canonicalFile
    val canonicalCacheDirectory = context.cacheDir.canonicalFile
    check(canonicalOwned == canonicalRequested) { "Recording URI does not match $recordingId." }
    check(canonicalOwned.parentFile == canonicalCacheDirectory) {
      "Recording file is outside the T3 voice cache directory."
    }
    check(canonicalOwned.name.startsWith(FILE_PREFIX) && canonicalOwned.name.endsWith(FILE_SUFFIX)) {
      "Recording file is not a T3 voice cache file."
    }
    check(!canonicalOwned.exists() || canonicalOwned.delete()) { "Recording file could not be deleted." }
    completed.remove(recordingId)
  }

  @Synchronized
  fun release() {
    val recording = active
    if (recording != null) {
      active = null
      recording.recorder.release()
      recording.file.delete()
    }
    completed.values.forEach(File::delete)
    completed.clear()
  }

  private fun requireActive(recordingId: String): ActiveRecording {
    val recording = active ?: error("No voice recording is active.")
    check(recording.recordingId == recordingId) {
      "Recording $recordingId does not own the active recorder."
    }
    return recording
  }

  @Suppress("DEPRECATION")
  private fun createMediaRecorder(): MediaRecorder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      MediaRecorder(context)
    } else {
      MediaRecorder()
    }

  companion object {
    private const val RECORDING_SAMPLE_RATE = 24_000
    private const val RECORDING_BIT_RATE = 64_000
    private const val FILE_PREFIX = "t3-voice-"
    private const val FILE_SUFFIX = ".m4a"
  }
}
