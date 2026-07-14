import { VOICE_RUNTIME_PROTOCOL_HEADER, VOICE_RUNTIME_PROTOCOL_MAJOR } from "@t3tools/contracts";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

export const voiceRuntimeProtocolResponse = (
  request: HttpServerRequest.HttpServerRequest,
): HttpServerResponse.HttpServerResponse | undefined =>
  request.headers[VOICE_RUNTIME_PROTOCOL_HEADER] === String(VOICE_RUNTIME_PROTOCOL_MAJOR)
    ? undefined
    : HttpServerResponse.jsonUnsafe(
        {
          code: "voice_runtime_protocol_incompatible",
          requiredMajor: VOICE_RUNTIME_PROTOCOL_MAJOR,
        },
        {
          status: 426,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
