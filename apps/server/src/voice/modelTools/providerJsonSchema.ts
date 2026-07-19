/**
 * Flatten Effect-generated JSON Schema quirks into the inline OpenAI-friendly
 * shape used by the hand-written sibling tools (e.g. integer bounds as
 * `minimum`/`maximum` rather than a single-member `allOf`).
 *
 * Shared by direct Realtime declarations and `command_describe` so both routes
 * present the same schema to the model.
 */
export function normalizeProviderJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeProviderJsonSchema);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (key === "allOf" && Array.isArray(child)) {
      const members = child.map(normalizeProviderJsonSchema);
      const onlyConstraints = members.every(
        (member) =>
          typeof member === "object" &&
          member !== null &&
          !Array.isArray(member) &&
          !("type" in (member as object)) &&
          !("properties" in (member as object)) &&
          !("items" in (member as object)) &&
          !("anyOf" in (member as object)) &&
          !("oneOf" in (member as object)) &&
          !("allOf" in (member as object)),
      );
      if (onlyConstraints) {
        for (const member of members) {
          Object.assign(next, member as Record<string, unknown>);
        }
        continue;
      }
      next[key] = members;
      continue;
    }
    next[key] = normalizeProviderJsonSchema(child);
  }
  return next;
}
