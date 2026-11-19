import {
  formatPrinterStateLabel,
  observationAge,
  printerStateLabel,
  type FarmRow,
} from './farm-view.ts'

export type FarmFilter =
  | 'all'
  | 'unknown'
  | 'stale'
  | 'connected'
  | 'disconnected'
  | keyof typeof printerStateLabel
export type FarmSort = 'original' | 'name-asc' | 'name-desc'

export const farmStateLabels = {
  ...printerStateLabel,
  unknown: 'Sem estado recebido',
  stale: 'Observação não atual',
}

type FarmState = keyof typeof farmStateLabels
type Clock = Parameters<typeof observationAge>[1]
type GroupField = 'groupName' | 'location'

export type FarmWallQuery = {
  query: string
  filter: FarmFilter
  sort: FarmSort
  group: string
  location: string
  connector: string
  alerts: '' | 'yes' | 'no'
  groupBy: '' | GroupField
}

export function readFarmWallQuery(
  params: Record<string, unknown>,
): FarmWallQuery {
  const { filter, sort, alerts, groupBy } = params
  const value = (key: string) => {
    const entry = params[key]
    return typeof entry === 'string' ? entry : ''
  }
  return {
    query: value('q'),
    filter:
      filter === 'connected' || filter === 'disconnected' || isFarmState(filter)
        ? filter
        : 'all',
    sort: sort === 'name-asc' || sort === 'name-desc' ? sort : 'original',
    group: value('group'),
    location: value('location'),
    connector: value('connector'),
    alerts: alerts === 'yes' || alerts === 'no' ? alerts : '',
    groupBy: groupBy === 'groupName' || groupBy === 'location' ? groupBy : '',
  }
}

function isFarmState(value: unknown): value is FarmState {
  return typeof value === 'string' && Object.hasOwn(farmStateLabels, value)
}

export function writeFarmWallQuery(state: FarmWallQuery) {
  return {
    q: state.query || undefined,
    filter: state.filter === 'all' ? undefined : state.filter,
    sort: state.sort === 'original' ? undefined : state.sort,
    group: state.group || undefined,
    location: state.location || undefined,
    connector: state.connector || undefined,
    alerts: state.alerts || undefined,
    groupBy: state.groupBy || undefined,
  }
}

function rowState(row: FarmRow, now: Clock): FarmState {
  if (!row.observation) return 'unknown'
  if (
    row.connection !== 'authenticated' ||
    observationAge(row.observation, now).stale
  )
    return 'stale'
  return row.observation.state.state
}

export function summarizeFarmRows(rows: readonly FarmRow[], now: Clock) {
  const counts: Record<FarmState, number> = {
    idle: 0,
    printing: 0,
    paused: 0,
    error: 0,
    offline: 0,
    unknown: 0,
    stale: 0,
  }
  for (const row of rows) counts[rowState(row, now)]++
  return counts
}

export function groupFarmRows<T extends FarmRow>(
  rows: readonly T[],
  groupBy: FarmWallQuery['groupBy'],
) {
  const groups = new Map<string | null, T[]>()
  for (const row of rows) {
    const key = groupBy ? row.assignment[groupBy] || null : null
    const members = groups.get(key)
    if (members) members.push(row)
    else groups.set(key, [row])
  }
  return [...groups].map(([key, rows]) => ({ key, rows }))
}

export function filterFarmRows<T extends FarmRow>(
  rows: readonly T[],
  query: string,
  filter: FarmFilter,
  sort: FarmSort,
  now: Clock,
  facets?: Pick<FarmWallQuery, 'group' | 'location' | 'connector' | 'alerts'>,
): T[] {
  const search = query.trim().toLocaleLowerCase('pt-BR')
  const result = rows.filter((row) => {
    const { assignment, observation } = row
    const state = rowState(row, now)
    if (facets?.group && assignment.groupName !== facets.group) return false
    if (facets?.location && assignment.location !== facets.location)
      return false
    if (facets?.connector && assignment.agentId !== facets.connector)
      return false
    const hasAlert = state === 'error'
    if (facets?.alerts && hasAlert !== (facets.alerts === 'yes')) return false
    const matches = [
      row.assignment.printerKey,
      assignment.displayName,
      row.assignment.assignmentId,
      row.assignment.agentId,
      observation && formatPrinterStateLabel(observation.state),
    ].some((value) => value?.toLocaleLowerCase('pt-BR').includes(search))
    if (!matches) return false
    if (filter === 'all') return true
    if (filter === 'connected') return row.connection === 'authenticated'
    if (filter === 'disconnected') return row.connection !== 'authenticated'
    return state === filter
  })
  if (sort !== 'original')
    result.sort(
      (a, b) =>
        (sort === 'name-asc' ? 1 : -1) *
        a.assignment.printerKey.localeCompare(b.assignment.printerKey, 'pt-BR'),
    )
  return result
}
