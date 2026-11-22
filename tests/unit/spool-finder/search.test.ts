// spec-derived, not captured: Spoolman REST API, https://donkie.github.io/Spoolman/
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  EMPTY_FINDER_FILTERS,
  filterSpools,
  searchColor,
  type FinderFilters,
} from '../../../apps/farm/app/components/spool-finder/finder-filter.ts'
import type { SpoolItem } from '../../../apps/farm/app/utils/spool-library-types.ts'
import { startFinderSimulator } from './simulator.ts'

let finder: Awaited<ReturnType<typeof startFinderSimulator>>
let spools: SpoolItem[]

beforeAll(async () => {
  finder = await startFinderSimulator()
  spools = await finder.list()
})
afterAll(async () => {
  await finder.sim.close()
})

const find = (patch: Partial<FinderFilters>) =>
  filterSpools(spools, { ...EMPTY_FINDER_FILTERS, ...patch })
    .map((spool) => spool.id)
    .sort((a, b) => a - b)

test('lists every active spool and hides archived ones by default', () => {
  const { ids } = finder
  expect(find({})).toEqual([
    ids.blueShelf,
    ids.redShelf,
    ids.blackNone,
    ids.blueBox,
  ])
  expect(find({ includeArchived: true })).toContain(ids.archived)
})

test('filters by material, exactly', () => {
  const { ids } = finder
  expect(find({ material: 'PETG' })).toEqual([ids.redShelf])
  expect(find({ material: 'pla' })).toEqual([
    ids.blueShelf,
    ids.blackNone,
    ids.blueBox,
  ])
  expect(find({ material: 'PET' })).toEqual([])
})

test('filters by colour name or hex with tolerance', () => {
  const { ids } = finder
  expect(find({ color: 'azul' })).toEqual([ids.blueShelf, ids.blueBox])
  expect(find({ color: '#2050E0' })).toEqual([ids.blueShelf, ids.blueBox])
  expect(find({ color: 'preto' })).toEqual([ids.blackNone])
  expect(find({ color: 'vermelho' })).toEqual([ids.redShelf])
  expect(find({ color: 'branco' })).toEqual([])
  // Not a colour: falls back to the filament name.
  expect(find({ color: 'fosco' })).toEqual([ids.blackNone])
  expect(searchColor('Azul')).not.toBeNull()
  expect(searchColor('fosco')).toBeNull()
})

test('filters by location, ignoring case and accents', () => {
  const { ids } = finder
  expect(find({ location: 'prateleira' })).toEqual([
    ids.blueShelf,
    ids.redShelf,
  ])
  expect(find({ location: 'CAIXA' })).toEqual([ids.blueBox])
  expect(find({ withoutLocation: true })).toEqual([ids.blackNone])
})

test('combines filters and searches free text by id and name', () => {
  const { ids } = finder
  expect(find({ material: 'PLA', location: 'prateleira' })).toEqual([
    ids.blueShelf,
  ])
  expect(find({ text: `#${ids.redShelf}` })).toContain(ids.redShelf)
  expect(find({ text: 'vermelho fogo' })).toEqual([ids.redShelf])
  expect(find({ text: 'inexistente' })).toEqual([])
})
