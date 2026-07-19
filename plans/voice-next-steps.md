# Voice Next Steps

Status: Active working draft. The accepted foreground baseline, low-risk simplification batch,
Android readiness, model-tool command wrapper, and the 2026-07-19 cleanup follow-up are complete
on implementation branches; merge to `product/integration` still requires user approval where
noted.

This plan tracks cleanup of the implemented voice system described by
[voice.md](../docs/architecture/voice.md). It is not an architecture contract and does not authorize
new product features. Longer-term ideas are isolated in
[voice-roadmap.md](../specs/voice-roadmap.md).

## Current objective

Preserve accepted voice behavior while removing measured incidental complexity. Prefer one
reviewable slice at a time over large concurrent native refactors.

## Accepted device checkpoint

The server and verified preview APK were built and deployed from `0852af685`. Server health checks
passed, and subsequent user testing accepted the explicit-ID Realtime-to-Thread handoff, shared
audio-route controls, and the Realtime-only bottom-bar behavior.

Do not reopen the full device matrix merely to repeat accepted behavior. Revalidate paths touched
by later cleanup (especially WebRTC fencing) from the exact committed revision under test.

## Workstreams

| Workstream                         | Status      | Scope                                                                                                                                                             |
| ---------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accepted behavior baseline         | Complete    | Explicit-ID handoff, atomic native switching, global route preference, shared controls, and unambiguous notifications.                                            |
| As-built documentation correction  | Complete    | Journal behavior and cleanup estimates now match measured production writers and code.                                                                            |
| Duplicate contract/type removal    | Complete    | Removed the dead public error, duplicate transcript, and duplicate native parsed-target shapes without compatibility aliases.                                     |
| Mechanical native pruning          | Complete    | Folded retained credential storage into its transfer owner while preserving and extending invariant tests.                                                        |
| Typed context comparison           | Complete    | Replaced serialization-based comparison with tested field-wise equality covering every current context field.                                                     |
| Android native readiness           | Implemented | Ready controls, prepared starts, expiry fencing, race-safe no-input settlement, non-sticky cleanup (device acceptance may remain).                                |
| Model-tool command wrapper         | Merged      | Schema-defined tools, command catalog, `list_provider_models`, schema error surfacing (see product/integration history).                                          |
| Cleanup follow-up (5 slices)       | Implemented | Branch `refactor/voice-cleanup-followup` commits `053e750dc`…`9ec38064f` — hydration planner, WebRTC lease, provider extraction, dictation policy, journal prune. |
| Medium-risk architecture reduction | Deferred    | Binder, executors, shared media, route-release ownership, server registry fold — still separate.                                                                  |

## Cleanup follow-up (2026-07-19)

Branch: `refactor/voice-cleanup-followup` (base `1e0707f6d`).

1. `053e750dc` — `refactor(mobile): make thread speech hydration explicit`
2. `53a11c26f` — `refactor(mobile): consolidate realtime session fencing`
3. `585e27d4a` — `refactor(mobile): extract voice runtime interaction effects`
4. `28896b9cf` — `refactor(mobile): consolidate composer dictation policy`
5. `9ec38064f` — `refactor(voice): prune unwritten journal kinds`

Before merging: complete native JVM suite on `pc`, Keel iterative-review if required by the plan,
and device acceptance for Realtime fencing paths if an APK is rebuilt.

## Remaining near-term work

1. Integrate `refactor/voice-cleanup-followup` after review and native/device gates.
2. Android readiness device acceptance (if not already signed off on the integrated revision):
   enable/disable Ready, defaults, background/lock, headset, expiry, return-to-Ready.
3. Rebuild/install Android if the device still lacks `list_provider_models` in the native tool
   allowlist (server already emits that tool name on public events).

Further medium-risk slices remain optional and separately approved.
