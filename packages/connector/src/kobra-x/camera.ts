// SPDX-License-Identifier: MIT
import { isIP } from 'node:net'

/** An operator-selected passive endpoint. MQTT reports cannot set this path. */
export function isKobraXFlvPath(path: string): boolean {
  return (
    path.length <= 1024 &&
    /^\/(?:flv|live\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)$/.exec(path)?.[0] === path
  )
}

export function isKobraXFlvPort(address: string, port: number): boolean {
  return (
    isIP(address) === 4 &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    (port === 18088 || address.startsWith('127.'))
  )
}
