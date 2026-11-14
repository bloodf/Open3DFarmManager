import { z } from 'zod'

/**
 * Local network policy for printer endpoints. Only canonical IPv4 addresses
 * inside operator-configured RFC 1918 networks are accepted; the browser can
 * never select a management URL, scheme, path or port.
 */
export const KOBRA_X_PRINTER_PORT = 18910
const PRIVATE_BLOCKS: readonly (readonly [number, number])[] = [
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
]

function ipv4ToInt(value: string): number | null {
  const parsed = z.ipv4().safeParse(value)
  if (!parsed.success) return null
  const parts = value.split('.')
  if (parts.some((part) => part.length > 1 && part.startsWith('0'))) return null
  return parts.reduce((acc, part) => acc * 256 + Number(part), 0)
}
const maskOf = (prefix: number) =>
  prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
const within = (address: number, network: number, prefix: number) =>
  (address & maskOf(prefix)) >>> 0 === network

export interface PrinterNetworkPolicy {
  allows(ip: string): boolean
}

export function createPrinterNetworkPolicy(
  cidrs: readonly string[],
): PrinterNetworkPolicy {
  if (!Array.isArray(cidrs) || cidrs.length < 1 || cidrs.length > 16)
    throw new Error('Invalid printer network policy')
  const networks = cidrs.map((cidr) => {
    const match = /^([0-9.]+)\/([0-9]{1,2})$/.exec(cidr)
    const address = match?.[1] ? ipv4ToInt(match[1]) : null
    const prefix = Number(match?.[2])
    if (address === null || !Number.isInteger(prefix) || prefix > 32)
      throw new Error('Invalid printer network policy')
    if ((address & maskOf(prefix)) >>> 0 !== address)
      throw new Error('Invalid printer network policy')
    if (
      !PRIVATE_BLOCKS.some(
        ([block, size]) => prefix >= size && within(address, block, size),
      )
    )
      throw new Error('Printer networks must be private RFC 1918 ranges')
    return [address, prefix] as const
  })
  return Object.freeze({
    allows(ip: string): boolean {
      const address = ipv4ToInt(ip)
      if (address === null) return false
      const last = address & 0xff
      if (last === 0 || last === 255) return false
      return networks.some(([network, prefix]) =>
        within(address, network, prefix),
      )
    },
  })
}
