// SPDX-License-Identifier: MIT
import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

const MAX_CHUNK = 65_536;
const MAX_BODY = 262_156;
const MAX_BUFFERED = MAX_BODY + 4;
const MAX_TIMESTAMP = BigInt(Number.MAX_SAFE_INTEGER);

export type HelperFailureCode =
  | "HELPER_OPTIONS" | "HELPER_CANCELED" | "HELPER_LEASE"
  | "HELPER_BINDING" | "HELPER_DESTINATION" | "HELPER_EXECUTABLE"
  | "HELPER_SPAWN" | "HELPER_IO" | "HELPER_EXIT" | "HELPER_REAP"
  | "HELPER_CLEANUP" | "HELPER_RECORD" | "HELPER_EOF"
  | "HELPER_PRESSURE" | "HELPER_TIMEOUT" | "HELPER_STDERR";

/** Fixed diagnostics only. Never attach upstream errors, config or child text. */
export class HelperFailure extends Error {
  readonly code: HelperFailureCode;
  readonly pid: number | undefined;
  constructor(code: HelperFailureCode, pid?: number) {
    super(code);
    this.name = "HelperFailure";
    this.code = code;
    this.pid = pid;
  }
}

// Deliberately private. Connector integration requires an explicit adapter gate.
type HelperAU = Readonly<{
  data: Uint8Array;
  keyframe: boolean;
  timestampUs: number;
}>;

/** One body and one <=64 KiB carry; no flowing-mode stdout or AU queue. */
class BoundedPipeReader {
  private carry: Buffer | undefined;
  private offset = 0;
  private pending = false;
  private fault: HelperFailure | undefined;
  private previousTimestamp = -1;
  private wake: (() => void) | undefined;

  private readonly pipe: Readable;
  private readonly terminal: (failure: HelperFailure) => void;

  constructor(pipe: Readable, terminal: (failure: HelperFailure) => void) {
    this.pipe = pipe;
    this.terminal = terminal;
    pipe.pause();
    pipe.on("readable", this.onReadable);
    pipe.on("end", this.onEnd);
    pipe.on("close", this.onEnd);
    pipe.on("error", this.onError);
    if (pipe.readableLength !== 0) this.fail("HELPER_PRESSURE");
  }

  private fail(code: HelperFailureCode): HelperFailure {
    if (!this.fault) {
      this.fault = new HelperFailure(code);
      this.wake?.();
      this.terminal(this.fault);
    }
    return this.fault;
  }

  private onReadable = (): void => {
    if (this.pipe.readableLength > MAX_BUFFERED) {
      this.fail("HELPER_PRESSURE");
    } else if (!this.pending && this.pipe.readableLength !== 0) {
      this.fail("HELPER_PRESSURE");
    }
    this.wake?.();
  };
  private onEnd = (): void => { this.fail("HELPER_EOF"); };
  private onError = (): void => { this.fail("HELPER_IO"); };

  stop(): void {
    this.fault ??= new HelperFailure("HELPER_CANCELED");
    this.carry = undefined;
    this.wake?.();
    this.pipe.destroy();
  }

  private async exact(size: number, signal: AbortSignal): Promise<Buffer> {
    // Only the four-byte prefix or a validated <=262156-byte body reaches here.
    const output = Buffer.allocUnsafeSlow(size);
    let written = 0;
    while (written < size) {
      if (signal.aborted) throw this.fail("HELPER_CANCELED");
      if (this.fault) throw this.fault;
      if (!this.carry) {
        if (this.pipe.readableLength > MAX_BUFFERED) throw this.fail("HELPER_PRESSURE");
        const chunk: unknown = this.pipe.read(Math.min(MAX_CHUNK, Math.max(1, this.pipe.readableLength)));
        if (this.fault) throw this.fault;
        if (chunk !== null) {
          if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > MAX_CHUNK || this.pipe.readableLength + chunk.length > MAX_BUFFERED) {
            throw this.fail("HELPER_PRESSURE");
          }
          this.carry = chunk;
          this.offset = 0;
        } else {
          if (this.pipe.readableEnded || this.pipe.destroyed) throw this.fail("HELPER_EOF");
          await new Promise<void>((resolve) => {
            this.wake = resolve;
            // No await occurs between read(null) and installing this waiter.
          });
          this.wake = undefined;
          continue;
        }
      }
      const copied = this.carry.copy(output, written, this.offset,
        this.offset + Math.min(size - written, this.carry.length - this.offset));
      written += copied;
      this.offset += copied;
      if (this.offset === this.carry.length) this.carry = undefined;
    }
    return output;
  }

  async read(signal: AbortSignal): Promise<HelperAU> {
    if (this.pending) throw this.fail("HELPER_PRESSURE");
    if (this.fault) throw this.fault;
    // Bytes already present precede this demand and must not acquire a credit.
    if (this.carry || this.pipe.readableLength !== 0) throw this.fail("HELPER_PRESSURE");
    this.pending = true;
    const aborted = (): void => { this.fail("HELPER_CANCELED"); };
    signal.addEventListener("abort", aborted, { once: true });
    const timer = setTimeout(() => this.fail("HELPER_TIMEOUT"), 2_000);
    try {
      const prefix = await this.exact(4, signal);
      const length = prefix.readUInt32BE();
      if (length < 13 || length > MAX_BODY) throw this.fail("HELPER_RECORD");
      const body = await this.exact(length, signal);
      if (signal.aborted) throw this.fail("HELPER_CANCELED");
      if (this.fault) throw this.fault;
      if (body[0] !== 1 || (body[1] !== 0 && body[1] !== 1) || body[2] !== 0 || body[3] !== 0) {
        throw this.fail("HELPER_RECORD");
      }
      const timestamp = body.readBigUInt64BE(4);
      if (timestamp > MAX_TIMESTAMP || timestamp <= BigInt(this.previousTimestamp)) {
        throw this.fail("HELPER_RECORD");
      }
      if (this.carry || this.pipe.readableLength !== 0) throw this.fail("HELPER_PRESSURE");
      this.previousTimestamp = Number(timestamp);
      // body is never reused. The view owns this exact record's backing store.
      return Object.freeze({ data: body.subarray(12), keyframe: body[1] === 1,
        timestampUs: this.previousTimestamp });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      this.pending = false;
      this.wake = undefined;
    }
  }
}

// These are supervisor-private module seams, not a shared protocol.
export function createRecordReader(pipe: Readable, terminal: (failure: HelperFailure) => void) {
  return new BoundedPipeReader(pipe, terminal);
}

export function readAURecord(reader: ReturnType<typeof createRecordReader>, signal: AbortSignal) {
  return reader.read(signal);
}
