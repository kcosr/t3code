import type { VoiceThreadSettings } from "@t3tools/client-runtime/voice";
import { useEffect, useState } from "react";

import { Button } from "../components/ui/button";
import { useOptionalVoiceRuntime } from "./VoiceRuntimeContext";
import {
  DEFAULT_WEB_VOICE_THREAD_SETTINGS,
  loadWebVoiceThreadSettings,
  saveWebVoiceThreadSettings,
} from "./defaultThreadSettings";

export function VoiceSettingsSection() {
  const voice = useOptionalVoiceRuntime();
  const [localSettings, setLocalSettings] = useState<VoiceThreadSettings>(() =>
    loadWebVoiceThreadSettings(),
  );

  useEffect(() => {
    if (voice != null) {
      setLocalSettings(voice.threadSettings);
    }
  }, [voice, voice?.threadSettings]);

  const settings = voice?.threadSettings ?? localSettings;

  const patch = (partial: Partial<VoiceThreadSettings>) => {
    const next: VoiceThreadSettings = {
      ...settings,
      ...partial,
      endpointDetection: {
        ...settings.endpointDetection,
        ...(partial.endpointDetection ?? {}),
      },
    };
    if (voice != null) {
      voice.setThreadSettings(next);
    } else {
      setLocalSettings(next);
      saveWebVoiceThreadSettings(next);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Voice</h2>
        <p className="text-sm text-muted-foreground">
          Thread Auto Listen and Realtime preferences for this browser profile.
        </p>
      </div>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Auto-submit transcripts (skip review)</span>
        <input
          type="checkbox"
          checked={settings.submission === "auto-submit"}
          onChange={(event) =>
            patch({ submission: event.target.checked ? "auto-submit" : "review" })
          }
        />
      </label>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Play Thread responses</span>
        <input
          type="checkbox"
          checked={settings.playResponses}
          onChange={(event) => patch({ playResponses: event.target.checked })}
        />
      </label>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Auto-rearm Auto Listen</span>
        <input
          type="checkbox"
          checked={settings.autoRearm}
          onChange={(event) => patch({ autoRearm: event.target.checked })}
        />
      </label>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span>End silence (ms)</span>
        <input
          type="number"
          className="w-28 rounded border border-border bg-background px-2 py-1"
          value={settings.endpointDetection.endSilenceMs}
          min={200}
          max={10_000}
          onChange={(event) =>
            patch({
              endpointDetection: {
                ...settings.endpointDetection,
                endSilenceMs: Number(event.target.value) || 900,
              },
            })
          }
        />
      </label>

      <label className="flex items-center justify-between gap-4 text-sm">
        <span>Max utterance (ms)</span>
        <input
          type="number"
          className="w-28 rounded border border-border bg-background px-2 py-1"
          value={settings.endpointDetection.maximumUtteranceMs}
          min={5_000}
          max={180_000}
          onChange={(event) =>
            patch({
              endpointDetection: {
                ...settings.endpointDetection,
                maximumUtteranceMs: Number(event.target.value) || 60_000,
              },
            })
          }
        />
      </label>

      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (voice != null) {
            voice.setThreadSettings(DEFAULT_WEB_VOICE_THREAD_SETTINGS);
          } else {
            setLocalSettings(DEFAULT_WEB_VOICE_THREAD_SETTINGS);
            saveWebVoiceThreadSettings(DEFAULT_WEB_VOICE_THREAD_SETTINGS);
          }
        }}
      >
        Reset voice defaults
      </Button>
    </section>
  );
}
