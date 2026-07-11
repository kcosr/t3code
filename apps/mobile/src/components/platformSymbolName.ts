import type { AndroidSymbol, SFSymbol, SymbolViewProps } from "expo-symbols";

const ANDROID_SYMBOL_BY_SF_SYMBOL = {
  airplayaudio: "speaker",
  "arrow.up": "arrow_upward",
  checkmark: "check",
  "chevron.down": "keyboard_arrow_down",
  "clock.arrow.circlepath": "history",
  desktopcomputer: "computer",
  "mic.fill": "mic",
  "mic.slash.fill": "mic_off",
  "microphone.fill": "mic",
  "phone.down.fill": "call_end",
  plus: "add",
  "point.topleft.down.curvedto.point.bottomright.up": "account_tree",
  "slider.horizontal.3": "tune",
  "speaker.slash.fill": "volume_off",
  "speaker.wave.2.fill": "volume_up",
  "stop.fill": "stop",
  "tray.and.arrow.up": "upload",
  "waveform.circle.fill": "graphic_eq",
  xmark: "close",
} satisfies Partial<Record<SFSymbol, AndroidSymbol>>;

export function platformSymbolName(name: SymbolViewProps["name"]): SymbolViewProps["name"] {
  if (typeof name !== "string") return name;

  return {
    ios: name,
    android: ANDROID_SYMBOL_BY_SF_SYMBOL[name as keyof typeof ANDROID_SYMBOL_BY_SF_SYMBOL],
  };
}
