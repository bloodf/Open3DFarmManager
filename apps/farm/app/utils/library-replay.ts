// Replay from the library and history pages. Printers always list (for the
// compatibility comparison); only those with a live, signed session can be
// picked, so nothing is sent without one.
import type { LibraryVersion, PrinterProfile } from './library-view.ts'
import type { LiveReplayInfo } from './replay-live.ts'
import type {
  ReplayPrinter,
  ReplayResult,
  ReplaySource,
} from './replay-view.ts'

/** One farm printer assignment, as `/api/farms/:farmId/printers` lists it. */
export type LibraryReplayAssignment = Readonly<{
  assignmentId: string
  agentId: string
  printerKey: string
  displayName?: string | null
  status: 'active' | 'revoked'
  connectorStatus: 'pending' | 'approved' | 'revoked'
}>

/** Active printers of approved Connectors, without a live session. */
export function libraryReplayPrinters(
  assignments: readonly LibraryReplayAssignment[],
  profiles: readonly PrinterProfile[],
  /** Live session data; without it no printer can be picked. */
  liveFor?: (printerKey: string) => LiveReplayInfo | undefined,
): ReplayPrinter[] {
  return assignments
    .filter(
      (row) => row.status === 'active' && row.connectorStatus === 'approved',
    )
    .map((row) => {
      const profile = profiles.find((p) => p.assignmentId === row.assignmentId)
      const nozzle = profile?.effective.values.nozzleDiameterMm
      return {
        key: row.printerKey,
        label: row.displayName || row.printerKey,
        agentId: row.agentId,
        model: profile?.effective.values.model ?? '',
        compatibleModels: profile?.effective.compatibleModels ?? [],
        nozzleDiameters: typeof nozzle === 'number' ? [nozzle] : [],
        connectorOnline: true,
        live: false,
        materials: [],
        ...liveFor?.(row.printerKey),
      }
    })
}

/** Without a live signed session nothing is sent. */
export async function sendWithoutSession(): Promise<ReplayResult> {
  return { outcome: 'not-sent' }
}

/** The replay dialog's view of a stored library version. */
export function libraryReplaySource(version: LibraryVersion): ReplaySource {
  return {
    versionId: version.id,
    sha256: version.sha256,
    name: version.originalName,
    kind: version.kind,
    plateCount: version.plateCount,
    metadata: version.metadata,
    storageLocation: version.storageLocation,
    agentId: version.agentId,
    purged: version.purgedAt !== null,
  }
}
