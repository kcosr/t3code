import type { T3VoiceAudioRoute } from "@t3tools/mobile-voice-native";
import { SymbolView } from "expo-symbols";
import { ActivityIndicator, FlatList, Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPill } from "../../components/ControlPill";
import { platformSymbolName } from "../../components/platformSymbolName";
import { useThemeColor } from "../../lib/useThemeColor";
import type { ActiveMasterVoiceAttachment } from "./masterVoiceState";
import type { RealtimeVoiceControllerSnapshot } from "./realtimeVoiceController";

export interface MasterVoiceTranscriptTurn {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface VoiceAudioRoutePickerState {
  readonly routes: ReadonlyArray<T3VoiceAudioRoute> | null;
  readonly selectingRouteId: T3VoiceAudioRoute["id"] | null;
  readonly error: string | null;
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
  readonly turns: ReadonlyArray<MasterVoiceTranscriptTurn>;
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
  readonly state: VoiceAudioRoutePickerState | null;
  readonly onClose: () => void;
  readonly onSelect: (route: T3VoiceAudioRoute) => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const routes = props.state?.routes ?? [];
  const loading = props.state !== null && props.state.routes === null;
  const selectionInFlight = props.state?.selectingRouteId != null;
  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.state !== null}
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
          title="Audio route"
          closeLabel="Close audio routes"
          onClose={props.onClose}
        />
        {loading ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator accessibilityLabel="Loading audio routes" color={iconColor} />
          </View>
        ) : props.state?.error && routes.length === 0 ? (
          <Text accessibilityRole="alert" className="px-5 py-8 text-center text-sm text-danger">
            {props.state.error}
          </Text>
        ) : (
          <FlatList
            data={routes}
            keyExtractor={(route) => route.id}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24 }}
            ListHeaderComponent={
              props.state?.error ? (
                <Text accessibilityRole="alert" className="px-2 py-4 text-sm text-danger">
                  {props.state.error}
                </Text>
              ) : null
            }
            ListEmptyComponent={
              <Text className="px-2 py-8 text-center text-sm text-foreground-muted">
                No audio routes available
              </Text>
            }
            renderItem={({ item }) => {
              const selecting = props.state?.selectingRouteId === item.id;
              return (
                <Pressable
                  accessibilityRole="radio"
                  accessibilityState={{
                    checked: item.selected,
                    disabled: selectionInFlight,
                  }}
                  accessibilityLabel={item.label}
                  className="flex-row items-center border-b border-border px-2 py-4"
                  disabled={selectionInFlight}
                  onPress={() => props.onSelect(item)}
                >
                  <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
                    {item.label}
                  </Text>
                  {selecting ? (
                    <ActivityIndicator
                      accessibilityLabel={`Selecting ${item.label}`}
                      color={iconColor}
                    />
                  ) : item.selected ? (
                    <SymbolView
                      name={platformSymbolName("checkmark")}
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

function phaseLabel(snapshot: RealtimeVoiceControllerSnapshot): string {
  if (snapshot.phase === "starting") return "Connecting";
  if (snapshot.phase === "stopping") return "Ending voice session";
  if (snapshot.phase === "error") return "Voice session failed";
  if (snapshot.native?.realtimeConnectionState === "connecting") return "Connecting media";
  if (snapshot.native?.realtimeConnectionState === "connected") return "Voice active";
  return "Voice";
}

export function MasterVoiceCallBar(props: {
  readonly historyAvailable: boolean;
  readonly callAvailable: boolean;
  readonly snapshot: RealtimeVoiceControllerSnapshot;
  readonly attachment: ActiveMasterVoiceAttachment | null;
  readonly transcript: ReadonlyArray<MasterVoiceTranscriptTurn>;
  readonly onMute: () => void;
  readonly onRoute: () => void;
  readonly onTranscript: () => void;
  readonly onResume: () => void;
  readonly resumePending: boolean;
  readonly onHistory: () => void;
  readonly onRetryAttachment: () => void;
  readonly onStop: () => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  if (props.snapshot.phase === "idle") {
    if (!props.historyAvailable && !props.callAvailable) return null;
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
            {props.callAvailable ? "Resume your last conversation" : "Browse saved conversations"}
          </Text>
        </View>
        {props.historyAvailable ? (
          <ControlPill
            icon="clock.arrow.circlepath"
            accessibilityLabel="Browse voice conversations"
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
      <SymbolView
        name={platformSymbolName("waveform.circle.fill")}
        size={24}
        tintColor={iconColor}
        type="monochrome"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open voice transcript"
        className="min-w-0 flex-1"
        onPress={props.onTranscript}
      >
        <Text className="text-sm font-t3-bold text-foreground" numberOfLines={1}>
          {phaseLabel(props.snapshot)}
          {props.attachment?.focus === null || props.attachment === null
            ? ""
            : ` · ${props.attachment.focus.threadTitle}`}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {lastTurn?.text ?? "Tap to view the voice transcript"}
        </Text>
      </Pressable>
      {props.snapshot.phase === "active" ? (
        <>
          <ControlPill
            icon={props.snapshot.native?.realtimeMuted ? "mic.slash.fill" : "mic.fill"}
            accessibilityLabel={
              props.snapshot.native?.realtimeMuted ? "Unmute microphone" : "Mute microphone"
            }
            active={props.snapshot.native?.realtimeMuted ?? false}
            onPress={props.onMute}
          />
          <ControlPill
            icon="airplayaudio"
            accessibilityLabel="Choose audio route"
            onPress={props.onRoute}
          />
        </>
      ) : null}
      {props.snapshot.phase === "error" &&
      typeof props.snapshot.native?.activeRealtimeSessionId === "string" ? (
        <ControlPill
          icon="arrow.clockwise"
          label="Retry"
          accessibilityLabel="Retry voice attachment"
          onPress={props.onRetryAttachment}
        />
      ) : null}
      <ControlPill
        icon={
          props.snapshot.phase === "error" &&
          typeof props.snapshot.native?.activeRealtimeSessionId !== "string"
            ? "xmark"
            : "stop.fill"
        }
        accessibilityLabel={
          props.snapshot.phase === "error" &&
          typeof props.snapshot.native?.activeRealtimeSessionId !== "string"
            ? "Dismiss voice error"
            : "End voice session"
        }
        variant="danger"
        onPress={props.onStop}
      />
    </View>
  );
}
