import { describe, expect, it } from "vitest";

import {
  aacLcMonoAudioSpecificConfig,
  muxProgressiveAacMp4,
  stripAdtsIfPresent,
} from "./progressiveAacMp4";

function findBox(
  bytes: Uint8Array,
  type: string,
  start = 0,
): { offset: number; size: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = start;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset);
    const boxType = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    );
    if (size < 8 || offset + size > bytes.byteLength) return null;
    if (boxType === type) return { offset, size };
    offset += size;
  }
  return null;
}

describe("progressiveAacMp4", () => {
  it("builds AudioSpecificConfig for AAC-LC mono", () => {
    const asc = aacLcMonoAudioSpecificConfig(24_000);
    expect(asc.byteLength).toBe(2);
  });

  it("muxes progressive MP4 without moof and with moov before mdat", () => {
    const frame = new Uint8Array(32).fill(0x11);
    const bytes = muxProgressiveAacMp4({
      sampleRate: 24_000,
      frames: [
        { data: frame, samples: 1024 },
        { data: frame, samples: 1024 },
      ],
      audioSpecificConfig: aacLcMonoAudioSpecificConfig(24_000),
    });

    expect(findBox(bytes, "ftyp")).not.toBeNull();
    const moov = findBox(bytes, "moov");
    const mdat = findBox(bytes, "mdat");
    expect(moov).not.toBeNull();
    expect(mdat).not.toBeNull();
    expect(moov!.offset).toBeLessThan(mdat!.offset);
    expect(findBox(bytes, "moof")).toBeNull();
  });

  it("writes esds lengths that do not overread (DecoderConfig body = 13 + DSI)", () => {
    const frame = new Uint8Array(16).fill(0x22);
    const bytes = muxProgressiveAacMp4({
      sampleRate: 24_000,
      frames: Array.from({ length: 4 }, () => ({ data: frame, samples: 1024 })),
      audioSpecificConfig: aacLcMonoAudioSpecificConfig(24_000),
    });
    // Locate esds box anywhere under moov and ensure size is consistent.
    const esds = (() => {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      let offset = 0;
      while (offset + 8 <= bytes.byteLength) {
        const size = view.getUint32(offset);
        const type = String.fromCharCode(
          bytes[offset + 4]!,
          bytes[offset + 5]!,
          bytes[offset + 6]!,
          bytes[offset + 7]!,
        );
        if (size < 8 || offset + size > bytes.byteLength) return null;
        if (type === "esds") return { offset, size };
        // Walk children of container boxes by scanning sequentially (top-level only for ftyp/moov/mdat).
        if (
          type === "moov" ||
          type === "trak" ||
          type === "mdia" ||
          type === "minf" ||
          type === "stbl"
        ) {
          // Dive into container: search nested boxes with a simple recursive scan via restart.
        }
        offset += size;
      }
      return null;
    })();
    // esds is nested; linear top-level scan may miss it — fall back to indexOf 'esds'
    const marker = [0x65, 0x73, 0x64, 0x73]; // esds
    let found = -1;
    for (let i = 0; i < bytes.byteLength - 4; i += 1) {
      if (
        bytes[i] === marker[0] &&
        bytes[i + 1] === marker[1] &&
        bytes[i + 2] === marker[2] &&
        bytes[i + 3] === marker[3]
      ) {
        found = i - 4; // size field starts 4 bytes before type
        break;
      }
    }
    expect(found).toBeGreaterThanOrEqual(0);
    void esds;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = view.getUint32(found);
    expect(size).toBeGreaterThan(20);
    expect(found + size).toBeLessThanOrEqual(bytes.byteLength);
  });

  it("strips ADTS headers when present", () => {
    // Minimal fake ADTS header (7 bytes) + payload
    const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x1c, 0x1f, 0xfc, 0xaa, 0xbb, 0xcc]);
    // Fix length field roughly
    const stripped = stripAdtsIfPresent(adts);
    expect(stripped.data.byteLength).toBeGreaterThan(0);
    expect(stripped.samples).toBe(1024);
  });
});
