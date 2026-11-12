import { isIP } from 'node:net'
import { z } from 'zod'

/** Loopback only. LAN exposure is an explicit opt-in. */
export const DEFAULT_RTC_BIND_ADDRESS = '127.0.0.1'

/**
 * Local address the Connector's WebRTC ICE agent binds to. Only a literal
 * IPv4 or IPv6 address is accepted (including `0.0.0.0` and `::` for all
 * interfaces). Host names, zone IDs, brackets, ports and whitespace are refused,
 * so a configured value can never depend on name resolution.
 */
function allowedBindAddress(value: string): boolean {
  const family = isIP(value)
  if (family === 4) return true
  if (family !== 6 || value.includes('%')) return false
  // WHATWG URL parsing gives the canonical compressed IPv6 form.
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1)
  // All interfaces only through the exact literal `::`, never `0:0:…:0`,
  // `::0.0.0.0` or another spelling. IPv4-mapped addresses are refused: use the
  // IPv4 literal itself.
  if (canonical === '::') return value === '::'
  return !canonical.startsWith('::ffff:')
}
export const RtcBindAddress = z
  .string()
  .max(45)
  .refine(
    allowedBindAddress,
    'Expected a literal IPv4 or IPv6 address (all interfaces: exactly 0.0.0.0 or ::)',
  )

/** 127.0.0.0/8 or ::1. Anything else widens exposure beyond this host. */
export function isLoopbackBindAddress(value: string): boolean {
  return isIP(value) === 4
    ? value.startsWith('127.')
    : new URL(`http://[${value}]`).hostname === '[::1]'
}

export const RtcRuntimeConfigSchema = z.strictObject({
  bindAddress: RtcBindAddress.optional(),
})

/** Resolves the optional runtime `rtc` section; absent keeps the loopback default. */
export function parseRtcRuntimeConfig(input: unknown): Readonly<{
  bindAddress: string
}> {
  const parsed = input === undefined ? {} : RtcRuntimeConfigSchema.parse(input)
  return Object.freeze({
    bindAddress: parsed.bindAddress ?? DEFAULT_RTC_BIND_ADDRESS,
  })
}

/** The single resolver every peer uses: validated value, or the loopback default. */
export function rtcBindAddress(value: string | undefined): string {
  return value === undefined
    ? DEFAULT_RTC_BIND_ADDRESS
    : RtcBindAddress.parse(value)
}
