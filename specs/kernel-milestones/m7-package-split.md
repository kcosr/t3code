# M7 — Package Split (mechanical, no behavior change)

Final kernel milestone (`specs/native-voice-runtime-kernel.md` Migration M7). Binding
inventory: `specs/kernel-milestones/m7-seam-map.md` — its census table IS the
assignment; this packet only fixes the rules. Base: `e2cbc5312`.

## Binding rulings

1. **Root-pinned entry classes.** `T3VoiceRuntimeService` and `T3VoiceModule` STAY in
   `expo.modules.t3voice` (root). Rationale (seam map §3): AndroidManifest.xml,
   expo-module.config.json, and package.json reference them by FQCN string — a wrong
   FQCN compiles clean and fails only on device, the one failure class the pc gate
   cannot catch. ZERO config-file edits in this milestone.
2. **The 8 `ACTION_*` intent-action string constants keep their literal values
   verbatim** (`"expo.modules.t3voice.action.*"`) — they are action identities, not
   class names, regardless of where their defining file moves.
3. **Whole-file moves only.** Every file moves to exactly the package in the seam-map
   census (root 2 / host 2 / kernel 21 / media 14 / net 6 / store 11 / bridge 4; tests
   mirror). The seam map's per-file "deferred split boundaries" are documentation for
   the future — executing ANY of them in M7 is forbidden (splits touch code bodies).
   The AMBIGUOUS files use the seam map's primary recommendation, not the alternative.
4. **One atomic move commit** for all of main+test+androidTest, then (only if lint
   requires) a second commit for formatting fallout. Diff shape is the contract: every
   hunk in the move commit must be a `package` declaration line, an `import` line, or a
   git rename header (R≥95). Any hunk touching a code body is a defect.
5. Kotlin `internal` is module-scoped and `private` is file-scoped — no visibility
   modifier changes are needed or permitted.

## Verification (the implementer runs these; the reviewer re-checks the diff shape)

- `git diff -M --stat` shows only renames + the two root-pinned files unmodified (or
  import-only changes).
- Diff-shape grep: no hunk line outside `package `/`import `/rename metadata.
- Byte-identity of the 8 ACTION string literals (grep values pre/post).
- `grep -rn "expo.modules.t3voice" apps/mobile/modules/t3-voice/android/src/main/AndroidManifest.xml apps/mobile/modules/t3-voice/expo-module.config.json apps/mobile/modules/t3-voice/package.json` — byte-identical to base.
- Module unit tests: identical pass set. Both source sets compile.

## Forbidden

- No code-body changes of any kind; no file splits; no renames of classes/symbols; no
  config-file edits; no visibility changes; no test logic changes (only their package
  lines + imports + directory moves).

## Done criteria

- All 109 files (60 main + 47 test + 2 androidTest) in their census packages; root
  retains exactly the two pinned classes (+ their root-staying tests per seam map);
  diff shape verified; `pnpm run typecheck` + `pnpm run lint:mobile` green; module
  tests green; tree clean.
