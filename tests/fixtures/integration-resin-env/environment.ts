// spec-derived, not captured: https://github.com/bloodf/Open3DFarmManager/issues/684
// Deterministic printer-state rows for environment measurements. The state
// shape follows PrinterState (packages/farm-protocol/src/state.ts); no printer,
// sensor or power device was contacted.
import type { IntegrationPrinterRow } from '../../../apps/farm/server/utils/integration-auth.ts'
import { farmA, farmB, printerA1, printerA2, printerB1 } from './ledger.ts'

export const now = 1_000_000

const state = (observedAt: number, extra: Record<string, unknown> = {}) => ({
  printerKey: 'key',
  state: 'idle',
  progress: 0,
  observedAt,
  ...extra,
})

const row = (
  id: string,
  farmId: string,
  printerState: unknown,
  observedAt: number | null,
): IntegrationPrinterRow => ({
  id,
  farmId,
  printerKey: `key-${id.slice(-1)}`,
  displayName: `Impressora ${id.slice(-1)}`,
  location: 'Sala de cura',
  sandbox: false,
  state: printerState,
  observedAt,
})

/** Fresh chamber-fan reading: air/extraction is known. */
export const freshChamber = row(
  printerA1,
  farmA,
  state(now - 5_000, { fans: { chamber: 60 } }),
  now - 5_000,
)
/** Reporting printer without a chamber fan: unsupported device. */
export const noChamber = row(printerA2, farmA, state(now - 5_000), now - 5_000)
/** Last observation too old to be current. */
export const staleChamber = row(
  printerA2,
  farmA,
  state(now - 600_000, { fans: { chamber: 60 } }),
  now - 600_000,
)
/** Printer that never reported state. */
export const neverObserved = row(printerA2, farmA, null, null)
export const offlineChamber = row(
  printerA2,
  farmA,
  state(now - 10_000, { state: 'offline', fans: { chamber: 60 } }),
  now - 10_000,
)
export const otherFarm = row(
  printerB1,
  farmB,
  state(now - 5_000, { fans: { chamber: 20 } }),
  now - 5_000,
)
