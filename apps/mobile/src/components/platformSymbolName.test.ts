import { describe, expect, it } from "vitest";

import { platformSymbolName } from "./platformSymbolName";

describe("platformSymbolName", () => {
  it.each([
    ["microphone.fill", "mic"],
    ["waveform", "graphic_eq"],
    ["waveform.circle.fill", "graphic_eq"],
    ["speaker.wave.2.fill", "volume_up"],
    ["stop.fill", "stop"],
    ["arrow.up", "arrow_upward"],
    ["chevron.down", "keyboard_arrow_down"],
    ["clock.arrow.circlepath", "history"],
    ["airplayaudio", "speaker"],
    ["checkmark", "check"],
    ["xmark", "close"],
  ] as const)("maps %s to its Android Material symbol", (ios, android) => {
    expect(platformSymbolName(ios)).toEqual({ ios, android });
  });

  it("preserves an explicit platform symbol definition", () => {
    const name = {
      ios: "keyboard.chevron.compact.down",
      android: "keyboard_hide",
    } as const;

    expect(platformSymbolName(name)).toBe(name);
  });
});
