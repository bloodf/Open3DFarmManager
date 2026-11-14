import { probePrinterHost } from '../discovery/probe.ts'
import { discoverPrinters } from '../discovery/index.ts'
import {
  DISCOVERY_TIMEOUT_MS,
  MAX_DISCOVERY_RESULTS,
  DiscoveryPrinter,
  type DiscoveryResult,
} from '../../../farm-protocol/src/configuration-discovery.ts'
import type { ConfigurationAuthority } from './configuration-authority.ts'

export type DiscoveryScanner = typeof discoverPrinters
const active = new WeakSet<ConfigurationAuthority>()

/** Shared authority belongs to one Connector, across all its RTC sessions. */
export async function scanConfigurationDiscovery(
  authority: ConfigurationAuthority,
  requestId: string,
  scan: DiscoveryScanner = discoverPrinters,
  host?: string,
): Promise<DiscoveryResult> {
  if (active.has(authority))
    return { request_id: requestId, ok: false, reason: 'busy' }
  active.add(authority)
  let timer: ReturnType<typeof setTimeout> | undefined
  // Leave room for socket setup and cleanup inside the five-second deadline.
  const work = Promise.resolve().then(async () =>
    host === undefined
      ? scan({ timeout: DISCOVERY_TIMEOUT_MS - 500 })
      : probePrinterHost(host).then((printer) => (printer ? [printer] : [])),
  )
  // Keep the lease until the scanner settles, even if it ignores its timeout.
  void work.finally(() => active.delete(authority)).catch(() => {})
  try {
    const results = await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), DISCOVERY_TIMEOUT_MS)
      }),
    ])
    if (results === null)
      return { request_id: requestId, ok: false, reason: 'timeout' }
    const unique = new Map<string, DiscoveryPrinterValue>()
    for (const result of results) {
      // Whitelist fields; discovery implementations never export credentials.
      const parsed = DiscoveryPrinter.safeParse(result)
      if (!parsed.success) continue
      const p = parsed.data
      const key = `${p.vendor}:${p.serial ?? p.host}:${p.port ?? ''}`
      if (!unique.has(key)) unique.set(key, p)
      if (unique.size === MAX_DISCOVERY_RESULTS) break
    }
    return { request_id: requestId, ok: true, printers: [...unique.values()] }
  } catch {
    return { request_id: requestId, ok: false, reason: 'failed' }
  } finally {
    clearTimeout(timer)
  }
}
type DiscoveryPrinterValue = ReturnType<typeof DiscoveryPrinter.parse>
