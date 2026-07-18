/**
 * Pi model selection is a (provider, modelId, thinkingLevel) triple.
 * T3 model slugs round-trip as `provider/modelId`.
 *
 * Thinking-level filtering mirrors stock Pi (`getSupportedThinkingLevels` in
 * `@earendil-works/pi-ai`): missing map keys use defaults; `null` disables a
 * level; `xhigh` is only advertised when explicitly present in the map.
 */

export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

/** Default levels for reasoning models that omit thinkingLevelMap. */
export const PI_DEFAULT_REASONING_THINKING_LEVELS: ReadonlyArray<PiThinkingLevel> = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
];

export function isPiThinkingLevel(value: string): value is PiThinkingLevel {
  return (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolve thinking levels a Pi model actually accepts from RPC model metadata.
 */
export function getSupportedPiThinkingLevels(model: {
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}): ReadonlyArray<PiThinkingLevel> {
  if (model.reasoning !== true) {
    return [];
  }

  const map =
    model.thinkingLevelMap &&
    typeof model.thinkingLevelMap === "object" &&
    !Array.isArray(model.thinkingLevelMap)
      ? (model.thinkingLevelMap as Record<string, unknown>)
      : undefined;

  if (!map || Object.keys(map).length === 0) {
    return PI_DEFAULT_REASONING_THINKING_LEVELS;
  }

  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = map[level];
    if (mapped === null) {
      return false;
    }
    if (level === "xhigh") {
      return mapped !== undefined;
    }
    // Missing keys still default to supported (except xhigh above).
    return true;
  });
}

export function clampPiThinkingLevel(
  model: { readonly reasoning?: unknown; readonly thinkingLevelMap?: unknown },
  requested: string | undefined,
): PiThinkingLevel | undefined {
  const supported = getSupportedPiThinkingLevels(model);
  if (supported.length === 0) {
    return undefined;
  }
  if (requested && isPiThinkingLevel(requested) && supported.includes(requested)) {
    return requested;
  }
  if (supported.includes("off")) {
    return "off";
  }
  return supported[0];
}

export function encodePiModelSlug(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function parsePiModelSlug(
  slug: string | undefined,
): { provider: string; modelId: string } | undefined {
  if (!slug) {
    return undefined;
  }
  const trimmed = slug.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (!provider || !modelId) {
    return undefined;
  }
  return { provider, modelId };
}

/** Pi session ids: alphanumeric, `-`, `_`, `.`; must start and end alphanumeric. */
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidPiSessionId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && PI_SESSION_ID_PATTERN.test(value);
}

/**
 * Prefer a deterministic Pi session id derived from the T3 thread when valid;
 * otherwise return undefined so the caller generates a fresh Pi-valid id.
 */
export function preferPiSessionIdFromThreadId(threadId: string): string | undefined {
  return isValidPiSessionId(threadId) ? threadId : undefined;
}
