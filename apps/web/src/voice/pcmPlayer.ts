/**
 * 24 kHz mono s16le PCM player for Thread response TTS.
 */

export interface PcmPlayer {
  readonly play: (pcm: Uint8Array) => Promise<void>;
  readonly cancel: () => void;
  readonly dispose: () => void;
}

export function makePcmPlayer(sampleRate = 24_000): PcmPlayer {
  let audioContext: AudioContext | null = null;
  let currentSource: AudioBufferSourceNode | null = null;
  let cancelled = false;

  const ensureContext = async () => {
    audioContext ??= new AudioContext({ sampleRate });
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  };

  return {
    play: async (pcm) => {
      cancelled = false;
      if (pcm.byteLength < 2) return;
      const context = await ensureContext();
      if (cancelled) return;

      // Ensure even byte length for Int16.
      const usable = pcm.byteLength - (pcm.byteLength % 2);
      const samples = usable / 2;
      const view = new DataView(pcm.buffer, pcm.byteOffset, usable);
      const buffer = context.createBuffer(1, samples, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples; i += 1) {
        channel[i] = view.getInt16(i * 2, true) / 0x8000;
      }

      await new Promise<void>((resolve, reject) => {
        if (cancelled) {
          resolve();
          return;
        }
        currentSource?.stop();
        const source = context.createBufferSource();
        currentSource = source;
        source.buffer = buffer;
        source.connect(context.destination);
        source.onended = () => {
          if (currentSource === source) currentSource = null;
          resolve();
        };
        try {
          source.start();
        } catch (cause) {
          reject(cause);
        }
      });
    },
    cancel: () => {
      cancelled = true;
      try {
        currentSource?.stop();
      } catch {
        // ignore
      }
      currentSource = null;
    },
    dispose: () => {
      cancelled = true;
      try {
        currentSource?.stop();
      } catch {
        // ignore
      }
      currentSource = null;
      if (audioContext !== null) {
        void audioContext.close().catch(() => undefined);
        audioContext = null;
      }
    },
  };
}
