import type { NativeStackHeaderItem } from "@react-navigation/native-stack";

import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";

export function createHomeSettingsHeaderItems(onOpenSettings: () => void): NativeStackHeaderItem[] {
  return [
    withNativeGlassHeaderItem({
      accessibilityLabel: "Open settings",
      icon: { name: "gearshape", type: "sfSymbol" } as const,
      identifier: "home-settings",
      label: "",
      onPress: onOpenSettings,
      sharesBackground: false,
      type: "button",
    }),
  ];
}
