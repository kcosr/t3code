/**
 * Mic capture + simple energy-based endpoint detection for Thread Auto Listen.
 */

export interface AudioCaptureSession {
  readonly stream: MediaStream;
  readonly sampleRate: number;
  readonly getPcmMono: () => Float32Array;
  readonly getLevel: () => number;
  readonly stop: () => void;
}

export interface EndpointDetectionConfig {
  readonly endSilenceMs: number;
  readonly noSpeechTimeoutMs: number | null;
  readonly maximumUtteranceMs: number;
}

export type EndpointReason = "silence" | "no-speech" | "max-utterance" | "manual";

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || navigator.mediaDevices?.getUserMedia == null) {
    throw new Error("Microphone access is not available in this environment");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

export async function startAudioCapture(stream: MediaStream): Promise<AudioCaptureSession> {
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  // ScriptProcessor is deprecated but widely available; AudioWorklet is preferred
  // when registered. Use a ring buffer filled from an AudioWorklet when possible.
  const bufferSize = 4096;
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1);
  const chunks: Float32Array[] = [];
  let latestLevel = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    let sum = 0;
    for (let i = 0; i < input.length; i += 1) {
      const sample = input[i]!;
      sum += sample * sample;
    }
    latestLevel = Math.sqrt(sum / Math.max(1, input.length));
  };

  source.connect(processor);
  // Keep the processor alive without audible feedback.
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(audioContext.destination);

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return {
    stream,
    sampleRate: audioContext.sampleRate,
    getPcmMono: () => {
      let total = 0;
      for (const chunk of chunks) total += chunk.length;
      const out = new Float32Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
    getLevel: () => latestLevel,
    stop: () => {
      try {
        processor.disconnect();
        source.disconnect();
        mute.disconnect();
      } catch {
        // ignore
      }
      void audioContext.close().catch(() => undefined);
      for (const track of stream.getTracks()) {
        track.stop();
      }
    },
  };
}

const SPEECH_LEVEL_THRESHOLD = 0.02;

/**
 * Wait until endpoint detection fires, or abortSignal cancels.
 */
export async function waitForEndpoint(input: {
  readonly capture: AudioCaptureSession;
  readonly config: EndpointDetectionConfig;
  readonly signal?: AbortSignal;
  readonly onLevel?: (level: number) => void;
}): Promise<EndpointReason> {
  const startedAt = Date.now();
  let speechSeen = false;
  let silenceStartedAt: number | null = null;

  return new Promise<EndpointReason>((resolve, reject) => {
    const tick = () => {
      if (input.signal?.aborted) {
        cleanup();
        reject(new DOMException("Endpoint wait aborted", "AbortError"));
        return;
      }
      const level = input.capture.getLevel();
      input.onLevel?.(level);
      const elapsed = Date.now() - startedAt;

      if (elapsed >= input.config.maximumUtteranceMs) {
        cleanup();
        resolve("max-utterance");
        return;
      }

      if (level >= SPEECH_LEVEL_THRESHOLD) {
        speechSeen = true;
        silenceStartedAt = null;
      } else if (speechSeen) {
        silenceStartedAt ??= Date.now();
        if (Date.now() - silenceStartedAt >= input.config.endSilenceMs) {
          cleanup();
          resolve("silence");
          return;
        }
      } else if (
        input.config.noSpeechTimeoutMs !== null &&
        elapsed >= input.config.noSpeechTimeoutMs
      ) {
        cleanup();
        resolve("no-speech");
        return;
      }
    };

    const interval = setInterval(tick, 50);
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Endpoint wait aborted", "AbortError"));
    };
    const cleanup = () => {
      clearInterval(interval);
      input.signal?.removeEventListener("abort", onAbort);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    tick();
  });
}

/** Downsample / convert Float32 mono PCM to Int16 LE at a target rate (for diagnostics only). */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
