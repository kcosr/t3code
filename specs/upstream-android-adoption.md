# Upstream Android Adoption

## Status

Proposed integration plan. This document records a point-in-time comparison made on 2026-07-13.
Refresh the upstream reference and repeat the dry-run merge before executing the plan.

## Goal

Adopt the maintained Android and mobile application work from `pingdotgg/t3code`, while preserving
the voice functionality developed in `kcosr/t3code`. The resulting branch must use upstream as its
foundation and retain only one final implementation for each mobile concern. It must not ship
compatibility aliases, duplicate native modules, parallel icon systems, or alternative execution
paths left over from the integration.

The target repository relationship is:

1. Current `pingdotgg/main` is the first-parent foundation.
2. The completed and tested voice feature branch is merged into a new integration branch.
3. General Android and mobile UI behavior follows upstream.
4. Voice-specific contracts, native runtime ownership, server behavior, and controls are applied at
   the upstream extension points.
5. Future feature work continues from the integrated branch.

## Point-In-Time Findings

The comparison used:

- Upstream: `pingdotgg/t3code` at `c1ec1915fc16f3dc1ec5d47d9a97f6210a574526`
- Fork branch: `feature/native-voice-runtime-ownership` at
  `e6317a8bc0fc8bf051c84ca5d75287c0d2cbdae1`
- Merge base: `f61fa9499d96fee825492aba204593c37b27e0cb`

At that point, upstream was three commits ahead of the merge base and the fork was 125 commits
ahead. A dry-run merge produced six textual conflicts. None of the 49 files modified or added in the
active, uncommitted voice-runtime worktree overlapped the 168 files changed by the new upstream
Android work. This reduces direct source conflict, but it does not remove the need for behavioral and
visual regression testing.

The dry-run conflict set was:

- `apps/mobile/app.config.ts`
- `apps/mobile/src/Stack.tsx`
- `apps/mobile/src/components/ComposerToolbarTrigger.tsx`
- `apps/mobile/src/features/home/HomeHeader.tsx`
- `apps/mobile/src/features/home/HomeRouteScreen.tsx`
- `pnpm-lock.yaml`

## Preconditions

Do not begin integration while the native voice ownership work is uncommitted or under active
development. First:

1. Complete the Android-native Active Thread and Realtime ownership milestone.
2. Run its focused and repository-required tests.
3. Commit and push the complete voice branch.
4. Record the exact commit that passed testing.
5. Confirm the shared worktree is clean except for explicitly documented user-owned files.
6. Fetch the latest `pingdotgg/main` and update the references in this document if upstream moved.

## Branch Strategy

Create the integration branch from upstream, then merge the completed voice branch into it. Do not
rebase 125 commits individually: that would repeatedly expose historical conflicts and add risk
without improving the final source tree.

Illustrative commands, with the final branch and remote names substituted as appropriate:

```bash
git fetch upstream main
git fetch origin feature/native-voice-runtime-ownership
git switch --create integration/upstream-android upstream/main
git merge --no-ff origin/feature/native-voice-runtime-ownership
```

The merge commit should describe the integration decisions rather than presenting the result as a
mechanical upstream sync. Resolve and validate all conflicts before committing it.

## Conflict Resolution

### Expo Configuration

Use upstream's updated Expo configuration as the base, including:

- `expo-asset`
- quick actions
- Android Gradle heap configuration
- modern Android popup and alert styling
- predictive-back compatibility
- conditional iOS personal-team behavior

Preserve the fork's `withAndroidNetworkSecurity.cjs` instead of upstream's
`withAndroidCleartextTraffic.cjs`. The fork plugin both permits required development traffic and
trusts system and user certificate authorities. User-installed CA trust is required for the current
`https://termstation` development origin. Do not register both plugins.

Verify the merged Android manifest retains the voice module's microphone, foreground-service,
notification, Bluetooth, and media-playback requirements.

### Root Navigation And Providers

In `Stack.tsx`, retain upstream's app-shortcut handling and navigation changes. Add the voice settings
route and wrap the application workspace in the canonical voice runtime provider. Preserve exact
thread focus and environment selection, but do not restore an Android React execution owner after the
native-runtime cutover. React remains command and presentation state on Android.

Provider nesting must leave `HomeListOptionsProvider`, shortcut navigation, connection state, and
voice focus available without creating two instances of any provider.

### Symbols And Composer Controls

Adopt upstream's `AppSymbol` abstraction and its `className` support in
`ComposerToolbarTrigger.tsx`. Remove the fork's separate `platformSymbolName` path after all callers
have migrated.

Extend the Android symbol map for every symbol used by voice surfaces. At minimum, audit mappings for:

- microphone and muted microphone
- waveform and active waveform
- speaker, muted speaker, and audio route
- headphones
- history
- stop, close, retry, and confirmation
- timers and diagnostic/settings rows

`AppSymbol` returns no visible icon when an Android mapping is absent. Missing mappings therefore
cause functional controls to appear blank and must be treated as test failures.

### Android Home Header

Use upstream's dedicated Android home header and settings control. Remove the fork's older Android
header workaround rather than preserving both. Retain iOS behavior and any voice navigation that is
still required.

The upstream Android header contains a visible gear button with the accessibility label
`Open settings`. Preserve that button and its navigation to the root Settings screen. The merged
Settings screen must also retain the fork's Voice row and `SettingsVoice` destination. Verify access
from the normal phone home layout and from any split/sidebar layout where the home header is replaced;
there must always be a visible route to Settings without first opening a thread.

### Home Route And Voice Bar

Use upstream's `AndroidHomeFabLayout`. Preserve stable settings navigation and the global voice
provider behavior. The voice bar should remain a normal bottom layout participant so the home FAB is
positioned above it, not underneath or on top of it.

Test the inactive, connecting, active, error, and history-only voice bar states with the Android FAB,
keyboard, navigation bar, and safe-area inset present.

### Lockfile

Resolve `pnpm-lock.yaml` by regenerating it from the final merged package manifests. Do not select
either side's lockfile wholesale.

## Automatically Merged Areas Requiring Review

A conflict-free merge does not establish semantic compatibility. Review these areas explicitly:

- `ThreadComposer` and its toolbar layout
- `ThreadRouteScreen`
- settings navigation and voice settings rows
- bottom input padding and keyboard behavior
- native composer editor integration
- terminal and review-diff native modules
- notification and headset entry points
- Android process/background lifecycle
- React attachment to an already active native runtime

Voice controls must use upstream's component and symbol conventions without moving media ownership
back into React.

## Android Build Risks

Upstream adds native implementations for composer editing, native controls, review diff, and the
terminal. The terminal includes CMake/NDK compilation and approximately 4.65 MB of raw multi-ABI
`libghostty-vt` libraries.

Confirm the Android build host has the required NDK and CMake version. Continue using the documented
preview build command with official Node 24, Java 21, the Android SDK, and a clean Expo prebuild.

Upstream's Gradle plugin configures a 4 GiB heap and 1 GiB metaspace. The local build host has
previously required 2 GiB metaspace. Retain the explicit local build override or raise the generated
configuration after validating that it is appropriate for other environments.

Inspect the final APK package, signature, archive integrity, source revision, and checksum before
installation.

## Validation

### Static And Unit Validation

Run the repository-required checks on the integrated branch:

```bash
vp check
vp run typecheck
vp run lint:mobile
```

Run focused mobile, voice contract, native runtime, server voice, persistence, and migration tests.
Also run upstream's Android shortcut, terminal, composer, navigation, and UI component tests affected
by the merge.

### Android Build And Smoke Test

Build the preview APK on `pc` from the exact committed integration revision. Install it in place so
pairing and local certificate state are preserved.

Smoke-test upstream Android functionality:

1. Launch, pairing, connection, and environment switching.
2. Thread list, search, filtering, the visible Settings gear, the Voice settings destination, and the
   new-task FAB.
3. Thread composer, keyboard, attachments, and native editor.
4. Terminal input/rendering and review diff.
5. Predictive back, popup menus, confirmation dialogs, and app shortcuts.

Smoke-test voice functionality:

1. Start and stop Realtime from the application, notification, and headset.
2. Start Active Thread voice from the same entry points.
3. Lock and background the phone during both modes.
4. Attach the UI to a native session started while React was unavailable.
5. Switch Realtime to a thread and complete the handoff.
6. Exercise dictation, auto rearm, streaming TTS, interruption, and draft completion.
7. Confirm route selection, cues, notification permission, microphone permission, and Bluetooth.
8. Verify every voice control has a visible Android icon and accessibility label.
9. Connect through `https://termstation` using the installed local CA.
10. Inspect logcat and server diagnostics for crashes, duplicate execution, stale authority, or media
    ownership errors.

### Visual Validation

Capture Android screenshots for the home screen, active thread, voice history, voice settings,
Realtime active state, and Active Thread recording state. Check that:

- the home FAB and voice bar do not overlap;
- the keyboard does not cover voice controls;
- bottom insets remain correct;
- header controls remain usable;
- icons are visible in light and dark themes;
- dialogs and menus remain legible and correctly layered.

## Completion Criteria

The adoption is complete only when:

- the integrated branch has current upstream as its first-parent foundation;
- all six conflicts are resolved intentionally;
- the old symbol translation path and obsolete Android header workaround are removed;
- only one Android voice execution owner exists for each mode;
- no legacy or alias APIs were introduced for the merge;
- repository checks and focused tests pass;
- the committed preview APK builds and passes device smoke testing;
- server and mobile continue to work through the existing LAN HTTPS origin;
- the integration branch is pushed and ready to become the base for web/desktop voice work.

## Follow-Up

After adoption and a short Android stabilization period, implement the React-backed `VoiceRuntime`
adapter for web and desktop on top of the integrated shared contracts. Browser voice may remain bound
to the page lifecycle; a packaged desktop application can later provide persistent runtime ownership
without changing the shared command, snapshot, receipt, or presentation contracts.
