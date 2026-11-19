import { DiscoveryPrinter } from '../../../../packages/farm-protocol/src/configuration-discovery.ts'
import type { NetworkDiscovered } from './network-map.ts'
import type { DiscoveredPrinter } from './printer-setup-state.ts'

export type NetworkAdoption = {
  farmId: string
  agentId: string
  printer: DiscoveredPrinter
}

export function adoptionPrinter(found: NetworkDiscovered) {
  const parsed = DiscoveryPrinter.safeParse({
    vendor: found.vendor,
    host: found.host,
    port: found.port ?? undefined,
    serial: found.serial ?? undefined,
    model: found.model ?? undefined,
    name: found.name ?? undefined,
  })
  return !found.adopted && parsed.success ? parsed.data : undefined
}

function samePrinter(a: NetworkDiscovered, b: NetworkDiscovered) {
  return (
    a.agentId === b.agentId &&
    a.vendor === b.vendor &&
    (a.serial && b.serial
      ? a.serial === b.serial
      : a.host !== undefined &&
        a.host === b.host &&
        (a.port == null || b.port == null || a.port === b.port))
  )
}

export function mergeNetworkDiscoveries(
  reported: readonly NetworkDiscovered[],
  scanned: readonly NetworkDiscovered[],
) {
  const merged = [...reported]
  for (const printer of scanned) {
    const index = merged.findIndex((entry) => samePrinter(entry, printer))
    if (index === -1) merged.push(printer)
    else if (
      !merged[index]!.adopted &&
      merged[index]!.lastSeen < printer.lastSeen
    ) {
      merged[index] = printer
    }
  }
  return merged
}
