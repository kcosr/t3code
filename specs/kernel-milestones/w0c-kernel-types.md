# W0c — Kernel Type Surfaces

Milestone W0c of `specs/voice-kernel-orchestration.md`. Adds the kernel's foundational
vocabulary from `specs/native-voice-runtime-kernel.md` as NEW, compilable, UNWIRED Kotlin —
nothing existing changes, nothing constructs these yet (M1 wires them).

## Context

You are working in a git checkout already on the correct branch. Commit here; do not push
or create branches. The Kotlin toolchain is NOT available on this host — you cannot compile.
Mitigate by keeping every new file pure Kotlin/JVM (no Android framework imports anywhere,
including tests), mirroring the module's existing code style, and re-reading each referenced
spec section twice before writing.

Read first: `specs/native-voice-runtime-kernel.md` sections Terminology, The kernel
(Messages, Effects), and the epoch definition under "Fencing model". These are the
authoritative shapes; do not invent beyond them.

## Scope — new files only, flat package `expo.modules.t3voice`

All under `apps/mobile/modules/t3-voice/android/src/main/java/expo/modules/t3voice/`
(the package split is M7; stay flat like every existing file):

### 1. `VoiceKernelEpoch.kt`

- `data class VoiceKernelEpoch(val runtimeInstanceId: String, val authorityGeneration: Long,
val rootOperationId: String, val attemptOrdinal: Long)`.
- `object VoiceKernelEpochPolicy` with a pure admission function comparing the kernel's
  current epoch against the epoch echoed by an effect result. Result is a sealed
  `VoiceKernelEpochAdmission`: `Admit`, or `DropStale(dimension)` where `dimension` is an
  enum naming the FIRST mismatching field in precedence order
  `RUNTIME_INSTANCE → AUTHORITY_GENERATION → ROOT_OPERATION → ATTEMPT` (distinct staleness
  dimensions must stay distinguishable for diagnostics, mirroring the contract's distinct
  rejection reasons).
- Names must not collide with existing symbols; prefix everything `VoiceKernel`.

### 2. `VoiceKernelMessages.kt`

`sealed interface VoiceKernelMessage` with exactly these five variants, per the kernel
spec's message taxonomy:

- `Command` — carries a caller identity string and an OPAQUE payload placeholder
  (`payloadKind: String` + documentation comment stating M1 binds the real command union).
  Do NOT reference or wrap `VoiceRuntimeCommand`, `VoiceRuntimeNativeCommand`, or any
  existing command type — premature coupling is the failure mode here.
- `HostIntent` — enum-like variant for the onStartCommand action families (a nested enum
  with the action names that exist today as `ACTION_*` constants in the service's companion
  object is acceptable; copy the names, do not import the service — most are `private` and
  cannot be imported anyway). Deliberate narrowing versus the kernel spec: MediaSession
  buttons already map onto `ACTION_PRIMARY`/`ACTION_TOGGLE_MUTE`/`ACTION_STOP`, and boot
  recovery is the separate `Recover` message — you are not dropping spec names by
  enumerating only the `ACTION_*` set.
- `DriverResult` — carries `epoch: VoiceKernelEpoch`, a `driver` enum
  (`MEDIA, NET, STORE, HOST`), a `resultKind: String` placeholder, and a documentation
  comment that concrete result payloads are bound at M1/M3. Note: this driver enum and the
  effect `family` enum in `VoiceKernelEffects.kt` are two DISTINCT enum types — the driver
  set intentionally excludes `LOCAL` (Local effects execute in the kernel and never produce
  driver results); do not reuse one enum for both.
- `Tick` — `timerId: String`, `epoch: VoiceKernelEpoch`.
- `Recover` — empty marker variant with a doc comment (loaded-state payload bound at M6).

### 3. `VoiceKernelEffects.kt`

`sealed interface VoiceKernelEffect` with `val epoch: VoiceKernelEpoch`, a `family` enum
(`MEDIA, NET, STORE, HOST, LOCAL`), and one nested variant per effect NAME listed in the
kernel spec's effect taxonomy (Media: StartRecording … ObserveTimeout; Net: ThreadTurnCall
… CancelAll; Store: Persist/Load/Clear; Host: SetForeground … StopSelfIfIdle; Local:
EmitEvent/SettleCommand/ScheduleTick/CancelTick). Parameters: ONLY the epoch plus at most
one or two primitive identifiers per variant where the spec names them (e.g. `timerId` on
ScheduleTick/CancelTick, `kind` strings where the spec shows them). Everything else is a
doc comment `// payload bound at M1/M3`. Resist elaborating.

### 4. `VoiceKernel.kt`

- `data class VoiceKernelReduction(val state: VoiceKernelState, val effects:
List<VoiceKernelEffect>)` — the reducer's output (new state plus emitted effects),
  mirroring the kernel spec's `(KernelState, Message) -> (KernelState, [Effect])`. There is
  no separate "Transition" type.
- `interface VoiceKernelReducer { fun reduce(state: VoiceKernelState, message:
VoiceKernelMessage): VoiceKernelReduction }`.
- `class VoiceKernelState` as a DELIBERATELY EMPTY placeholder (single doc comment listing
  the component slots the kernel spec names — MediaArbiterState, ThreadModeState,
  RealtimeState, AuthorityReadinessState, HostState — as prose, NOT as fields or classes).
  M1/M3 add the real fields; creating empty component classes now would be speculative
  scaffolding.

### 5. `VoiceKernelEpochPolicyTest.kt` (under `src/test/java/expo/modules/t3voice/`)

JUnit4 only (this module has NO Robolectric, NO mocking framework — hand-written values
only, matching the style of e.g. `T3VoiceStartCommandPolicyTest.kt`). Table-style tests:
exact match admits; each single-field mismatch drops with the correct dimension; precedence
when multiple fields mismatch (first in precedence order wins); attempt-ordinal
monotonicity is NOT assumed (an older ordinal is simply a mismatch — the policy compares
equality, not ordering).

## Forbidden

- Modifying ANY existing file (production or test). This milestone is additive-only.
- Android framework imports (`android.*`, `androidx.*`) anywhere in the new files.
- Referencing existing runtime types (`VoiceRuntime*`, `T3Voice*`) from the new files —
  the kernel vocabulary stands alone until M1 binds it.
- Inventing payload fields, extra variants, extra enums, or helper utilities beyond what
  this packet and the kernel spec name.
- New dependencies or `build.gradle` changes.

## Verification

1. `grep -rn "android\.\|androidx\." <each new file>` → zero matches.
2. `grep -rn "VoiceKernel" apps/mobile --include="*.kt"` → matches only in the five new
   files (proves nothing existing was touched and no collisions exist).
3. `git diff --stat` shows only added files.
4. `pnpm run lint:mobile` — passes.
5. `pnpm run typecheck` — passes (TS untouched; prove it).
6. Self-review: re-read the kernel spec's Messages/Effects lists and diff them against
   your variants name-by-name; list any spec name you intentionally rendered differently
   (with reason) in the commit message.

## Done criteria

- One commit, subject `feat(voice): add kernel type surfaces`.
- Five new files, zero modified files, working tree clean.
- Kotlin compilation and the epoch policy test run happen at the pc gate; expect a
  possible follow-up fix round from that gate.
