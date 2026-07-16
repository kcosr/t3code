package expo.modules.t3voice.media

import org.junit.Assert.assertEquals
import org.junit.Test

class T3VoiceAudioFocusPolicyTest {
  @Test
  fun coversEveryStateAndEventCombination() {
    val expected =
      mapOf(
        case(T3VoiceAudioFocusState.ACTIVE, T3VoiceAudioFocusEvent.GAINED) to
          transition(T3VoiceAudioFocusState.ACTIVE),
        case(T3VoiceAudioFocusState.ACTIVE, T3VoiceAudioFocusEvent.LOST_TRANSIENTLY) to suspended(),
        case(T3VoiceAudioFocusState.ACTIVE, T3VoiceAudioFocusEvent.DUCK_REQUESTED) to suspended(),
        case(T3VoiceAudioFocusState.ACTIVE, T3VoiceAudioFocusEvent.LOST_PERMANENTLY) to terminated(),
        case(T3VoiceAudioFocusState.ACTIVE, T3VoiceAudioFocusEvent.REQUEST_DENIED) to terminated(),
        case(T3VoiceAudioFocusState.SUSPENDED, T3VoiceAudioFocusEvent.GAINED) to
          transition(
            T3VoiceAudioFocusState.ACTIVE,
            T3VoiceAudioFocusAction.UNMUTE_CAPTURE,
            T3VoiceAudioFocusAction.RESUME_PLAYBACK,
          ),
        case(T3VoiceAudioFocusState.SUSPENDED, T3VoiceAudioFocusEvent.LOST_TRANSIENTLY) to
          transition(T3VoiceAudioFocusState.SUSPENDED),
        case(T3VoiceAudioFocusState.SUSPENDED, T3VoiceAudioFocusEvent.DUCK_REQUESTED) to
          transition(T3VoiceAudioFocusState.SUSPENDED),
        case(T3VoiceAudioFocusState.SUSPENDED, T3VoiceAudioFocusEvent.LOST_PERMANENTLY) to
          terminated(),
        case(T3VoiceAudioFocusState.SUSPENDED, T3VoiceAudioFocusEvent.REQUEST_DENIED) to terminated(),
        case(T3VoiceAudioFocusState.TERMINATED, T3VoiceAudioFocusEvent.GAINED) to
          transition(T3VoiceAudioFocusState.TERMINATED),
        case(T3VoiceAudioFocusState.TERMINATED, T3VoiceAudioFocusEvent.LOST_TRANSIENTLY) to
          transition(T3VoiceAudioFocusState.TERMINATED),
        case(T3VoiceAudioFocusState.TERMINATED, T3VoiceAudioFocusEvent.DUCK_REQUESTED) to
          transition(T3VoiceAudioFocusState.TERMINATED),
        case(T3VoiceAudioFocusState.TERMINATED, T3VoiceAudioFocusEvent.LOST_PERMANENTLY) to
          transition(T3VoiceAudioFocusState.TERMINATED),
        case(T3VoiceAudioFocusState.TERMINATED, T3VoiceAudioFocusEvent.REQUEST_DENIED) to
          transition(T3VoiceAudioFocusState.TERMINATED),
      )

    val actualCases =
      T3VoiceAudioFocusState.entries.flatMap { state ->
        T3VoiceAudioFocusEvent.entries.map { event -> case(state, event) }
      }
    assertEquals(actualCases.toSet(), expected.keys)
    actualCases.forEach { (state, event) ->
      assertEquals(
        "Unexpected transition for $state + $event",
        expected.getValue(case(state, event)),
        T3VoiceAudioFocusPolicy.reduce(state, event),
      )
    }
  }

  @Test
  fun transientLossAndGainSuspendAndResumeDuplexMediaInOrder() {
    val suspended =
      T3VoiceAudioFocusPolicy.reduce(
        T3VoiceAudioFocusState.ACTIVE,
        T3VoiceAudioFocusEvent.LOST_TRANSIENTLY,
      )
    assertEquals(
      listOf(
        T3VoiceAudioFocusAction.MUTE_CAPTURE,
        T3VoiceAudioFocusAction.PAUSE_PLAYBACK,
      ),
      suspended.actions,
    )

    val resumed = T3VoiceAudioFocusPolicy.reduce(suspended.state, T3VoiceAudioFocusEvent.GAINED)
    assertEquals(
      listOf(
        T3VoiceAudioFocusAction.UNMUTE_CAPTURE,
        T3VoiceAudioFocusAction.RESUME_PLAYBACK,
      ),
      resumed.actions,
    )
  }

  @Test
  fun repeatedLossAndTerminalEventsAreIdempotent() {
    val suspended =
      T3VoiceAudioFocusPolicy.reduce(
        T3VoiceAudioFocusState.ACTIVE,
        T3VoiceAudioFocusEvent.DUCK_REQUESTED,
      )
    assertEquals(
      transition(T3VoiceAudioFocusState.SUSPENDED),
      T3VoiceAudioFocusPolicy.reduce(suspended.state, T3VoiceAudioFocusEvent.DUCK_REQUESTED),
    )

    val terminated =
      T3VoiceAudioFocusPolicy.reduce(
        suspended.state,
        T3VoiceAudioFocusEvent.LOST_PERMANENTLY,
      )
    assertEquals(
      transition(T3VoiceAudioFocusState.TERMINATED),
      T3VoiceAudioFocusPolicy.reduce(terminated.state, T3VoiceAudioFocusEvent.GAINED),
    )
  }

  private fun case(
    state: T3VoiceAudioFocusState,
    event: T3VoiceAudioFocusEvent,
  ) = state to event

  private fun suspended() =
    transition(
      T3VoiceAudioFocusState.SUSPENDED,
      T3VoiceAudioFocusAction.MUTE_CAPTURE,
      T3VoiceAudioFocusAction.PAUSE_PLAYBACK,
    )

  private fun terminated() =
    transition(
      T3VoiceAudioFocusState.TERMINATED,
      T3VoiceAudioFocusAction.TERMINATE_SESSION,
    )

  private fun transition(
    state: T3VoiceAudioFocusState,
    vararg actions: T3VoiceAudioFocusAction,
  ) = T3VoiceAudioFocusTransition(state, actions.toList())
}
