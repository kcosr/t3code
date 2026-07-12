package expo.modules.t3voice

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
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

internal sealed interface T3VoiceRecordingTermination {
  data class Completed(val recording: T3VoiceRecordingResult, val reason: String) :
    T3VoiceRecordingTermination

  data class Cancelled(val recordingId: String, val reason: String) : T3VoiceRecordingTermination

  data class Failed(val recordingId: String, val message: String) : T3VoiceRecordingTermination
}

internal class T3VoiceRecorder(
  private val context: Context,
  private val onTerminated: (T3VoiceRecordingTermination) -> Unit = {},
) {
  private data class ActiveRecording(
    val recordingId: String,
    val recorder: MediaRecorder,
    val file: File,
    val startedAtMs: Long,
    val terminalOwner: T3VoiceRecordingTerminalPolicy.Owner,
    val endpointDetector: T3VoiceEndpointDetector,
  )

  private var active: ActiveRecording? = null
  private val completed = mutableMapOf<String, File>()
  private val recordingCache = T3VoiceRecordingCache(context.cacheDir)
  private val terminalPolicy = T3VoiceRecordingTerminalPolicy()
  private val endpointThread = HandlerThread("t3-voice-endpoint").apply { start() }
  private val endpointHandler = Handler(endpointThread.looper)

  fun sweepStaleCache(): Int = recordingCache.sweep()

  @Synchronized
  fun start(
    recordingId: String,
    endpointConfig: T3VoiceEndpointDetectionConfig,
  ) {
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
        endpointDetector = T3VoiceEndpointDetector(endpointConfig),
      )
    scheduleEndpointPoll(terminalOwner)
  }

  @Synchronized
  fun stop(recordingId: String): T3VoiceRecordingResult {
    val recording = requireActive(recordingId)
    check(terminalPolicy.claim(recording.terminalOwner)) { "The recording already terminated." }
    active = null
    return finalizeCompleted(recording)
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
    endpointThread.quitSafely()
  }

  private fun requireActive(recordingId: String): ActiveRecording {
    val recording = active ?: error("No voice recording is active.")
    check(recording.recordingId == recordingId) {
      "Recording $recordingId does not own the active recorder."
    }
    return recording
  }

  private fun handleRecorderInfo(source: MediaRecorder, what: Int) {
    val reason =
      when (what) {
        MediaRecorder.MEDIA_RECORDER_INFO_MAX_DURATION_REACHED -> "media-duration-limit"
        MediaRecorder.MEDIA_RECORDER_INFO_MAX_FILESIZE_REACHED -> "media-file-size-limit"
        else -> return
      }
    val recording =
      synchronized(this) {
        val current = active?.takeIf { it.recorder === source } ?: return
        if (!terminalPolicy.claim(current.terminalOwner)) return
        active = null
        current
      }
    completeAutomatically(recording, reason)
  }

  private fun scheduleEndpointPoll(owner: T3VoiceRecordingTerminalPolicy.Owner) {
    endpointHandler.postDelayed(
      object : Runnable {
        override fun run() {
          val termination =
            synchronized(this@T3VoiceRecorder) {
              val recording = active?.takeIf { it.terminalOwner == owner } ?: return
              val elapsed = SystemClock.elapsedRealtime() - recording.startedAtMs
              recording.endpointDetector.observe(elapsed, recording.recorder.maxAmplitude)
            }
          if (termination == null) {
            endpointHandler.postDelayed(this, ENDPOINT_POLL_INTERVAL_MS)
            return
          }
          val recording =
            synchronized(this@T3VoiceRecorder) {
              val current = active?.takeIf { it.terminalOwner == owner } ?: return
              if (!terminalPolicy.claim(owner)) return
              active = null
              current
            }
          when (termination) {
            T3VoiceEndpointDetector.Outcome.NO_SPEECH -> cancelAutomatically(recording)
            T3VoiceEndpointDetector.Outcome.SPEECH_ENDED ->
              completeAutomatically(recording, "speech-ended")
            T3VoiceEndpointDetector.Outcome.MAXIMUM_UTTERANCE ->
              completeAutomatically(recording, "maximum-utterance")
          }
        }
      },
      ENDPOINT_POLL_INTERVAL_MS,
    )
  }

  private fun completeAutomatically(recording: ActiveRecording, reason: String) {
    val result = try {
      finalizeCompleted(recording)
    } catch (_: RuntimeException) {
      onTerminated(
        T3VoiceRecordingTermination.Failed(
          recording.recordingId,
          "The recording could not be finalized.",
        ),
      )
      return
    }
    onTerminated(T3VoiceRecordingTermination.Completed(result, reason))
  }

  private fun cancelAutomatically(recording: ActiveRecording) {
    stopAndDelete(recording)
    onTerminated(T3VoiceRecordingTermination.Cancelled(recording.recordingId, "no-speech"))
  }

  private fun finalizeCompleted(recording: ActiveRecording): T3VoiceRecordingResult {
    try {
      recording.recorder.stop()
    } catch (cause: RuntimeException) {
      recording.file.delete()
      throw IllegalStateException("The recording was too short or could not be finalized.", cause)
    } finally {
      recording.recorder.release()
    }
    val result =
      T3VoiceRecordingResult(
        recordingId = recording.recordingId,
        uri = Uri.fromFile(recording.file).toString(),
        durationMs = SystemClock.elapsedRealtime() - recording.startedAtMs,
        byteLength = recording.file.length(),
      )
    synchronized(this) { completed[recording.recordingId] = recording.file }
    return result
  }

  private fun stopAndDelete(recording: ActiveRecording) {
    try {
      recording.recorder.stop()
    } catch (_: RuntimeException) {
      // A silent or short recording may not contain a complete MPEG-4 sample.
    } finally {
      recording.recorder.release()
      recording.file.delete()
    }
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
    private const val ENDPOINT_POLL_INTERVAL_MS = 50L
  }
}
