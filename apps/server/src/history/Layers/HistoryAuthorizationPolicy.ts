import * as Layer from "effect/Layer";

import {
  HistoryAuthorizationPolicy,
  environmentHistoryAuthorizationPolicy,
} from "../Services/HistoryAuthorizationPolicy.ts";

export const HistoryAuthorizationPolicyLive = Layer.succeed(
  HistoryAuthorizationPolicy,
  environmentHistoryAuthorizationPolicy,
);
