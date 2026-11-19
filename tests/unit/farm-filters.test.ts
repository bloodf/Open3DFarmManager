import { describe, expect, it } from 'vitest'
import {
  filterFarmRows,
  groupFarmRows,
  readFarmWallQuery,
  summarizeFarmRows,
  writeFarmWallQuery,
} from '../../apps/farm/app/utils/farm-filters.ts'
import {
  FarmAssignmentPage,
  type FarmRow,
} from '../../apps/farm/app/utils/farm-view.ts'

const now = { wall: 100000, mono: 100000 }
function row(
  name: string,
  state: NonNullable<FarmRow['observation']>['state']['state'] | null,
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

describe('printer wall', () => {
  const defaults = readFarmWallQuery({})
  const fixtures = [
    row('Zulu', 'error'),
    row('Alfa', 'error'),
    row('Beta', 'error'),
    row('Delta', 'error'),
    row('Gama', 'error', true),
    row('Épsilon', null),
  ]
  Object.assign(fixtures[0].assignment, {
    groupName: 'Ação & B',
    location: 'Sul/1',
  })
  Object.assign(fixtures[1].assignment, { groupName: 'B', location: 'Sul/1' })
  Object.assign(fixtures[2].assignment, {
    groupName: 'Ação & B',
    location: 'Norte',
  })
  Object.assign(fixtures[3].assignment, {
    groupName: 'Ação & B',
    location: 'Sul/1',
    agentId: 'other',
  })
  Object.assign(fixtures[4].assignment, {
    groupName: 'Ação & B',
    location: 'Sul/1',
  })

  const cases = [false, true].flatMap((group) =>
    [false, true].flatMap((location) =>
      [false, true].flatMap((connector) =>
        (['', 'yes', 'no'] as const).map((alerts) => ({
          group,
          location,
          connector,
          alerts,
        })),
      ),
    ),
  )
  it.each(cases)(
    'combines filters and round trips the URL ($group, $location, $connector, $alerts)',
    (choice) => {
      const state = {
        ...defaults,
        group: choice.group ? 'Ação & B' : '',
        location: choice.location ? 'Sul/1' : '',
        connector: choice.connector ? 'connector' : '',
        alerts: choice.alerts,
      }
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(writeFarmWallQuery(state))) {
        if (value !== undefined) params.set(key, value)
      }
      expect(
        readFarmWallQuery(
          Object.fromEntries(new URLSearchParams(params.toString())),
        ),
      ).toEqual(state)

      const expected = [
        ...(choice.alerts === 'no'
          ? []
          : [
              'Zulu',
              ...(choice.group ? [] : ['Alfa']),
              ...(choice.location ? [] : ['Beta']),
              ...(choice.connector ? [] : ['Delta']),
            ]),
        ...(choice.alerts === 'yes'
          ? []
          : [
              'Gama',
              ...(!choice.group && !choice.location ? ['Épsilon'] : []),
            ]),
      ]
      expect(
        filterFarmRows(fixtures, '', 'all', 'original', now, state).map(
          (item) => item.assignment.printerKey,
        ),
      ).toEqual(expected)
    },
  )

  it('combines existing search, filter and sort with the selected facets', () => {
    const state = readFarmWallQuery({
      q: 'connector',
      filter: 'error',
      sort: 'name-desc',
      group: 'Ação & B',
      alerts: 'yes',
      groupBy: 'location',
    })
    expect(readFarmWallQuery(writeFarmWallQuery(state))).toEqual(state)
    expect(
      filterFarmRows(
        fixtures,
        state.query,
        state.filter,
        state.sort,
        now,
        state,
      ),
    ).toEqual([fixtures[0], fixtures[2]])
    expect(
      readFarmWallQuery({
        q: ['a', 'b'],
        filter: 'constructor',
        sort: 'bad',
        groupBy: 'bad',
        alerts: null,
      }),
    ).toEqual(defaults)
  })

  it('groups by group or location and keeps missing metadata together', () => {
    expect(groupFarmRows(fixtures, 'groupName')).toEqual([
      {
        key: 'Ação & B',
        rows: [fixtures[0], fixtures[2], fixtures[3], fixtures[4]],
      },
      { key: 'B', rows: [fixtures[1]] },
      { key: null, rows: [fixtures[5]] },
    ])
    expect(groupFarmRows(fixtures, 'location')).toEqual([
      {
        key: 'Sul/1',
        rows: [fixtures[0], fixtures[1], fixtures[3], fixtures[4]],
      },
      { key: 'Norte', rows: [fixtures[2]] },
      { key: null, rows: [fixtures[5]] },
    ])
    expect(groupFarmRows(fixtures, '')).toEqual([{ key: null, rows: fixtures }])
  })

  it('counts every state without counting past errors as current', () => {
    expect(
      summarizeFarmRows(
        [
          ...fixtures,
          row('I', 'idle'),
          row('P', 'printing'),
          row('S', 'paused'),
          row('O', 'offline'),
          { ...row('D', 'error'), connection: 'unavailable' },
        ],
        now,
      ),
    ).toEqual({
      error: 4,
      stale: 2,
      unknown: 1,
      idle: 1,
      printing: 1,
      paused: 1,
      offline: 1,
    })
  })

  it('accepts inventories with grouping metadata and legacy assignments', () => {
    const assignment = {
      ...fixtures[0].assignment,
      assignmentId: '00000000-0000-4000-8000-000000000001',
      agentId: '00000000-0000-4000-8000-000000000002',
    }
    const legacy = {
      ...fixtures[5].assignment,
      assignmentId: '00000000-0000-4000-8000-000000000003',
      agentId: assignment.agentId,
    }
    const page = {
      printers: [{ ...assignment, displayName: null, sortOrder: 2 }, legacy],
      nextAfter: null,
      canManage: true,
    }
    expect(FarmAssignmentPage.parse(page)).toEqual(page)
  })
})
