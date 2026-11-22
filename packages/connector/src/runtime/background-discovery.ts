import {
  DiscoveryPrinter,
  MAX_DISCOVERY_RESULTS,
} from '../../../farm-protocol/src/configuration-discovery.ts'
import type { DiscoveryResults } from '../../../farm-protocol/src/telemetry.ts'
import type { AgentRuntimeConfig } from '../config/runtime.ts'
import { discoverPrinters, type Printer } from '../discovery/index.ts'

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

let scanning = false

export function startDiscoveryScan<T>(scan: () => Promise<T>) {
  if (scanning) return undefined
  scanning = true
  return Promise.resolve()
    .then(scan)
    .finally(() => {
      scanning = false
    })
}

type BoundPrinter = Pick<Printer, 'vendor' | 'host' | 'serial' | 'port'>

export function discoveryBindings(
  collection: AgentRuntimeConfig['collection'],
): BoundPrinter[] {
  const moonraker = collection.printers.map(({ origin }): BoundPrinter => {
    const url = new URL(origin)
    return {
      vendor: 'moonraker',
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    }
  })
  switch (collection.version) {
    case 3:
      return [
        ...moonraker,
        ...collection.bambu.printers.map(({ host, serial }) => ({
          vendor: 'bambu' as const,
          host,
          serial,
        })),
      ]
    case 4:
      return [
        ...moonraker,
        ...collection.creality.printers.map(({ host }) => ({
          vendor: 'creality' as const,
          host,
        })),
      ]
    case 6:
      return [
        ...moonraker,
        ...collection.sdcp.printers.map(({ host, mainboardId }) => ({
          vendor: 'sdcp' as const,
          host,
          serial: mainboardId,
          port: 3030,
        })),
      ]
    case 5:
      return [
        ...moonraker,
        ...collection.anycubic.printers.map(({ host }) => ({
          vendor: 'anycubic' as const,
          host,
        })),
      ]
    default:
      return moonraker
  }
}

export async function runBackgroundDiscovery(input: {
  enabled: boolean
  intervalMs: number
  signal: AbortSignal
  bindings: readonly BoundPrinter[]
  report: (results: DiscoveryResults, now: number) => void
  scan?: typeof discoverPrinters
  now?: () => number
}) {
  if (!input.enabled) return
  let previous = new Map<string, number>()
  while (!input.signal.aborted) {
    await pause(input.intervalMs, input.signal)
    if (input.signal.aborted) return
    const work = startDiscoveryScan(input.scan ?? discoverPrinters)
    const printers = await work?.catch(() => undefined)
    if (!printers || input.signal.aborted) continue

    const now = (input.now ?? Date.now)()
    const seen = new Map<string, number>()
    const results: DiscoveryResults = []
    for (const printer of printers) {
      const parsed = DiscoveryPrinter.safeParse(printer)
      if (!parsed.success) continue
      const p = parsed.data
      const key = p.serial ? `serial:${p.serial}` : `${p.vendor}:${p.host}`
      if (seen.has(key)) continue
      const firstSeen = Math.min(previous.get(key) ?? now, now)
      seen.set(key, firstSeen)
      const adopted = input.bindings.some(
        (binding) =>
          binding.vendor === p.vendor &&
          (binding.serial && p.serial
            ? binding.serial === p.serial
            : binding.host === p.host &&
              (binding.port === undefined ||
                p.port === undefined ||
                binding.port === p.port)),
      )
      results.push({
        ...p,
        model: p.model ?? null,
        name: p.name ?? null,
        port: p.port ?? null,
        firstSeen,
        lastSeen: now,
        adopted,
      })
      if (results.length === MAX_DISCOVERY_RESULTS) break
    }
    previous = seen
    input.report(results, now)
  }
}
