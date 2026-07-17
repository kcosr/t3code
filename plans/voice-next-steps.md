# Voice Next Steps

Status: Active working draft.

This plan tracks cleanup of the implemented voice system described by
[voice.md](../docs/architecture/voice.md). It is not an architecture contract and does not authorize
new product features. Longer-term ideas are isolated in
[voice-roadmap.md](../specs/voice-roadmap.md).

## Current objective

Reduce the voice implementation to the smallest clear end state without changing the tested product
behavior:

- the composer microphone remains one-shot dictation into the draft;
- the composer waveform remains Thread voice / Auto Listen;
- the bottom call bar remains Realtime-only;
- Realtime and Thread remain native-owned on Android;
- both native mode-switch directions preserve exact single-owner quiescence; and
- notification and MediaSession controls continue to operate while React is detached.

## Accepted device checkpoint

The deployed `7372e5742` baseline was accepted after user testing of the corrected control ownership
and Thread-to-Realtime Resume behavior. Treat the foreground/background and notification validation
checkpoint as sufficient for the current cleanup cycle.

Do not reopen the full device matrix merely to repeat it. Revalidate a focused path when cleanup
changes that path, or expand testing when a failure supplies concrete evidence that the checkpoint
was insufficient.

## Workstreams

| Workstream                        | Status      | Scope                                                                                                                                                 |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation consolidation       | Complete    | Established one as-built document, this active plan, and one non-authoritative roadmap; removed competing voice authority documents.                  |
| Realtime presentation cleanup     | Complete    | Removed dead global phase state, retained one Realtime-bar classifier, removed redundant mode guards, and stabilized empty transcript data.           |
| Realtime admission cleanup        | Complete    | Reserved Resume selection under the shared start transition and consolidated duplicated Realtime start/switch preparation, types, and native parsing. |
| Native transition cleanup         | Complete    | Removed duplicated pending target data, obsolete transient publications, and the one-value Thread-to-Realtime phase hierarchy.                        |
| Native mechanical deduplication   | Complete    | Reused starting/stopping state construction and enum bridge naming where the result is smaller and clearer.                                           |
| Diagnostics cleanup               | Complete    | Confirmed temporary milestone tracing is absent while retaining the bounded Android diagnostic ring and privacy-safe server logs.                     |
| Dead-code and naming sweep        | Complete    | Removed obsolete exports and stale `MasterVoice` ownership names without compatibility aliases or dual contracts.                                     |
| Final verification and deployment | In progress | Required static, type, focused voice, and native JVM checks pass; full repository tests, exact-revision builds, deployment, and focused smoke remain. |

## Detailed scope and definition of done

### 1. Realtime presentation cleanup

Scope:

- Remove `MasterVoicePhase`, `voiceRuntimePresentationPhase`, and the unused context `phase` field.
- Define the Realtime call-bar phase directly and use it as the single ownership classifier.
- Derive labels from that classifier rather than repeating snapshot-mode switches.
- Remove callback guards made redundant by conditional rendering.
- Use stable empty Realtime transcript data outside Realtime snapshots.

Definition of done:

- No consumer-visible behavior changes.
- Thread snapshots still render the idle/resumable Realtime bar.
- Realtime failures still render the error/stop surface.
- Shared presentation tests cover the remaining classifier.

### 2. Realtime admission cleanup

Scope:

- Ensure paginated Resume selection owns or remains cancellable by the same exclusive start
  transition used for native admission.
- Prevent another start from winning while Resume continues unnecessary page requests.
- Share permission, notification, Bluetooth, prepared-connection, and child-session preparation
  between initial Realtime start and Thread-to-Realtime switch.
- Collapse identical bridge input types and native target/session parsing.

Definition of done:

- Exactly one start path can proceed at a time.
- A losing path stops work before credential issuance and native admission.
- React issues one Realtime admission operation; Android selects initial start or Thread handoff
  from the current native mode at the bridge boundary.
- Race and adapter tests cover Resume cancellation and both admission outcomes.

### 3. Native transition cleanup

Scope:

- Retain only the private credential/session data that cannot appear in a public switching snapshot.
- Derive the Realtime target from the typed controller state instead of duplicating it in pending
  state.
- When a pending Thread start has not acquired native resources, advance directly to Realtime rather
  than publishing a transition snapshot that is immediately obsolete.
- Evaluate whether the single-value Thread-to-Realtime stage types add useful invariants; remove them
  if the transition state itself is sufficient.

Definition of done:

- Thread-to-Realtime still waits for exact Thread release whenever Thread acquired resources.
- Stop still cancels the pending Realtime start.
- Duplicate switch admission remains harmless.
- Credentials never enter snapshots, diagnostics, or persisted state.
- Controller, bridge, notification, and adapter tests pass with fewer duplicated state fields.

### 4. Mechanical cleanup and dead-code sweep

Scope:

- Reuse small state factories only where they remove repeated defaults without hiding transitions.
- Consolidate repeated enum-to-bridge naming while retaining deliberate special mappings.
- Search for obsolete native revisions, bridge methods, runtime shapes, unused exports, and stale UI
  ownership terminology.
- Delete obsolete code directly; do not retain migration shims.

Definition of done:

- No old and new contract shapes coexist.
- No dead voice exports or unused presentation state remain.
- The controller remains readable as an explicit state machine rather than a generic framework.

### 5. Diagnostics cleanup

Scope:

- Distinguish temporary device-pass milestone tracing from durable operational diagnostics.
- Remove any remaining temporary milestone-only events or helpers.
- Retain the bounded native diagnostic ring and curated server lifecycle/media logs.
- Recheck that content-bearing fields cannot enter either path.

Definition of done:

- No temporary trace layer remains.
- Troubleshooting still has bounded lifecycle, endpoint, route/focus, timing, byte-count, and outcome
  evidence.
- Tests continue to reject transcript, audio, SDP, credential, provider payload, and tool content.

### 6. Final verification and deployment

Definition of done:

- `vp check` passes.
- `vp run typecheck` passes.
- `vp run lint:mobile` passes for native changes.
- `vp test` passes.
- The complete native JVM suite passes.
- The final source is committed before building release artifacts.
- Server and preview APK are built from that committed revision.
- APK package, signature, archive integrity, source revision, and checksum are verified before an
  in-place install.
- Focused device smoke tests cover every user-visible path changed during cleanup.

## Exclusions

This cleanup does not include:

- new voice features from the roadmap;
- web, desktop, or iOS voice adapters;
- a second voice provider;
- Realtime transcription;
- automatic summarization or transparent provider-call replacement;
- Android process-death recovery or durable mode-switch transactions;
- always-on or wake-word capture;
- a React-owned Android fallback state machine; or
- compatibility aliases for removed voice contracts.

If cleanup exposes a behavior defect, fix and test that defect within the existing design. If the
fix would expand product behavior or authority boundaries, stop and create a separate approved spec.
