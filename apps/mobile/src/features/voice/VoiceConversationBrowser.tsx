import type { VoiceHttpClient } from "@t3tools/client-runtime/voice";
import type {
  VoiceConversationId,
  VoiceConversationSummary,
  VoiceConversationTranscriptEntry,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import * as Effect from "effect/Effect";
import { SymbolView } from "expo-symbols";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { EmptyState } from "../../components/EmptyState";
import { platformSymbolName } from "../../components/platformSymbolName";
import { relativeTime } from "../../lib/time";
import { useThemeColor } from "../../lib/useThemeColor";
import { uuidv4 } from "../../lib/uuid";
import {
  mergeVoiceTranscriptEntries,
  mergeVoiceConversations,
  removeVoiceConversation,
  replaceVoiceConversation,
  sortVoiceConversations,
  voiceTranscriptRows,
  type VoiceTranscriptRow,
} from "./voiceConversationBrowserState";
import { VoiceConversationRenameModal } from "./VoiceConversationRenameModal";

export type VoiceConversationClient = Pick<
  VoiceHttpClient,
  | "listConversations"
  | "getConversation"
  | "updateConversation"
  | "getConversationTranscript"
  | "clearConversationContext"
  | "deleteConversation"
>;

const TRANSCRIPT_PAGE_SIZE = 40;
const CONVERSATION_PAGE_SIZE = 40;
const CONVERSATION_ACTIONS: MenuAction[] = [
  { id: "rename", title: "Rename", image: "pencil" },
  { id: "clear", title: "Clear Model Context", image: "eraser" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

const messageFromCause = (cause: unknown): string =>
  cause instanceof Error && cause.message.trim().length > 0
    ? cause.message
    : "The request could not be completed.";

const isConversationNotFound = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  (cause as { readonly reason: unknown }).reason === "voice_conversation_not_found";

function BrowserHeader(props: {
  readonly title: string;
  readonly back: boolean;
  readonly onBack: () => void;
  readonly action?: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-3 border-b border-border px-4 pb-3">
      <ControlPill
        icon={props.back ? "chevron.left" : "xmark"}
        accessibilityLabel={
          props.back ? "Back to voice conversations" : "Close voice conversations"
        }
        onPress={props.onBack}
      />
      <Text className="min-w-0 flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
        {props.title}
      </Text>
      {props.action}
    </View>
  );
}

export function VoiceConversationBrowser(props: {
  readonly visible: boolean;
  readonly client: VoiceConversationClient | null;
  readonly onClose: () => void;
  readonly onNew: () => void;
  readonly onResume: (conversationId: VoiceConversationId) => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const [conversations, setConversations] = useState<ReadonlyArray<VoiceConversationSummary>>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listRefreshing, setListRefreshing] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listNextCursor, setListNextCursor] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VoiceConversationSummary | null>(null);
  const [entries, setEntries] = useState<ReadonlyArray<VoiceConversationTranscriptEntry>>([]);
  const [activeContextEpoch, setActiveContextEpoch] = useState(1);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [mutation, setMutation] = useState<null | "rename" | "clear" | "delete">(null);
  const [renameVisible, setRenameVisible] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);

  useEffect(() => {
    listGeneration.current += 1;
    detailGeneration.current += 1;
    setConversations([]);
    setListLoading(false);
    setListRefreshing(false);
    setListLoadingMore(false);
    setListNextCursor(null);
    setListError(null);
    setSelected(null);
    setEntries([]);
    setNextCursor(null);
    setDetailLoading(false);
    setDetailError(null);
    setLoadingEarlier(false);
    setMutation(null);
    setRenameVisible(false);
    setRenameError(null);
  }, [props.client]);

  const loadList = useCallback(
    async (refresh: boolean) => {
      if (props.client === null) return;
      const generation = ++listGeneration.current;
      setListLoadingMore(false);
      setListNextCursor(null);
      if (refresh) setListRefreshing(true);
      else setListLoading(true);
      setListError(null);
      try {
        const result = await Effect.runPromise(
          props.client.listConversations({ limit: CONVERSATION_PAGE_SIZE }),
        );
        if (generation === listGeneration.current) {
          setConversations(sortVoiceConversations(result.conversations));
          setListNextCursor(result.nextCursor);
        }
      } catch (cause) {
        if (generation === listGeneration.current) setListError(messageFromCause(cause));
      } finally {
        if (generation === listGeneration.current) {
          setListLoading(false);
          setListRefreshing(false);
        }
      }
    },
    [props.client],
  );

  const loadMoreConversations = useCallback(async () => {
    if (
      props.client === null ||
      listNextCursor === null ||
      listLoading ||
      listRefreshing ||
      listLoadingMore ||
      mutation !== null
    )
      return;
    const generation = listGeneration.current;
    const cursor = listNextCursor;
    setListLoadingMore(true);
    setListError(null);
    try {
      const result = await Effect.runPromise(
        props.client.listConversations({ cursor, limit: CONVERSATION_PAGE_SIZE }),
      );
      if (generation !== listGeneration.current) return;
      setConversations((current) => mergeVoiceConversations(current, result.conversations));
      setListNextCursor(result.nextCursor);
    } catch (cause) {
      if (generation === listGeneration.current) setListError(messageFromCause(cause));
    } finally {
      if (generation === listGeneration.current) setListLoadingMore(false);
    }
  }, [listLoading, listLoadingMore, listNextCursor, listRefreshing, mutation, props.client]);

  useEffect(() => {
    if (!props.visible) {
      listGeneration.current += 1;
      detailGeneration.current += 1;
      setSelected(null);
      setRenameVisible(false);
      setListLoadingMore(false);
      return;
    }
    void loadList(false);
  }, [loadList, props.visible]);

  const convergeMissingConversation = useCallback(
    (conversationId: VoiceConversationId) => {
      listGeneration.current += 1;
      detailGeneration.current += 1;
      setConversations((current) => removeVoiceConversation(current, conversationId));
      setListLoading(false);
      setListRefreshing(false);
      setListLoadingMore(false);
      setListNextCursor(null);
      setSelected(null);
      setEntries([]);
      setNextCursor(null);
      setDetailLoading(false);
      setDetailError(null);
      setLoadingEarlier(false);
      setMutation(null);
      setRenameVisible(false);
      setRenameError(null);
      void loadList(true);
    },
    [loadList],
  );

  const openConversation = useCallback(
    async (conversation: VoiceConversationSummary) => {
      if (props.client === null || mutation !== null) return;
      const generation = ++detailGeneration.current;
      setSelected(conversation);
      setEntries([]);
      setActiveContextEpoch(conversation.activeEpoch);
      setNextCursor(null);
      setLoadingEarlier(false);
      setDetailLoading(true);
      setDetailError(null);
      try {
        const page = await Effect.runPromise(
          props.client.getConversationTranscript(conversation.conversationId, {
            limit: TRANSCRIPT_PAGE_SIZE,
          }),
        );
        if (generation !== detailGeneration.current) return;
        setEntries(page.entries);
        setActiveContextEpoch(page.activeContextEpoch);
        setNextCursor(page.nextCursor);
      } catch (cause) {
        if (generation !== detailGeneration.current) return;
        if (isConversationNotFound(cause)) {
          convergeMissingConversation(conversation.conversationId);
          return;
        }
        setDetailError(messageFromCause(cause));
      } finally {
        if (generation === detailGeneration.current) setDetailLoading(false);
      }
    },
    [convergeMissingConversation, mutation, props.client],
  );

  const loadEarlier = useCallback(async () => {
    if (
      props.client === null ||
      selected === null ||
      nextCursor === null ||
      loadingEarlier ||
      mutation !== null
    )
      return;
    const generation = detailGeneration.current;
    const cursor = nextCursor;
    setLoadingEarlier(true);
    setDetailError(null);
    try {
      const page = await Effect.runPromise(
        props.client.getConversationTranscript(selected.conversationId, {
          cursor,
          limit: TRANSCRIPT_PAGE_SIZE,
        }),
      );
      if (generation !== detailGeneration.current) return;
      setEntries((current) => mergeVoiceTranscriptEntries(current, page.entries));
      setActiveContextEpoch(page.activeContextEpoch);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (generation !== detailGeneration.current) return;
      if (isConversationNotFound(cause)) {
        convergeMissingConversation(selected.conversationId);
        return;
      }
      setDetailError(messageFromCause(cause));
    } finally {
      if (generation === detailGeneration.current) setLoadingEarlier(false);
    }
  }, [convergeMissingConversation, loadingEarlier, mutation, nextCursor, props.client, selected]);

  const rows = useMemo(
    () => voiceTranscriptRows(entries, activeContextEpoch),
    [activeContextEpoch, entries],
  );
  const activeEpochHasEntries = entries.some((entry) => entry.contextEpoch === activeContextEpoch);
  const detailActionBusy = detailLoading || loadingEarlier || mutation !== null;

  const saveRename = useCallback(
    async (title: string) => {
      if (props.client === null || selected === null || mutation !== null) return;
      const generation = detailGeneration.current;
      listGeneration.current += 1;
      setListLoading(false);
      setListRefreshing(false);
      setListLoadingMore(false);
      setListNextCursor(null);
      setMutation("rename");
      setRenameError(null);
      try {
        const updated = await Effect.runPromise(
          props.client.updateConversation(selected.conversationId, { title }),
        );
        if (generation !== detailGeneration.current) return;
        setSelected(updated);
        setConversations((current) => replaceVoiceConversation(current, updated));
        setRenameVisible(false);
      } catch (cause) {
        if (generation !== detailGeneration.current) return;
        if (isConversationNotFound(cause)) {
          convergeMissingConversation(selected.conversationId);
          return;
        }
        setRenameError(messageFromCause(cause));
      } finally {
        if (generation === detailGeneration.current) {
          setMutation(null);
          void loadList(true);
        }
      }
    },
    [convergeMissingConversation, loadList, mutation, props.client, selected],
  );

  const clearContext = useCallback(async () => {
    if (props.client === null || selected === null || mutation !== null) return;
    const generation = detailGeneration.current;
    listGeneration.current += 1;
    setListLoading(false);
    setListRefreshing(false);
    setListLoadingMore(false);
    setListNextCursor(null);
    setMutation("clear");
    try {
      const result = await Effect.runPromise(
        props.client.clearConversationContext(selected.conversationId, {
          expectedEpoch: activeContextEpoch,
          idempotencyKey: uuidv4(),
        }),
      );
      if (generation !== detailGeneration.current) return;
      const updated = { ...selected, activeEpoch: result.activeEpoch, updatedAt: result.clearedAt };
      setSelected(updated);
      setActiveContextEpoch(result.activeEpoch);
      setConversations((current) => replaceVoiceConversation(current, updated));
    } catch (cause) {
      if (generation !== detailGeneration.current) return;
      if (isConversationNotFound(cause)) {
        convergeMissingConversation(selected.conversationId);
        return;
      }
      Alert.alert("Could not clear model context", messageFromCause(cause));
    } finally {
      if (generation === detailGeneration.current) {
        setMutation(null);
        void loadList(true);
      }
    }
  }, [activeContextEpoch, convergeMissingConversation, loadList, mutation, props.client, selected]);

  const deleteConversation = useCallback(async () => {
    if (props.client === null || selected === null || mutation !== null) return;
    const generation = detailGeneration.current;
    listGeneration.current += 1;
    setListLoading(false);
    setListRefreshing(false);
    setListLoadingMore(false);
    setListNextCursor(null);
    setMutation("delete");
    try {
      await Effect.runPromise(props.client.deleteConversation(selected.conversationId));
      if (generation !== detailGeneration.current) return;
      convergeMissingConversation(selected.conversationId);
    } catch (cause) {
      if (generation !== detailGeneration.current) return;
      if (isConversationNotFound(cause)) {
        convergeMissingConversation(selected.conversationId);
        return;
      }
      Alert.alert("Could not delete conversation", messageFromCause(cause));
    } finally {
      if (generation === detailGeneration.current) {
        setMutation(null);
        void loadList(true);
      }
    }
  }, [convergeMissingConversation, loadList, mutation, props.client, selected]);

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (selected === null || detailActionBusy) return;
      if (nativeEvent.event === "rename") {
        setRenameError(null);
        setRenameVisible(true);
      } else if (nativeEvent.event === "clear") {
        Alert.alert(
          "Clear model context?",
          "Earlier transcript will remain visible, but it will not be included when this conversation is resumed. Any active call will end.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Clear", style: "destructive", onPress: () => void clearContext() },
          ],
        );
      } else if (nativeEvent.event === "delete") {
        Alert.alert(
          "Delete voice conversation?",
          `“${selected.title ?? "Voice conversation"}” and its transcript will be permanently deleted. Any active call will end.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => void deleteConversation() },
          ],
        );
      }
    },
    [clearContext, deleteConversation, detailActionBusy, selected],
  );

  const closeDetail = useCallback(() => {
    if (mutation !== null) return;
    detailGeneration.current += 1;
    setSelected(null);
    setEntries([]);
    setDetailError(null);
    setDetailLoading(false);
    setLoadingEarlier(false);
  }, [mutation]);

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={selected === null ? props.onClose : closeDetail}
    >
      <View
        className="flex-1 bg-screen"
        style={{ paddingTop: Math.max(insets.top, 20), paddingBottom: Math.max(insets.bottom, 12) }}
      >
        {selected === null ? (
          <>
            <BrowserHeader
              title="Voice conversations"
              back={false}
              onBack={props.onClose}
              action={
                <ControlPill
                  icon="plus"
                  label="New"
                  variant="primary"
                  accessibilityLabel="Start a new voice conversation"
                  disabled={props.client === null}
                  onPress={() => {
                    props.onClose();
                    props.onNew();
                  }}
                />
              }
            />
            {listLoading && conversations.length === 0 ? (
              <View className="flex-1 items-center justify-center gap-3">
                <ActivityIndicator
                  accessibilityLabel="Loading voice conversations"
                  color={iconColor}
                />
                <Text className="text-sm text-foreground-muted">Loading conversations…</Text>
              </View>
            ) : listError !== null && conversations.length === 0 ? (
              <View className="flex-1 items-center justify-center gap-4 px-8">
                <Text accessibilityRole="alert" className="text-center text-sm text-danger">
                  {listError}
                </Text>
                <ControlPill label="Retry" variant="primary" onPress={() => void loadList(false)} />
              </View>
            ) : (
              <FlatList
                data={conversations}
                keyExtractor={(conversation) => conversation.conversationId}
                contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 16, paddingBottom: 24 }}
                refreshControl={
                  <RefreshControl
                    refreshing={listRefreshing}
                    onRefresh={() => void loadList(true)}
                  />
                }
                ListHeaderComponent={
                  listError === null ? (
                    <View className="h-2" />
                  ) : (
                    <Pressable className="px-2 py-4" onPress={() => void loadList(true)}>
                      <Text accessibilityRole="alert" className="text-sm text-danger">
                        {listError} Tap to retry.
                      </Text>
                    </Pressable>
                  )
                }
                ListEmptyComponent={
                  <EmptyState
                    title="No saved conversations"
                    detail="Start a new voice conversation to keep its transcript here."
                    variant="plain"
                  />
                }
                ListFooterComponent={
                  listNextCursor === null ? null : (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: listLoadingMore }}
                      className="min-h-11 items-center justify-center px-4 py-3"
                      disabled={listLoadingMore}
                      onPress={() => void loadMoreConversations()}
                    >
                      {listLoadingMore ? (
                        <ActivityIndicator
                          accessibilityLabel="Loading more voice conversations"
                          color={iconColor}
                        />
                      ) : (
                        <Text className="text-sm font-t3-bold text-foreground">Load more</Text>
                      )}
                    </Pressable>
                  )
                }
                renderItem={({ item }) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Open transcript for ${item.title ?? "voice conversation"}`}
                    className="flex-row items-center gap-3 border-b border-border px-2 py-4 active:bg-subtle"
                    onPress={() => void openConversation(item)}
                  >
                    <SymbolView
                      name={platformSymbolName("waveform.circle.fill")}
                      size={24}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                    <View className="min-w-0 flex-1">
                      <Text className="text-base font-t3-bold text-foreground" numberOfLines={1}>
                        {item.title ?? "Voice conversation"}
                      </Text>
                      <Text className="mt-1 text-xs text-foreground-muted">
                        {relativeTime(item.updatedAt)}
                      </Text>
                    </View>
                    <SymbolView
                      name={platformSymbolName("chevron.right")}
                      size={14}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  </Pressable>
                )}
              />
            )}
          </>
        ) : (
          <>
            <BrowserHeader
              title={selected.title ?? "Voice conversation"}
              back
              onBack={closeDetail}
              action={
                <ControlPillMenu actions={CONVERSATION_ACTIONS} onPressAction={handleMenuAction}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Actions for ${selected.title ?? "voice conversation"}`}
                    className="h-11 w-11 items-center justify-center rounded-full bg-subtle"
                    disabled={detailActionBusy}
                  >
                    <SymbolView
                      name={platformSymbolName("ellipsis")}
                      size={16}
                      tintColor={iconColor}
                      type="monochrome"
                    />
                  </Pressable>
                </ControlPillMenu>
              }
            />
            {detailLoading ? (
              <View className="flex-1 items-center justify-center gap-3">
                <ActivityIndicator
                  accessibilityLabel="Loading voice transcript"
                  color={iconColor}
                />
                <Text className="text-sm text-foreground-muted">Loading transcript…</Text>
              </View>
            ) : detailError !== null && entries.length === 0 ? (
              <View className="flex-1 items-center justify-center gap-4 px-8">
                <Text accessibilityRole="alert" className="text-center text-sm text-danger">
                  {detailError}
                </Text>
                <ControlPill
                  label="Retry"
                  variant="primary"
                  onPress={() => void openConversation(selected)}
                />
              </View>
            ) : (
              <FlatList<VoiceTranscriptRow>
                data={rows}
                keyExtractor={(row) => row.id}
                maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingBottom: 20 }}
                ListHeaderComponent={
                  <View className="gap-3 py-4">
                    {!activeEpochHasEntries && entries.length > 0 ? (
                      <View className="rounded-[8px] bg-subtle px-4 py-3">
                        <Text className="text-sm font-t3-bold text-foreground">
                          Current model context is empty
                        </Text>
                        <Text className="mt-1 text-xs text-foreground-muted">
                          Earlier transcript remains available below.
                        </Text>
                      </View>
                    ) : null}
                    {nextCursor === null ? null : (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ disabled: loadingEarlier }}
                        className="min-h-11 items-center justify-center rounded-full bg-subtle px-4"
                        disabled={loadingEarlier}
                        onPress={() => void loadEarlier()}
                      >
                        {loadingEarlier ? (
                          <ActivityIndicator
                            accessibilityLabel="Loading earlier transcript"
                            color={iconColor}
                          />
                        ) : (
                          <Text className="text-sm font-t3-bold text-foreground">Load earlier</Text>
                        )}
                      </Pressable>
                    )}
                    {detailError === null ? null : (
                      <Pressable onPress={() => void loadEarlier()}>
                        <Text accessibilityRole="alert" className="text-center text-sm text-danger">
                          {detailError} Tap to retry.
                        </Text>
                      </Pressable>
                    )}
                  </View>
                }
                ListEmptyComponent={
                  <EmptyState
                    title="No transcript yet"
                    detail="Resume this conversation to begin a new call."
                    variant="plain"
                  />
                }
                renderItem={({ item }) =>
                  item.type === "epoch" ? (
                    <View className="flex-row items-center gap-3 py-4">
                      <View className="h-px flex-1 bg-border" />
                      <Text className="text-xs font-t3-bold text-foreground-muted">
                        {item.active ? "Current model context" : "Earlier model context"}
                      </Text>
                      <View className="h-px flex-1 bg-border" />
                    </View>
                  ) : (
                    <View className="pb-5">
                      <Text className="text-xs font-t3-bold text-foreground-muted">
                        {item.entry.role === "user" ? "You" : "T3"}
                      </Text>
                      <Text className="mt-1 text-base text-foreground" selectable>
                        {item.entry.text}
                        {item.entry.truncated ? "…" : ""}
                      </Text>
                    </View>
                  )
                }
              />
            )}
            <View className="flex-row items-center justify-end border-t border-border px-4 pt-3">
              <ControlPill
                icon="waveform.circle.fill"
                label="Resume"
                variant="primary"
                accessibilityLabel={`Resume ${selected.title ?? "voice conversation"}`}
                disabled={detailActionBusy}
                onPress={() => {
                  props.onClose();
                  props.onResume(selected.conversationId);
                }}
              />
            </View>
          </>
        )}
      </View>
      <VoiceConversationRenameModal
        visible={renameVisible}
        initialTitle={selected?.title ?? "Voice conversation"}
        saving={mutation === "rename"}
        error={renameError}
        onCancel={() => {
          if (mutation !== "rename") setRenameVisible(false);
        }}
        onSave={(title) => void saveRename(title)}
      />
    </Modal>
  );
}
