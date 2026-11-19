import { join } from 'node:path'
import type { LibraryRuntimeConfig } from '../config/runtime.ts'
import type {
  LibraryMigrationDirectionValue,
  LibraryMigrationOutcomeValue,
  LibraryMigrationVersionValue,
} from '../../../farm-protocol/src/library-storage.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import type { CompatibilityProfile } from '../../../shared/src/print-file/compatibility.ts'
import { createLibraryCache } from './library-cache.ts'
import {
  createHttpsLibraryDownloader,
  createLibraryPrintStarter,
} from './library-print-start.ts'
import { migrateLibrary } from './library-migration.ts'
import { createLibraryRelay } from './library-relay.ts'
import { createLibraryStore, type LibraryStore } from './library-store.ts'

/** Server-mode cache bound; files are evicted least recently used beyond it. */
export const DEFAULT_LIBRARY_CACHE_BYTES = 2 * 1024 ** 3

export interface ConnectorLibrary {
  starterFor(
    profile: () => Promise<CompatibilityProfile | undefined>,
  ): LibraryPrintStarter
  /** The Connector host's own store: the only place Connector-mode bytes live. */
  store: LibraryStore
  /**
   * Switches versions between the server and this host (#446). Server to
   * Connector pulls each file over the authenticated download and verifies its
   * hash before storing. Connector to server needs a server-side receiver that
   * does not exist yet: those versions report that they stay, source kept.
   */
  migrate(
    direction: LibraryMigrationDirectionValue,
    versions: readonly LibraryMigrationVersionValue[],
    signal: AbortSignal,
  ): Promise<LibraryMigrationOutcomeValue[]>
  /** Serves the server's relay operations until the signal aborts. */
  serveRelay(
    signal: AbortSignal,
    onDiagnostic?: (event: {
      kind: 'library-relay-error'
      reason: string
    }) => void,
  ): Promise<void>
}

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
 * HTTPS server there is nothing to download from, so no library print starts
 * and the server cannot reach this store either.
 */
export async function createConnectorLibrary(config: {
  endpoint: string
  credential: { device_token: string; farm_id: string; agent_id: string }
  dataDirectory: string
  /** Trust anchor for a private server certificate. */
  ca?: string | Buffer
  cacheMaxBytes?: number
  /** `library` section of the Connector runtime configuration. */
  library?: LibraryRuntimeConfig | undefined
}): Promise<ConnectorLibrary | undefined> {
  let baseUrl: URL
  try {
    baseUrl = new URL(config.endpoint)
  } catch {
    return undefined
  }
  if (baseUrl.protocol !== 'https:') return undefined
  const { device_token, farm_id, agent_id } = config.credential
  const headers = () => ({
    authorization: `Bearer ${device_token}`,
    'x-connector-agent': agent_id,
    'x-connector-farm': farm_id,
  })
  const download = createHttpsLibraryDownloader({
    baseUrl: baseUrl.origin,
    headers,
    ...(config.ca ? { ca: config.ca } : {}),
  })
  const settings = config.library
  const cache = await createLibraryCache({
    directory: join(config.dataDirectory, 'library-cache'),
    maxBytes:
      config.cacheMaxBytes ??
      settings?.cacheMaxBytes ??
      DEFAULT_LIBRARY_CACHE_BYTES,
  })
  const local = await createLibraryStore({
    directory: settings?.directory ?? join(config.dataDirectory, 'library'),
    ...(settings?.quotaBytes === undefined
      ? {}
      : { quotaBytes: settings.quotaBytes }),
    ...(settings?.retentionDays === undefined
      ? {}
      : { retentionDays: settings.retentionDays }),
    ...(settings?.keepVersions === undefined
      ? {}
      : { keepVersions: settings.keepVersions }),
  })
  return {
    store: local,
    starterFor: (profile) =>
      createLibraryPrintStarter({ cache, download, local, profile }),
    migrate: (direction, versions, signal) =>
      migrateLibrary({
        direction,
        versions,
        store: local,
        transfer: {
          async pull(sha256) {
            return (await download(sha256, signal)).stream
          },
          async push() {
            throw new Error(
              'Server receiver for Connector files is not available',
            )
          },
        },
      }),
    serveRelay: (signal, onDiagnostic) =>
      createLibraryRelay({
        baseUrl: baseUrl.origin,
        headers,
        store: local,
        signal,
        ...(config.ca ? { ca: config.ca } : {}),
        ...(onDiagnostic ? { onDiagnostic } : {}),
      }).run(),
  }
}
