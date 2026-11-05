#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Finite process-lifecycle fixture. These bytes are not decodable video.
// Prepared source only; never run without separate process-test authorization.
import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";

const input = Buffer.alloc(2049);
let used = 0;
let configured = false;
let credits = 0;
let mode = "";
const lifetime = setTimeout(() => process.exit(0), 4000);
process.on("SIGTERM", () => { if (mode !== "/ignore-term") process.exit(0); });
const control = createReadStream("", { fd: 3, autoClose: true, highWaterMark: 1 });
control.pause();
control.on("error", () => process.exit(2));
control.on("end", () => { if (mode !== "/ignore-term") process.exit(0); });
process.stdout.on("error", () => process.exit(0));
process.stderr.on("error", () => process.exit(0));

/** @param {number} timestamp */
function record(timestamp) {
  // Original literal AnnexB-shaped bytes plus PID for reap assertions, not codec proof.
  const output = Buffer.alloc(25);
  output.writeUInt32BE(21, 0);
  output[4] = 1;
  output[5] = 1;
  output.writeBigUInt64BE(BigInt(timestamp), 8);
  output.set([0, 0, 0, 1, 0x65], 16);
  output.writeUInt32BE(process.pid, 21);
  return output;
}

control.on("data", (chunk) => {
  if (!configured || chunk.length !== 1 || chunk[0] !== 1 || ++credits > 32) process.exit(2);
  if (mode === "/partial") {
    if (credits === 1) process.stdout.write(record(0).subarray(0, 9));
  } else if (mode === "/exit-record") {
    process.stdout.end(record(0).subarray(0, 9), () => process.exit(0));
  } else if (mode === "/oversize") {
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(262157);
    process.stdout.write(prefix);
  } else if (mode === "/two") {
    process.stdout.write(Buffer.concat([record(0), record(1)]));
  } else if (mode !== "/hang") {
    process.stdout.write(record(credits - 1));
  }
});
process.stdin.on("error", () => process.exit(2));
process.stdin.on("data", (chunk) => {
  if (!Buffer.isBuffer(chunk) || chunk.length > input.length - used) process.exit(2);
  used += chunk.copy(input, used);
});
process.stdin.on("end", () => {
  try {
    const config = JSON.parse(input.subarray(0, used).toString("utf8"));
    input.fill(0);
    if (config.version !== 1 || typeof config.path !== "string" || used > 2048) process.exit(2);
    mode = config.path;
    configured = true;
    if (mode === "/premature") process.exit(0);
    if (mode === "/stderr") process.stderr.write(Buffer.alloc(16385, 0x78));
    if (mode === "/unsolicited") process.stdout.write(record(0));
    control.resume();
  } catch { process.exit(2); }
});
process.on("exit", () => clearTimeout(lifetime));
