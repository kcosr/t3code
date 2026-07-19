import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { makeVoiceHttpClient, type VoiceHttpClient } from "@t3tools/client-runtime/voice";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { browserCryptoLayer } from "../cloud/dpop";
import { relayDpopSignerLayer } from "../cloud/managedRelayLayer";

let dpopSignerPromise: Promise<ManagedRelay.ManagedRelayDpopSigner["Service"]> | null = null;

const getDpopSigner = (): Promise<ManagedRelay.ManagedRelayDpopSigner["Service"]> => {
  dpopSignerPromise ??= Effect.runPromise(
    ManagedRelay.ManagedRelayDpopSigner.pipe(
      Effect.provide(Layer.provideMerge(relayDpopSignerLayer, browserCryptoLayer)),
    ),
  );
  return dpopSignerPromise;
};

export async function makeWebVoiceHttpClient(
  prepared: PreparedConnection,
): Promise<VoiceHttpClient> {
  return makeVoiceHttpClient({
    prepared,
    fetch: globalThis.fetch.bind(globalThis),
    ...(prepared.httpAuthorization?._tag === "Dpop" ? { signer: await getDpopSigner() } : {}),
  });
}
