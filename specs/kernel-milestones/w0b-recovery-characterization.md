# W0b — Recovery Characterization: Resolved Without a Run

Milestone W0b of `specs/voice-kernel-orchestration.md`. Resolution: **no implementation
run**. The pre-launch packet review established that the milestone's premise was wrong and
its intended value is unobtainable before M6.

## Finding

The recovery decision surface is already characterized, and the part that is not cannot be
tested without the kernel refactor itself:

- The module's unit-test toolchain is JUnit4 + org.json only — no Robolectric, no Context,
  no mocking framework. `T3VoiceRuntimeService` (`: Service()`) cannot be instantiated and
  `onCreate` (lines ~1819-2334) cannot be driven from any test in this module.
- `T3VoiceRuntimeServiceRecoveryTest.kt` is not a service harness; its six tests cover four
  extracted recovery policy objects.
- Of the fifteen recovery scenarios enumerated for characterization, **thirteen decision
  seams are already covered** by existing tests; two scenarios are fully covered including
  effects; one (startup-resolution failure fallback) has no extracted seam at all — its
  logic is inline in `onCreate`. Every "write-back / clear / install / schedule" effect
  lives in `onCreate` and is unreachable.

An implementation run would therefore have produced a near-empty commit or uncompilable
service-level tests.

## Consequence

The orchestration-level recovery coverage this milestone wanted is exactly what M6 of
`specs/native-voice-runtime-kernel.md` delivers by construction: `recover(LoadedState) ->
(KernelState, [Effect])` makes every currently-unreachable `onCreate` effect a pure fixture
assertion. This finding strengthens the kernel-rework motivation — the highest-risk code is
not merely under-tested, it is untestable in its current shape.

## Scenario → seam → coverage map (M6 fixture-matrix seed)

| #   | Scenario                              | Decision seam                                              | Covered today | Unreachable effect (M6 fixture) |
| --- | ------------------------------------- | ---------------------------------------------------------- | ------------- | ------------------------------- |
| 1   | Canonical + readiness disabled        | `T3VoiceCanonicalReadinessPolicy.transient`                | yes           | transient write-back            |
| 2   | Committed-readiness mismatch          | `VoiceRuntimeCommittedReadinessPolicy.reconcile`           | yes           | clear + disable + diagnostic    |
| 3   | Prepared authority survives           | `T3VoiceStartupAuthorityFencePolicy.persistentPreparation` | yes           | verified-readiness write-back   |
| 4   | Discard preparation                   | `…FencePolicy.resolve`                                     | yes           | revoke/discard write-backs      |
| 5   | Resolution-failure fallback           | none — inline in `onCreate`                                | no            | entire fallback                 |
| 6   | Thread op RESTORE                     | `VoiceRuntimeThreadStoredStatePolicy.decide`               | yes           | scheduled thread start          |
| 7   | CANCEL_PREPARED / CANCEL_UNDISPATCHED | same                                                       | yes           | cancel write-backs              |
| 8   | REVOKE                                | same                                                       | yes           | revoke write-backs              |
| 9   | Completed-recording restore + sweep   | `VoiceRuntimeThreadRecordingRecovery` + cache              | fully         | —                               |
| 10  | Active-at-crash detach                | `…RecordingRecovery.restore`                               | decision only | detach/cancel write-back        |
| 11  | Checkpoint → recovered engine         | `T3VoiceRecoveredRealtimeAuthorityPolicy`                  | yes           | engine install                  |
| 12  | Finalization → cleanup retry          | same + `…FinalizationCallbackPolicy`                       | yes           | scheduling                      |
| 13  | Legacy cutover idempotent/failure     | `VoiceRuntimeLegacyRealtimeCutover.migrate`                | yes           | failure snapshot reset          |
| 14  | Authority tamper → Locked             | `VoiceRuntimeAuthorityStore` load                          | yes           | non-capturing convergence       |
| 15  | Checkpoint corruption                 | checkpoint store `assertCorrupt`                           | fully         | service `runCatching` path      |

Owning test files: `T3VoiceCanonicalReadinessPolicyTest`, `VoiceRuntimeCommittedReadinessTest`,
`VoiceRuntimeThreadExecutionTest`, `VoiceRuntimeThreadOperationStoreTest`,
`T3VoiceRecordingCacheTest`, `T3VoiceRuntimeServiceRecoveryTest`,
`VoiceRuntimeLegacyRealtimeCutoverTest`, `VoiceRuntimeAuthorityStoreTest`,
`VoiceRuntimeRealtimeCheckpointStoreTest`.

## Disposition

- W0b closes with this record; the chain proceeds W0a → W0c → M0.
- M6's packet must include the fifteen-row matrix above as its minimum fixture set, with
  scenario 5 and every "unreachable effect" column entry as mandatory new fixtures.
