/**
 * Exclusive media ownership for web voice paths.
 *
 * At most one owner holds capture and exclusive playout related to voice.
 * Replacement waits for exact release (tracks stopped, peer closed, etc.).
 */

export type VoiceMediaOwnerKind =
  | "none"
  | "realtime"
  | "thread-auto-listen"
  | "dictation"
  | "thread-tts-only";

export interface VoiceMediaRelease {
  readonly release: () => Promise<void>;
}

export interface VoiceMediaOwnerState {
  readonly owner: VoiceMediaOwnerKind;
  readonly generation: number;
}

export interface VoiceMediaAdmission {
  readonly generation: number;
  readonly release: () => Promise<void>;
}

export class VoiceMediaOwnerGate {
  private owner: VoiceMediaOwnerKind = "none";
  private generation = 0;
  private releaseCurrent: (() => Promise<void>) | null = null;
  private admitting: Promise<void> | null = null;

  getState(): VoiceMediaOwnerState {
    return { owner: this.owner, generation: this.generation };
  }

  /**
   * Serialize admission. Replaces any current owner after exact release.
   * Returns a generation-fenced admission handle.
   */
  async admit(
    next: VoiceMediaOwnerKind,
    install: (generation: number) => Promise<VoiceMediaRelease>,
  ): Promise<VoiceMediaAdmission> {
    while (this.admitting !== null) {
      await this.admitting;
    }
    let resolveAdmitting!: () => void;
    this.admitting = new Promise<void>((resolve) => {
      resolveAdmitting = resolve;
    });
    try {
      await this.releaseExact();
      const generation = this.generation + 1;
      this.generation = generation;
      this.owner = next;
      const installed = await install(generation);
      if (this.generation !== generation) {
        await installed.release().catch(() => undefined);
        throw new Error("Voice media admission was fenced by a newer generation");
      }
      this.releaseCurrent = installed.release;
      return {
        generation,
        release: async () => {
          if (this.generation !== generation) return;
          await this.releaseExact();
        },
      };
    } finally {
      this.admitting = null;
      resolveAdmitting();
    }
  }

  async releaseExact(): Promise<void> {
    const release = this.releaseCurrent;
    this.releaseCurrent = null;
    this.owner = "none";
    if (release !== null) {
      await release();
    }
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation && this.owner !== "none";
  }
}
