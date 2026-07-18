# Pi (`piAgent`) provider — implementation plan

## Scope

End-to-end stock Pi integration per agent-context `specs/pi-provider.md`, using
driver kind **`piAgent`** (existing UI placeholder).

Reference material:

- `/home/kevin/worktrees/pi` (stock RPC, jsonl, rpc-types)
- `/home/kevin/worktrees/pi-threads` (protocol/lifecycle reference only — not a dependency)
- T3 Codex/OpenCode adapter lifecycle patterns

## Layout

- `packages/contracts` — `PiSettings`, `providers.piAgent`, `pi.rpc` raw source
- `apps/server/src/provider/pi/*` — framing, version, model slug, protocol
- `apps/server/src/provider/Layers/PiSessionRuntime.ts` — process + RPC
- `apps/server/src/provider/Layers/PiAdapter.ts` — canonical events
- `apps/server/src/provider/Layers/PiProvider.ts` — health + models
- `apps/server/src/provider/Drivers/PiDriver.ts` — registration
- `apps/server/src/textGeneration/PiTextGeneration.ts` — no-session utility gen
- Web settings / icons / session-logic
- `docs/providers/pi.md`

## Non-goals (initial)

- `pi-threads` dependency or dual transport
- Steer / follow-up product surface
- Non–full-access runtime modes
