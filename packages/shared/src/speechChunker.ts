export interface SpeechTextSegment {
  readonly index: number;
  readonly text: string;
  readonly finalSegment: boolean;
}

export interface SpeechChunkerState {
  readonly buffer: string;
  readonly nextIndex: number;
  readonly finished: boolean;
}

export interface SpeechChunkerResult {
  readonly state: SpeechChunkerState;
  readonly segments: ReadonlyArray<SpeechTextSegment>;
}

export interface SpeechChunkerOptions {
  readonly minimumChars?: number;
  readonly maximumChars?: number;
}

const DEFAULT_MINIMUM_CHARS = 32;
const DEFAULT_MAXIMUM_CHARS = 240;

export const initialSpeechChunkerState = (): SpeechChunkerState => ({
  buffer: "",
  nextIndex: 0,
  finished: false,
});

const boundaryAtOrBefore = (text: string, maximumChars: number): number => {
  const bounded = text.slice(0, maximumChars + 1);
  const sentenceMatches = Array.from(bounded.matchAll(/[.!?](?:["')\]]*)\s+/g));
  const sentenceEnd = sentenceMatches.at(-1)?.index;
  if (sentenceEnd !== undefined) {
    const match = sentenceMatches.at(-1)?.[0] ?? "";
    return sentenceEnd + match.length;
  }
  const newline = bounded.lastIndexOf("\n");
  if (newline >= 0) return newline + 1;
  const whitespace = bounded.lastIndexOf(" ");
  return whitespace > 0 ? whitespace + 1 : Math.min(text.length, maximumChars);
};

const nextCompletedBoundary = (text: string, minimumChars: number): number | undefined => {
  const matches = text.matchAll(/[.!?](?:["')\]]*)(?:\s+|$)|\n+/g);
  for (const match of matches) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimumChars) return end;
  }
  return undefined;
};

export const appendSpeechText = (
  state: SpeechChunkerState,
  delta: string,
  final: boolean,
  options: SpeechChunkerOptions = {},
): SpeechChunkerResult => {
  if (state.finished) {
    throw new Error("Cannot append text after speech chunking has finished");
  }
  const minimumChars = options.minimumChars ?? DEFAULT_MINIMUM_CHARS;
  const maximumChars = options.maximumChars ?? DEFAULT_MAXIMUM_CHARS;
  if (minimumChars < 1 || maximumChars < minimumChars) {
    throw new Error("Invalid speech chunker bounds");
  }

  let buffer = state.buffer + delta;
  let nextIndex = state.nextIndex;
  const segments: SpeechTextSegment[] = [];

  while (buffer.length > 0) {
    const completedBoundary = nextCompletedBoundary(buffer, minimumChars);
    const boundary =
      completedBoundary !== undefined && completedBoundary <= maximumChars
        ? completedBoundary
        : buffer.length > maximumChars
          ? boundaryAtOrBefore(buffer, maximumChars)
          : undefined;
    if (boundary === undefined) break;
    const text = buffer.slice(0, boundary).trim();
    buffer = buffer.slice(boundary);
    if (text.length === 0) continue;
    segments.push({ index: nextIndex, text, finalSegment: false });
    nextIndex += 1;
  }

  if (final) {
    const text = buffer.trim();
    if (text.length > 0) {
      segments.push({ index: nextIndex, text, finalSegment: true });
      nextIndex += 1;
    }
    buffer = "";
  }

  return {
    state: { buffer, nextIndex, finished: final },
    segments,
  };
};
