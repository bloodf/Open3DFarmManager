// SPDX-License-Identifier: MIT
// Execute only under an explicitly reviewed OS profile. A negative bind probe
// closes immediately if the OS unexpectedly allows it; no handler serves clients.
import assert from "node:assert/strict";
import { createConnection, createServer } from "node:net";
import { createSocket } from "node:dgram";

const [mode, text] = process.argv.slice(2);
assert.ok(mode === "client" || mode === "server-deny" || mode === "build-deny");
assert.ok(text && /^[1-9][0-9]{0,4}$/.test(text));
const port = Number(text);
assert.ok(port < 65535);
/** @param {unknown} error */
const denied = (error) => error instanceof Error && "code" in error &&
  (error.code === "EPERM" || error.code === "EACCES");
const watchdog = setTimeout(() => { process.exitCode = 1; throw new Error("POLICY_PROBE_TIMEOUT"); }, 4_000);

/** @param {string} host @param {number} destination @param {boolean} [positive] */
async function tcp(host, destination, positive = false) {
  await new Promise(/** @param {(value?: unknown) => void} resolve @param {(reason: Error) => void} reject */ (resolve, reject) => {
    const socket = createConnection({ host, port: destination, family: host.includes(":") ? 6 : 4 });
    /** @type {Error | undefined} */
    let result = new Error("POLICY_PREMATURE_TCP_CLOSE");
    socket.once("connect", () => {
      result = positive ? undefined : new Error("POLICY_UNEXPECTED_TCP_ALLOW");
      socket.destroy();
    });
    socket.once("error", (error) => { result = !positive && denied(error) ? undefined : new Error("POLICY_WRONG_TCP_RESULT"); });
    socket.once("close", () => result ? reject(result) : resolve());
  });
}
async function udp() {
  await new Promise(/** @param {(value?: unknown) => void} resolve @param {(reason: Error) => void} reject */ (resolve, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    /** @param {unknown} error */
    const finish = (error) => {
      if (settled) return;
      settled = true;
      const complete = () => denied(error) ? resolve() : reject(new Error("POLICY_WRONG_UDP_RESULT"));
      try { socket.close(complete); }
      catch (closeError) {
        if (closeError instanceof Error && "code" in closeError && closeError.code === "ERR_SOCKET_DGRAM_NOT_RUNNING") complete();
        else reject(new Error("POLICY_UDP_CLEANUP"));
      }
    };
    socket.once("error", finish);
    socket.send(Buffer.from([0]), port, "127.0.0.1", finish);
  });
}
async function bindDenied() {
  await new Promise(/** @param {(value?: unknown) => void} resolve @param {(reason: Error) => void} reject */ (resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => denied(error) ? resolve() : reject(new Error("POLICY_WRONG_BIND_RESULT")));
    server.once("listening", () => server.close(() => reject(new Error("POLICY_UNEXPECTED_BIND_ALLOW"))));
    server.listen({ host: "127.0.0.1", port: port + 1 });
  });
}
try {
  if (mode === "client") await tcp("127.0.0.1", port, true);
  if (mode === "server-deny") await tcp("127.0.0.1", port);
  // All probes remain literal loopback; no DNS or external destination is touched.
  await tcp("127.0.0.1", mode === "build-deny" ? port : port + 1);
  await tcp("127.0.0.2", port);
  await tcp("::1", port);
  await udp();
  await bindDenied();
  process.stdout.write("POLICY_PROBE_PASS\n");
} finally {
  clearTimeout(watchdog);
}
