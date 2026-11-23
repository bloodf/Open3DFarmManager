// spec-derived, not captured: Spoolman REST API, https://donkie.github.io/Spoolman/
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  repositoryFinderStore,
  scanForAuthority,
  scanSpoolLabel,
  spoolmanFinderStore,
} from '../../../apps/farm/server/utils/spool-library/finder.ts'
import type {
  Spool,
  SpoolLibraryRepository,
  SpoolLibraryStorage,
} from '../../../apps/farm/server/utils/spool-library/scope.ts'
import { FARM, labelFor, startFinderSimulator } from './simulator.ts'

let finder: Awaited<ReturnType<typeof startFinderSimulator>>
beforeAll(async () => {
  finder = await startFinderSimulator()
})
afterAll(async () => {
  await finder.sim.close()
})

const locationOf = async (id: number) =>
  (await finder.list()).find((spool) => spool.id === id)?.location

test('a scan writes the location once; the same scan again is a no-op', async () => {
  const store = spoolmanFinderStore({ origin: finder.sim.origin })
  const id = finder.ids.blackNone
  const before = finder.patches()

  const first = await scanSpoolLabel(store, {
    label: labelFor(id),
    location: 'Prateleira C3',
    farmId: FARM,
  })
  expect(first).toMatchObject({
    ok: true,
    status: 'moved',
    from: null,
    to: 'Prateleira C3',
  })
  expect(await locationOf(id)).toBe('Prateleira C3')
  expect(finder.patches()).toBe(before + 1)

  const again = await scanSpoolLabel(store, {
    label: labelFor(id),
    location: ' Prateleira  C3 ',
    farmId: FARM,
  })
  expect(again).toMatchObject({ ok: true, status: 'unchanged' })
  expect(finder.patches()).toBe(before + 1)

  const moved = await scanSpoolLabel(store, {
    label: `#${id}`,
    location: 'Caixa seca',
  })
  expect(moved).toMatchObject({
    ok: true,
    status: 'moved',
    from: 'Prateleira C3',
  })
  expect(finder.patches()).toBe(before + 2)
})

test('simultaneous duplicate scans write once', async () => {
  const store = spoolmanFinderStore({ origin: finder.sim.origin })
  const id = finder.ids.redShelf
  const before = finder.patches()
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      scanSpoolLabel(store, { label: labelFor(id), location: 'Estante D4' }),
    ),
  )
  expect(results.filter((r) => r.ok && r.status === 'moved')).toHaveLength(1)
  expect(results.filter((r) => r.ok && r.status === 'unchanged')).toHaveLength(
    4,
  )
  expect(finder.patches()).toBe(before + 1)
  expect(await locationOf(id)).toBe('Estante D4')
})

test('an unknown label is refused with a reason and nothing is written', async () => {
  const store = spoolmanFinderStore({ origin: finder.sim.origin })
  const before = finder.patches()
  for (const label of [
    'lixo',
    labelFor(9999),
    '#9999',
    'https://exemplo.invalid/x',
  ]) {
    const result = await scanSpoolLabel(store, { label, location: 'Qualquer' })
    expect(result).toMatchObject({ ok: false, reason: 'unknown-label' })
    if (!result.ok) expect(result.message).toMatch(/Etiqueta não reconhecida/)
  }
  expect(finder.patches()).toBe(before)
})

test('refuses a label of another farm, an archived spool and a bad location', async () => {
  const store = spoolmanFinderStore({ origin: finder.sim.origin })
  const before = finder.patches()
  expect(
    await scanSpoolLabel(store, {
      label: labelFor(
        finder.ids.blueBox,
        '44444444-4444-4444-8444-444444444444',
      ),
      location: 'X1',
      farmId: FARM,
    }),
  ).toMatchObject({ ok: false, reason: 'wrong-farm' })
  expect(
    await scanSpoolLabel(store, {
      label: `#${finder.ids.archived}`,
      location: 'X1',
    }),
  ).toMatchObject({ ok: false, reason: 'archived' })
  for (const location of ['', '   ', 'a'.repeat(65), 'x\ny', undefined])
    expect(
      await scanSpoolLabel(store, {
        label: `#${finder.ids.blueBox}`,
        location,
      }),
    ).toMatchObject({ ok: false, reason: 'invalid-location' })
  expect(finder.patches()).toBe(before)
})

test('an unreachable store refuses; an unconfirmed write is never retried', async () => {
  const id = finder.ids.blueShelf
  const down = spoolmanFinderStore({
    origin: finder.sim.origin,
    fetch: async () => {
      throw new Error('offline')
    },
  })
  expect(
    await scanSpoolLabel(down, { label: `#${id}`, location: 'Z9' }),
  ).toMatchObject({
    ok: false,
    reason: 'unavailable',
  })

  const before = finder.patches()
  let attempts = 0
  const flaky = spoolmanFinderStore({
    origin: finder.sim.origin,
    fetch: async (input, init) => {
      if (init?.method === 'PATCH') {
        attempts++
        throw new Error('connection reset')
      }
      return fetch(input, init)
    },
  })
  const result = await scanSpoolLabel(flaky, {
    label: `#${id}`,
    location: 'Z9',
  })
  expect(result).toMatchObject({ ok: false, reason: 'uncertain' })
  expect(attempts).toBe(1)
  expect(finder.patches()).toBe(before)
})

test('the farm library store and session scope behave the same', async () => {
  const spools = new Map<number, Spool>([
    [1, spool(1, null, false)],
    [2, spool(2, 'A1', true)],
  ])
  let writes = 0
  const repo = (access: 'read' | 'write') =>
    ({
      farmId: FARM,
      access,
      spools: {
        async get(id: number) {
          const found = spools.get(id)
          return found
            ? { ok: true, value: found }
            : { ok: false, reason: 'not-found' }
        },
        async update(id: number, patch: { location?: string | null }) {
          if (access === 'read') return { ok: false, reason: 'denied' }
          writes++
          const next = { ...spools.get(id)!, location: patch.location ?? null }
          spools.set(id, next)
          return { ok: true, value: next }
        },
      },
    }) as unknown as SpoolLibraryRepository
  const storage = (access: 'read' | 'write'): SpoolLibraryStorage =>
    ({
      async withScope(
        _authority: unknown,
        work: (r: SpoolLibraryRepository) => Promise<never>,
      ) {
        return work(repo(access))
      },
    }) as unknown as SpoolLibraryStorage
  const authority = {
    kind: 'session',
    sessionRecordId: 's',
    policy: { idleTimeoutMs: 1 },
    farmId: FARM,
  } as const

  expect(
    await scanForAuthority(storage('read'), authority, {
      label: '#1',
      location: 'B2',
    }),
  ).toMatchObject({ ok: false, reason: 'denied' })
  expect(writes).toBe(0)

  const input = { label: labelFor(1), location: 'B2' }
  expect(
    await scanForAuthority(storage('write'), authority, input),
  ).toMatchObject({
    ok: true,
    status: 'moved',
  })
  expect(
    await scanForAuthority(storage('write'), authority, input),
  ).toMatchObject({
    ok: true,
    status: 'unchanged',
  })
  expect(writes).toBe(1)
  expect(
    await scanForAuthority(storage('write'), authority, {
      label: '#3',
      location: 'B2',
    }),
  ).toMatchObject({ ok: false, reason: 'unknown-label' })
  expect(
    await scanForAuthority(storage('write'), authority, {
      label: labelFor(1, '55555555-5555-4555-8555-555555555555'),
      location: 'B3',
    }),
  ).toMatchObject({ ok: false, reason: 'wrong-farm' })
  expect(
    await scanForAuthority(storage('write'), authority, {
      label: '#2',
      location: 'B2',
    }),
  ).toMatchObject({ ok: false, reason: 'archived' })
  expect(repositoryFinderStore(repo('write')).scope).toBe(`farm:${FARM}`)
  expect(writes).toBe(1)
})

function spool(id: number, location: string | null, archived: boolean): Spool {
  return {
    id,
    filamentId: 1,
    initialWeight: null,
    spoolWeight: null,
    usedWeight: 0,
    price: null,
    location,
    lotNr: null,
    comment: null,
    archived,
    extra: {},
    registeredAt: 0,
    firstUsedAt: null,
    lastUsedAt: null,
  }
}
