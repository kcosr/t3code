# Voice Next Steps

Status: Active working draft; the end-state implementation is present and focused validation remains.

This plan tracks cleanup of the implemented voice system described by
[voice.md](../docs/architecture/voice.md). It is not an architecture contract and does not authorize
new product features. Longer-term ideas are isolated in
[voice-roadmap.md](../specs/voice-roadmap.md).

## Current objective

Finish and verify the smallest end state for two related control contracts:

- one native-persisted audio-route preference is shared by the bottom call bar and Voice Settings
  and applies to one-shot dictation, Thread voice, and Realtime;
- `switch_to_thread_voice` requires an explicit `threadId`, the server resolves the complete target,
  and Android performs the Realtime-to-Thread ownership transition without React;
- React only reconciles navigation after a native switch; and
- notifications retain controls that have an unambiguous native meaning and do not infer a Thread
  from current or last-used UI state.

## Accepted device checkpoint

The deployed `7372e5742` baseline was accepted after user testing of the corrected control ownership
and Thread-to-Realtime Resume behavior. Treat the foreground/background and notification validation
checkpoint as sufficient for the current cleanup cycle.

Do not reopen the full device matrix merely to repeat it. Revalidate a focused path when cleanup
changes that path, or expand testing when a failure supplies concrete evidence that the checkpoint
was insufficient.

The cleanup deployment at `dd2bde9b0` passed static checks, full typecheck, native lint, focused
voice tests, the native JVM suite, and the full 4,960-test repository suite. The server and preview
APK were built from that revision, both server health endpoints passed, and the verified APK was
installed in place on the Pixel 9. Post-install process and error-log checks passed; the securely
locked device prevented an additional UI-driven voice call, so the earlier accepted functional
checkpoint remains the device evidence for this cycle.

## Workstreams

| Workstream                         | Status      | Scope                                                                                                                           |
| ---------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Earlier simplification cycle       | Complete    | Presentation, admission, transition-state, diagnostics, naming, and dead-code cleanup described by the accepted baseline above. |
| Explicit-ID agent handoff          | Implemented | Require `threadId`, resolve and authorize the full target on the server, and publish one discriminated terminal action.         |
| Native atomic handoff              | Implemented | Consume the resolved target, drain and release Realtime, start Thread voice, and let React reconcile navigation from snapshots. |
| Global native audio preference     | Implemented | Persist one route choice and apply it across Realtime, Thread voice, and one-shot dictation with non-destructive fallback.      |
| Shared route controls              | Implemented | Keep the convenience selector in the Realtime bar and expose the same native preference in Voice Settings.                      |
| Notification destination semantics | Implemented | Remove inferred current/last-Thread switching; notification controls remain state-derived and unambiguous.                      |
| Contract and regression validation | Remaining   | Run focused server, shared-runtime, Android bridge/controller, audio-routing, and UI tests for the changed contracts.           |
| Device validation and deployment   | Remaining   | Build exact committed source, install in place, and exercise the changed handoff and routing paths on the Pixel.                |

## Remaining near-term work

### 1. Focused automated coverage

- Prove that a missing, unknown, unauthorized, or ineligible `threadId` cannot publish a native
  switch action.
- Prove that the resolved target survives terminal-action serialization and starts the exact Thread
  while React is detached.
- Prove that React follows a completed native switch once without becoming a second transition
  owner or continuously forcing navigation.
- Cover preferred-route persistence, temporary device loss, system fallback without preference
  deletion, and preference reapplication.
- Cover route selection from both UI surfaces and application by all three native voice paths.

### 2. Repository gates

- Run `vp check`.
- Run `vp run typecheck`.
- Run `vp run lint:mobile`.
- Run focused voice suites and `vp test`.
- Run the complete native JVM suite.

### 3. Exact-revision deployment and device smoke test

- Commit before building the server or APK.
- Build and deploy the server and preview APK from that exact revision.
- Verify APK package, signature, archive integrity, source revision, and checksum before installation.
- Confirm that the route button remains available when Realtime is idle and matches Voice Settings.
- Select routes from each UI surface and exercise one-shot dictation, Thread voice, and Realtime,
  including temporary route unavailability where practical.
- From Realtime, invoke `switch_to_thread_voice` with a non-visible Thread ID and confirm native
  handoff plus subsequent UI reconciliation in foreground and background cases.
- Confirm the notification offers no guessed Thread-switch action.

### 4. Closeout

- Reconcile this plan with observed device behavior and any fixes.
- Mark validation and deployment complete only after their evidence exists.
- Keep [voice.md](../docs/architecture/voice.md) limited to implemented behavior and move any
  unapproved feature ideas to the roadmap.

## Exclusions

This work does not include:

- new voice features from the roadmap;
- web, desktop, or iOS voice adapters;
- a second voice provider;
- Realtime transcription;
- automatic summarization or transparent provider-call replacement;
- Android process-death recovery or durable mode-switch transactions;
- notification-initiated Thread voice based on a remembered current or last-used Thread;
- always-on or wake-word capture;
- a React-owned Android fallback state machine; or
- compatibility aliases for removed voice contracts.

If cleanup exposes a behavior defect, fix and test that defect within the existing design. If the
fix would expand product behavior or authority boundaries, stop and create a separate approved spec.
