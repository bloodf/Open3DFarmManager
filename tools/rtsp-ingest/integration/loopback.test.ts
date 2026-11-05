// SPDX-License-Identifier: MIT
// Explicit runtime gate only. The external controller owns the server and OS profiles.
// Run with --experimental-test-isolation=none so private fd4/fd5 stay in this process.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { closeSync, createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { openHelperSource, type HelperSource } from "../supervisor/process.ts";

const enabled = process.env.RTSP_LOOPBACK_GATE === "1";

test("real helper single-credit exact synthetic AU and cancellation", { skip: !enabled, timeout: 8_000 }, async () => {
  // These are private controller inputs, not browser/status-derived authority.
  const path = process.env.RTSP_HELPER_PATH;
  const sha256 = process.env.RTSP_HELPER_SHA256;
  const ledger = process.env.RTSP_HELPER_PID_RECEIPT;
  const portText = process.env.RTSP_FIXTURE_PORT;
  assert.ok(path && isAbsolute(path));
  assert.ok(sha256 && /^[a-f0-9]{64}$/.test(sha256));
  assert.ok(ledger && isAbsolute(ledger));
  assert.ok(portText && /^[1-9][0-9]{0,4}$/.test(portText));
  const port = Number(portText);
  assert.ok(port <= 65535);
  // fd4 is sole reader of fixture stdout; fd5 is sole remaining writer of its stdin.
  // Controller wrote the three config bytes, transferred descriptors, closed duplicates.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 6_000);
  const status = createReadStream("", { fd: 4, autoClose: true, highWaterMark: 36, signal: deadline.signal });
  const chunks = status[Symbol.asyncIterator]();
  let carry = Buffer.alloc(0);
  let received = 0;
  async function exact(size: number): Promise<Buffer> {
    while (carry.length < size) {
      const item = await chunks.next();
      assert.equal(item.done, false, "truncated fixture status");
      const data: unknown = item.value;
      assert.ok(Buffer.isBuffer(data));
      received += data.length;
      assert.ok(received <= 36, "fixture status exceeded 36-byte budget");
      carry = Buffer.concat([carry, data], carry.length + data.length);
    }
    const value = carry.subarray(0, size);
    carry = carry.subarray(size);
    return value;
  }
  let source: HelperSource | undefined;
  let controlClosed = false;
  let admitted = true;
  const cancel = new AbortController();
  try {
    const ready = await exact(8);
    assert.equal(ready.subarray(0, 4).toString("ascii"), "RTF1");
    assert.equal(ready.readUInt16BE(4), port);
    assert.equal(ready.readUInt16BE(6), 0);
    source = await openHelperSource({
      executable: { path, sha256 }, sourceHandle: "synthetic-loopback-source",
      resolveLocal: (handle) => handle === "synthetic-loopback-source"
        ? { address: "127.0.0.1", port, path: "/fixture" } : undefined,
      signal: cancel.signal, expiresAtMonoMs: performance.now() + 3_000,
      generation: 1, isAdmitted: (generation) => admitted && generation === 1,
    });
    assert.ok(Number.isSafeInteger(source.pid) && source.pid > 0);
    // Exclusive creation is completed before any .next() / credit admission.
    await writeFile(ledger, JSON.stringify({ pid: source.pid, parentPid: process.pid,
      phase: "spawned-before-first-credit", executableSha256: sha256 }) + "\n", { flag: "wx", mode: 0o600 });
    const item = await source[Symbol.asyncIterator]().next();
    assert.equal(item.done, false);
    if (item.done) throw new Error("missing synthetic AU");
    assert.deepEqual(Buffer.from(item.value.data), Buffer.from("000000016742e01faa0000000168ce0600000001658884", "hex"));
    assert.equal(item.value.keyframe, true);
    assert.equal(item.value.timestampUs, 0);
    admitted = false;
    cancel.abort();
    await source.stop();
    await source.closed;
    const settledPid = source.pid;
    assert.throws(() => process.kill(settledPid, 0), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "ESRCH");
    closeSync(5);
    controlClosed = true;
    const summary = await exact(28);
    assert.equal(summary.subarray(0, 4).toString("ascii"), "RTS1");
    assert.equal(summary.readUInt32BE(4), 1, "one accepted connection");
    assert.equal(summary.readUInt32BE(8), 0, "no rejected extra connection");
    assert.equal(summary.readUInt32BE(12), 1, "one successful PLAY");
    assert.equal(summary.readUInt32BE(16), 1, "one sent AU");
    assert.ok(summary.readUInt32BE(20) >= 1 && summary.readUInt32BE(20) <= 8);
    assert.ok(summary.readUInt32BE(24) > 0 && summary.readUInt32BE(24) <= 2_097_152);
    assert.equal(carry.length, 0);
    const end = await chunks.next();
    assert.equal(end.done, true);
    assert.equal(received, 36);
  } finally {
    admitted = false;
    cancel.abort();
    try {
      // Unknown/live helper settlement failure propagates; external owner preserves dirs.
      await source?.stop();
    } finally {
      if (!controlClosed) closeSync(5);
      clearTimeout(timer);
      status.destroy();
    }
  }
});
