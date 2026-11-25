import { expect, it } from 'vitest'
import type {
  FarmRow,
  FarmSpoolObservation,
} from '../../apps/farm/app/utils/farm-view.ts'
import { activeSlotSpools } from '../../apps/farm/app/utils/slot-spools.ts'

const now = { wall: 50_000, mono: 40_000 }
const row: FarmRow = {
  assignment: {
    assignmentId: 'assignment-fixture',
    agentId: 'connector-fixture',
    printerKey: 'printer-fixture',
    status: 'active',
    connectorStatus: 'approved',
  },
  connection: 'authenticated',
  observation: {
    received: now,
    state: {
      printerKey: 'printer-fixture',
      state: 'idle',
      observedAt: now.wall,
      materials: [{ slot: 'ams:0:0', remainingPercent: 90 }],
    },
    historical: false,
    sourceClockComparable: true,
  },
  localOrigin: null,
}
const stock = (
  agentId: string,
  remainingPercent: number,
): FarmSpoolObservation => ({
  agentId,
  received: now,
  historical: false,
  inventory: {
    observedAt: now.wall,
    stale: false,
    total: 1,
    serviceId: '00000000-0000-4000-8000-000000000011',
    spools: [
      {
        spoolId: 11,
        name: 'PLA',
        material: 'PLA',
        colorHex: 'e04030',
        remainingGrams: 0,
        remainingPercent,
        location: null,
        archived: false,
      },
    ],
  },
})
const input = {
  farmId: 'farm-fixture',
  row,
  now,
  assignments: { 'ams:0:0': 11, 'ams:0:1': 12 },
  inventory: [stock('other-connector', 70), stock('connector-fixture', 0)],
}

it('uses the same Connector and exact assigned spool, including zero', () => {
  const spools = activeSlotSpools(input)
  expect(spools).toMatchObject([
    { slot: 'ams:0:0', spoolId: 11, remainingPercent: 0 },
    { slot: 'ams:0:1', spoolId: 12 },
  ])
  expect(spools[1]?.remainingPercent).toBeUndefined()
})

it('drops the Spoolman level when the mirror is stale or from another Connector', () => {
  expect(
    activeSlotSpools({ ...input, now: { wall: 80_000, mono: 70_000 } })[0]
      ?.remainingPercent,
  ).toBeUndefined()
  expect(
    activeSlotSpools({ ...input, inventory: [stock('other-connector', 70)] })[0]
      ?.remainingPercent,
  ).toBeUndefined()
})
