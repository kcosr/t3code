package expo.modules.t3voice

/**
 * The narrow shared-media surface owned by a Thread session. Keeping this boundary explicit makes
 * the session lifecycle testable without constructing Android media framework objects.
 */
internal interface T3VoiceThreadMedia {
  fun acquireAudio(): Boolean

  fun releaseAudio()

  fun startRecording(recordingId: String, endpointConfig: T3VoiceEndpointDetectionConfig)

  fun finishRecording(recordingId: String): T3VoiceRecordingResult

  fun cancelRecording(recordingId: String)

  fun deleteRecording(recording: T3VoiceRecordingResult)

  fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int)

  fun enqueuePlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray)

  fun finishPlayback(playbackId: String, finalChunkIndex: Int)

  fun cancelPlayback(playbackId: String)

  fun pausePlayback(playbackId: String)

  fun resumePlayback(playbackId: String)
}

internal class T3VoiceAndroidThreadMedia(
  private val recorder: T3VoiceRecorder,
  private val player: T3VoicePcmPlayer,
  private val audioRouter: T3VoiceAudioRouter,
) : T3VoiceThreadMedia {
  override fun acquireAudio(): Boolean =
    audioRouter.start().transition.state != T3VoiceAudioFocusState.TERMINATED

  override fun releaseAudio() = audioRouter.stop()

  override fun startRecording(
    recordingId: String,
    endpointConfig: T3VoiceEndpointDetectionConfig,
  ) = recorder.start(recordingId, endpointConfig)

  override fun finishRecording(recordingId: String): T3VoiceRecordingResult =
    recorder.stop(recordingId)

  override fun cancelRecording(recordingId: String) = recorder.cancel(recordingId)

  override fun deleteRecording(recording: T3VoiceRecordingResult) =
    recorder.delete(recording.recordingId, recording.uri)

  override fun startPlayback(playbackId: String, sampleRate: Int, channelCount: Int) =
    player.start(playbackId, sampleRate, channelCount)

  override fun enqueuePlaybackPcm(playbackId: String, chunkIndex: Int, pcm: ByteArray) =
    player.enqueuePcm(playbackId, chunkIndex, pcm)

  override fun finishPlayback(playbackId: String, finalChunkIndex: Int) =
    player.finish(playbackId, finalChunkIndex)

  override fun cancelPlayback(playbackId: String) = player.cancel(playbackId)

  override fun pausePlayback(playbackId: String) = player.pause(playbackId)

  override fun resumePlayback(playbackId: String) = player.resume(playbackId)
}
