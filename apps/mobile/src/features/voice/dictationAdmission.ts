export function canStartComposerDictation(input: {
  readonly phase: "idle" | "recording" | "transcribing";
  readonly startPending: boolean;
  readonly activeRecordingId: string | null;
  readonly stoppingRecordingId: string | null;
  readonly transcribingRecordingId: string | null;
}): boolean {
  return (
    input.phase === "idle" &&
    !input.startPending &&
    input.activeRecordingId === null &&
    input.stoppingRecordingId === null &&
    input.transcribingRecordingId === null
  );
}
