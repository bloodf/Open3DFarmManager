// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createRecordReader, HelperFailure, readAURecord } from "./record-reader.ts";

function wire(timestamp = 0n, payload = Buffer.from([0, 0, 0, 1, 0x65])): Buffer {
  const record = Buffer.alloc(16 + payload.length);
  record.writeUInt32BE(12 + payload.length);
  record[4] = 1;
  record[5] = 1;
  record.writeBigUInt64BE(timestamp, 8);
  payload.copy(record, 16);
  return record;
}
function setup() {
  const stream = new PassThrough({ highWaterMark: 65536 });
  const reader = createRecordReader(stream, () => {});
  const signal = new AbortController();
  return { stream, reader, signal };
}
const code = (expected: string) => (error: unknown) =>
  error instanceof HelperFailure && error.code === expected;

// No sockets, helper process or application fixtures in these reader cases.
test("reads fragmented v1 and transfers an independently owned body", async () => {
  const { stream, reader, signal } = setup();
  try {
    const first = readAURecord(reader, signal.signal);
    const raw = wire();
    for (const byte of raw) stream.write(Buffer.from([byte]));
    const result = await first;
    assert.deepEqual(result, { data: Buffer.from([0, 0, 0, 1, 0x65]), keyframe: true, timestampUs: 0 });
    const next = readAURecord(reader, signal.signal);
    stream.write(wire(1n, Buffer.from([0, 0, 0, 1, 0x41])));
    assert.equal((await next).timestampUs, 1);
    assert.deepEqual(result.data, Buffer.from([0, 0, 0, 1, 0x65]));
  } finally { reader.stop(); }
});

test("accepts safe maximum timestamp and bounded maximum body", async () => {
  const { stream, reader, signal } = setup();
  try {
    const result = readAURecord(reader, signal.signal);
    const raw = wire(BigInt(Number.MAX_SAFE_INTEGER), Buffer.alloc(262144, 0x65));
    stream.write(raw);
    const unit = await result;
    assert.equal(unit.timestampUs, Number.MAX_SAFE_INTEGER);
    assert.equal(unit.data.byteLength, 262144);
  } finally { reader.stop(); }
});

for (const length of [0, 12, 262157, 0xffffffff]) {
  test(`rejects prefix ${length} without waiting for or allocating its claimed body`, async () => {
    const { stream, reader, signal } = setup();
    try {
      const result = readAURecord(reader, signal.signal);
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(length);
      stream.write(prefix);
      await assert.rejects(result, code("HELPER_RECORD"));
    } finally { reader.stop(); }
  });
}
for (const [offset, value] of [[4, 2], [5, 2], [6, 1], [7, 1]]) {
  test(`rejects metadata byte ${offset}`, async () => {
    const { stream, reader, signal } = setup();
    try {
      const result = readAURecord(reader, signal.signal);
      const raw = wire();
      if (offset === undefined || value === undefined) throw new Error("invalid literal test case");
      raw[offset] = value;
      stream.write(raw);
      await assert.rejects(result, code("HELPER_RECORD"));
    } finally { reader.stop(); }
  });
}
for (const timestamp of [9007199254740992n, 18446744073709551615n]) {
  test(`rejects unsafe timestamp ${timestamp}`, async () => {
    const { stream, reader, signal } = setup();
    try {
      const result = readAURecord(reader, signal.signal);
      stream.write(wire(timestamp));
      await assert.rejects(result, code("HELPER_RECORD"));
    } finally { reader.stop(); }
  });
}
for (const timestamp of [1n, 0n]) {
  test(`rejects nonincreasing timestamp ${timestamp}`, async () => {
    const { stream, reader, signal } = setup();
    try {
      const first = readAURecord(reader, signal.signal);
      stream.write(wire(1n));
      await first;
      const second = readAURecord(reader, signal.signal);
      stream.write(wire(timestamp));
      await assert.rejects(second, code("HELPER_RECORD"));
    } finally { reader.stop(); }
  });
}
for (const cut of [0, 1, 3, 4, 10, 20]) {
  test(`rejects EOF after ${cut} bytes`, async () => {
    const { stream, reader, signal } = setup();
    try {
      const result = readAURecord(reader, signal.signal);
      stream.end(wire().subarray(0, cut));
      await assert.rejects(result, code("HELPER_EOF"));
    } finally { reader.stop(); }
  });
}

test("two records for one demand are terminal pressure", async () => {
  const { stream, reader, signal } = setup();
  try {
    const result = readAURecord(reader, signal.signal);
    stream.write(Buffer.concat([wire(), wire(1n)]));
    await assert.rejects(result, code("HELPER_PRESSURE"));
  } finally { reader.stop(); }
});

test("an unsolicited record cannot acquire a later demand", async () => {
  const { stream, reader, signal } = setup();
  try {
    stream.write(wire());
    await assert.rejects(readAURecord(reader, signal.signal), code("HELPER_PRESSURE"));
  } finally { reader.stop(); }
});

test("one pending read only, with both reads failing terminally", async () => {
  const { reader, signal } = setup();
  try {
    const first = readAURecord(reader, signal.signal);
    void first.catch(() => {});
    await assert.rejects(readAURecord(reader, signal.signal), code("HELPER_PRESSURE"));
    await assert.rejects(first, code("HELPER_PRESSURE"));
  } finally { reader.stop(); }
});

test("abort releases a partial record wait", async () => {
  const { stream, reader, signal } = setup();
  try {
    const result = readAURecord(reader, signal.signal);
    stream.write(wire().subarray(0, 9));
    signal.abort();
    await assert.rejects(result, code("HELPER_CANCELED"));
  } finally { reader.stop(); }
});

test("rejects runtime buffering beyond one maximum credited record", async () => {
  let supplied = false;
  const stream = new Readable({ read() {
    if (!supplied) { supplied = true; this.push(Buffer.alloc(262161)); }
  } });
  const reader = createRecordReader(stream, () => {});
  try {
    await assert.rejects(readAURecord(reader, new AbortController().signal), code("HELPER_PRESSURE"));
  } finally { reader.stop(); }
});

test("accepts a valid record coalesced above 64 KiB", async () => {
  const { stream, reader, signal } = setup();
  try {
    const result = readAURecord(reader, signal.signal);
    const payload = Buffer.alloc(65521, 0x65);
    payload.set([0, 0, 0, 1]);
    stream.write(wire(0n, payload));
    assert.deepEqual((await result).data, payload);
  } finally { reader.stop(); }
});
