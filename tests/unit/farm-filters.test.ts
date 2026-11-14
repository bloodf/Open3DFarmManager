import { describe, expect, it } from 'vitest'
import { filterFarmRows } from '../../apps/farm/app/utils/farm-filters.ts'
import type { FarmRow } from '../../apps/farm/app/utils/farm-view.ts'

const now = { wall: 100000, mono: 100000 }
function row(
  name: string,
  state: 'printing' | 'idle' | null,
  historical = false,
): FarmRow {
  return {
    assignment: {
      assignmentId: name,
      agentId: 'connector',
      printerKey: name,
      status: 'active',
      connectorStatus: 'approved',
    },
    connection: 'authenticated',
    localOrigin: null,
    observation: state
      ? {
          state: { printerKey: name, state, observedAt: 100000 },
          received: now,
          sourceClockComparable: true,
          historical,
        }
      : null,
  }
}
describe('farm filters', () => {
  const rows = [
    row('Zulu', 'printing'),
    row('Alfa', 'idle'),
    row('Beta', 'printing', true),
    row('Gama', null),
  ]
  it('handles empty, search and stable sorting', () => {
    expect(filterFarmRows([], '', 'all', 'original', now)).toEqual([])
    expect(
      filterFarmRows(rows, 'connector', 'all', 'name-asc', now).map(
        (r) => r.assignment.printerKey,
      ),
    ).toEqual(['Alfa', 'Beta', 'Gama', 'Zulu'])
  })
  it('separates current state, stale and unknown', () => {
    expect(
      filterFarmRows(rows, '', 'printing', 'original', now).map(
        (r) => r.assignment.printerKey,
      ),
    ).toEqual(['Zulu'])
    expect(
      filterFarmRows(rows, '', 'stale', 'original', now).map(
        (r) => r.assignment.printerKey,
      ),
    ).toEqual(['Beta'])
    expect(
      filterFarmRows(rows, '', 'unknown', 'original', now).map(
        (r) => r.assignment.printerKey,
      ),
    ).toEqual(['Gama'])
  })
})
