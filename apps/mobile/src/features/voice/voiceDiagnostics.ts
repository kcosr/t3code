import type { T3VoiceDiagnosticEntry } from "@t3tools/mobile-voice-native";

const EXPORT_VERSION = 1;

export function formatVoiceDiagnostics(entries: ReadonlyArray<T3VoiceDiagnosticEntry>): string {
  return JSON.stringify(
    {
      version: EXPORT_VERSION,
      entries: entries.map((entry) => ({
        elapsedRealtimeMillis: entry.elapsedRealtimeMillis,
        generation: entry.generation,
        category: entry.category,
        code: entry.code,
        primaryCount: entry.primaryCount,
        secondaryCount: entry.secondaryCount,
        ...(entry.endpointElapsedMs === undefined
          ? {}
          : { endpointElapsedMs: entry.endpointElapsedMs }),
        ...(entry.levelDbfsBucket === undefined ? {} : { levelDbfsBucket: entry.levelDbfsBucket }),
        ...(entry.noiseFloorDbfsBucket === undefined
          ? {}
          : { noiseFloorDbfsBucket: entry.noiseFloorDbfsBucket }),
        ...(entry.releaseThresholdDbfsBucket === undefined
          ? {}
          : { releaseThresholdDbfsBucket: entry.releaseThresholdDbfsBucket }),
        ...(entry.speechConfirmed === undefined ? {} : { speechConfirmed: entry.speechConfirmed }),
        ...(entry.silenceElapsedMs === undefined
          ? {}
          : { silenceElapsedMs: entry.silenceElapsedMs }),
        ...(entry.silenceResetCount === undefined
          ? {}
          : { silenceResetCount: entry.silenceResetCount }),
      })),
    },
    null,
    2,
  );
}
