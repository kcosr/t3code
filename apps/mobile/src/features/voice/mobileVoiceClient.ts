import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { makeVoiceHttpClient, type VoiceUriUploadResult } from "@t3tools/client-runtime/voice";
import * as Effect from "effect/Effect";
import {
  createUploadTask,
  FileSystemUploadType,
  type FileSystemUploadResult,
} from "expo-file-system/legacy";

import { cryptoLayer } from "../cloud/dpop";
import { relayDpopSignerLayer } from "../cloud/managedRelayLayer";

let dpopSignerPromise: Promise<ManagedRelay.ManagedRelayDpopSigner["Service"]> | null = null;

const uploadUri = async (input: {
  readonly requestUrl: string;
  readonly fileUri: string;
  readonly fieldName: string;
  readonly mimeType: string;
  readonly parameters: Readonly<Record<string, string>>;
  readonly headers: Headers;
  readonly signal: AbortSignal;
}): Promise<VoiceUriUploadResult> => {
  const task = createUploadTask(input.requestUrl, input.fileUri, {
    uploadType: FileSystemUploadType.MULTIPART,
    fieldName: input.fieldName,
    mimeType: input.mimeType,
    parameters: { ...input.parameters },
    headers: Object.fromEntries(input.headers.entries()),
    httpMethod: "POST",
  });
  const cancel = () => void task.cancelAsync();
  input.signal.addEventListener("abort", cancel, { once: true });
  let result: FileSystemUploadResult | null | undefined;
  try {
    result = await task.uploadAsync();
  } finally {
    input.signal.removeEventListener("abort", cancel);
  }
  if (result === null || result === undefined) {
    throw new Error("Voice transcription upload was cancelled");
  }
  return {
    body: result.body,
    status: result.status,
    headers: result.headers,
  };
};

const getDpopSigner = (): Promise<ManagedRelay.ManagedRelayDpopSigner["Service"]> => {
  dpopSignerPromise ??= Effect.runPromise(
    ManagedRelay.ManagedRelayDpopSigner.pipe(
      Effect.provide(relayDpopSignerLayer),
      Effect.provide(cryptoLayer),
    ),
  );
  return dpopSignerPromise;
};

export const makeMobileVoiceClient = async (prepared: PreparedConnection) =>
  makeVoiceHttpClient({
    prepared,
    fetch: globalThis.fetch,
    uploadUri,
    ...(prepared.httpAuthorization?._tag === "Dpop" ? { signer: await getDpopSigner() } : {}),
  });
