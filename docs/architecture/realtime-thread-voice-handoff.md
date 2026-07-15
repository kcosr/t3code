# Realtime-to-Thread Voice Handoff

## Goal

Allow the Realtime voice agent to transfer the user into traditional voice capture for a selected thread. Traditional capture starts in waveform mode with auto-rearm enabled, while the Realtime transport terminates cleanly.

The handoff must:

- Complete the Realtime tool call in durable conversation history.
- Avoid generating an unnecessary final assistant response.
- Decouple server teardown from client capture startup.
- Prevent simultaneous microphone or audio-focus ownership.
- Preserve enough state to resume the durable Realtime conversation later.
- Record whether client-side capture ultimately started.

## Tool Contract

```json
{
  "name": "handoff_to_thread_voice",
  "description": "End this Realtime interaction and start auto-rearming voice capture for a selected standard thread.",
  "arguments": {
    "projectId": "...",
    "threadId": "..."
  }
}
```

The tool instructions should say:

> Call this tool as your final action when the user asks to switch to standard thread voice. Do not speak before or after calling it unless clarification is required.

The server must enforce terminal behavior rather than relying solely on the model instructions.

## Server Flow

1. Receive and validate the tool call, target thread, authorization, and active client lease.
2. Persist the tool call in the durable conversation journal.
3. Create a durable handoff action in the non-deliverable `prepared` state.
4. Submit a successful provider tool result:

   ```json
   {
     "status": "accepted",
     "threadId": "...",
     "message": "Realtime is ending and the client will start thread voice capture."
   }
   ```

5. Wait for the provider's matching `conversation.item.created` acknowledgement.
6. Reserve the handoff-only native authority and atomically activate the durable action as
   `pending`. Teardown must retain that authority even when it races activation.
7. Do not issue `response.create` or permit another Realtime response.
8. Cancel any active provider response and audio output.
9. Emit a targeted client action:

   ```json
   {
     "type": "client-action",
     "action": "handoff-to-thread-voice",
     "actionId": "...",
     "projectId": "...",
     "threadId": "...",
     "autoRearm": true
   }
   ```

10. Begin bounded Realtime teardown independently of client execution.
11. Finalize the session with `endReason: "handed-off-to-thread-voice"`.

The result is `accepted`, not `completed`, because the server cannot guarantee that Android successfully acquired the microphone. Sending and persisting this result prevents a resumed conversation from containing an unresolved tool call.

## Client Flow

Upon receiving the action, Android should:

1. Resolve the target thread locally.
2. Prepare traditional recognition without acquiring the microphone.
3. Stop Realtime output and disable its microphone track.
4. Close the peer connection and release Realtime audio focus.
5. Start waveform recognition.
6. Enable auto-rearm for this handoff's subsequent TTS and recognition cycles.
7. Acknowledge the client action with the final outcome.
8. Notify React to navigate to the target thread when a visible UI runtime exists.

Traditional capture must not acquire the microphone before Realtime media ownership is released.
Navigation is ancillary and does not define handoff success: background and screen-off operation
must succeed while React is suspended or absent. The handoff-specific `autoRearm` value is an
activation policy and must not silently overwrite the user's persisted default.

Success:

```json
{
  "actionId": "...",
  "outcome": "succeeded",
  "state": "listening"
}
```

Failure:

```json
{
  "actionId": "...",
  "outcome": "failed",
  "stage": "recognition-start",
  "reason": "microphone-unavailable"
}
```

Useful native failure stages are `target-resolution`, `realtime-release`, `audio-focus`, and
`recognition-start`. Diagnostics must not contain audio or transcript content. `navigation` is a UI
diagnostic only and cannot turn an otherwise successful native handoff into a failed handoff.

## Durable Client Action

The handoff action and its outcome must outlive the Realtime runtime session. They cannot exist only
in the session's in-memory event buffer or require a nonterminal Realtime lease for acknowledgement.
The server prepares the action before provider acknowledgement, makes it pollable only after that
acknowledgement, and targets it to the lease-owning device. A scoped
native action channel can poll, claim, and acknowledge pending actions after provider media and the
Realtime session have ended.

Action delivery and acknowledgement are idempotent by `actionId`. Redelivery must never start a
second recording. A conflicting second acknowledgement is rejected, while an identical
acknowledgement returns the stored result. Expiry stores one terminal failure outcome rather than
deleting the action.

The native action channel uses a revocable, environment-scoped runtime grant fenced by auth session,
Realtime session, and lease generation. The server stores only its SHA-256 hash. The grant authorizes
only session control and handoff action polling/acknowledgement; terminal teardown removes session
control while retaining handoff authority. A successful acknowledgement or terminal failure revokes
the remaining grant.

The current milestone retains the plaintext grant and replayable handoff envelope in the Android
service process. It survives React remounts and service rebinding, but not Android process death.
Keystore-backed persistence of the grant, environment origin, deadline, and pending envelope belongs
to the React-independent background execution milestone. Until then, process death causes the durable
server action to expire rather than allowing an unfenced recovery.

## Persistence and Resume

The durable journal should contain the tool call, accepted tool result, eventual client outcome, and intentional Realtime end reason.

```json
{
  "phase": "ended",
  "endReason": "handed-off-to-thread-voice",
  "targetThreadId": "...",
  "handedOffAt": "..."
}
```

Resuming Realtime later creates a new provider and WebRTC transport for the same durable conversation. It must not resurrect the previous transport or repeat the handoff action. Compiled context may include a concise statement indicating whether the client-side handoff succeeded.

## Performance and Ownership

To minimize transition latency:

- Prepare recognition configuration before releasing Realtime.
- Cancel provider audio immediately after accepting the tool.
- Emit the client action without waiting for complete server teardown.
- Release media and audio focus through one native state-machine transition.
- Start capture as soon as native media release completes.
- Perform remaining server cleanup asynchronously.

The native runtime should own the transition so foreground UI, notification controls, screen-off operation, and future headset controls use the same state machine:

```text
realtime-active
  -> handoff-preparing
  -> realtime-releasing
  -> thread-voice-starting
  -> thread-voice-listening
```

The terminal failure state is `handoff-failed`.

React, notification actions, and future MediaSession callbacks issue typed commands to one native
command processor. They do not maintain parallel media-transition state machines.

## Timeout Semantics

Use separate bounded timeouts for provider tool-result acknowledgement, Realtime teardown, and client-action completion. Server cleanup must not block traditional capture.

A client timeout records a failed handoff outcome but does not undo the completed provider tool call. This keeps resumed conversation history coherent while allowing server teardown and client startup to remain decoupled.

## Addendum: Drain Final Realtime Speech Before Handoff

OpenAI may generate audio and the terminal function call in the same response. Provider
`response.done` means generation has completed; it does not prove that Android has finished playing
audio already buffered by WebRTC. Immediately closing the provider and peer connection can therefore
cut off a short final sentence while it is audible to the user.

The handoff must treat final output drainage as part of the native media transition:

1. Accept, acknowledge, and persist the terminal tool result as described above. The provider
   terminal latch continues to prohibit another `response.create`, tool call, or assistant turn.
2. Publish the durable handoff action while the existing Realtime media path remains available for
   bounded output drainage.
3. Android enters `handoff-draining` and observes local Realtime playout rather than assuming that
   provider generation completion means playback completion.
4. After approximately 300-500 ms of output silence, Android stops Realtime, releases its audio
   focus, and starts thread capture through one native state-machine transition.
5. Bound drainage to approximately 2-3 seconds. If output does not become quiet, fade or stop it and
   proceed so model speech cannot indefinitely block the requested handoff.
6. Android acknowledges media release and capture startup. Server teardown may complete after that
   acknowledgement or after its independent maximum deadline.

When no output is buffered, the transition remains immediate. Do not replace output detection with
an unconditional delay: that would slow silent handoffs and still fail for unusually long buffered
speech.

The tool instructions should continue to tell the model to invoke the handoff without narrating it;
the client can provide a deterministic visual state, haptic, or brief earcon. Prompting is only a UX
optimization, not the correctness mechanism, because mixed audio and function-call output can still
occur.

This addendum supersedes the earlier recommendation to cancel provider audio immediately after tool
acceptance. New provider generation is still cancelled or fenced immediately, but audio already in
the client playout path receives the bounded drain window above.
