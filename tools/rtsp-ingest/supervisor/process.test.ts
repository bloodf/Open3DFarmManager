// SPDX-License-Identifier: MIT
// Prepared source only. Running these tests executes a finite local child and
// requires separate process-test authorization. No network or app imports.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { openHelperSource, type HelperSource, type HelperSourceOptions } from "./process.ts";
import { HelperFailure } from "./record-reader.ts";

const code = (expected: string) => (error: unknown) =>
  error instanceof HelperFailure && error.code === expected;

async function fixture(t: TestContext, path = "/one") {
  const directory = await mkdtemp(join(tmpdir(), "rtsp-supervisor-test-"));
  let source: HelperSource | undefined;
  t.after(async () => {
    // Never remove an artifact still potentially used by an unreaped child.
    await source?.stop();
    await rm(directory, { recursive: true });
  });
  const original = await readFile(new URL("./testdata/child-fixture.mjs", import.meta.url), "utf8");
  assert.ok(!process.execPath.includes("\n") && !process.execPath.includes(" "));
  const script = `#!${process.execPath}\n${original.slice(original.indexOf("\n") + 1)}`;
  const candidate = join(directory, "child.mjs");
  await writeFile(candidate, script, { mode: 0o700 });
  await chmod(candidate, 0o700);
  const executable = { path: await realpath(candidate), sha256: createHash("sha256").update(script).digest("hex") };
  const controller = new AbortController();
  const destination = { address: "127.0.0.1", port: 554, path };
  const options: HelperSourceOptions = {
    executable, sourceHandle: "connector-local-source", resolveLocal: () => destination,
    signal: controller.signal, expiresAtMonoMs: performance.now() + 10_000,
    generation: 4, isAdmitted: (generation) => generation === 4,
  };
  return { directory, executable, controller, destination, options,
    async open() { source = await openHelperSource(options); return source; } };
}

function assertGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "ESRCH");
}
function childPid(unit: Awaited<ReturnType<AsyncIterator<unknown>["next"]>>): number {
  assert.equal(unit.done, false);
  const value: unknown = unit.value;
  if (typeof value !== "object" || value === null || !("data" in value) || !Buffer.isBuffer(value.data)) {
    throw new Error("fixture result is missing its owned buffer");
  }
  assert.deepEqual(value.data.subarray(0, 5), Buffer.from([0, 0, 0, 1, 0x65]));
  return value.data.readUInt32BE(5);
}

test("one requested AU, stop and return observe exit and close", async (t) => {
  const f = await fixture(t);
  const source = await f.open();
  const iterator = source[Symbol.asyncIterator]();
  const unit = await iterator.next();
  const pid = childPid(unit);
  if (unit.done) throw new Error("missing AU");
  assert.equal(unit.value.timestampUs, 0);
  assert.equal(unit.value.keyframe, true);
  assert.equal(unit.value.data.byteLength, 9);
  const firstStop = source.stop();
  assert.equal(firstStop, source.closed);
  assert.equal(source.stop(), firstStop);
  await iterator.return?.();
  await firstStop;
  assertGone(pid);
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("TERM-resistant child is killed and reaped before closed resolves", async (t) => {
  const f = await fixture(t, "/ignore-term");
  const source = await f.open();
  const pid = childPid(await source[Symbol.asyncIterator]().next());
  const started = performance.now();
  await source.stop();
  assert.ok(performance.now() - started < 2000);
  assertGone(pid);
});

test("stop with a pending next cancels it and observes cleanup", async (t) => {
  const f = await fixture(t, "/partial");
  const source = await f.open();
  const iterator = source[Symbol.asyncIterator]();
  const pending = iterator.next();
  // This proves pending-next cleanup. Reader tests separately force partial bytes.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await source.stop();
  assert.deepEqual(await pending, { done: true, value: undefined });
  await iterator.return?.();
});

test("parallel next calls terminate the source", async (t) => {
  const f = await fixture(t, "/hang");
  const source = await f.open();
  const iterator = source[Symbol.asyncIterator]();
  const first = iterator.next();
  void first.catch(() => {});
  await assert.rejects(iterator.next(), code("HELPER_PRESSURE"));
  await assert.rejects(first, code("HELPER_PRESSURE"));
  await source.closed;
});

test("a second iterator terminates even before credit", async (t) => {
  const source = await (await fixture(t)).open();
  source[Symbol.asyncIterator]();
  assert.throws(() => source[Symbol.asyncIterator](), code("HELPER_PRESSURE"));
  await source.closed;
});

test("revocation in the binding callback prevents a credit and reaps", async (t) => {
  const f = await fixture(t, "/hang");
  let revoke = false;
  f.options.isAdmitted = () => {
    if (revoke) f.controller.abort();
    return true;
  };
  const source = await f.open();
  revoke = true;
  await assert.rejects(source[Symbol.asyncIterator]().next(), code("HELPER_CANCELED"));
  await source.closed;
});

test("stop reentrantly from a binding callback is observed before credit", async (t) => {
  const f = await fixture(t, "/hang");
  let opened: HelperSource | undefined;
  f.options.isAdmitted = () => { void opened?.stop(); return true; };
  opened = await f.open();
  assert.deepEqual(await opened[Symbol.asyncIterator]().next(), { done: true, value: undefined });
  await opened.closed;
});

test("binding callback can reenter next, terminally preventing the original credit", async (t) => {
  const f = await fixture(t, "/hang");
  let iterator: AsyncIterator<unknown> | undefined;
  let nested: Promise<IteratorResult<unknown>> | undefined;
  f.options.isAdmitted = () => {
    if (iterator) { nested = iterator.next(); void nested.catch(() => {}); }
    return true;
  };
  const source = await f.open();
  iterator = source[Symbol.asyncIterator]();
  await assert.rejects(iterator.next(), code("HELPER_PRESSURE"));
  if (!nested) throw new Error("callback did not reenter");
  await assert.rejects(nested, code("HELPER_PRESSURE"));
  await source.closed;
});

test("binding revoked during next never yields the completed AU", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  let reading = false;
  f.options.isAdmitted = () => !reading || ++calls < 4;
  const source = await f.open();
  reading = true;
  await assert.rejects(source[Symbol.asyncIterator]().next(), code("HELPER_BINDING"));
  await source.closed;
});

test("abort inside resolver returning a destination prevents executable access/spawn", async () => {
  const controller = new AbortController();
  await assert.rejects(openHelperSource({
    executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
    signal: controller.signal, expiresAtMonoMs: performance.now() + 1000, generation: 1,
    isAdmitted: () => true,
    resolveLocal: () => { controller.abort(); return { address: "127.0.0.1", port: 554, path: "/one" }; },
  }), code("HELPER_CANCELED"));
});

test("abort inside admission returning true prevents resolver", async () => {
  const controller = new AbortController();
  let resolutions = 0;
  await assert.rejects(openHelperSource({
    executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
    signal: controller.signal, expiresAtMonoMs: performance.now() + 1000, generation: 1,
    isAdmitted: () => { controller.abort(); return true; }, resolveLocal: () => { resolutions++; return undefined; },
  }), code("HELPER_CANCELED"));
  assert.equal(resolutions, 0);
});

test("snapshots input primitives, callbacks and resolver result before async work", async (t) => {
  const f = await fixture(t);
  f.options.isAdmitted = (generation) => {
    assert.equal(generation, 4);
    f.options.generation = 999;
    f.options.executable = { path: "/different-helper", sha256: "0".repeat(64) };
    f.options.isAdmitted = () => false;
    f.options.resolveLocal = () => undefined;
    return true;
  };
  f.options.resolveLocal = () => {
    queueMicrotask(() => { f.destination.path = "/hang"; });
    return f.destination;
  };
  const source = await f.open();
  const pid = childPid(await source[Symbol.asyncIterator]().next());
  await source.stop();
  assertGone(pid);
});

test("wrong hash stops before spawn and has fixed diagnostics", async (t) => {
  const f = await fixture(t);
  f.options.executable = { ...f.executable, sha256: "0".repeat(64) };
  await assert.rejects(f.open(), code("HELPER_EXECUTABLE"));
});

test("symlink executable is rejected even with the correct hash", async (t) => {
  const f = await fixture(t);
  const alias = join(f.directory, "alias.mjs");
  await symlink(f.executable.path, alias);
  f.options.executable = { ...f.executable, path: alias };
  await assert.rejects(f.open(), code("HELPER_EXECUTABLE"));
});

for (const address of ["127.0.0.1", "192.168.1.1", "::1"]) {
  test(`valid literal ${address} reaches executable validation without spawning`, async () => {
    await assert.rejects(openHelperSource({
      executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
      signal: new AbortController().signal, expiresAtMonoMs: performance.now() + 1000,
      generation: 1, isAdmitted: () => true,
      resolveLocal: () => ({ address, port: 554, path: "/one" }),
    }), code("HELPER_EXECUTABLE"));
  });
}

for (const destination of [
  { address: "camera.example", port: 554, path: "/one" },
  { address: "0.0.0.0", port: 554, path: "/one" },
  { address: "224.0.0.1", port: 554, path: "/one" },
  { address: "255.255.255.255", port: 554, path: "/one" },
  { address: "::", port: 554, path: "/one" },
  { address: "ff02::1", port: 554, path: "/one" },
  { address: "::ffff:127.0.0.1", port: 554, path: "/one" },
  { address: "127.0.0.1", port: 0, path: "/one" },
  { address: "127.0.0.1", port: 554, path: "//foreign" },
  { address: "127.0.0.1", port: 554, path: "/secret?token=x" },
]) {
  test("invalid local destination is rejected before executable access", async () => {
    await assert.rejects(openHelperSource({
      executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
      signal: new AbortController().signal, expiresAtMonoMs: performance.now() + 1000,
      generation: 1, isAdmitted: () => true, resolveLocal: () => destination,
    }), code("HELPER_DESTINATION"));
  });
}

for (const [mode, expected] of [
  ["/oversize", "HELPER_RECORD"], ["/two", "HELPER_PRESSURE"],
  ["/exit-record", "HELPER_EOF"], ["/hang", "HELPER_TIMEOUT"],
]) {
  test(`child fault ${mode} is terminal and cleanup is observed`, async (t) => {
    const f = await fixture(t, mode);
    const source = await f.open();
    await assert.rejects(source[Symbol.asyncIterator]().next(), (error: unknown) =>
      error instanceof HelperFailure && (error.code === expected ||
        (mode === "/exit-record" && error.code === "HELPER_EXIT")));
    await source.closed;
  });
}

for (const mode of ["/stderr", "/premature", "/unsolicited"]) {
  test(`startup/idle fault ${mode} cannot become authorized output`, async (t) => {
    const f = await fixture(t, mode);
    // Fault may arrive either during open or before the first consumer demand.
    try {
      const source = await f.open();
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      await assert.rejects(source[Symbol.asyncIterator]().next(), (error: unknown) =>
        error instanceof HelperFailure && ["HELPER_STDERR", "HELPER_EXIT", "HELPER_EOF", "HELPER_PRESSURE"].includes(error.code));
      await source.closed;
    } catch (error: unknown) {
      assert.ok(error instanceof HelperFailure);
      assert.ok(["HELPER_STDERR", "HELPER_EXIT", "HELPER_EOF", "HELPER_PRESSURE"].includes(error.code));
    }
  });
}


test("resolver revocation is checked even when it returns a valid destination", async () => {
  let current = true;
  await assert.rejects(openHelperSource({
    executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
    signal: new AbortController().signal, expiresAtMonoMs: performance.now() + 1000,
    generation: 1, isAdmitted: () => current,
    resolveLocal: () => { current = false; return { address: "127.0.0.1", port: 554, path: "/one" }; },
  }), code("HELPER_BINDING"));
});

test("a callback crossing the monotonic deadline cannot authorize the resolver", async (t) => {
  let mono = 100;
  t.mock.method(performance, "now", () => mono);
  let resolutions = 0;
  await assert.rejects(openHelperSource({
    executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
    signal: new AbortController().signal, expiresAtMonoMs: 200, generation: 1,
    isAdmitted: () => { mono = 201; return true; },
    resolveLocal: () => { resolutions++; return undefined; },
  }), code("HELPER_LEASE"));
  assert.equal(resolutions, 0);
});

test("a lease beyond thirty seconds is rejected before any callback", async () => {
  await assert.rejects(openHelperSource({
    executable: { path: "/unread/missing-helper", sha256: "0".repeat(64) }, sourceHandle: "local",
    signal: new AbortController().signal, expiresAtMonoMs: performance.now() + 60000, generation: 1,
    isAdmitted: () => { assert.fail("admission callback must not run"); },
    resolveLocal: () => { assert.fail("resolver must not run"); },
  }), code("HELPER_OPTIONS"));
});

test("the thirty-first AU in a fixed monotonic second is terminal", async (t) => {
  t.mock.method(performance, "now", () => 100);
  const f = await fixture(t);
  const source = await f.open();
  const iterator = source[Symbol.asyncIterator]();
  const pid = childPid(await iterator.next());
  for (let i = 1; i < 30; i++) {
    const result = await iterator.next();
    assert.equal(result.done, false);
    if (result.done) throw new Error("fixture ended early");
    assert.equal(result.value.timestampUs, i);
  }
  await assert.rejects(iterator.next(), code("HELPER_PRESSURE"));
  await source.closed;
  assertGone(pid);
});


test("binding callback crossing the operation deadline cannot send credit", async (t) => {
  let mono = 100;
  t.mock.method(performance, "now", () => mono);
  const f = await fixture(t, "/hang");
  let reading = false;
  f.options.isAdmitted = () => { if (reading) mono += 2001; return true; };
  const source = await f.open();
  reading = true;
  await assert.rejects(source[Symbol.asyncIterator]().next(), code("HELPER_TIMEOUT"));
  await source.closed;
});


test("a nonregular executable is rejected before spawn", async (t) => {
  const f = await fixture(t);
  f.options.executable = { ...f.executable, path: await realpath(f.directory) };
  await assert.rejects(f.open(), code("HELPER_EXECUTABLE"));
});
