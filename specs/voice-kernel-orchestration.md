# Voice Kernel Rework — Orchestration Plan

Status: Active execution plan for delivering `specs/native-voice-runtime-kernel.md` plus the
voice auth unification that precedes it. Companion documents:
`specs/native-voice-runtime-kernel.md` (the design), `specs/voice-auth-unification.md` (M0,
to be drafted), `docs/architecture/voice-workstreams.md` (the broader voice roadmap this
slots into).

## Decisions

1. **M0 — voice auth unification comes first.** The voice runtime grant / media ticket /
   refresh-rotation subsystem is removed. The native runtime authenticates as the paired
   client itself: same durable client session, same `/oauth/token` access-token refresh,
   standard `EnvironmentAuthenticatedAuth` + `voice:use` on all voice endpoints. Rationale:
   the native service and React are one app (same UID/sandbox/Keystore); a second derived
   identity is a parallel auth stack with no enforceable boundary. The only residual loss —
   scope minimization for a compromised native process — is judged worthless because the full
   credential is readable from the same sandbox regardless. OpenAI credentials remain
   server-side, unchanged. Authority _generation_/target state survives as plain coordination
   data (lease state), not credentials. M0 has its own spec because it changes server
   contracts, which the kernel spec excludes.
2. **Implementation is executed by codex (`gpt-5.6-sol`, reasoning `medium`) through Keel;
   Claude (this session's agent) is the orchestrator.** The orchestrator authors
   per-milestone implementation packets containing the detailed instructions and invariants,
   launches runs, adjudicates reviews, integrates, and drives device gates. Medium reasoning
   is sufficient for the implementer because packets remove the judgment calls.
3. **Workflow: `implement-review-loop` targeting this checkout
   (`/home/kevin/worktrees/t3code`) directly, switched to the milestone's stack branch.**
   Not `branch-worktree-implement-review`, and no per-milestone worktrees. Rationale:
   Keel's generated branches would require translating `keel/<hash>/...` refs into the
   repo's stacked-branch convention, and Keel's `workspace merge` is a final-tree patch
   that destroys commit history. Editing the real checkout puts the implementer's commits
   directly on the stack branch — integration is review + push. The milestone chain is
   serial, so parallel-run capacity is not needed; a temporary worktree is created only if
   a genuinely concurrent need appears mid-run. Disciplines that make single-dir safe:
   (a) commit packet/spec files before launching so the tree is clean; (b) while a run is
   active the checkout belongs to the run — orchestrator activity there is read-only, with
   drafts staged in scratch space and committed between runs; (c) a failed run is recovered
   by resetting the milestone branch. A custom workflow is deferred until a concrete
   friction appears.
4. **Reviews:**
   - Inside each Keel run: the default read-only reviewer (`claude-default`, Opus 4.8 xhigh)
     iterates with the implementer unattended for up to 10 rounds.
   - Specs, packets, and post-integration gates: direct Opus subagents spawned by the
     orchestrator, resumed across cycles via continued agent conversations. Keel's
     `spec-review-loop` / `iterative-review` are not used — the orchestrator is already
     driving, so a parked Keel reviewer adds indirection without capability. Review
     correspondence is recorded in the spec files (timestamped sections) so reviewer context
     survives orchestrator sessions.
5. **The ui-attached TypeScript voice path is preserved** (seed of the React-backed
   desktop/web adapter). Milestone M5 removes only its Android-native reachability.

## Milestones

| #   | Item                                                                                                                                  | Depends on                     | Parallel?                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------- |
| W0a | Dead code removal (`executeRealtimeHandoff` + `completionLock`, zero-caller bridge functions)                                         | —                              | no — short sequential runs |
| W0b | Recovery characterization tests against the current implementation (expand 6 scenarios toward the fixture matrix)                     | W0a                            | no                         |
| W0c | Kernel type surfaces: message/effect/epoch definitions + unwired kernel skeleton                                                      | W0b                            | no                         |
| M0  | Voice auth unification (`specs/voice-auth-unification.md`)                                                                            | W0 merged                      | no                         |
| M1  | Mailbox ingress (kernel thread; binder/intents/media-button routed through it; interrupt lane + stop tombstones deleted)              | M0                             | no                         |
| M2  | State capture: callbacks onto mailbox, `operationLock` deleted. Device soak gate.                                                     | M1                             | no — ships alone           |
| M3  | Driver extraction (Media/Net/Store/Host); realtime engine → sub-reducer                                                               | M2                             | no                         |
| M4  | Epoch consolidation; delete local fencing families                                                                                    | M3                             | no                         |
| M5  | Bridge cutover (delete unreachable surface; pending/ack → completion handles + retained records; `nativeRevision` bump). Device gate. | M4                             | no                         |
| M6  | Recovery as pure function + fixture matrix; service shrinks to host                                                                   | M2 (fixtures reusable earlier) | partially                  |
| M7  | Package split                                                                                                                         | M6                             | no                         |

The whole chain is serial: M1–M6 all rewrite `T3VoiceRuntimeService.kt`, and W0 runs are
small enough that sequential execution beats worktree ceremony. The orchestrator pipelines
around the runs — authoring packet N+1 and adjudicating reviews while run N executes.

## Per-milestone cycle

1. **Base**: stack tip committed, checkout switched to the new milestone branch. Stack
   branches are human-named (`feature/voice-auth-unification`, `feature/voice-kernel-m1`,
   ...), each created from the reviewed predecessor per repo convention. First
   prerequisite: a stabilization commit on `feature/native-voice-runtime-ownership`
   (currently dirty).
2. **Packet**: orchestrator writes `specs/kernel-milestones/<mN>-<name>.md` — scope, files
   with line-referenced seams, invariants, forbidden changes, test expectations, done
   criteria. Reviewed by an Opus subagent, then committed before launch (clean tree).
3. **Launch**:

   ```bash
   KEEL_ADMIN_TOKEN=token ~/.bun/bin/keel workflow run implement-review-loop \
     --target /home/kevin/worktrees/t3code \
     --input '{
       "spec": "/home/kevin/worktrees/t3code/specs/kernel-milestones/<mN>-<name>.md",
       "implementerProfile": "codex-gpt-5-6-sol-fast",
       "completionChecks": [
         {"key": "typecheck", "type": "command",
          "command": "bash", "args": ["-lc", "pnpm run typecheck"], "timeoutMs": 1200000},
         {"key": "lint-mobile", "type": "command",
          "command": "bash", "args": ["-lc", "pnpm run lint:mobile"], "timeoutMs": 600000},
         {"key": "committed", "type": "has-commits", "baseRef": "<stack-tip-sha>"},
         {"key": "clean", "type": "git-clean"}
       ]
     }' --output json
   ```

   No `branch-pushed` check — pushes to `kcosr/t3code` are performed only by the
   orchestrator. Command checks are wrapped in `bash -lc` because the keel daemon's
   systemd unit PATH omits `/home/kevin/.local/bin` (where pnpm lives); the login shell
   restores the user PATH. The durable fix is adding that directory to
   `keel-daemon.service` PATH and restarting the daemon — deferred because a daemon
   restart affects Keel runs outside this workstream. Adjust command checks per milestone (JS-touching milestones add targeted
   `vp check` scopes).

4. **Adjudicate at park**: inspect `git diff <base>...`; spawn adversarial Opus subagents
   (spec-conformance, concurrency, deletion-completeness lenses); signal
   `implementation-completion` with `continue` + instructions, or `complete`.
5. **Post-integration gate** (host split per `~/agent-context/repos/t3code/ANDROID_BUILD_ON_PC.md`):
   - `srv`: never runs Expo prebuild or APK assembly.
   - Push the stack branch; on `pc`: clean preview prebuild, `assembleRelease` with the
     documented Node 24 PATH / JAVA_HOME / memory overrides, Kotlin unit tests, artifact
     verification.
   - Device (from `srv`): `adb install -r` only — never uninstall, never clear app data;
     persisted voice-runtime state is part of the recovery test cases. M2 soak and M5
     cutover checks run here.
   - A failure after integration goes through a fresh short run against the same stack tip,
     not by reopening the parked run.
6. **Advance**: create the next milestone branch from the completed one and switch the
   checkout to it. Never launch milestone N+1 while N is ungated.

## Profiles and models

- Implementer: `codex-gpt-5-6-sol-fast` — a profile to be created once via
  `keel profiles set codex-gpt-5-6-sol-fast --create --file -` with
  `{provider: codex, model: gpt-5.6-sol, reasoning: medium, providerConfig: {codex:
{serviceTier: "fast", transport: {type: "stdio"}}}}`. Service tier is a profile-level
  setting (`providerConfig.codex.serviceTier`, values `fast | normal`); the workflow input
  cannot pass it. Reasoning defaults to `medium` in the profile; `implementerReasoning`
  remains available as a per-run override for milestones that warrant more.
- In-loop reviewer: `claude-default` (Opus 4.8, xhigh) — default, no override needed.
- Orchestrator-side reviewers: Opus subagents with continued-conversation resumption.

## Open items

- Draft `specs/voice-auth-unification.md` (M0): decision record (including the accepted
  scope-minimization tradeoff), endpoint removals, deletion inventory, superseded sections
  of `specs/native-voice-runtime-ownership.md`.
- Amend `specs/native-voice-runtime-kernel.md` after M0 is accepted: StoreDriver loses the
  grant cipher/refresh stores; `Recover` loses the corresponding fence inputs; "hard case C"
  (distributed authority chain) largely dissolves.
- Stabilization commit on `feature/native-voice-runtime-ownership` before W0 launches.
- W0 packet drafts; decide per-milestone `vp check` scopes for command checks.
