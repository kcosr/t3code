import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-notifications", () => ({
  AndroidImportance: { LOW: 4 },
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
}));

import {
  requestAndroidVoiceNotificationPermission,
  type AndroidVoiceNotificationPermissionApi,
} from "./androidVoiceNotificationPermission";

const makeApi = (input: {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
  readonly requestedGranted?: boolean;
}) => {
  const api: AndroidVoiceNotificationPermissionApi = {
    prepareChannel: vi.fn(async () => undefined),
    getPermissions: vi.fn(async () => ({
      granted: input.granted,
      canAskAgain: input.canAskAgain,
    })),
    requestPermissions: vi.fn(async () => ({
      granted: input.requestedGranted ?? false,
      canAskAgain: true,
    })),
  };
  return api;
};

describe("requestAndroidVoiceNotificationPermission", () => {
  it("prepares the foreground-service channel before requesting fresh-install access", async () => {
    const api = makeApi({ granted: false, canAskAgain: true, requestedGranted: true });

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("granted");
    expect(api.prepareChannel).toHaveBeenCalledOnce();
    expect(api.requestPermissions).toHaveBeenCalledOnce();
    expect(vi.mocked(api.prepareChannel).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.requestPermissions).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("does not reprompt an existing grant", async () => {
    const api = makeApi({ granted: true, canAskAgain: true });

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("granted");
    expect(api.requestPermissions).not.toHaveBeenCalled();
  });

  it("reports denial without throwing or reprompting when Android forbids another prompt", async () => {
    const api = makeApi({ granted: false, canAskAgain: false });

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("denied");
    expect(api.requestPermissions).not.toHaveBeenCalled();
  });

  it("degrades to denial when channel preparation fails", async () => {
    const api = makeApi({ granted: false, canAskAgain: true });
    vi.mocked(api.prepareChannel).mockRejectedValueOnce(new Error("channel unavailable"));

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("denied");
    expect(api.getPermissions).not.toHaveBeenCalled();
    expect(api.requestPermissions).not.toHaveBeenCalled();
  });

  it("degrades to denial when reading notification permission fails", async () => {
    const api = makeApi({ granted: false, canAskAgain: true });
    vi.mocked(api.getPermissions).mockRejectedValueOnce(
      new Error("permission manager unavailable"),
    );

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("denied");
    expect(api.requestPermissions).not.toHaveBeenCalled();
  });

  it("degrades to denial when requesting notification permission fails", async () => {
    const api = makeApi({ granted: false, canAskAgain: true });
    vi.mocked(api.requestPermissions).mockRejectedValueOnce(new Error("prompt unavailable"));

    await expect(requestAndroidVoiceNotificationPermission(api)).resolves.toBe("denied");
  });
});
