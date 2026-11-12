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
export const RtcBindAddress = z
  .string()
  .max(45)
  .refine(
    (value) => isIP(value) !== 0 && !value.includes('%'),
    'Expected a literal IPv4 or IPv6 address',
  )

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
