import {
  realtimeVoiceBarPhase,
  type ActiveVoiceRuntimeAttachment,
  type RealtimeVoiceBarPhase,
  type VoiceRuntimeSnapshot,
} from "@t3tools/client-runtime/voice";
import { ActivityIndicator, FlatList, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { useThemeColor } from "../../lib/useThemeColor";
import type { VoiceAudioRoutePreferenceController } from "./VoiceAudioRoutePreference";

export interface RealtimeVoiceTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

function VoiceSheetHeader(props: {
  readonly title: string;
  readonly closeLabel: string;
  readonly onClose: () => void;
}) {
  return (
    <View className="flex-row items-center justify-between border-b border-border px-5 pb-4">
      <Text className="min-w-0 flex-1 pr-4 text-lg font-t3-bold text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
      <ControlPill icon="xmark" accessibilityLabel={props.closeLabel} onPress={props.onClose} />
    </View>
  );
}

export function VoiceTranscriptModal(props: {
  readonly visible: boolean;
  readonly turns: ReadonlyArray<RealtimeVoiceTranscriptTurn>;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={props.onClose}
    >
      <View
        className="flex-1 bg-screen"
        style={{
          paddingTop: Math.max(insets.top, 20),
          paddingBottom: Math.max(insets.bottom, 16),
        }}
      >
        <VoiceSheetHeader
          title="Current voice session"
          closeLabel="Close transcript"
          onClose={props.onClose}
        />
        <FlatList
          data={props.turns}
          keyExtractor={(_, index) => String(index)}
          contentContainerStyle={{ padding: 20, gap: 18 }}
          ListEmptyComponent={
            <Text className="py-8 text-center text-sm text-foreground-muted">
              The transcript will appear here.
            </Text>
          }
          renderItem={({ item }) => (
            <View>
              <Text className="text-xs font-t3-bold text-foreground-muted">
                {item.role === "user" ? "You" : "T3"}
              </Text>
              <Text className="mt-1 text-base text-foreground" selectable>
                {item.text}
              </Text>
            </View>
          )}
        />
      </View>
    </Modal>
  );
}

export function VoiceAudioRoutePicker(props: {
  readonly controller: VoiceAudioRoutePreferenceController;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const routes = props.controller.state?.routes ?? [];
  const loading = props.controller.loading && props.controller.state === null;
  const selectionInFlight = props.controller.selectingRoute !== null;
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.controller.visible}
      onRequestClose={props.controller.close}
    >
      <View
        className="flex-1 bg-screen"
        style={{
          paddingTop: Math.max(insets.top, 20),
          paddingBottom: Math.max(insets.bottom, 16),
        }}
      >
        <VoiceSheetHeader
          title="Voice audio device"
          closeLabel="Close voice audio devices"
          onClose={props.controller.close}
        />
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator accessibilityLabel="Loading audio routes" color={iconColor} />
          </View>
        ) : props.controller.error && routes.length === 0 ? (
          <Text accessibilityRole="alert" className="px-5 py-8 text-center text-sm text-danger">
            {props.controller.error}
          </Text>
        ) : (
          <FlatList
            data={routes}
            keyExtractor={(route) => route.kind}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
            ListHeaderComponent={
              props.controller.error || props.controller.statusMessage ? (
                <Text
                  accessibilityRole={props.controller.error ? "alert" : undefined}
                  className={
                    props.controller.error
                      ? "px-2 py-4 text-sm text-danger"
                      : "px-2 py-4 text-sm text-foreground-muted"
                  }
                >
                  {props.controller.error ?? props.controller.statusMessage}
                </Text>
              ) : null
            }
            ListEmptyComponent={
              <Text className="px-2 py-8 text-center text-sm text-foreground-muted">
                No audio devices available
              </Text>
            }
            renderItem={({ item }) => {
              const selecting = props.controller.selectingRoute === item.kind;
              const preferred = props.controller.state?.preferredRoute === item.kind;
              const active = props.controller.state?.activeRoute === item.kind;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: preferred,
                    disabled: selectionInFlight,
                  }}
                  accessibilityLabel={item.label}
                  className="flex-row items-center border-b border-border px-2 py-4"
                  disabled={selectionInFlight}
                  onPress={() => props.controller.select(item)}
                >
                  <View className="min-w-0 flex-1">
                    <Text className="text-base text-foreground" numberOfLines={1}>
                      {item.label}
                    </Text>
                    {active ? (
                      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                        Active now
                      </Text>
                    ) : null}
                  </View>
                  {selecting ? (
                    <ActivityIndicator
                      accessibilityLabel={`Selecting ${item.label}`}
                      color={iconColor}
                    />
                  ) : preferred ? (
                    <SymbolView
                      name="checkmark"
                      size={20}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function realtimePhaseLabel(phase: RealtimeVoiceBarPhase): string {
  switch (phase) {
    case "idle":
      return "Realtime voice";
    case "starting":
      return "Connecting Realtime voice";
    case "active":
      return "Realtime voice active";
    case "stopping":
      return "Ending Realtime voice";
    case "error":
      return "Realtime voice failed";
  }
}

export function RealtimeVoiceCallBar(props: {
  readonly historyAvailable: boolean;
  readonly callAvailable: boolean;
  readonly snapshot: VoiceRuntimeSnapshot;
  readonly controlsAvailable: boolean;
  readonly attachment: ActiveVoiceRuntimeAttachment | null;
  readonly transcript: ReadonlyArray<RealtimeVoiceTranscriptTurn>;
  readonly onMute: () => void;
  readonly onRoute: () => void;
  readonly routeAvailable: boolean;
  readonly onTranscript: () => void;
  readonly onResume: () => void;
  readonly resumePending: boolean;
  readonly onHistory: () => void;
  readonly onStop: () => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const barPhase = realtimeVoiceBarPhase(props.snapshot);
  if (barPhase === "idle") {
    if (!props.historyAvailable && !props.callAvailable && !props.routeAvailable) return null;
    return (
      <View
        className="flex-row items-center gap-3 border-t border-border bg-screen px-3 pt-2"
        style={{ paddingBottom: Math.max(insets.bottom, 12) }}
      >
        <View className="min-w-0 flex-1">
          <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
            Voice conversation
          </Text>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.callAvailable
              ? "Resume your last conversation"
              : props.historyAvailable
                ? "Browse saved conversations"
                : "Choose your preferred audio device"}
          </Text>
        </View>
        <ControlPill
          icon="airplayaudio"
          accessibilityLabel="Choose voice audio device"
          disabled={!props.routeAvailable}
          onPress={props.onRoute}
        />
        {props.historyAvailable ? (
          <ControlPill
            icon="clock.arrow.circlepath"
            accessibilityLabel="Browse voice conversations"
            disabled={props.resumePending}
            onPress={props.onHistory}
          />
        ) : null}
        {props.callAvailable ? (
          <ControlPill
            icon="waveform.circle.fill"
            label="Resume"
            accessibilityLabel="Resume last voice conversation"
            variant="primary"
            disabled={props.resumePending}
            onPress={props.onResume}
          />
        ) : null}
      </View>
    );
  }
  const lastTurn = props.transcript.at(-1);
  return (
    <View
      className="flex-row items-center gap-3 border-t border-border bg-screen px-3 pt-2"
      style={{ paddingBottom: Math.max(insets.bottom, 12) }}
    >
      <SymbolView name="waveform.circle.fill" size={24} tintColor={iconColor} type="monochrome" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open voice transcript"
        className="min-w-0 flex-1"
        onPress={props.onTranscript}
      >
        <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {realtimePhaseLabel(barPhase)}
          {props.attachment?.focus === null || props.attachment === null
            ? ""
            : ` · ${props.attachment.focus.threadTitle}`}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {lastTurn?.text ?? "Tap to view the voice transcript"}
        </Text>
      </Pressable>
      {props.snapshot.mode === "realtime" && props.snapshot.phase === "connected" ? (
        <>
          <ControlPill
            icon={props.snapshot.muted ? "mic.slash.fill" : "mic.fill"}
            accessibilityLabel={props.snapshot.muted ? "Unmute microphone" : "Mute microphone"}
            active={props.snapshot.muted}
            disabled={!props.controlsAvailable}
            onPress={props.onMute}
          />
        </>
      ) : null}
      <ControlPill
        icon="airplayaudio"
        accessibilityLabel="Choose voice audio device"
        disabled={!props.routeAvailable}
        onPress={props.onRoute}
      />
      <ControlPill
        icon={props.snapshot.mode === "failed" ? "xmark" : "stop.fill"}
        accessibilityLabel={
          props.snapshot.mode === "failed" ? "Dismiss voice error" : "End voice session"
        }
        variant="danger"
        disabled={!props.controlsAvailable}
        onPress={props.onStop}
      />
    </View>
  );
}
