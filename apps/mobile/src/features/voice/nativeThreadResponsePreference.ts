import type { VoiceRuntimeSnapshot } from "@t3tools/client-runtime/voice";
import type { T3VoiceNativeModule } from "@t3tools/mobile-voice-native";

type NativeThreadResponsePreferenceModule = Pick<
  T3VoiceNativeModule,
  "updateThreadPlayResponsesAsync"
>;

/**
 * Serializes the app preference into the currently active native Thread cycle.
 * Every request supersedes queued work. The native generation is captured at
 * request time and checked again before dispatch so a queued operation cannot
 * retarget itself to a replacement cycle.
 */
export class NativeThreadResponsePreferenceSync {
  readonly #native: NativeThreadResponsePreferenceModule;
  readonly #getSnapshot: () => VoiceRuntimeSnapshot;
  #operation = 0;
  #tail = Promise.resolve();

  constructor(input: {
    readonly native: NativeThreadResponsePreferenceModule;
    readonly getSnapshot: () => VoiceRuntimeSnapshot;
  }) {
    this.#native = input.native;
    this.#getSnapshot = input.getSnapshot;
  }

  synchronize(playResponses: boolean): Promise<void> {
    const operation = ++this.#operation;
    const captured = this.#getSnapshot();
    const generation = captured.mode === "thread" ? captured.generation : null;
    const task = this.#tail
      .catch(() => undefined)
      .then(async () => {
        if (operation !== this.#operation || generation === null) return;

        // Yield once so preference and runtime snapshot updates from the same
        // React commit settle before we cross the native bridge.
        await Promise.resolve();
        if (operation !== this.#operation) return;
        const current = this.#getSnapshot();
        if (current.mode !== "thread" || current.generation !== generation) return;
        if (current.settings.playResponses === playResponses) return;

        try {
          await this.#native.updateThreadPlayResponsesAsync({
            expectedGeneration: generation,
            playResponses,
          });
        } catch (cause) {
          const latest = this.#getSnapshot();
          if (
            operation === this.#operation &&
            latest.mode === "thread" &&
            latest.generation === generation
          ) {
            throw cause;
          }
        }
      });
    this.#tail = task;
    return task;
  }

  cancel(): void {
    ++this.#operation;
  }
}
