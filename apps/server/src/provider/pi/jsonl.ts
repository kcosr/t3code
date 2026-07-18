/**
 * Strict LF-delimited JSONL framing for Pi RPC.
 *
 * Matches stock Pi (`packages/coding-agent/src/modes/rpc/jsonl.ts`):
 * - split only on `\n`
 * - strip optional trailing `\r`
 * - do not use Node readline (it splits on U+2028 / U+2029)
 */

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;

export function serializeJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export class JsonlProtocolError extends Error {
  readonly _tag = "JsonlProtocolError";
  constructor(message: string) {
    super(message);
    this.name = "JsonlProtocolError";
  }
}

export interface JsonlDecoderOptions {
  readonly maxBufferBytes?: number;
  readonly maxRecordBytes?: number;
}

/**
 * Incremental decoder for a UTF-8 byte stream into complete LF records.
 */
export class JsonlDecoder {
  private buffer = "";
  private readonly maxBufferBytes: number;
  private readonly maxRecordBytes: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });

  constructor(options?: JsonlDecoderOptions) {
    this.maxBufferBytes = options?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.maxRecordBytes = options?.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES;
  }

  push(chunk: Uint8Array | string): string[] {
    const text = typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    if (this.buffer.length > this.maxBufferBytes) {
      throw new JsonlProtocolError(
        `Pi RPC receive buffer exceeded ${this.maxBufferBytes} bytes without a record delimiter.`,
      );
    }

    const lines: string[] = [];
    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }
      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > this.maxRecordBytes) {
        throw new JsonlProtocolError(
          `Pi RPC record exceeded ${this.maxRecordBytes} bytes (length ${line.length}).`,
        );
      }
      if (line.length === 0) {
        continue;
      }
      lines.push(line);
    }
    return lines;
  }

  /**
   * Flush any trailing incomplete record (process closed without final LF).
   * Returns the leftover line if non-empty, else undefined.
   */
  finish(): string | undefined {
    const tail = this.decoder.decode();
    if (tail.length > 0) {
      this.buffer += tail;
    }
    if (this.buffer.length === 0) {
      return undefined;
    }
    let line = this.buffer;
    this.buffer = "";
    if (line.endsWith("\r")) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) {
      return undefined;
    }
    if (line.length > this.maxRecordBytes) {
      throw new JsonlProtocolError(
        `Pi RPC trailing record exceeded ${this.maxRecordBytes} bytes (length ${line.length}).`,
      );
    }
    return line;
  }
}

export function parseJsonlRecord(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new JsonlProtocolError(
      `Malformed Pi RPC JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
