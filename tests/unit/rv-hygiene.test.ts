// SPDX-License-Identifier: AGPL-3.0-or-later
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { z } from 'zod'
import {
  loadSlotBindings,
  SPOOL_REQUEST_CONCURRENCY,
} from '../../apps/farm/app/utils/slot-bindings-load.ts'
import { resinLedgerEntry as clientEntry } from '../../apps/farm/common/resin-ledger/entry.ts'
import type * as ClientSummary from '../../apps/farm/common/resin-ledger/summary-types.ts'
import { resinLedgerEntry as serverEntry } from '../../apps/farm/server/utils/resin-ledger/entry.ts'
import type * as ServerSummary from '../../apps/farm/server/utils/resin-ledger/summary.ts'

const assignment = (spoolId: number, unassignedAt: number | null = null) => ({
  id: `a${spoolId}`,
  spoolId,
  printerId: `printer-${spoolId}`,
  slotKind: 'ams' as const,
  slotIndex: 0,
  assignedAt: 1,
  unassignedAt,
})

const api = '/api/farms/farm/spool-library'

function stubApi(
  assignments: ReturnType<typeof assignment>[],
  failures: Record<number, number> = {},
) {
  const urls: string[] = []
  const flight = { now: 0, most: 0 }
  vi.stubGlobal('$fetch', async (url: string) => {
    urls.push(url)
    if (url === `${api}/slots`) return { assignments }
    const id = Number(url.slice(`${api}/spools/`.length))
    flight.most = Math.max(flight.most, ++flight.now)
    await Promise.resolve()
    flight.now--
    const statusCode = failures[id]
    if (statusCode)
      throw Object.assign(new Error('Request failed'), { statusCode })
    return {
      item: {
        id,
        archived: false,
        remaining_weight: id,
        initial_weight: 1000,
        filament: {},
      },
    }
  })
  return { urls, flight }
}

const load = () => loadSlotBindings('farm', new AbortController().signal)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assigned-slot spool fetch', () => {
  test('requests only the actively assigned spool ids', async () => {
    const { urls } = stubApi([
      assignment(9),
      assignment(4),
      assignment(7, 2),
      { ...assignment(9), printerId: 'printer-other' },
    ])
    const index = await load()
    expect(urls).toEqual([`${api}/slots`, `${api}/spools/9`, `${api}/spools/4`])
    expect(index.get('printer-4')?.get('ams:0')?.remainingGrams).toBe(4)
    expect(index.get('printer-other')?.get('ams:0')?.remainingGrams).toBe(9)
    expect(index.has('printer-7')).toBe(false)
  })

  test('requests no spool without an active assignment', async () => {
    const { urls } = stubApi([assignment(7, 2)])
    await load()
    expect(urls).toEqual([`${api}/slots`])
  })

  test('bounds the requests in flight', async () => {
    const count = SPOOL_REQUEST_CONCURRENCY * 2 + 1
    const { urls, flight } = stubApi(
      Array.from({ length: count }, (_, i) => assignment(i + 1)),
    )
    expect((await load()).size).toBe(count)
    expect(urls).toHaveLength(count + 1)
    expect(flight.most).toBe(SPOOL_REQUEST_CONCURRENCY)
  })

  test('keeps the other bindings when an assigned spool is missing', async () => {
    stubApi([assignment(1), assignment(2)], { 1: 404 })
    expect([...(await load()).keys()]).toEqual(['printer-2'])
  })

  test('reports any other failure', async () => {
    stubApi([assignment(1), assignment(2)], { 1: 503 })
    await expect(load()).rejects.toMatchObject({ statusCode: 503 })
  })
})

describe("the browser's resin ledger copy", () => {
  test('has the same schema as the server', () => {
    expect(z.toJSONSchema(clientEntry)).toEqual(z.toJSONSchema(serverEntry))
  })

  test.each([
    { kind: 'vat', name: '  Cuba  ', source: 'manual' },
    { kind: 'vat', name: '   ', source: 'manual' },
    { kind: 'vat', name: 'x'.repeat(129), source: 'manual' },
    { kind: 'bottle', name: 'A', volumeMl: null, source: 'reported' },
    {
      kind: 'volume',
      target: 'vat',
      name: 'A',
      volumeMl: -1,
      source: 'manual',
    },
    { kind: 'film', layers: 1.5, source: 'manual' },
    { kind: 'lcd', hours: Infinity, source: 'manual' },
    { kind: 'lcd', hours: 2, source: 'manual', extra: true },
  ])('reads %j as the server does', (input) => {
    const client = clientEntry.safeParse(input)
    const server = serverEntry.safeParse(input)
    expect(client.success).toBe(server.success)
    expect(client.data).toEqual(server.data)
  })

  test('has the same summary types as the server', () => {
    expectTypeOf<ClientSummary.ResinLedgerSummary>().toEqualTypeOf<ServerSummary.ResinLedgerSummary>()
    expectTypeOf<ClientSummary.Reading<number>>().toEqualTypeOf<
      ServerSummary.Reading<number>
    >()
  })
})

describe('client and server boundary', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const app = join(root, 'apps/farm/app')
  const server = join(root, 'apps/farm/server')

  const sources = [app, join(root, 'apps/farm/common')].flatMap((directory) =>
    readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(?:ts|mjs|js|vue)$/.test(file))
      .map((file) => {
        const path = join(directory, file)
        return { path, text: readFileSync(path, 'utf8') }
      }),
  )

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
