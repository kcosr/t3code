package expo.modules.t3voice

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import java.io.File
import java.util.UUID

internal class T3VoiceRecordingCache(
  cacheRoot: File,
  private val nowMillis: () -> Long = System::currentTimeMillis,
  private val maximumAgeMillis: Long = DEFAULT_MAXIMUM_AGE_MILLIS,
  private val maximumRetainedFiles: Int = DEFAULT_MAXIMUM_RETAINED_FILES,
) {
  val directory = File(cacheRoot, DIRECTORY_NAME)

  init {
    require(maximumAgeMillis > 0) { "Recording cache maximum age must be positive." }
    require(maximumRetainedFiles >= 0) { "Recording cache file limit must be non-negative." }
  }

  fun createTempFile(): File {
    ensureDirectory()
    repeat(MAXIMUM_CREATE_ATTEMPTS) {
      val candidate = File(directory, "$FILE_PREFIX${UUID.randomUUID()}$FILE_SUFFIX")
      if (candidate.createNewFile()) return candidate
    }
    error("A unique T3 voice recording cache file could not be created.")
  }

  fun sweep(): Int {
    ensureDirectory()
    val now = nowMillis()
    val owned =
      directory.listFiles().orEmpty()
        .filter(::isOwnedFile)
        .sortedWith(compareByDescending<File> { it.lastModified() }.thenByDescending(File::getName))
    var deleted = 0
    owned.forEachIndexed { index, file ->
      val ageMillis = (now - file.lastModified()).coerceAtLeast(0)
      if (ageMillis >= maximumAgeMillis || index >= maximumRetainedFiles) {
        if (file.delete()) deleted += 1
      }
    }
    return deleted
  }

  fun owns(file: File): Boolean {
    val canonicalDirectory = directory.canonicalFile
    val canonicalFile = file.canonicalFile
    return canonicalFile.parentFile == canonicalDirectory && isOwnedFile(canonicalFile)
  }

  private fun ensureDirectory() {
    check(directory.isDirectory || directory.mkdirs()) {
      "The T3 voice recording cache directory could not be created."
    }
  }

  private fun isOwnedFile(file: File): Boolean =
    file.isFile && OWNED_FILENAME.matches(file.name)

  companion object {
    private const val DIRECTORY_NAME = "t3-voice-recordings"
    private const val FILE_PREFIX = "recording-"
    private const val FILE_SUFFIX = ".m4a"
    private const val MAXIMUM_CREATE_ATTEMPTS = 4
    private const val DEFAULT_MAXIMUM_AGE_MILLIS = 24L * 60L * 60L * 1_000L
    private const val DEFAULT_MAXIMUM_RETAINED_FILES = 64
    private val OWNED_FILENAME =
      Regex("^recording-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.m4a$")
  }
}

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

internal class T3VoiceRecorder(
  private val context: Context,
  private val onLimitReached: (String, String) -> Unit = { _, _ -> },
) {
  private data class ActiveRecording(
    val recordingId: String,
    val recorder: MediaRecorder,
    val file: File,
    val startedAtMs: Long,
    val terminalOwner: T3VoiceRecordingTerminalPolicy.Owner,
  )

  private var active: ActiveRecording? = null
  private val completed = mutableMapOf<String, File>()
  private val recordingCache = T3VoiceRecordingCache(context.cacheDir)
  private val terminalPolicy = T3VoiceRecordingTerminalPolicy()

  fun sweepStaleCache(): Int = recordingCache.sweep()

  @Synchronized
  fun start(recordingId: String) {
    check(active == null) { "A voice recording is already active." }
    val outputFile = recordingCache.createTempFile()
    val recorder = createMediaRecorder()
    val terminalOwner = terminalPolicy.activate(recordingId)
    try {
      recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioSamplingRate(RECORDING_SAMPLE_RATE)
      recorder.setAudioChannels(1)
      recorder.setAudioEncodingBitRate(RECORDING_BIT_RATE)
      recorder.setMaxDuration(MAXIMUM_RECORDING_DURATION_MS)
      recorder.setMaxFileSize(MAXIMUM_RECORDING_BYTES)
      recorder.setOnInfoListener { source, what, _ -> handleRecorderInfo(source, what) }
      recorder.setOutputFile(outputFile.absolutePath)
      recorder.prepare()
      recorder.start()
    } catch (cause: Throwable) {
      terminalPolicy.deactivate(terminalOwner)
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
        terminalOwner = terminalOwner,
      )
  }

  @Synchronized
  fun stop(recordingId: String): T3VoiceRecordingResult {
    val recording = requireActive(recordingId)
    active = null
    terminalPolicy.deactivate(recording.terminalOwner)
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
    terminalPolicy.deactivate(recording.terminalOwner)
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
    check(canonicalOwned == canonicalRequested) { "Recording URI does not match $recordingId." }
    check(recordingCache.owns(canonicalOwned)) {
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
      terminalPolicy.deactivate(recording.terminalOwner)
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

  private fun handleRecorderInfo(source: MediaRecorder, what: Int) {
    val code =
      when (what) {
        MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED -> "recording-duration-limit"
        MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> "recording-file-size-limit"
        else -> return
      }
    val recording =
      synchronized(this) {
        val current = active?.takeIf { it.recorder === source } ?: return
        if (!terminalPolicy.claim(current.terminalOwner)) return
        active = null
        current
      }
    try {
      recording.recorder.stop()
    } catch (_: RuntimeException) {
      // The capped recording is discarded regardless of finalization state.
    } finally {
      recording.recorder.release()
      recording.file.delete()
    }
    onLimitReached(recording.recordingId, code)
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
    private const val MAXIMUM_RECORDING_DURATION_MS = 30 * 60 * 1_000
    private const val MAXIMUM_RECORDING_BYTES = 32L * 1_024L * 1_024L
  }
}
