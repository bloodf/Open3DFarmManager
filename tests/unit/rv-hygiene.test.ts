// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { loadSlotBindings } from '../../apps/farm/app/utils/slot-bindings-load.ts'
import { findSpoolsByIds } from '../../apps/farm/server/utils/spool-library/legacy-api/spool.ts'
import type { SpoolLibraryRepository } from '../../apps/farm/server/utils/spool-library/scope.ts'
import { MAX_SPOOL_IDS } from '../../apps/farm/common/spool-ids.ts'

const assignment = (spoolId: number, unassignedAt: number | null = null) => ({
  id: `a${spoolId}`,
  spoolId,
  printerId: `printer-${spoolId}`,
  slotKind: 'ams' as const,
  slotIndex: 0,
  assignedAt: 1,
  unassignedAt,
})

function stubApi(assignments: ReturnType<typeof assignment>[]) {
  const calls: { url: string; query: unknown }[] = []
  vi.stubGlobal(
    '$fetch',
    async (url: string, options: { query?: Record<string, unknown> }) => {
      calls.push({ url, query: options.query })
      if (url.endsWith('/slots')) return { assignments }
      const ids = String((options.query as { ids?: string } | undefined)?.ids)
        .split(',')
        .map(Number)
      return {
        items: ids.map((id) => ({
          id,
          archived: false,
          remaining_weight: id,
          initial_weight: 1000,
          filament: {},
        })),
      }
    },
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assigned-slot spool fetch', () => {
  test('requests only the actively assigned spool ids', async () => {
    const calls = stubApi([
      assignment(9),
      assignment(4),
      assignment(7, 2),
      { ...assignment(9), printerId: 'printer-other' },
    ])
    const index = await loadSlotBindings('farm', new AbortController().signal)
    expect(calls).toEqual([
      { url: '/api/farms/farm/spool-library/slots', query: undefined },
      { url: '/api/farms/farm/spool-library/spools', query: { ids: '4,9' } },
    ])
    expect(index.get('printer-4')?.get('ams:0')?.remainingGrams).toBe(4)
    expect(index.has('printer-7')).toBe(false)
  })

  test('requests no spool without an active assignment', async () => {
    const calls = stubApi([assignment(7, 2)])
    await loadSlotBindings('farm', new AbortController().signal)
    expect(calls.map((call) => call.url)).toEqual([
      '/api/farms/farm/spool-library/slots',
    ])
  })

  test('splits many assignments into bounded batches', async () => {
    const count = MAX_SPOOL_IDS + 1
    const calls = stubApi(
      Array.from({ length: count }, (_, i) => assignment(i + 1)),
    )
    const index = await loadSlotBindings('farm', new AbortController().signal)
    expect(
      calls
        .slice(1)
        .map(
          (call) =>
            String((call.query as { ids: string }).ids).split(',').length,
        ),
    ).toEqual([MAX_SPOOL_IDS, 1])
    expect(index.size).toBe(count)
  })
})

describe('spool ids filter', () => {
  function repository() {
    const read: string[] = []
    const scan = async () => {
      throw new Error('The ids filter must not scan the library')
    }
    const spools = new Map(
      [
        { id: 1, archived: false },
        { id: 2, archived: true },
        { id: 3, archived: false },
      ].map((spool) => [
        spool.id,
        {
          ...spool,
          filamentId: 5,
          usedWeight: 0,
          extra: {},
          registeredAt: 0,
          firstUsedAt: null,
          lastUsedAt: null,
        },
      ]),
    )
    const found = (value: unknown) =>
      value ? { ok: true, value } : { ok: false, reason: 'not-found' }
    const repo = {
      spools: {
        list: scan,
        async get(id: number) {
          read.push(`spool:${id}`)
          return found(spools.get(id))
        },
      },
      filaments: {
        list: scan,
        async get(id: number) {
          read.push(`filament:${id}`)
          return found({
            id,
            vendorId: null,
            density: 1.24,
            diameter: 1.75,
            weight: 1000,
            extra: {},
            registeredAt: 0,
          })
        },
      },
      vendors: { list: scan, get: scan },
    } as unknown as SpoolLibraryRepository
    return { repo, read }
  }

  test('reads only the named records and skips archived and unknown', async () => {
    const { repo, read } = repository()
    const result = await findSpoolsByIds(repo, '3,2,99,1,3')
    expect(result).toMatchObject({
      ok: true,
      value: { status: 200, body: [{ id: 3 }, { id: 1 }] },
    })
    expect(read).toEqual([
      'spool:3',
      'filament:5',
      'spool:2',
      'spool:99',
      'spool:1',
    ])
  })

  test.each([
    '',
    '0',
    '-1',
    '1,,2',
    '1.5',
    '9007199254740993',
    Array.from({ length: MAX_SPOOL_IDS + 1 }, (_, i) => i + 1).join(','),
  ])('refuses the id list %j without reading', async (raw) => {
    const { repo, read } = repository()
    expect(await findSpoolsByIds(repo, raw)).toMatchObject({
      ok: true,
      value: { status: 422 },
    })
    expect(read).toEqual([])
  })
})

describe('client and server boundary', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const app = join(root, 'apps/farm/app')
  const server = join(root, 'apps/farm/server')

  const sources = readdirSync(app, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(?:ts|mjs|js|vue)$/.test(file))
    .map((file) => {
      const path = join(app, file)
      return { path, text: readFileSync(path, 'utf8') }
    })

  test('no app file imports apps/farm/server', () => {
    expect(sources.length).toBeGreaterThan(100)
    const offenders = sources.flatMap(({ path, text }) =>
      Array.from(
        text.matchAll(/(?:\bfrom|\bimport\s*\(?)\s*['"]([^'"]+)['"]/g),
        (match) => match[1]!,
      )
        .filter(
          (specifier) =>
            /^(?:~~|@@)\/server\/|^#server\//.test(specifier) ||
            (specifier.startsWith('.') &&
              !relative(server, resolve(dirname(path), specifier)).startsWith(
                '..',
              )),
        )
        .map((specifier) => `${relative(root, path)}: ${specifier}`),
    )
    expect(offenders).toEqual([])
  })

  test('no app file carries the Node component compiler', () => {
    expect(
      sources
        .filter(({ text }) => text.includes('vue/compiler-sfc'))
        .map(({ path }) => relative(root, path)),
    ).toEqual([])
  })
})
