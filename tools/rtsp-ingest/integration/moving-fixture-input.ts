// SPDX-License-Identifier: MIT
// Private synthetic fixture framing. No authority, parser, pacing or lease grants.
import { Buffer } from "node:buffer";
import { Readable, Writable } from "node:stream";

const activeWrites = new WeakSet<Writable>();
const failedWrites = new WeakSet<Writable>();
const activeReads = new WeakSet<Readable>();
const failedReads = new WeakSet<Readable>();
const failure = (): Error => new Error("MOVING_FIXTURE_FAILURE");

type MovingHeader = Readonly<{ port: number; frames: number }>;
type MovingAU = Readonly<{ data: Uint8Array; keyframe: boolean; timestampUs: number }>;
export type MovingSummary = Readonly<{
  accepted: number; rejected: number; plays: number; accessUnits: number;
  packets: number; wireBytes: number; canonicalSHA256: readonly string[];
}>;

function validFrames(frames: number): boolean {
  return Number.isInteger(frames) && frames >= 1 && frames <= 60;
}

// The one owned copy is made before any asynchronous callback can mutate input.
// A successful write callback is NOT a consumed/validated-credit acknowledgement.
async function writeOwned(pipe: Writable, bytes: Buffer, signal: AbortSignal): Promise<void> {
  if (activeWrites.has(pipe) || failedWrites.has(pipe) || pipe.destroyed ||
      pipe.writableLength !== 0 || signal.aborted) {
    failedWrites.add(pipe);
    throw failure();
  }
  activeWrites.add(pipe);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, awaitingErrorEvent = false): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        // Writable emits its error event after invoking a failed write callback.
        if (!awaitingErrorEvent) pipe.removeListener("error", errored);
        pipe.removeListener("close", closed);
        if (error || signal.aborted || failedWrites.has(pipe)) {
          failedWrites.add(pipe);
          reject(failure());
        } else resolve();
      };
      const aborted = (): void => finish(failure());
      const errored = (): void => finish(failure());
      const closed = (): void => finish(failure());
      signal.addEventListener("abort", aborted, { once: true });
      pipe.once("error", errored);
      pipe.once("close", closed);
      if (signal.aborted) { finish(failure()); return; }
      try { pipe.write(bytes, (error) => finish(error, error != null)); } catch { finish(failure()); }
    });
  } finally {
    activeWrites.delete(pipe);
  }
}

export async function writeMovingHeader(pipe: Writable, header: MovingHeader, signal: AbortSignal): Promise<void> {
  const { port, frames } = header;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !validFrames(frames)) throw failure();
  const bytes = Buffer.alloc(8);
  bytes[0] = 2;
  bytes[1] = 1;
  bytes.writeUInt16BE(port, 2);
  bytes.writeUInt16BE(frames, 4);
  await writeOwned(pipe, bytes, signal);
}

export async function writeMovingAU(pipe: Writable, unit: MovingAU, signal: AbortSignal): Promise<void> {
  const { data, keyframe, timestampUs } = unit;
  if (!(data instanceof Uint8Array) || data.byteLength < 1 || data.byteLength > 262144 ||
      keyframe !== true || !Number.isSafeInteger(timestampUs) || timestampUs < 0) throw failure();
  const bytes = Buffer.allocUnsafe(16 + data.byteLength);
  bytes.writeUInt32BE(12 + data.byteLength, 0);
  bytes[4] = 1;
  bytes[5] = 1;
  bytes[6] = 0;
  bytes[7] = 0;
  bytes.writeBigUInt64BE(BigInt(timestampUs), 8);
  bytes.set(data, 16);
  await writeOwned(pipe, bytes, signal);
}

// Caller consumes/validates the separate eight-byte RTF2 readiness first, with
// the same sole reader. This function owns only RTS2+EOF, at most 1952 bytes.
// Descriptor closure/reaping belongs to the controller, including on abort.
export async function readMovingSummary(pipe: Readable, options: Readonly<{ frames: number }>, signal: AbortSignal): Promise<MovingSummary> {
  const frames = options.frames;
  if (!validFrames(frames) || activeReads.has(pipe) || failedReads.has(pipe) || signal.aborted) throw failure();
  activeReads.add(pipe);
  const expected = 32 + 32 * frames;
  const data = Buffer.alloc(expected);
  let offset = 0;
  let fault = false;
  let wake: (() => void) | undefined;
  const notify = (): void => { wake?.(); };
  const failed = (): void => { fault = true; notify(); };
  pipe.pause();
  pipe.on("readable", notify);
  pipe.on("end", notify);
  pipe.on("close", notify);
  pipe.on("error", failed);
  signal.addEventListener("abort", failed, { once: true });
  try {
    for (;;) {
      if (signal.aborted || fault || pipe.readableLength > expected - offset + 1) throw failure();
      const chunk: unknown = pipe.read(Math.min(expected - offset + 1, Math.max(1, pipe.readableLength)));
      if (fault || signal.aborted) throw failure();
      if (chunk !== null) {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0 || chunk.length > expected - offset ||
            pipe.readableLength + chunk.length > expected - offset) throw failure();
        chunk.copy(data, offset);
        offset += chunk.length;
        continue;
      }
      if (pipe.readableEnded) break;
      if (pipe.destroyed) throw failure();
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
    if (offset !== expected || data.subarray(0, 4).toString("ascii") !== "RTS2" ||
        data.readUInt16BE(28) !== frames || data.readUInt16BE(30) !== 0) throw failure();
    const accepted = data.readUInt32BE(4);
    const rejected = data.readUInt32BE(8);
    const plays = data.readUInt32BE(12);
    const accessUnits = data.readUInt32BE(16);
    const packets = data.readUInt32BE(20);
    const wireBytes = data.readUInt32BE(24);
    if (accepted !== 1 || rejected !== 0 || plays !== 1 || accessUnits !== frames ||
        packets < frames || packets > frames * 8 || wireBytes < 1 || wireBytes > 2097152) throw failure();
    const hashes: string[] = [];
    for (let i = 0; i < frames; i++) hashes.push(data.subarray(32 + i * 32, 64 + i * 32).toString("hex"));
    return Object.freeze({ accepted, rejected, plays, accessUnits, packets, wireBytes,
      canonicalSHA256: Object.freeze(hashes) });
  } catch {
    failedReads.add(pipe);
    throw failure();
  } finally {
    activeReads.delete(pipe);
    signal.removeEventListener("abort", failed);
    pipe.removeListener("readable", notify);
    pipe.removeListener("end", notify);
    pipe.removeListener("close", notify);
    pipe.removeListener("error", failed);
  }
}
