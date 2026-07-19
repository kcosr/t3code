/**
 * Browser mono PCM → progressive AAC-LC MP4 encoder for STT uploads.
 *
 * Hard v1 gate: MediaRecorder cannot produce the required container. Prefer
 * WebCodecs AudioEncoder (mp4a.40.2) when available; otherwise fail clearly.
 */

import {
  aacLcMonoAudioSpecificConfig,
  muxProgressiveAacMp4,
  stripAdtsIfPresent,
  type AacFrame,
} from "./progressiveAacMp4";

export interface EncodeMonoPcmToAacMp4Input {
  readonly pcm: Float32Array;
  readonly sampleRate: number;
}

export interface EncodeMonoPcmToAacMp4Result {
  readonly blob: Blob;
  readonly byteLength: number;
  readonly sampleRate: number;
  readonly codec: "mp4a.40.2";
}

/** Prefer a rate the AAC encoder and server both accept cleanly. */
export function pickAacEncodeSampleRate(captureSampleRate: number): number {
  const preferred: ReadonlyArray<number> = [
    24_000, 16_000, 48_000, 44_100, 32_000, 22_050, 12_000, 8_000,
  ];
  if (preferred.includes(captureSampleRate)) {
    return captureSampleRate;
  }
  // Nearest preferred rate.
  let best = preferred[0]!;
  let bestDelta = Math.abs(captureSampleRate - best);
  for (const rate of preferred) {
    const delta = Math.abs(captureSampleRate - rate);
    if (delta < bestDelta) {
      best = rate;
      bestDelta = delta;
    }
  }
  return best;
}

export function resampleMonoPcm(pcm: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(pcm.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio;
    const left = Math.floor(src);
    const right = Math.min(pcm.length - 1, left + 1);
    const frac = src - left;
    out[i] = pcm[left]! * (1 - frac) + pcm[right]! * frac;
  }
  return out;
}

export function isWebAacEncoderAvailable(): boolean {
  return (
    typeof globalThis.AudioEncoder !== "undefined" &&
    typeof globalThis.AudioData !== "undefined" &&
    typeof globalThis.AudioEncoder.isConfigSupported === "function"
  );
}

async function assertAacSupported(sampleRate: number): Promise<void> {
  if (!isWebAacEncoderAvailable()) {
    throw new Error(
      "This browser cannot encode AAC-LC for voice transcription. Use Chrome/Edge or enable WebCodecs AAC.",
    );
  }
  const support = await AudioEncoder.isConfigSupported({
    codec: "mp4a.40.2",
    numberOfChannels: 1,
    sampleRate,
    bitrate: 64_000,
  });
  if (!support.supported) {
    throw new Error(
      `WebCodecs AAC-LC mono @ ${sampleRate} Hz is not supported in this browser for STT upload.`,
    );
  }
}

/**
 * Encode mono Float32 PCM into progressive AAC-LC MP4 (audio/mp4).
 */
export async function encodeMonoPcmToAacMp4(
  input: EncodeMonoPcmToAacMp4Input,
): Promise<EncodeMonoPcmToAacMp4Result> {
  const encodeRate = pickAacEncodeSampleRate(input.sampleRate);
  const pcm = resampleMonoPcm(input.pcm, input.sampleRate, encodeRate);
  if (pcm.length === 0) {
    throw new Error("Cannot encode empty PCM for voice transcription");
  }
  await assertAacSupported(encodeRate);

  const frames: AacFrame[] = [];
  let encoderError: unknown = null;
  let audioSpecificConfig: Uint8Array | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const description = meta?.decoderConfig?.description;
      if (description != null && audioSpecificConfig === null) {
        if (description instanceof ArrayBuffer) {
          audioSpecificConfig = new Uint8Array(description.slice(0));
        } else if (ArrayBuffer.isView(description)) {
          audioSpecificConfig = new Uint8Array(
            description.buffer.slice(
              description.byteOffset,
              description.byteOffset + description.byteLength,
            ),
          );
        }
      }
      const buffer = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buffer);
      const stripped = stripAdtsIfPresent(buffer);
      // Prefer encoder duration when present (microseconds → samples).
      const samplesFromChunk =
        chunk.duration != null && chunk.duration > 0
          ? Math.max(1, Math.round((chunk.duration / 1_000_000) * encodeRate))
          : stripped.samples;
      frames.push({
        data: stripped.data,
        samples: samplesFromChunk > 0 ? samplesFromChunk : 1024,
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });

  encoder.configure({
    codec: "mp4a.40.2",
    numberOfChannels: 1,
    sampleRate: encodeRate,
    bitrate: 64_000,
  });

  // Feed PCM in ~1024-sample frames (AAC frame size).
  const frameSize = 1024;
  let timestampUs = 0;
  for (let offset = 0; offset < pcm.length; offset += frameSize) {
    const end = Math.min(offset + frameSize, pcm.length);
    const slice = pcm.subarray(offset, end);
    // Pad final partial frame with silence so the encoder emits a complete frame.
    const samples = new Float32Array(frameSize);
    samples.set(slice);
    const audioData = new AudioData({
      format: "f32",
      sampleRate: encodeRate,
      numberOfFrames: frameSize,
      numberOfChannels: 1,
      timestamp: timestampUs,
      data: samples,
    });
    encoder.encode(audioData);
    audioData.close();
    timestampUs += Math.round((frameSize / encodeRate) * 1_000_000);
  }

  await encoder.flush();
  encoder.close();

  if (encoderError !== null) {
    throw encoderError instanceof Error
      ? encoderError
      : new Error("AAC encoder failed", { cause: encoderError });
  }
  if (frames.length === 0) {
    throw new Error("AAC encoder produced no frames");
  }

  const mp4 = muxProgressiveAacMp4({
    sampleRate: encodeRate,
    frames,
    audioSpecificConfig: audioSpecificConfig ?? aacLcMonoAudioSpecificConfig(encodeRate),
  });
  // Copy into a standalone ArrayBuffer so Blob gets exact bytes.
  const copy = mp4.slice();
  const blob = new Blob([copy.buffer], { type: "audio/mp4" });
  return {
    blob,
    byteLength: mp4.byteLength,
    sampleRate: encodeRate,
    codec: "mp4a.40.2",
  };
}
