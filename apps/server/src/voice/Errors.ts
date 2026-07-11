import { VoicePublicErrorReason } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export class VoiceError extends Schema.TaggedErrorClass<VoiceError>()("VoiceError", {
  reason: VoicePublicErrorReason,
  operation: Schema.String,
  detail: Schema.String,
  retryable: Schema.Boolean,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Voice ${this.operation} failed (${this.reason}): ${this.detail}`;
  }
}
