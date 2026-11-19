// SPDX-License-Identifier: MIT
import { isIP } from 'node:net'

export const BAMBU_CLOUD_FLAG = 'NUXT_BAMBU_CLOUD'

/**
 * Known Bambu cloud host suffixes. Any connection or resolution targeting
 * these hosts is rejected when `NUXT_BAMBU_CLOUD` is off.
 * Even when enabled in tests, E15 tests must use a loopback fake cloud on the
 * harness (127.0.0.1 / ::1 / localhost), never the real service.
 */
export const BAMBU_CLOUD_HOST_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:^|\.)bambulab\.com$/i,
  /(?:^|\.)bambulab\.cn$/i,
  /(?:^|\.)bambu\.com$/i,
])

export type BambuCloudPolicyState =
  { state: 'off'; enabled: false } | { state: 'on'; enabled: true }

/**
 * Bambu cloud import is off by default. It is enabled only when
 * `NUXT_BAMBU_CLOUD` (or the runtime config `bambuCloud` flag) is explicitly
 * `true` or `'true'`.
 */
export function isBambuCloudEnabled(
  configOrEnv: unknown = process.env,
): boolean {
  if (typeof configOrEnv === 'boolean') return configOrEnv === true
  if (typeof configOrEnv === 'string') {
    return configOrEnv.trim().toLowerCase() === 'true'
  }
  if (typeof configOrEnv === 'object' && configOrEnv !== null) {
    if ('bambuCloud' in configOrEnv) {
      const value = (configOrEnv as { bambuCloud?: unknown }).bambuCloud
      if (typeof value === 'boolean') return value === true
      if (
        typeof value === 'object' &&
        value !== null &&
        'enabled' in value &&
        (value as { enabled?: unknown }).enabled === true
      ) {
        return true
      }
    }
    if (BAMBU_CLOUD_FLAG in configOrEnv) {
      const raw = (configOrEnv as Record<string, unknown>)[
        BAMBU_CLOUD_CLOUD_KEY
      ]
      return typeof raw === 'string'
        ? raw.trim().toLowerCase() === 'true'
        : raw === true
    }
  }
  return false
}

const BAMBU_CLOUD_CLOUD_KEY = BAMBU_CLOUD_FLAG

export function readBambuCloudPolicy(
  configOrEnv: unknown = process.env,
): BambuCloudPolicyState {
  return isBambuCloudEnabled(configOrEnv)
    ? { state: 'on', enabled: true }
    : { state: 'off', enabled: false }
}

/**
 * Returns true if the given hostname or URL points to a Bambu cloud domain.
 */
export function isBambuCloudHost(hostOrUrl: string): boolean {
  const trimmed = hostOrUrl.trim()
  if (!trimmed) return false
  let hostname = trimmed
  if (trimmed.includes('://')) {
    try {
      hostname = new URL(trimmed).hostname
    } catch {
      return true
    }
  } else {
    hostname = trimmed.split('/')[0]?.split(':')[0] ?? trimmed
  }
  const normalized = hostname.replace(/\.$/, '').toLowerCase()
  return BAMBU_CLOUD_HOST_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function isLoopbackHost(hostOrUrl: string): boolean {
  const trimmed = hostOrUrl.trim()
  if (!trimmed) return false
  let hostname = trimmed
  if (trimmed.includes('://')) {
    try {
      hostname = new URL(trimmed).hostname
    } catch {
      return false
    }
  } else if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    hostname = end > 1 ? trimmed.slice(1, end) : trimmed
  } else if (isIP(trimmed) === 0) {
    hostname = trimmed.split('/')[0]?.split(':')[0] ?? trimmed
  }
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === 'localhost'
  )
}

/**
 * Asserts that `NUXT_BAMBU_CLOUD` is off (`false`). Used by `desktop:check`
 * to guarantee offline desktop runs keep Bambu cloud disabled.
 */
export function assertBambuCloudOff(configOrEnv: unknown = process.env): void {
  if (isBambuCloudEnabled(configOrEnv)) {
    throw new Error(
      `Desktop offline policy violation: ${BAMBU_CLOUD_FLAG} must be off (default false)`,
    )
  }
}

/**
 * Guards any Bambu cloud endpoint resolution or outbound contact.
 * - When `NUXT_BAMBU_CLOUD` is off (the default), every call throws before
 *   resolving DNS or opening a socket.
 * - Real Bambu cloud hosts (`*.bambulab.com`, `*.bambulab.cn`, `*.bambu.com`)
 *   are always rejected so tests and harness runs can only contact a loopback
 *   fake cloud (`127.0.0.1`, `::1`, `localhost`).
 */
export function resolveBambuCloudEndpoint(
  endpoint: string,
  configOrEnv: unknown = process.env,
): URL {
  if (!isBambuCloudEnabled(configOrEnv)) {
    throw new Error(
      `Bambu cloud is disabled (${BAMBU_CLOUD_FLAG} is off by default)`,
    )
  }
  if (isBambuCloudHost(endpoint) || !isLoopbackHost(endpoint)) {
    throw new Error(
      'Bambu cloud endpoint must target a loopback fake cloud on the test harness, never the real service',
    )
  }
  return new URL(endpoint)
}
