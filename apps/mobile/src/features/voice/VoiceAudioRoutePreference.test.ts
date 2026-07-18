import { describe, expect, it } from "vitest";

import { presentVoiceAudioRoutePreference } from "./VoiceAudioRoutePreference";

describe("presentVoiceAudioRoutePreference", () => {
  it("reports a missing native runtime", () => {
    expect(
      presentVoiceAudioRoutePreference(null, {
        nativeAvailable: false,
        loading: false,
        error: null,
      }),
    ).toEqual({
      valueLabel: "Unavailable",
      statusMessage: "This build has no native voice runtime.",
    });
  });

  it("distinguishes the preferred route from the active fallback", () => {
    expect(
      presentVoiceAudioRoutePreference(
        {
          preferredRoute: "bluetooth",
          activeRoute: "speaker",
          routes: [
            {
              kind: "speaker",
              label: "Speaker",
            },
            {
              kind: "bluetooth",
              label: "Bluetooth",
            },
          ],
        },
        { nativeAvailable: true, loading: false, error: null },
      ),
    ).toEqual({
      valueLabel: "Bluetooth",
      statusMessage: "Android is currently using Speaker.",
    });
  });

  it("makes an unavailable persisted preference explicit", () => {
    expect(
      presentVoiceAudioRoutePreference(
        {
          preferredRoute: "bluetooth",
          activeRoute: "speaker",
          routes: [
            {
              kind: "speaker",
              label: "Speaker",
            },
          ],
        },
        { nativeAvailable: true, loading: false, error: null },
      ),
    ).toEqual({
      valueLabel: "Bluetooth (unavailable)",
      statusMessage: "Your preferred audio route is unavailable. Android is using Speaker.",
    });
  });
});
