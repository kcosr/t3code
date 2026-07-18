# Voice Next Steps

Status: Active working draft; the accepted end state and low-risk simplification batch are
complete. Medium-risk reductions remain deferred to separately approved slices.

This plan tracks cleanup of the implemented voice system described by
[voice.md](../docs/architecture/voice.md). It is not an architecture contract and does not authorize
new product features. Longer-term ideas are isolated in
[voice-roadmap.md](../specs/voice-roadmap.md).

## Current objective

Preserve the accepted voice behavior while removing measured incidental complexity. The completed
low-risk batch corrected as-built documentation, removed duplicate/dead data shapes, replaced a
serialization-based comparison with tested typed equality, and folded one redundant native
credential holder into its existing transfer owner.

Binder lifecycle reduction, WebRTC fencing changes, executor consolidation, shared native media
primitives, audio-route release ownership, and server registry folding are separate medium-risk
workstreams. They are not part of the current mechanical batch.

## Accepted device checkpoint

The server and verified preview APK were built and deployed from `0852af685`. Server health checks
passed, and subsequent user testing accepted the explicit-ID Realtime-to-Thread handoff, shared
audio-route controls, and the Realtime-only bottom-bar behavior.

At that revision, `vp check`, `vp run typecheck`, `vp run lint:mobile`, focused voice tests, and all
270 native JVM tests passed. The full repository run reported 5,128 passing tests and one unrelated
ProviderRegistry timing failure; that test passed when rerun in isolation.

The follow-up low-risk cleanup passed `vp check`, `vp run typecheck`, `vp run lint:mobile`, all 271
native JVM tests, and the complete `vp test` run: 654 test files and 5,131 tests passed, with only
the repository's intentional skips. Native production source moved from 13,117 lines to 13,080
lines while retaining 47 files; the purpose was concept removal and invariant preservation, not a
line-count target.

Do not reopen the full device matrix merely to repeat accepted behavior. Revalidate only paths
touched by cleanup, or expand testing when a failure supplies concrete evidence that the accepted
checkpoint was insufficient.

## Workstreams

| Workstream                         | Status   | Scope                                                                                                                          |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Accepted behavior baseline         | Complete | Explicit-ID handoff, atomic native switching, global route preference, shared controls, and unambiguous notifications.         |
| As-built documentation correction  | Complete | Journal behavior and cleanup estimates now match measured production writers and code.                                         |
| Duplicate contract/type removal    | Complete | Removed the dead public error, duplicate transcript, and duplicate native parsed-target shapes without compatibility aliases.  |
| Mechanical native pruning          | Complete | Folded retained credential storage into its transfer owner while preserving and extending invariant tests.                     |
| Typed context comparison           | Complete | Replaced serialization-based comparison with tested field-wise equality covering every current context field.                  |
| Medium-risk architecture reduction | Deferred | Binder, WebRTC fencing, executors, shared media, route-release ownership, and server registry changes require separate slices. |
| Final validation                   | Complete | Required repository gates, the native JVM suite, and the clean full repository test suite passed.                              |

## Remaining near-term work

No further implementation is active in this cleanup batch. Choose and scope any next slice
independently:

1. Decide whether to prune unused server journal kinds and other reserved/speculative contracts.
   Do not combine this API/compiler decision with native lifecycle work.
2. If further native reduction is desired, start with one measured medium-risk area and preserve
   its concurrency/lifecycle tests: binder lifecycle, WebRTC fencing, executor ownership, shared
   media primitives, or route-release ownership.
3. Consider React provider/hydration extraction only as a separate test-first maintainability
   slice; it is not required for the accepted Android behavior.

No new server or APK deployment is required for this batch because it changes internal
representation, type reuse, comparisons, tests, and documentation without changing the accepted
runtime behavior. If a later slice changes runtime behavior, commit first and deploy from that
exact revision for focused device validation.

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
