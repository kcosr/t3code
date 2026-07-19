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

  it("strips ADTS headers when present", () => {
    // Minimal fake ADTS header (7 bytes) + payload
    const adts = new Uint8Array([0xff, 0xf1, 0x4c, 0x80, 0x1c, 0x1f, 0xfc, 0xaa, 0xbb, 0xcc]);
    // Fix length field roughly
    const stripped = stripAdtsIfPresent(adts);
    expect(stripped.data.byteLength).toBeGreaterThan(0);
    expect(stripped.samples).toBe(1024);
  });
});
