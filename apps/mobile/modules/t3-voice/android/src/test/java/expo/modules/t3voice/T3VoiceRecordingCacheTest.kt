package expo.modules.t3voice

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class T3VoiceRecordingCacheTest {
  private lateinit var cacheRoot: File

  @Before
  fun createCacheRoot() {
    cacheRoot = Files.createTempDirectory("t3-voice-cache-test").toFile()
  }

  @After
  fun deleteCacheRoot() {
    cacheRoot.deleteRecursively()
  }

  @Test
  fun sweepDeletesExpiredOwnedFilesWithoutTouchingUnrelatedCacheEntries() {
    val now = 10_000L
    val cache =
      T3VoiceRecordingCache(
        cacheRoot,
        nowMillis = { now },
        maximumAgeMillis = 1_000,
        maximumRetainedFiles = 10,
      )
    val expired = cache.createTempFile().apply { setLastModified(now - 1_000) }
    val recent = cache.createTempFile().apply { setLastModified(now - 999) }
    val unrelatedRoot = File(cacheRoot, "recording-unrelated.m4a").apply { writeText("keep") }
    val unrelatedOwnedDirectory =
      File(cache.directory, "recording-not-generated.m4a").apply {
        writeText("keep")
        setLastModified(0)
      }
    val similarlyNamedDirectory = File(cache.directory, "recording-directory.m4a").apply { mkdirs() }

    assertEquals(1, cache.sweep())

    assertFalse(expired.exists())
    assertTrue(recent.exists())
    assertTrue(unrelatedRoot.exists())
    assertTrue(unrelatedOwnedDirectory.exists())
    assertTrue(similarlyNamedDirectory.isDirectory)
  }

  @Test
  fun sweepRetainsOnlyTheNewestBoundedNumberOfRecentOwnedFiles() {
    val now = 100_000L
    val cache =
      T3VoiceRecordingCache(
        cacheRoot,
        nowMillis = { now },
        maximumAgeMillis = 50_000,
        maximumRetainedFiles = 2,
      )
    val files =
      (1L..4L).map { ordinal ->
        cache.createTempFile().apply { setLastModified(now - ordinal * 100) }
      }

    assertEquals(2, cache.sweep())
    assertEquals(setOf(files[0].canonicalFile, files[1].canonicalFile), ownedFiles(cache))
    assertEquals(0, cache.sweep())
  }

  @Test
  fun sweepProtectsPendingCompletedRecordingFromAgeAndCountLimits() {
    val now = 100_000L
    val cache =
      T3VoiceRecordingCache(
        cacheRoot,
        nowMillis = { now },
        maximumAgeMillis = 1_000,
        maximumRetainedFiles = 0,
      )
    val pending = cache.createTempFile().apply { setLastModified(0) }

    assertEquals(0, cache.sweep(setOf(pending)))
    assertTrue(pending.exists())
  }

  @Test
  fun ownershipRequiresTheDedicatedDirectoryAndGeneratedFilenameShape() {
    val cache = T3VoiceRecordingCache(cacheRoot)
    val owned = cache.createTempFile()
    val outside = File(cacheRoot, owned.name).apply { writeText("outside") }
    val wrongName = File(cache.directory, "recording.txt").apply { writeText("wrong") }

    assertTrue(cache.owns(owned))
    assertFalse(cache.owns(outside))
    assertFalse(cache.owns(wrongName))
  }

  @Test
  fun processRestartRestoresRecordingForCancelRevocationAndNormalCleanup() {
    listOf("cancel", "revocation", "normal").forEach { path ->
      val cache = T3VoiceRecordingCache(cacheRoot)
      val file = cache.createTempFile().apply { writeText(path) }
      val recording = T3VoiceRecordingResult(
        recordingId = "recording-$path",
        uri = file.toURI().toString(),
        durationMs = 1_000,
        byteLength = file.length(),
      )

      val restartedRegistry = T3VoiceCompletedRecordingRegistry(cache)
      assertTrue(restartedRegistry.restore(recording))
      var durableStateCleared = false
      assertTrue(VoiceRuntimeThreadLocalCleanupCoordinator.complete(
        deleteRecording = {
          runCatching {
            restartedRegistry.delete(recording.recordingId, recording.uri)
          }.isSuccess
        },
        clearDurableState = { durableStateCleared = true; true },
      ))
      assertTrue(durableStateCleared)
      assertFalse(file.exists())

      restartedRegistry.delete(recording.recordingId, recording.uri)
    }
  }

  @Test
  fun unregisteredExistingRecordingCannotBeDeleted() {
    val cache = T3VoiceRecordingCache(cacheRoot)
    val file = cache.createTempFile().apply { writeText("live") }
    val registry = T3VoiceCompletedRecordingRegistry(cache)

    assertFalse(runCatching { registry.delete("unknown", file.toURI().toString()) }.isSuccess)
    assertTrue(file.exists())
  }

  @Test
  fun processRestartRejectsMissingPersistedRecording() {
    val cache = T3VoiceRecordingCache(cacheRoot)
    val missing = cache.createTempFile()
    val result = T3VoiceRecordingResult(
      "recording-missing", missing.toURI().toString(), 1_000, 128,
    )
    assertTrue(missing.delete())

    assertFalse(T3VoiceCompletedRecordingRegistry(cache).restore(result))
  }

  @Test
  fun processRestartRejectsTruncatedPersistedRecording() {
    val cache = T3VoiceRecordingCache(cacheRoot)
    val truncated = cache.createTempFile().apply { writeText("short") }
    val result = T3VoiceRecordingResult(
      "recording-truncated", truncated.toURI().toString(), 1_000, truncated.length() + 10,
    )

    assertFalse(T3VoiceCompletedRecordingRegistry(cache).restore(result))
    assertTrue(truncated.exists())
  }

  private fun ownedFiles(cache: T3VoiceRecordingCache): Set<File> =
    cache.directory.listFiles().orEmpty().filter(cache::owns).map(File::getCanonicalFile).toSet()
}
