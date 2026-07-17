package expo.modules.t3voice

/**
 * Converts arbitrary HTTP byte boundaries into ordered s16le frames while applying bounded credit
 * backpressure to [T3VoicePcmPlayer]. The speech HTTP call runs on its own worker, so waiting for
 * playback credit cannot delay Realtime control, event, or shutdown work.
 */
internal class T3VoicePcmStreamSink(
  private val playbackId: String,
  private val enqueue: (playbackId: String, chunkIndex: Int, pcm: ByteArray) -> Unit,
  private val maximumPendingChunks: Int = DEFAULT_MAXIMUM_PENDING_CHUNKS,
  private val maximumPendingBytes: Int = DEFAULT_MAXIMUM_PENDING_BYTES,
) {
  private val lock = java.lang.Object()
  private val pendingBytesByIndex = mutableMapOf<Int, Int>()
  private var pendingBytes = 0
  private var nextChunkIndex = 0
  private var partialFrameByte: Byte? = null
  private var cancelled = false
  private var finished = false

  init {
    require(playbackId.isNotBlank()) { "playbackId must be non-empty." }
    require(maximumPendingChunks > 0) { "PCM pending chunk limit must be positive." }
    require(maximumPendingBytes >= Short.SIZE_BYTES) { "PCM pending byte limit is too small." }
  }

  fun accept(bytes: ByteArray) {
    require(bytes.isNotEmpty()) { "PCM HTTP chunks must not be empty." }
    val aligned = synchronized(lock) { alignFramesLocked(bytes) }
    if (aligned.isEmpty()) return

    val chunkIndex =
      synchronized(lock) {
        while (
          !cancelled &&
            (pendingBytesByIndex.size >= maximumPendingChunks ||
              pendingBytes.toLong() + aligned.size > maximumPendingBytes)
        ) {
          lock.wait()
        }
        check(!cancelled) { "PCM stream was cancelled." }
        check(!finished) { "PCM stream was already finished." }
        val index = nextChunkIndex++
        pendingBytesByIndex[index] = aligned.size
        pendingBytes += aligned.size
        index
      }

    try {
      enqueue(playbackId, chunkIndex, aligned)
    } catch (cause: Throwable) {
      synchronized(lock) {
        pendingBytes -= pendingBytesByIndex.remove(chunkIndex) ?: 0
        cancelled = true
        lock.notifyAll()
      }
      throw cause
    }
  }

  fun consumed(chunkIndex: Int) {
    synchronized(lock) {
      val bytes = pendingBytesByIndex.remove(chunkIndex) ?: return
      pendingBytes -= bytes
      lock.notifyAll()
    }
  }

  /** Returns the inclusive final player chunk index. */
  fun finish(): Int =
    synchronized(lock) {
      check(!cancelled) { "PCM stream was cancelled." }
      check(!finished) { "PCM stream was already finished." }
      check(partialFrameByte == null) { "PCM stream ended on a partial s16le frame." }
      check(nextChunkIndex > 0) { "PCM stream returned no audio frames." }
      finished = true
      nextChunkIndex - 1
    }

  fun cancel() {
    synchronized(lock) {
      cancelled = true
      partialFrameByte = null
      lock.notifyAll()
    }
  }

  private fun alignFramesLocked(bytes: ByteArray): ByteArray {
    check(!cancelled) { "PCM stream was cancelled." }
    check(!finished) { "PCM stream was already finished." }
    val leading = partialFrameByte
    val totalBytes = bytes.size + if (leading == null) 0 else 1
    val alignedBytes = totalBytes - (totalBytes % Short.SIZE_BYTES)
    if (alignedBytes == 0) {
      partialFrameByte = bytes.single()
      return ByteArray(0)
    }

    val output = ByteArray(alignedBytes)
    var sourceOffset = 0
    var outputOffset = 0
    if (leading != null) {
      output[0] = leading
      outputOffset = 1
    }
    val copyLength = alignedBytes - outputOffset
    bytes.copyInto(output, outputOffset, sourceOffset, sourceOffset + copyLength)
    sourceOffset += copyLength
    partialFrameByte = bytes.getOrNull(sourceOffset)
    return output
  }

  private companion object {
    const val DEFAULT_MAXIMUM_PENDING_CHUNKS = 4
    const val DEFAULT_MAXIMUM_PENDING_BYTES = 512 * 1_024
  }
}
