# Voice Workstream History

## Status

This document is a historical index for the stacked voice and Pi workstreams that began after
`feature/master-voice-orchestrator` at `40c43d1e5`. It is not an implementation plan and does not
define current Android ownership, persistence, background behavior, controls, or release status.

Current authority is split between:

- [`voice.md`](./voice.md), for the integrated voice architecture and server capabilities; and
- [`android-voice-runtime-rebaseline.md`](../../specs/android-voice-runtime-rebaseline.md), for the
  Android product contract, native ownership, lifecycle boundary, and acceptance criteria.

When this history conflicts with either document, the current documents win.

## Historical workstreams

| Order | Branch                                  | Historical purpose                                                                                            |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 0     | `feature/voice-thread-followup-tools`   | Immediate thread dispatch receipts, exact bounded turn waits, and thread-message reads for the Realtime agent |
| 1     | `feature/voice-conversation-management` | Durable voice transcript browsing and conversation administration                                             |
| 2     | `feature/voice-history-search`          | Bounded history search and exact reads for the Realtime voice agent                                           |
| 3     | `feature/pi-provider`                   | Pi coding-agent provider over native `pi --mode rpc` JSONL                                                    |
| 4     | `feature/android-voice-hardening`       | Android media, lifecycle, route, WebRTC, diagnostics, and device-test hardening                               |
| 5     | `feature/voice-long-context`            | Deterministic context compilation, truncation, and Realtime call rotation                                     |
| 6     | `feature/voice-media-limits`            | Trusted media validation, quotas, and adversarial limits                                                      |
| 7     | `feature/voice-observability`           | Privacy-safe server and Android diagnostics                                                                   |
| 8     | `feature/voice-hands-free`              | Earlier Thread voice proposal, superseded by native Thread mode in the Android rebaseline                     |
| 9     | `feature/voice-headset-controls`        | Earlier background-control proposal, superseded by operation-scoped notification and MediaSession controls    |

The historical server/tool decisions that remain valid are:

- `send_thread_message` dispatches immediately and returns stable correlation identifiers.
- `wait_for_thread_turn` is an explicit cancellable bounded wait. There is no asynchronous
  completion watcher and no synthetic completion message injected into an active Realtime call.
- History tools belong only to the Realtime voice-agent allowlist; coding-agent providers do not
  receive them.
- Pi is an ordinary coding-agent provider using its native RPC protocol, not a voice runtime.
- Provider context pruning changes the compiled model view, not the durable normalized journal.
- Logs and traces exclude transcript, query, SDP, credential, and media content.

## Android rebaseline history

The later durable-kernel work interpreted background continuity as process-death recovery. The
product only requires a foreground-service-owned operation to outlive Activity backgrounding,
recreation, and React detachment while the application process remains alive.

The implementation therefore restarted from `f83577b035592feec1b772ded9f0e73f3625422d`
(`fix(voice): distinguish diagnostic copy failures`). The `feature/voice-kernel-m1`,
`debug/realtime-trace`, and convergence branches remain donor references for tested media,
shutdown, notification, networking, and diagnostic fixes. Their journals, elections, durable
handoff transactions, and process-recovery authority are not part of the current Android design.

The current Android runtime has one process-local native controller for Realtime and Thread voice.
React and notification/MediaSession controls call that same controller, and React reattaches by
reading complete native snapshots. A terminated process is a terminated operation; the next launch
starts from Idle.

## Historical artifacts

Historical review and discovery notes may remain under `scratch/` or on the donor refs. They
explain why alternatives were rejected, but they are not contracts and must not be used as current
implementation guidance.
