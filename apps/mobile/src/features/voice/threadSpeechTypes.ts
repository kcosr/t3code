import type { usePreparedConnection } from "../../state/session";
import type { AssistantSpeechSnapshot } from "./threadSpeechPlanner";

export interface ThreadSpeechInput {
  readonly environmentId: Parameters<typeof usePreparedConnection>[0];
  readonly scopeKey: string;
  readonly historyReady: boolean;
  readonly latestAssistant: AssistantSpeechSnapshot | null;
}
