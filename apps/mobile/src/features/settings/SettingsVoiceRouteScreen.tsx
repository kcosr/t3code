import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { getT3VoiceNativeModule } from "@t3tools/mobile-voice-native";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { Alert, Linking, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useProjects, useThreadShells } from "../../state/entities";
import {
  resolveVoicePreferences,
  VOICE_END_SILENCE_MAX_MS,
  VOICE_END_SILENCE_MIN_MS,
  VOICE_END_SILENCE_STEP_MS,
  VOICE_MAXIMUM_UTTERANCE_MAX_MS,
  VOICE_MAXIMUM_UTTERANCE_MIN_MS,
  VOICE_NO_SPEECH_DEFAULT_MS,
  VOICE_NO_SPEECH_MAX_MS,
  VOICE_NO_SPEECH_MIN_MS,
  VOICE_REARM_GUARD_MAX_MS,
  VOICE_REARM_GUARD_MIN_MS,
  VOICE_RESPONSE_TIMEOUT_MAX_MS,
  VOICE_RESPONSE_TIMEOUT_MIN_MS,
  VOICE_SUBMISSION_TIMEOUT_MAX_MS,
  VOICE_SUBMISSION_TIMEOUT_MIN_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS,
  VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS,
} from "../voice/voicePreferences";
import { formatVoiceDiagnostics } from "../voice/voiceDiagnostics";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsStepperRow } from "./components/SettingsStepperRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const seconds = (milliseconds: number): string => `${(milliseconds / 1_000).toFixed(1)} sec`;
const minutes = (milliseconds: number): string => `${Math.round(milliseconds / 60_000)} min`;

export function SettingsVoiceRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const threadShells = useThreadShells();
  const projects = useProjects();
  const ready = AsyncResult.isSuccess(preferencesResult);
  const stored = ready ? preferencesResult.value : {};
  const voice = resolveVoicePreferences(stored);
  const backgroundControlsEnabled = stored.voiceBackgroundControlsEnabled === true;
  const backgroundDefaultMode = stored.voiceBackgroundDefaultMode ?? "realtime";
  const target = stored.voiceThreadTarget;
  const backgroundThreadTargetValid =
    target != null &&
    threadShells.some(
      (thread) =>
        String(thread.environmentId) === target.environmentId &&
        String(thread.id) === target.threadId &&
        thread.archivedAt === null &&
        projects.some(
          (project) =>
            project.environmentId === thread.environmentId && project.id === thread.projectId,
        ),
    );
  const noSpeechEnabled = voice.noSpeechTimeoutMs !== null;
  const [notificationPermission, setNotificationPermission] = useState<
    "checking" | "granted" | "denied" | "open-settings" | "unavailable"
  >("checking");
  const [microphonePermissionGranted, setMicrophonePermissionGranted] = useState(false);
  const refreshNotificationPermission = useCallback(async () => {
    if (Platform.OS !== "android") {
      setNotificationPermission("unavailable");
      return;
    }
    const native = getT3VoiceNativeModule();
    if (native === null) {
      setNotificationPermission("unavailable");
      return;
    }
    try {
      const [permission, microphone] = await Promise.all([
        native.getNotificationPermissionAsync(),
        native.getMicrophonePermissionAsync(),
      ]);
      setMicrophonePermissionGranted(microphone.granted);
      setNotificationPermission(
        permission.granted ? "granted" : permission.canAskAgain ? "denied" : "open-settings",
      );
    } catch {
      setNotificationPermission("unavailable");
    }
  }, []);
  useFocusEffect(
    useCallback(() => {
      void refreshNotificationPermission();
    }, [refreshNotificationPermission]),
  );
  const requestNotificationPermission = async () => {
    if (notificationPermission === "open-settings") {
      await Linking.openSettings();
      return;
    }
    const native = getT3VoiceNativeModule();
    if (native === null) return;
    try {
      const permission = await native.requestNotificationPermissionAsync();
      setNotificationPermission(
        permission.granted ? "granted" : permission.canAskAgain ? "denied" : "open-settings",
      );
    } catch {
      setNotificationPermission("unavailable");
    }
  };
  const setBackgroundControlsEnabled = async (enabled: boolean) => {
    if (!enabled) {
      savePreferences({ voiceBackgroundControlsEnabled: false });
      return;
    }
    const native = getT3VoiceNativeModule();
    if (native === null) return;
    try {
      const microphone = microphonePermissionGranted
        ? await native.getMicrophonePermissionAsync()
        : await native.requestMicrophonePermissionAsync();
      const notification =
        notificationPermission === "granted"
          ? await native.getNotificationPermissionAsync()
          : await native.requestNotificationPermissionAsync();
      setMicrophonePermissionGranted(microphone.granted);
      setNotificationPermission(notification.granted ? "granted" : "denied");
      if (!microphone.granted || !notification.granted) {
        Alert.alert(
          "Permissions required",
          "Background voice controls need microphone and notification access.",
        );
        return;
      }
      savePreferences({ voiceBackgroundControlsEnabled: true });
    } catch {
      Alert.alert("Background voice controls unavailable", "Permissions could not be verified.");
    }
  };
  const copyDiagnostics = async () => {
    const native = getT3VoiceNativeModule();
    if (native === null) {
      Alert.alert("Voice diagnostics unavailable", "This build has no native voice runtime.");
      return;
    }
    let entries: Awaited<ReturnType<typeof native.getDiagnosticsAsync>>;
    try {
      entries = await native.getDiagnosticsAsync();
      if (entries.length === 0) {
        Alert.alert(
          "No voice diagnostics yet",
          "Use voice once, then copy the diagnostic snapshot.",
        );
        return;
      }
    } catch {
      Alert.alert("Voice diagnostics unavailable", "The diagnostic snapshot could not be read.");
      return;
    }
    try {
      await Clipboard.setStringAsync(formatVoiceDiagnostics(entries));
      Alert.alert("Voice diagnostics copied", `${entries.length} entries copied.`);
    } catch {
      Alert.alert("Voice diagnostics not copied", "The diagnostic snapshot could not be copied.");
    }
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Conversation">
          <SettingsSwitchRow
            disabled={!ready}
            icon="waveform"
            label="Auto Listen"
            value={voice.autoListenEnabled}
            onValueChange={(value) => savePreferences({ voiceAutoListenEnabled: value })}
          />
          <SettingsSwitchRow
            disabled={!ready || !voice.autoListenEnabled}
            icon="paperplane"
            label="Send automatically"
            value={voice.autoSubmitEnabled}
            onValueChange={(value) => savePreferences({ voiceAutoSubmitEnabled: value })}
          />
          <SettingsSwitchRow
            disabled={!ready}
            icon="speaker.wave.2"
            label="Play spoken responses"
            value={stored.threadSpeechEnabled === true}
            onValueChange={(value) => savePreferences({ threadSpeechEnabled: value })}
          />
        </SettingsSection>

        {Platform.OS === "android" ? (
          <SettingsSection title="Background controls">
            <SettingsSwitchRow
              disabled={!ready}
              icon="headphones"
              label="Background voice controls"
              value={backgroundControlsEnabled}
              onValueChange={(value) => void setBackgroundControlsEnabled(value)}
            />
            <SettingsRow
              disabled={!ready || !backgroundControlsEnabled}
              icon="waveform.circle"
              label="Default voice mode"
              value={
                backgroundDefaultMode === "realtime"
                  ? "Realtime"
                  : backgroundThreadTargetValid
                    ? "Active thread"
                    : "Active thread unavailable"
              }
              onPress={() =>
                Alert.alert(
                  "Default voice mode",
                  backgroundThreadTargetValid
                    ? undefined
                    : "Use Auto Listen in a thread before selecting Active thread.",
                  [
                    {
                      text: "Realtime",
                      onPress: () => savePreferences({ voiceBackgroundDefaultMode: "realtime" }),
                    },
                    ...(backgroundThreadTargetValid
                      ? [
                          {
                            text: "Active thread",
                            onPress: () =>
                              savePreferences({ voiceBackgroundDefaultMode: "thread" as const }),
                          },
                        ]
                      : []),
                    { text: "Cancel", style: "cancel" },
                  ],
                )
              }
            />
          </SettingsSection>
        ) : null}

        <SettingsSection title="Listening">
          <SettingsStepperRow
            disabled={!ready}
            icon="waveform.path"
            label="End silence"
            max={VOICE_END_SILENCE_MAX_MS}
            min={VOICE_END_SILENCE_MIN_MS}
            step={VOICE_END_SILENCE_STEP_MS}
            value={voice.endSilenceMs}
            valueLabel={seconds(voice.endSilenceMs)}
            onChange={(value) => savePreferences({ voiceEndSilenceMs: value })}
          />
          <SettingsSwitchRow
            disabled={!ready}
            icon="timer"
            label="Wait for speech limit"
            value={noSpeechEnabled}
            onValueChange={(value) =>
              savePreferences({
                voiceNoSpeechTimeoutMs: value ? VOICE_NO_SPEECH_DEFAULT_MS : null,
              })
            }
          />
          {noSpeechEnabled ? (
            <SettingsStepperRow
              disabled={!ready}
              icon="timer"
              label="Wait for speech"
              max={VOICE_NO_SPEECH_MAX_MS}
              min={VOICE_NO_SPEECH_MIN_MS}
              step={5_000}
              value={voice.noSpeechTimeoutMs ?? VOICE_NO_SPEECH_DEFAULT_MS}
              valueLabel={`${Math.round((voice.noSpeechTimeoutMs ?? 0) / 1_000)} sec`}
              onChange={(value) => savePreferences({ voiceNoSpeechTimeoutMs: value })}
            />
          ) : null}
          <SettingsStepperRow
            disabled={!ready}
            icon="stopwatch"
            label="Maximum utterance"
            max={VOICE_MAXIMUM_UTTERANCE_MAX_MS}
            min={VOICE_MAXIMUM_UTTERANCE_MIN_MS}
            step={60_000}
            value={voice.maximumUtteranceMs}
            valueLabel={minutes(voice.maximumUtteranceMs)}
            onChange={(value) => savePreferences({ voiceMaximumUtteranceMs: value })}
          />
        </SettingsSection>

        <SettingsSection title="Rearm">
          <SettingsStepperRow
            disabled={!ready}
            icon="text.bubble"
            label="Transcription timeout"
            max={VOICE_TRANSCRIPTION_TIMEOUT_MAX_MS}
            min={VOICE_TRANSCRIPTION_TIMEOUT_MIN_MS}
            step={60_000}
            value={voice.transcriptionTimeoutMs}
            valueLabel={minutes(voice.transcriptionTimeoutMs)}
            onChange={(value) => savePreferences({ voiceTranscriptionTimeoutMs: value })}
          />
          <SettingsStepperRow
            disabled={!ready}
            icon="paperplane"
            label="Send timeout"
            max={VOICE_SUBMISSION_TIMEOUT_MAX_MS}
            min={VOICE_SUBMISSION_TIMEOUT_MIN_MS}
            step={10_000}
            value={voice.submissionTimeoutMs}
            valueLabel={`${Math.round(voice.submissionTimeoutMs / 1_000)} sec`}
            onChange={(value) => savePreferences({ voiceSubmissionTimeoutMs: value })}
          />
          <SettingsStepperRow
            disabled={!ready}
            icon="arrow.clockwise"
            label="Playback guard"
            max={VOICE_REARM_GUARD_MAX_MS}
            min={VOICE_REARM_GUARD_MIN_MS}
            step={250}
            value={voice.postPlaybackGuardMs}
            valueLabel={seconds(voice.postPlaybackGuardMs)}
            onChange={(value) => savePreferences({ voicePostPlaybackGuardMs: value })}
          />
          <SettingsStepperRow
            disabled={!ready}
            icon="hourglass"
            label="Response cycle timeout"
            max={VOICE_RESPONSE_TIMEOUT_MAX_MS}
            min={VOICE_RESPONSE_TIMEOUT_MIN_MS}
            step={60_000}
            value={voice.responseTimeoutMs}
            valueLabel={minutes(voice.responseTimeoutMs)}
            onChange={(value) => savePreferences({ voiceResponseTimeoutMs: value })}
          />
        </SettingsSection>

        <SettingsSection title="Support">
          {Platform.OS === "android" ? (
            <SettingsRow
              icon="bell"
              label="Background voice notification"
              value={
                notificationPermission === "checking"
                  ? "Checking"
                  : notificationPermission === "granted"
                    ? "Allowed"
                    : notificationPermission === "denied"
                      ? "Not allowed"
                      : notificationPermission === "open-settings"
                        ? "Open settings"
                        : "Unavailable"
              }
              disabled={
                notificationPermission === "checking" ||
                notificationPermission === "granted" ||
                notificationPermission === "unavailable"
              }
              onPress={() => void requestNotificationPermission()}
            />
          ) : null}
          <SettingsRow
            icon="doc.on.clipboard"
            label="Copy voice diagnostics"
            value="Redacted"
            onPress={() => void copyDiagnostics()}
          />
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
