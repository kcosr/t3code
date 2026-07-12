import { describe, expect, it, vi } from "vite-plus/test";

import { createHomeSettingsHeaderItems } from "./home-settings-header-item";

describe("createHomeSettingsHeaderItems", () => {
  it("exposes the Android settings action from the native header options", () => {
    const onOpenSettings = vi.fn();
    const items = createHomeSettingsHeaderItems(onOpenSettings);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      accessibilityLabel: "Open settings",
      identifier: "home-settings",
      sharesBackground: false,
      type: "button",
    });
    if (items[0]?.type !== "button") throw new Error("Expected a settings button");
    items[0].onPress();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
