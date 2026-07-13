import { ProjectId, ThreadId, VoiceSessionId } from "@t3tools/contracts";
import * as SecureStore from "expo-secure-store";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  makeRealtimeVoiceAttachmentStore,
  realtimeVoiceAttachmentStore,
} from "./realtimeVoiceAttachmentStore";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const record = {
  ownerId: "owner-1",
  environmentOrigin: "https://termstation/path",
  sessionId: VoiceSessionId.make("session-1"),
  afterSequence: 7,
  focus: {
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
  },
  pendingEvents: [],
};

describe("realtimeVoiceAttachmentStore", () => {
  beforeEach(() => vi.clearAllMocks());

  it("round trips normalized non-secret attachment state", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(
      JSON.stringify({ ...record, environmentOrigin: "https://termstation" }),
    );

    await realtimeVoiceAttachmentStore.replace(record);
    await expect(realtimeVoiceAttachmentStore.load()).resolves.toEqual({
      ...record,
      environmentOrigin: "https://termstation",
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "t3.voice.realtime-attachment.v1",
      JSON.stringify({ ...record, environmentOrigin: "https://termstation" }),
    );
  });

  it("rejects malformed persisted cursors", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(
      JSON.stringify({ ...record, afterSequence: -1 }),
    );

    await expect(realtimeVoiceAttachmentStore.load()).resolves.toBeNull();
  });

  it("clears only the matching active session record", async () => {
    vi.mocked(SecureStore.getItemAsync)
      .mockResolvedValueOnce(JSON.stringify(record))
      .mockResolvedValueOnce(JSON.stringify(record));

    await realtimeVoiceAttachmentStore.clear(VoiceSessionId.make("other-session"), record.ownerId);
    await realtimeVoiceAttachmentStore.clear(record.sessionId, record.ownerId);

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledOnce();
  });

  it("serializes an old clear before installing a new owner", async () => {
    let value: string | null = JSON.stringify(record);
    let releaseRead!: () => void;
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let reads = 0;
    const storage = {
      getItemAsync: vi.fn(async () => {
        reads += 1;
        if (reads === 1) await readBlocked;
        return value;
      }),
      setItemAsync: vi.fn(async (_key: string, next: string) => {
        value = next;
      }),
      deleteItemAsync: vi.fn(async () => {
        value = null;
      }),
    };
    const store = makeRealtimeVoiceAttachmentStore(storage);
    const replacement = {
      ...record,
      ownerId: "owner-2",
      sessionId: VoiceSessionId.make("session-2"),
    };

    const clearing = store.clear(record.sessionId, record.ownerId);
    const replacing = store.replace(replacement);
    releaseRead();
    await Promise.all([clearing, replacing]);

    await expect(store.load()).resolves.toEqual({
      ...replacement,
      environmentOrigin: "https://termstation",
    });
  });

  it("rejects a delayed update from a replaced controller owner", async () => {
    let value: string | null = null;
    const storage = {
      getItemAsync: vi.fn(async () => value),
      setItemAsync: vi.fn(async (_key: string, next: string) => {
        value = next;
      }),
      deleteItemAsync: vi.fn(async () => {
        value = null;
      }),
    };
    const store = makeRealtimeVoiceAttachmentStore(storage);
    const replacement = { ...record, ownerId: "owner-2" };
    await store.replace(record);
    await store.replace(replacement);

    await expect(store.update({ ...record, afterSequence: 9 })).resolves.toBe(false);
    await expect(store.load()).resolves.toEqual({
      ...replacement,
      environmentOrigin: "https://termstation",
    });
  });

  it("self-heals a missing attachment for the current controller owner", async () => {
    let value: string | null = null;
    const storage = {
      getItemAsync: vi.fn(async () => value),
      setItemAsync: vi.fn(async (_key: string, next: string) => {
        value = next;
      }),
      deleteItemAsync: vi.fn(async () => {
        value = null;
      }),
    };
    const store = makeRealtimeVoiceAttachmentStore(storage);

    await expect(store.update(record)).resolves.toBe(true);
    await expect(store.load()).resolves.toEqual({
      ...record,
      environmentOrigin: "https://termstation",
    });
  });
});
