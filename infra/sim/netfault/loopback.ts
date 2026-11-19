// SPDX-License-Identifier: MIT
// The proxy is a test tool: it forwards only to loopback and never to a LAN host.

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

export function assertLoopbackTarget(host: string) {
  if (!LOOPBACK.has(host))
    throw new Error(`Fault proxy forwards to loopback only, got ${host}`)
}
