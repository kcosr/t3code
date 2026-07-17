import { useEffect, useState } from "react";
import { VOICE_CONVERSATION_TITLE_MAX_CHARS } from "@t3tools/contracts";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";

export function VoiceConversationRenameModal(props: {
  readonly visible: boolean;
  readonly initialTitle: string;
  readonly saving: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (title: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [title, setTitle] = useState(props.initialTitle);

  useEffect(() => {
    if (props.visible) setTitle(props.initialTitle);
  }, [props.initialTitle, props.visible]);

  const trimmed = title.trim();
  const canSave = !props.saving && trimmed.length > 0 && trimmed !== props.initialTitle.trim();

  return (
    <Modal
      animationType="fade"
      onRequestClose={props.saving ? undefined : props.onCancel}
      transparent
      visible={props.visible}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1 justify-end bg-black/50"
      >
        <Pressable
          accessibilityLabel="Cancel renaming voice conversation"
          className="absolute inset-0"
          disabled={props.saving}
          onPress={props.onCancel}
        />
        <View
          className="gap-4 rounded-t-[20px] bg-sheet px-5 pt-5"
          style={{ paddingBottom: Math.max(insets.bottom, 20) }}
        >
          <Text className="text-lg font-t3-bold text-foreground">Rename conversation</Text>
          <TextInput
            accessibilityLabel="Conversation title"
            autoCapitalize="sentences"
            autoCorrect
            autoFocus
            maxLength={VOICE_CONVERSATION_TITLE_MAX_CHARS}
            returnKeyType="done"
            selectTextOnFocus
            value={title}
            onChangeText={setTitle}
            onSubmitEditing={() => {
              if (canSave) props.onSave(trimmed);
            }}
            className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
          />
          {props.error === null ? null : (
            <Text accessibilityRole="alert" className="text-sm text-danger">
              {props.error}
            </Text>
          )}
          <View className="flex-row justify-end gap-3">
            <Pressable
              accessibilityRole="button"
              className="min-h-11 items-center justify-center rounded-full bg-subtle px-5"
              disabled={props.saving}
              onPress={props.onCancel}
            >
              <Text className="text-sm font-t3-bold text-foreground">Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              className="min-h-11 min-w-24 flex-row items-center justify-center gap-2 rounded-full bg-primary px-5 disabled:bg-subtle-strong"
              disabled={!canSave}
              onPress={() => props.onSave(trimmed)}
            >
              {props.saving ? <ActivityIndicator color="white" /> : null}
              <Text className="text-sm font-t3-bold text-primary-foreground">Save</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
