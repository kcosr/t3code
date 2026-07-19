/**
 * Progressive (non-fragmented) mono AAC-LC MP4 muxer for STT uploads.
 *
 * Server VoiceMp4Inspector requires: hasMoov, !isFragmented, moof===0, single
 * audio track, codec mp4a.40.2, channel_count===1, 8–48 kHz.
 */

export interface AacFrame {
  readonly data: Uint8Array;
  readonly samples: number;
}

export interface ProgressiveAacMp4Input {
  readonly sampleRate: number;
  readonly frames: ReadonlyArray<AacFrame>;
  /** AudioSpecificConfig bytes (typically 2 bytes for AAC-LC mono). */
  readonly audioSpecificConfig: Uint8Array;
}

const textEncoder = new TextEncoder();

function concatBytes(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function box(type: string, contents: Uint8Array): Uint8Array {
  const size = 8 + contents.byteLength;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size);
  out.set(textEncoder.encode(type), 4);
  out.set(contents, 8);
  return out;
}

function fullBox(type: string, version: number, flags: number, contents: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = version;
  header[1] = (flags >> 16) & 0xff;
  header[2] = (flags >> 8) & 0xff;
  header[3] = flags & 0xff;
  return box(type, concatBytes([header, contents]));
}

function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  const view = new DataView(out.buffer);
  // Enough for multi-hour mono audio at 48 kHz.
  view.setUint32(0, Math.floor(value / 0x1_0000_0000));
  view.setUint32(4, value >>> 0);
  return out;
}

function fixed16_16(value: number): Uint8Array {
  return u32(Math.round(value * 0x1_0000));
}

function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

/** Build AudioSpecificConfig for AAC-LC mono at the given sample rate. */
export function aacLcMonoAudioSpecificConfig(sampleRate: number): Uint8Array {
  const sampleRateTable = [
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
    7_350,
  ];
  let samplingFrequencyIndex = sampleRateTable.indexOf(sampleRate);
  if (samplingFrequencyIndex < 0) {
    // Prefer nearest known table entry for ASC; duration still uses real rate.
    samplingFrequencyIndex = 3; // 48000 fallback index
    let bestDelta = Number.POSITIVE_INFINITY;
    for (let i = 0; i < sampleRateTable.length; i += 1) {
      const delta = Math.abs(sampleRateTable[i]! - sampleRate);
      if (delta < bestDelta) {
        bestDelta = delta;
        samplingFrequencyIndex = i;
      }
    }
  }
  // audioObjectType=2 (AAC LC), channelConfiguration=1 (mono)
  const aot = 2;
  const byte0 = (aot << 3) | ((samplingFrequencyIndex & 0x0e) >> 1);
  const byte1 = ((samplingFrequencyIndex & 0x01) << 7) | (1 << 3);
  return new Uint8Array([byte0, byte1]);
}

/**
 * Mux AAC frames into a progressive (non-fragmented) MP4 suitable for STT upload.
 */
export function muxProgressiveAacMp4(input: ProgressiveAacMp4Input): Uint8Array {
  const { sampleRate, frames, audioSpecificConfig } = input;
  if (frames.length === 0) {
    throw new Error("Cannot mux an empty AAC frame list");
  }
  if (sampleRate < 8_000 || sampleRate > 48_000) {
    throw new Error(`Unsupported AAC sample rate for STT: ${sampleRate}`);
  }

  const sampleSizes = frames.map((frame) => frame.data.byteLength);
  const sampleDurations = frames.map((frame) => frame.samples);
  const totalSamples = sampleDurations.reduce((sum, value) => sum + value, 0);
  const mdatPayload = concatBytes(frames.map((frame) => frame.data));

  // Layout: ftyp + moov + mdat. Compute mdat offset after we know moov size via
  // a first pass with a placeholder stco, then rewrite stco with the real offset.
  const ftyp = box(
    "ftyp",
    concatBytes([
      textEncoder.encode("isom"),
      u32(0x200),
      textEncoder.encode("isom"),
      textEncoder.encode("iso2"),
      textEncoder.encode("mp41"),
    ]),
  );

  const buildMoov = (chunkOffset: number): Uint8Array => {
    const mvhd = fullBox(
      "mvhd",
      0,
      0,
      concatBytes([
        u32(0), // creation
        u32(0), // modification
        u32(sampleRate), // timescale
        u32(totalSamples), // duration
        fixed16_16(1), // rate
        u16(0x0100), // volume
        zeros(10),
        // unity matrix
        u32(0x0001_0000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x0001_0000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x4000_0000),
        zeros(24),
        u32(2), // next track id
      ]),
    );

    const tkhd = fullBox(
      "tkhd",
      0,
      0x000007, // track enabled, in movie, in preview
      concatBytes([
        u32(0),
        u32(0),
        u32(1), // track id
        u32(0),
        u32(totalSamples),
        zeros(8),
        u16(0),
        u16(0),
        u16(0x0100),
        u16(0),
        u32(0x0001_0000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x0001_0000),
        u32(0),
        u32(0),
        u32(0),
        u32(0x4000_0000),
        u32(0), // width
        u32(0), // height
      ]),
    );

    const mdhd = fullBox(
      "mdhd",
      0,
      0,
      concatBytes([
        u32(0),
        u32(0),
        u32(sampleRate),
        u32(totalSamples),
        u16(0x55c4), // und
        u16(0),
      ]),
    );

    const hdlr = fullBox(
      "hdlr",
      0,
      0,
      concatBytes([
        u32(0),
        textEncoder.encode("soun"),
        zeros(12),
        textEncoder.encode("SoundHandler\0"),
      ]),
    );

    const smhd = fullBox("smhd", 0, 0, concatBytes([u16(0), u16(0)]));

    const esdsDecoderConfig = (() => {
      // DecoderSpecificInfo
      const decSpecific = concatBytes([
        new Uint8Array([0x05, audioSpecificConfig.byteLength]),
        audioSpecificConfig,
      ]);
      // DecoderConfigDescriptor
      const decConfig = concatBytes([
        new Uint8Array([
          0x04, // tag
          23 + decSpecific.byteLength, // length (short form, enough for our ASC)
          0x40, // MPEG-4 AAC
          0x15, // stream type AudioStream, upstream=0, reserved=1
          0x00,
          0x00,
          0x00, // buffer size
        ]),
        u32(128_000), // max bitrate
        u32(128_000), // avg bitrate
        decSpecific,
      ]);
      // SLConfigDescriptor
      const slConfig = new Uint8Array([0x06, 0x01, 0x02]);
      // ES_Descriptor
      const es = concatBytes([
        new Uint8Array([0x03, 3 + decConfig.byteLength + slConfig.byteLength, 0x00, 0x00, 0x00]),
        decConfig,
        slConfig,
      ]);
      return fullBox("esds", 0, 0, es);
    })();

    const mp4a = box(
      "mp4a",
      concatBytes([
        zeros(6),
        u16(1), // data reference index
        zeros(8),
        u16(1), // channel count
        u16(16), // sample size
        u16(0),
        u16(0),
        u32(sampleRate << 16),
        esdsDecoderConfig,
      ]),
    );

    const stsd = fullBox("stsd", 0, 0, concatBytes([u32(1), mp4a]));

    // stts — run-length encode sample durations
    const sttsEntries: Array<{ count: number; delta: number }> = [];
    for (const duration of sampleDurations) {
      const last = sttsEntries.at(-1);
      if (last !== undefined && last.delta === duration) {
        last.count += 1;
      } else {
        sttsEntries.push({ count: 1, delta: duration });
      }
    }
    const stts = fullBox(
      "stts",
      0,
      0,
      concatBytes([
        u32(sttsEntries.length),
        ...sttsEntries.flatMap((entry) => [u32(entry.count), u32(entry.delta)]),
      ]),
    );

    const stsc = fullBox("stsc", 0, 0, concatBytes([u32(1), u32(1), u32(frames.length), u32(1)]));

    const stsz = fullBox(
      "stsz",
      0,
      0,
      concatBytes([u32(0), u32(sampleSizes.length), ...sampleSizes.map((size) => u32(size))]),
    );

    const stco = fullBox("stco", 0, 0, concatBytes([u32(1), u32(chunkOffset)]));

    const stbl = box("stbl", concatBytes([stsd, stts, stsc, stsz, stco]));
    const dref = fullBox(
      "dref",
      0,
      0,
      concatBytes([u32(1), fullBox("url ", 0, 1, new Uint8Array(0))]),
    );
    const dinf = box("dinf", dref);
    const minf = box("minf", concatBytes([smhd, dinf, stbl]));
    const mdia = box("mdia", concatBytes([mdhd, hdlr, minf]));
    const trak = box("trak", concatBytes([tkhd, mdia]));
    return box("moov", concatBytes([mvhd, trak]));
  };

  // First estimate: ftyp + moov(with placeholder) + 8-byte mdat header.
  const placeholderMoov = buildMoov(0);
  const mdatHeaderSize = 8;
  const chunkOffset = ftyp.byteLength + placeholderMoov.byteLength + mdatHeaderSize;
  const moov = buildMoov(chunkOffset);
  // If moov size changed (shouldn't for fixed stco width), recompute once.
  const finalChunkOffset = ftyp.byteLength + moov.byteLength + mdatHeaderSize;
  const finalMoov = finalChunkOffset === chunkOffset ? moov : buildMoov(finalChunkOffset);
  const mdat = box("mdat", mdatPayload);
  return concatBytes([ftyp, finalMoov, mdat]);
}

/** Strip ADTS header if present and return raw AAC frame payload. */
export function stripAdtsIfPresent(frame: Uint8Array): {
  readonly data: Uint8Array;
  readonly samples: number;
} {
  if (frame.byteLength >= 7 && frame[0] === 0xff && (frame[1]! & 0xf0) === 0xf0) {
    const protectionAbsent = (frame[1]! & 0x01) === 1;
    const headerLength = protectionAbsent ? 7 : 9;
    // ADTS frame length includes header
    const frameLength = ((frame[3]! & 0x03) << 11) | (frame[4]! << 3) | ((frame[5]! & 0xe0) >> 5);
    const raw = frame.subarray(headerLength, Math.min(frameLength, frame.byteLength));
    return { data: raw, samples: 1024 };
  }
  return { data: frame, samples: 1024 };
}
