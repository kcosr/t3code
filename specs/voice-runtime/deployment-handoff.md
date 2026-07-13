# Voice Runtime Deployment Handoff

Status: Implemented and deployed; T3 integration deferred until after long-context/compaction

This document records the concrete Voice Runtime deployment that the later T3 provider
integration must target. It supersedes example endpoints and media types in the earlier proposed
integration document.

## Runtime

- The control plane is TypeScript/Node and supervises persistent Python workers.
- The worker contract is provider-neutral; another runtime requires a configured worker adapter,
  not a T3 client-contract change.
- Speech output is normalized by Voice Runtime to signed 16-bit little-endian, 24 kHz, mono PCM.
- The response media contract is
  `audio/pcm; rate=24000; channels=1; format=s16le`.
- Voice Runtime owns media normalization. T3 must validate and stream this output without L16
  conversion, resampling, or byte swapping.

## Deployment

- The user systemd service is installed, enabled, active, and ready on `pc`.
- It binds only to `172.19.116.45:6624`.
- It is currently reachable from `srv` at `http://192.168.50.72:6624`.
- This plaintext private-network endpoint is suitable for development validation only. The T3
  integration must resolve the production transport requirement in
  `t3-integration-review.md` before sending credentials or voice content in a release setup.

Before configuring the T3 adapter, create its Voice Runtime credential and restart the service on
`pc`:

```sh
npx tsx scripts/create-token.ts t3-dev
systemctl --user restart voice-runtime.service
```

The temporary plaintext smoke token has been removed. Do not reuse or document it.

## Validation State

- A real Kokoro to WAV to Parakeet round trip succeeded from `srv`.
- Typecheck and all 24 Voice Runtime tests pass.
- Keel iterative Claude review completed cleanly after three repair cycles.
- The Voice Runtime directory is a Git repository, but no commit was created.
- Its `specs/` directory is intentionally ignored there.

Before T3 integration begins, commit or otherwise pin the exact Voice Runtime source revision so
the adapter and deployment can be tested against a reproducible service build.
