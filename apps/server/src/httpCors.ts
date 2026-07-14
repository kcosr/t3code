export const browserApiCorsAllowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "x-t3-voice-ticket",
  "x-t3-voice-runtime-protocol-major",
  "x-t3-voice-runtime",
  "x-t3-voice-control",
  "x-t3-voice-operation",
  "x-t3-voice-refresh",
] as const;

export const browserApiCorsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": browserApiCorsAllowedMethods.join(", "),
  "access-control-allow-headers": browserApiCorsAllowedHeaders.join(", "),
} as const;
