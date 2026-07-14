import { VOICE_RUNTIME_PROTOCOL_MAJOR } from "@t3tools/contracts";
import * as Data from "effect/Data";

import type { PreparedConnection } from "../connection/model.ts";

export type VoiceRuntimeProtocolAvailability =
  | {
      readonly status: "available";
      readonly protocolMajor: typeof VOICE_RUNTIME_PROTOCOL_MAJOR;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "incompatible-protocol-major";
      readonly requiredMajor: typeof VOICE_RUNTIME_PROTOCOL_MAJOR;
      readonly actualMajor: number;
    };

export class VoiceRuntimeProtocolIncompatibleError extends Data.TaggedError(
  "VoiceRuntimeProtocolIncompatibleError",
)<{
  readonly requiredMajor: typeof VOICE_RUNTIME_PROTOCOL_MAJOR;
  readonly actualMajor: number;
}> {
  override get message(): string {
    return `Voice requires runtime protocol major ${this.requiredMajor}, but this environment advertises major ${this.actualMajor}.`;
  }
}

export function voiceRuntimeProtocolAvailability(
  connection: Pick<PreparedConnection, "voiceRuntimeProtocolMajor">,
): VoiceRuntimeProtocolAvailability {
  return connection.voiceRuntimeProtocolMajor === VOICE_RUNTIME_PROTOCOL_MAJOR
    ? { status: "available", protocolMajor: VOICE_RUNTIME_PROTOCOL_MAJOR }
    : {
        status: "unavailable",
        reason: "incompatible-protocol-major",
        requiredMajor: VOICE_RUNTIME_PROTOCOL_MAJOR,
        actualMajor: connection.voiceRuntimeProtocolMajor,
      };
}

export function assertVoiceRuntimeProtocolAvailable(
  connection: Pick<PreparedConnection, "voiceRuntimeProtocolMajor">,
): void {
  const availability = voiceRuntimeProtocolAvailability(connection);
  if (availability.status === "unavailable") {
    throw new VoiceRuntimeProtocolIncompatibleError({
      requiredMajor: availability.requiredMajor,
      actualMajor: availability.actualMajor,
    });
  }
}
