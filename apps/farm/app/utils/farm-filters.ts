import { observationAge, printerStateLabel, type FarmRow } from './farm-view.ts'

export type FarmFilter =
  | 'all'
  | 'unknown'
  | 'stale'
  | 'connected'
  | 'disconnected'
  | keyof typeof printerStateLabel
export type FarmSort = 'original' | 'name-asc' | 'name-desc'

export function filterFarmRows<T extends FarmRow>(
  rows: readonly T[],
  query: string,
  filter: FarmFilter,
  sort: FarmSort,
  now: { wall: number; mono: number },
): T[] {
  const search = query.trim().toLocaleLowerCase('pt-BR')
  const result = rows.filter((row) => {
    const observation = row.observation
    const current =
      !!observation &&
      row.connection === 'authenticated' &&
      !observationAge(observation, now).stale
    const matches = [
      row.assignment.printerKey,
      row.assignment.assignmentId,
      row.assignment.agentId,
      observation && printerStateLabel[observation.state.state],
    ].some((value) => value?.toLocaleLowerCase('pt-BR').includes(search))
    if (!matches) return false
    if (filter === 'all') return true
    if (filter === 'unknown') return !observation
    if (filter === 'stale') return !!observation && !current
    if (filter === 'connected') return row.connection === 'authenticated'
    if (filter === 'disconnected') return row.connection !== 'authenticated'
    return current && observation.state.state === filter
  })
  if (sort !== 'original')
    result.sort(
      (a, b) =>
        (sort === 'name-asc' ? 1 : -1) *
        a.assignment.printerKey.localeCompare(b.assignment.printerKey, 'pt-BR'),
    )
  return result
}
