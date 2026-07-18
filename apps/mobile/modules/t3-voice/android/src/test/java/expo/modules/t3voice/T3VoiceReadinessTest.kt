package expo.modules.t3voice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class T3VoiceReadinessTest {
  private val target =
    T3VoiceRealtimeTarget(
      environmentId = "environment-a",
      conversation = T3VoiceConversationSelection.Continue("conversation-a", false),
      focus = null,
      threadSettings = null,
    )
  private val threadStart =
    T3VoiceThreadStart(
      target =
        T3VoiceThreadTarget(
          environmentId = "environment-a",
          projectId = "project-a",
          threadId = "thread-a",
          modelSelection = T3VoiceModelSelection("codex", "gpt-5.4", null),
          runtimeMode = T3VoiceThreadRuntimeMode.AUTO_ACCEPT_EDITS,
          interactionMode = T3VoiceThreadInteractionMode.DEFAULT,
        ),
      settings =
        T3VoiceThreadSettings(
          submissionPolicy = T3VoiceThreadSubmissionPolicy.AUTO_SUBMIT,
          playResponses = true,
          autoRearm = true,
          endpointDetection = T3VoiceThreadEndpointDetection(900, null, 120_000),
          rearmDelayMs = 500,
          transcriptionTimeoutMs = 600_000,
          submissionTimeoutMs = 30_000,
          responseTimeoutMs = 600_000,
        ),
    )
  private val session =
    T3VoiceNativeSessionConfig(
      "https://example.test",
      "secret",
      "2026-07-17T22:00:00.000Z",
    )

  @Test
  fun readyStartsTheExactPreparedCommandRepeatedly() {
    val owner = T3VoiceReadinessOwner { T3VoiceTime.parseIsoEpochMillis("2026-07-17T21:00:00Z", "now") }
    val configured = configuration(1)
    assertTrue(owner.configure(configured) is T3VoiceReadinessSnapshot.Ready)

    val first = owner.start(1) as T3VoiceReadinessStartDecision.Start
    val second = owner.start(1) as T3VoiceReadinessStartDecision.Start
    assertEquals(first.command, second.command)
    assertEquals(T3VoiceRuntimeCommand.StartRealtime(target, session), first.command)
    assertSame(threadStart, owner.preparedThreadStartFor("environment-a"))
    assertNull(owner.preparedThreadStartFor("environment-b"))
  }

  @Test
  fun staleConfigurationAndStartCannotReplaceOrUseTheCurrentGeneration() {
    val owner = T3VoiceReadinessOwner { 0 }
    owner.configure(configuration(4))
    assertThrows(IllegalArgumentException::class.java) { owner.configure(configuration(4)) }
    assertSame(T3VoiceReadinessStartDecision.IgnoreStale, owner.start(3))
    assertThrows(IllegalArgumentException::class.java) { owner.disable(4) }
  }

  @Test
  fun expirationTransitionsOnceToRefreshNeededAndRefusesStart() {
    val expiration = T3VoiceTime.parseIsoEpochMillis(session.expiresAt, "expiration")
    val owner = T3VoiceReadinessOwner { expiration }
    assertTrue(owner.configure(configuration(1)) is T3VoiceReadinessSnapshot.NeedsRefresh)
    assertSame(T3VoiceReadinessStartDecision.Unavailable, owner.start(1))
  }

  @Test
  fun unavailableThreadNeverFallsBackToRealtime() {
    val owner = T3VoiceReadinessOwner { 0 }
    val snapshot =
      owner.configure(
        T3VoiceReadinessConfiguration(
          generation = 1,
          mode = T3VoiceReadinessMode.THREAD,
          label = "Unavailable thread",
          preparedStart = null,
          preparedThreadSwitch = null,
        ),
      )
    assertTrue(snapshot is T3VoiceReadinessSnapshot.Unavailable)
    assertSame(T3VoiceReadinessStartDecision.Unavailable, owner.start(1))
    assertNull(owner.preparedThreadStartFor("environment-a"))
  }

  @Test
  fun disableClearsPreparedTargetsWithoutStoppingAnExternalOperation() {
    val owner = T3VoiceReadinessOwner { 0 }
    owner.configure(configuration(1))
    assertEquals(T3VoiceReadinessSnapshot.Disabled(2), owner.disable(2))
    assertNull(owner.preparedThreadStartFor("environment-a"))
    assertSame(T3VoiceReadinessStartDecision.Unavailable, owner.start(2))
  }

  @Test
  fun malformedReplacementDoesNotMutateTheCurrentReadyConfiguration() {
    val owner = T3VoiceReadinessOwner { 0 }
    val original = configuration(1)
    val ready = owner.configure(original)
    val malformed =
      configuration(2).copy(
        preparedStart =
          T3VoicePreparedStart.Realtime(
            target,
            T3VoiceNativeSessionConfig("https://example.test", "secret", "not-an-instant"),
          ),
      )

    assertThrows(IllegalArgumentException::class.java) { owner.configure(malformed) }
    assertEquals(ready, owner.snapshot())
    assertEquals(original, owner.checkpoint().configuration)
  }

  @Test
  fun failedPromotionRollsBackTheFullReadyConfiguration() {
    val owner = T3VoiceReadinessOwner { 0 }
    val original = configuration(1)
    val ready = owner.configure(original)

    assertThrows(IllegalStateException::class.java) {
      owner.configureTransaction(configuration(2)) {
        throw IllegalStateException("foreground promotion failed")
      }
    }

    assertEquals(ready, owner.snapshot())
    assertEquals(original, owner.checkpoint().configuration)
  }

  private fun configuration(generation: Long) =
    T3VoiceReadinessConfiguration(
      generation = generation,
      mode = T3VoiceReadinessMode.REALTIME,
      label = "Realtime",
      preparedStart = T3VoicePreparedStart.Realtime(target, session),
      preparedThreadSwitch = threadStart,
    )
}
