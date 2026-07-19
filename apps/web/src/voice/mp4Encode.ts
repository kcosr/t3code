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
  const { pcm, sampleRate } = input;
  if (pcm.length === 0) {
    throw new Error("Cannot encode empty PCM for voice transcription");
  }
  await assertAacSupported(sampleRate);

  const frames: AacFrame[] = [];
  let encoderError: unknown = null;

  const encoder = new AudioEncoder({
    output: (chunk) => {
      const buffer = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buffer);
      const stripped = stripAdtsIfPresent(buffer);
      frames.push({
        data: stripped.data,
        samples: stripped.samples > 0 ? stripped.samples : 1024,
      });
    },
    error: (error) => {
      encoderError = error;
    },
  });

  encoder.configure({
    codec: "mp4a.40.2",
    numberOfChannels: 1,
    sampleRate,
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
      sampleRate,
      numberOfFrames: frameSize,
      numberOfChannels: 1,
      timestamp: timestampUs,
      data: samples,
    });
    encoder.encode(audioData);
    audioData.close();
    timestampUs += Math.round((frameSize / sampleRate) * 1_000_000);
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
    sampleRate,
    frames,
    audioSpecificConfig: aacLcMonoAudioSpecificConfig(sampleRate),
  });
  const copy = mp4.slice();
  const blob = new Blob([copy.buffer as ArrayBuffer], { type: "audio/mp4" });
  return {
    blob,
    byteLength: mp4.byteLength,
    sampleRate,
    codec: "mp4a.40.2",
  };
}
