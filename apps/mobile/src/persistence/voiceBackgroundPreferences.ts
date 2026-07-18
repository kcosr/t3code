export interface VoiceBackgroundThreadTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly title: string;
}

export function sanitizeVoiceBackgroundThreadTarget(
  value: unknown,
): VoiceBackgroundThreadTarget | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["environmentId", "projectId", "threadId", "title"]);
  const keys = Object.keys(record);
  if (keys.length !== allowedKeys.size || !keys.every((key) => allowedKeys.has(key))) return null;
  const exactNonEmptyString = (field: unknown): field is string =>
    typeof field === "string" && field.length > 0 && field === field.trim();
  if (
    !exactNonEmptyString(record.environmentId) ||
    !exactNonEmptyString(record.projectId) ||
    !exactNonEmptyString(record.threadId) ||
    !exactNonEmptyString(record.title)
  ) {
    return null;
  }
  return {
    environmentId: record.environmentId,
    projectId: record.projectId,
    threadId: record.threadId,
    title: record.title,
  };
}
