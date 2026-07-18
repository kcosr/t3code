import { describe, expect, it } from "vitest";

import { JsonlDecoder, JsonlProtocolError, parseJsonlRecord, serializeJsonLine } from "./jsonl.ts";

describe("Pi JSONL framing", () => {
  it("splits only on LF and strips optional CR", () => {
    const decoder = new JsonlDecoder();
    const lines = decoder.push('{"a":1}\r\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("preserves U+2028 and U+2029 inside JSON strings", () => {
    const decoder = new JsonlDecoder();
    const payload = { text: "line\u2028sep\u2029end" };
    const encoded = serializeJsonLine(payload);
    expect(encoded.includes("\u2028")).toBe(true);
    expect(encoded.includes("\u2029")).toBe(true);
    const lines = decoder.push(encoded);
    expect(lines).toHaveLength(1);
    expect(parseJsonlRecord(lines[0]!)).toEqual(payload);
  });

  it("handles fragmented chunks", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"ok":')).toEqual([]);
    expect(decoder.push("true")).toEqual([]);
    expect(decoder.push("}\n")).toEqual(['{"ok":true}']);
  });

  it("rejects oversized records", () => {
    const decoder = new JsonlDecoder({ maxRecordBytes: 8 });
    expect(() => decoder.push("abcdefghijklmnop\n")).toThrow(JsonlProtocolError);
  });

  it("serializeJsonLine ends with a single LF", () => {
    expect(serializeJsonLine({ x: 1 })).toBe('{"x":1}\n');
  });
});
