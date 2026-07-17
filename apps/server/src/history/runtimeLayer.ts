import * as Layer from "effect/Layer";

import { HistorySearchRepositoryLive } from "../persistence/Layers/HistorySearch.ts";
import { HistoryAuthorizationPolicyLive } from "./Layers/HistoryAuthorizationPolicy.ts";
import { HistorySearchServiceLive } from "./Layers/HistorySearchService.ts";

const HistorySearchServiceConfiguredLive = HistorySearchServiceLive.pipe(
  Layer.provideMerge(HistorySearchRepositoryLive),
  Layer.provideMerge(HistoryAuthorizationPolicyLive),
);

export const HistoryRuntimeLive = Layer.mergeAll(
  HistorySearchRepositoryLive,
  HistoryAuthorizationPolicyLive,
  HistorySearchServiceConfiguredLive,
);
