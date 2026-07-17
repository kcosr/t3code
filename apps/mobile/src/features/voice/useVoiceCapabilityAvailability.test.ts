import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import type { VoiceCapabilities } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./mobileVoiceClient", () => ({ makeMobileVoiceClient: vi.fn() }));

import { loadVoiceCapabilities } from "./useVoiceCapabilityAvailability";

const preparedConnection = (): PreparedConnection => ({}) as PreparedConnection;
const capabilities: VoiceCapabilities = {
  version: 1,
  capabilities: [],
  conversationRetention: ["ephemeral", "durable"],
};

describe("loadVoiceCapabilities", () => {
  it("shares one capability request for a prepared connection", async () => {
    const prepared = preparedConnection();
    const load = vi.fn(async () => capabilities);

    const [first, second] = await Promise.all([
      loadVoiceCapabilities(prepared, { load }),
      loadVoiceCapabilities(prepared, { load }),
    ]);

    expect(first).toBe(capabilities);
    expect(second).toBe(capabilities);
    expect(load).toHaveBeenCalledOnce();
  });

  it("evicts a failed request so capability discovery can retry", async () => {
    const prepared = preparedConnection();
    const load = vi
      .fn<() => Promise<VoiceCapabilities>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(capabilities);

    await expect(loadVoiceCapabilities(prepared, { load })).rejects.toThrow("offline");
    await expect(loadVoiceCapabilities(prepared, { load })).resolves.toBe(capabilities);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts a synchronously failed loader so capability discovery can retry", async () => {
    const prepared = preparedConnection();
    const load = vi
      .fn<() => Promise<VoiceCapabilities>>()
      .mockImplementationOnce(() => {
        throw new Error("configuration failed");
      })
      .mockResolvedValueOnce(capabilities);

    await expect(loadVoiceCapabilities(prepared, { load })).rejects.toThrow("configuration failed");
    await expect(loadVoiceCapabilities(prepared, { load })).resolves.toBe(capabilities);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("refreshes a settled capability result after its bounded freshness window", async () => {
    const prepared = preparedConnection();
    let now = 1_000;
    const refreshed: VoiceCapabilities = {
      version: 1,
      capabilities: [
        {
          capability: "agent.realtime",
          state: "ready",
          inputFormats: [],
          outputFormats: [],
        },
      ],
      conversationRetention: ["ephemeral", "durable"],
    };
    const load = vi
      .fn<() => Promise<VoiceCapabilities>>()
      .mockResolvedValueOnce(capabilities)
      .mockResolvedValueOnce(refreshed);
    const options = { load, now: () => now, cacheTtlMs: 30_000 };

    await expect(loadVoiceCapabilities(prepared, options)).resolves.toBe(capabilities);
    now += 29_999;
    await expect(loadVoiceCapabilities(prepared, options)).resolves.toBe(capabilities);
    now += 1;
    await expect(loadVoiceCapabilities(prepared, options)).resolves.toBe(refreshed);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
