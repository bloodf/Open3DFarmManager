// Replay from the library page. The page has no live, signed session with any
// Connector, so every printer is listed (for the compatibility comparison) but
// cannot be picked, and the send never reaches a Connector.
import type { PrinterProfile } from './library-view.ts'
import type { ReplayPrinter, ReplayResult } from './replay-view.ts'

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
      }
    })
}

/** The library page cannot sign a command: nothing is sent. */
export async function sendWithoutSession(): Promise<ReplayResult> {
  return { outcome: 'not-sent' }
}
