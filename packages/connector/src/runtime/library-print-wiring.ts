import { join } from 'node:path'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { CompatibilityProfile } from '../../../shared/src/print-file/compatibility.ts'
import { createLibraryCache } from './library-cache.ts'
import {
  createHttpsLibraryDownloader,
  createLibraryPrintStarter,
} from './library-print-start.ts'
import { createLibraryStore } from './library-store.ts'

/** Server-mode cache bound; files are evicted least recently used beyond it. */
export const DEFAULT_LIBRARY_CACHE_BYTES = 2 * 1024 ** 3

export type LibraryPrintStarter = ReturnType<typeof createLibraryPrintStarter>

/**
 * The profile a library start is checked against: only what the printer itself
 * reported (identity model, nozzle diameters, bed). Never taken from the action;
 * undefined until the printer has reported both a model and its nozzles.
 */
export function createPrinterProfiles() {
  const seen = new Map<string, PrinterState>()
  return {
    /** Remembers the latest report; `machine` arrives on change only, so it is carried over. */
    observe(printer: PrinterState) {
      const machine = printer.machine ?? seen.get(printer.printerKey)?.machine
      seen.set(printer.printerKey, {
        ...printer,
        ...(machine ? { machine } : {}),
      })
    },
    read(printerKey: string): CompatibilityProfile | undefined {
      const printer = seen.get(printerKey)
      const model = printer?.identity?.model ?? printer?.machine?.model
      const nozzles = printer?.machine?.nozzleDiametersMm
      if (!model || !nozzles?.length) return undefined
      const bed = printer?.machine?.bedSizeMm
      return {
        model,
        nozzleDiameters: nozzles,
        ...(bed ? { bedSize: { x: bed.x, y: bed.y, z: bed.z } } : {}),
      }
    },
  }
}

/**
 * Builds the library print starter from the Connector's own configuration: the
 * server is the telemetry endpoint's origin and the credential is the one it
 * already sends there. Server-mode files go through the bounded cache; the
 * Connector's local library (Connector mode) is read in place. Without an
 * HTTPS server there is nothing to download from, so no library print starts.
 */
export async function createConnectorLibrary(config: {
  endpoint: string
  credential: { device_token: string; farm_id: string; agent_id: string }
  dataDirectory: string
  /** Trust anchor for a private server certificate. */
  ca?: string | Buffer
  cacheMaxBytes?: number
}): Promise<
  | {
      starterFor(
        profile: () => Promise<CompatibilityProfile | undefined>,
      ): LibraryPrintStarter
    }
  | undefined
> {
  let baseUrl: URL
  try {
    baseUrl = new URL(config.endpoint)
  } catch {
    return undefined
  }
  if (baseUrl.protocol !== 'https:') return undefined
  const { device_token, farm_id, agent_id } = config.credential
  const download = createHttpsLibraryDownloader({
    baseUrl: baseUrl.origin,
    headers: () => ({
      authorization: `Bearer ${device_token}`,
      'x-connector-agent': agent_id,
      'x-connector-farm': farm_id,
    }),
    ...(config.ca ? { ca: config.ca } : {}),
  })
  const cache = await createLibraryCache({
    directory: join(config.dataDirectory, 'library-cache'),
    maxBytes: config.cacheMaxBytes ?? DEFAULT_LIBRARY_CACHE_BYTES,
  })
  const local = await createLibraryStore({
    directory: join(config.dataDirectory, 'library'),
  })
  return {
    starterFor: (profile) =>
      createLibraryPrintStarter({ cache, download, local, profile }),
  }
}
