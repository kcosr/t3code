import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

export function getPreparedConnection(environmentId: EnvironmentId) {
  return Option.getOrNull(
    appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
  );
}

export async function prepareConnectionOnDemand(environmentId: EnvironmentId, timeoutMs = 5_000) {
  const existing = getPreparedConnection(environmentId);
  if (existing !== null) return existing;
  const retry = await environmentCatalog.retryNow.run(appAtomRegistry, environmentId);
  if (AsyncResult.isFailure(retry)) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const prepared = getPreparedConnection(environmentId);
    if (prepared !== null) return prepared;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getPreparedConnection(environmentId);
}
