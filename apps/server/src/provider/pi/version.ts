/**
 * Supported stock Pi CLI version range for the T3 piAgent driver.
 *
 * Aligned with the pi-threads reference range (0.75.x–0.80.x) plus room for
 * patch releases. Bump deliberately after re-running conformance tests.
 */

export const PI_COMPATIBILITY = {
  testedRange: "0.75.x - 0.80.x",
  minimum: "0.75.0",
  maximumExclusive: "0.81.0",
  tested: ["0.75.5", "0.80.3"],
} as const;

export function parsePiSemver(
  version: string,
): { major: number; minor: number; patch: number } | undefined {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function isSupportedPiVersion(version: string): boolean {
  const parsed = parsePiSemver(version);
  if (!parsed) {
    return false;
  }
  // Stock Pi is still 0.x; keep the gate tight on major/minor.
  return parsed.major === 0 && parsed.minor >= 75 && parsed.minor <= 80;
}

export function extractPiVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }
  const match = trimmed.match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/);
  return match?.[1] ?? (trimmed.split(/\s+/)[0] || undefined);
}
