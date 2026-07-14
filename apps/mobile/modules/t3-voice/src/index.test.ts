import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireOptionalNativeModule: vi.fn(),
}));

vi.mock("expo", () => ({
  requireOptionalNativeModule: expoMocks.requireOptionalNativeModule,
}));

describe("T3 voice native module resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("reports unavailable when the installed binary does not include the module", async () => {
    expoMocks.requireOptionalNativeModule.mockReturnValue(null);
    const voice = await import("./index");

    expect(voice.getT3VoiceNativeModule()).toBeNull();
    expect(voice.isT3VoiceNativeModuleAvailable()).toBe(false);
    expect(expoMocks.requireOptionalNativeModule).toHaveBeenCalledWith("T3Voice");
  });

  it("returns and caches the installed native module", async () => {
    const nativeModule = { nativeRevision: 13 };
    expoMocks.requireOptionalNativeModule.mockReturnValue(nativeModule);
    const voice = await import("./index");

    expect(voice.getT3VoiceNativeModule()).toBe(nativeModule);
    expect(voice.isT3VoiceNativeModuleAvailable()).toBe(true);
    expect(expoMocks.requireOptionalNativeModule).toHaveBeenCalledTimes(1);
  });

  it("rejects an obsolete native module revision", async () => {
    expoMocks.requireOptionalNativeModule.mockReturnValue({ nativeRevision: 12 });
    const voice = await import("./index");

    expect(voice.getT3VoiceNativeModule()).toBeNull();
    expect(voice.isT3VoiceNativeModuleAvailable()).toBe(false);
  });

  it("treats native resolution failures as unavailable", async () => {
    expoMocks.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error("native registry unavailable");
    });
    const voice = await import("./index");

    expect(voice.getT3VoiceNativeModule()).toBeNull();
    expect(voice.isT3VoiceNativeModuleAvailable()).toBe(false);
  });
});
