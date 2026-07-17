package expo.modules.t3voice

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceRecordingTerminalPolicyTest {
  @Test
  fun limitCallbackClaimsCurrentOwnerExactlyOnce() {
    val policy = T3VoiceRecordingTerminalPolicy()
    val owner = policy.activate("recording")

    assertTrue(policy.claim(owner))
    assertFalse(policy.claim(owner))
  }

  @Test
  fun staleCallbackCannotClaimReplacement() {
    val policy = T3VoiceRecordingTerminalPolicy()
    val stale = policy.activate("shared")
    assertTrue(policy.deactivate(stale))
    val replacement = policy.activate("shared")

    assertFalse(policy.claim(stale))
    assertTrue(policy.claim(replacement))
  }

  @Test
  fun completedLimitEventRetainsRecordingResultForUpload() {
    val recording = T3VoiceRecordingResult("recording", "file:///recording.m4a", 1_000, 4_096)
    val body =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = recording.recordingId,
        recording = recording,
        outcome = "completed",
        reason = "media-file-size-limit",
      ).toEventBody()

    assertEquals("completed", body["outcome"])
    assertEquals(recording.toResultBody(), body["recording"])
  }

  @Test
  fun finalizationFailureHasNoRecordingToUpload() {
    val body =
      T3VoiceRuntimeEvent.RecordingTerminated(
        recordingId = "recording",
        recording = null,
        outcome = "failed",
        reason = "finalization-failed",
      ).toEventBody()

    assertEquals("failed", body["outcome"])
    assertEquals(null, body["recording"])
  }

  @Test
  fun automaticTerminalWorkWaitsForManualOperationLock() {
    val lock = Any()
    val coordinator = T3VoiceRecordingTerminalCoordinator(lock)
    val manualEntered = CountDownLatch(1)
    val releaseManual = CountDownLatch(1)
    val automaticEntered = CountDownLatch(1)
    val manual =
      thread {
        synchronized(lock) {
          manualEntered.countDown()
          releaseManual.await()
        }
      }
    assertTrue(manualEntered.await(1, TimeUnit.SECONDS))
    val automatic = thread { coordinator.serialized { automaticEntered.countDown() } }

    assertFalse(automaticEntered.await(100, TimeUnit.MILLISECONDS))
    releaseManual.countDown()
    assertTrue(automaticEntered.await(1, TimeUnit.SECONDS))

    manual.join()
    automatic.join()
  }

  @Test
  fun manualFinishJoinsAutomaticTerminalizationAndObservesItsExactResult() {
    val coordinator = T3VoiceRecordingTerminalCoordinator(Any())
    val automaticEntered = CountDownLatch(1)
    val allowAutomaticCompletion = CountDownLatch(1)
    val manualCompleted = CountDownLatch(1)
    val published = AtomicReference<T3VoiceRecordingResult?>()
    val observed = AtomicReference<T3VoiceRecordingResult?>()
    val recording = T3VoiceRecordingResult("recording", "file:///recording.m4a", 1_000, 4_096)

    val automatic =
      thread {
        coordinator.serialized {
          automaticEntered.countDown()
          allowAutomaticCompletion.await()
          published.set(recording)
        }
      }
    assertTrue(automaticEntered.await(1, TimeUnit.SECONDS))
    val manual =
      thread {
        coordinator.serialized {
          observed.set(published.get())
          manualCompleted.countDown()
        }
      }

    assertFalse(manualCompleted.await(100, TimeUnit.MILLISECONDS))
    allowAutomaticCompletion.countDown()
    assertTrue(manualCompleted.await(1, TimeUnit.SECONDS))
    assertEquals(recording, observed.get())

    automatic.join()
    manual.join()
  }

  @Test
  fun cancellationJoinsAutomaticTerminalizationBeforeReturning() {
    val coordinator = T3VoiceRecordingTerminalCoordinator(Any())
    val automaticEntered = CountDownLatch(1)
    val allowAutomaticCompletion = CountDownLatch(1)
    val cancellationReturned = CountDownLatch(1)

    val automatic =
      thread {
        coordinator.serialized {
          automaticEntered.countDown()
          allowAutomaticCompletion.await()
        }
      }
    assertTrue(automaticEntered.await(1, TimeUnit.SECONDS))
    val cancellation =
      thread {
        coordinator.serialized { cancellationReturned.countDown() }
      }

    assertFalse(cancellationReturned.await(100, TimeUnit.MILLISECONDS))
    allowAutomaticCompletion.countDown()
    assertTrue(cancellationReturned.await(1, TimeUnit.SECONDS))

    automatic.join()
    cancellation.join()
  }
}
