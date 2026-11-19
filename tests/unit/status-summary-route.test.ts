import { afterEach, describe, expect, test, vi } from 'vitest'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import {
  STATUS_SUMMARY_MAX_PRINTERS,
  statusSummary,
  type StatusSummary,
} from '../../apps/farm/server/services/status-summary.ts'
import type { PrinterStateReader } from '../../apps/farm/server/utils/printer-states/runtime.ts'
import type { PrinterStateRow } from '../../apps/farm/server/services/printer-states-core.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { serveTestServer, type TestServer } from './serve.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: (event: { res: { headers: Headers } }) =>
    event.res.headers.set('Cache-Control', 'no-store'),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: async (event: { req: Request }) => {
    if (!event.req.headers.get('cookie'))
      throw Object.assign(new Error('Entre novamente.'), { status: 401 })
    return 'summary-session'
  },
}))

const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarmId = '22222222-2222-4222-8222-222222222222'
const now = 1_700_000_100_000
const auth = { idleTimeoutMs: 100 } as unknown as AuthRuntime

const row = (
  n: number,
  over: Partial<PrinterStateRow> = {},
): PrinterStateRow => ({
  assignmentId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  printerKey: `printer-${n}`,
  displayName: `Mesa ${n}`,
  groupName: n % 2 ? 'A' : 'B',
  location: null,
  sortOrder: 0,
  state: n % 3 ? 'idle' : 'printing',
  progress: undefined,
  toolTemperatureCelsius: undefined,
  bedTemperatureCelsius: undefined,
  observedAt: now - 5_000,
  ...over,
})

/** In-process reader: only `memberOf` farms are visible, like the projection. */
function reader(rows: PrinterStateRow[], memberOf = [farmId]) {
  const list = vi.fn<PrinterStateReader['list']>(async (input) =>
    memberOf.includes(input.farmId)
      ? { ok: true, states: rows }
      : { ok: false, reason: 'forbidden' },
  )
  return { list }
}

let server: TestServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

/** Serves the route handler on 127.0.0.1 port 0; thrown errors become statuses. */
async function serve(r: PrinterStateReader) {
  server = await withNetworkGuard(() =>
    serveTestServer(async (request) => {
      const farm = new URL(request.url).pathname.split('/')[3] ?? ''
      const event = {
        req: request,
        res: { headers: new Headers() },
      } as Parameters<typeof statusSummary>[0]
      try {
        const body = await statusSummary(event, farm, {
          auth,
          reader: r,
          clock: () => now,
        })
        if (body instanceof Response) {
          const headers = new Headers(event.res.headers)
          body.headers.forEach((v, k) => headers.set(k, v))
          return new Response(null, { status: body.status, headers })
        }
        const headers = new Headers(event.res.headers)
        headers.set('content-type', 'application/json')
        return new Response(JSON.stringify(body), { headers })
      } catch (error) {
        const { status = 500 } = error as { status?: number }
        return new Response(JSON.stringify({ status }), { status })
      }
    }),
  )
  return (farm: string, headers: Record<string, string> = {}) =>
    fetch(`${server!.url.origin}/api/farms/${farm}/status-summary`, {
      headers: { cookie: 'session=x', ...headers },
    })
}

describe('status summary route', () => {
  test('returns counts and latest state with grouping and data age', async () => {
    const get = await serve(
      reader([
        row(2, { state: 'error', observedAt: now - 60_000 }),
        row(1, { location: 'Sala 1' }),
      ]),
    )
    const response = await get(farmId)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(response.headers.get('etag')).toMatch(/^W\/"/)
    const body = (await response.json()) as StatusSummary
    expect(body).toMatchObject({
      total: 2,
      truncated: false,
      counts: { idle: 1, error: 1 },
    })
    expect(body.printers).toEqual([
      expect.objectContaining({
        displayName: 'Mesa 1',
        groupName: 'A',
        location: 'Sala 1',
        state: 'idle',
        dataAgeMs: 5_000,
      }),
      expect.objectContaining({ displayName: 'Mesa 2', dataAgeMs: 60_000 }),
    ])
  })

  test('unchanged data answers 304 even when the age moved', async () => {
    const get = await serve(reader([row(1)]))
    const etag = (await get(farmId)).headers.get('etag')!
    const same = await get(farmId, { 'if-none-match': etag })
    expect(same.status).toBe(304)
    expect(await same.text()).toBe('')
    expect((await get(farmId, { 'if-none-match': '*' })).status).toBe(304)
    expect((await get(farmId, { 'if-none-match': 'W/"other"' })).status).toBe(
      200,
    )
  })

  test('a changed state changes the tag', async () => {
    const a = await serve(reader([row(1)]))
    const first = (await a(farmId)).headers.get('etag')
    await server?.stop()
    const b = await serve(reader([row(1, { state: 'error' })]))
    expect((await b(farmId)).headers.get('etag')).not.toBe(first)
  })

  test('response stays bounded for 500 printers and for more', async () => {
    const rows = Array.from({ length: 500 }, (_, n) => row(n + 1))
    const get = await serve(reader(rows))
    const text = await (await get(farmId)).text()
    const body = JSON.parse(text) as StatusSummary
    expect(body.printers).toHaveLength(500)
    expect(body.truncated).toBe(false)
    expect(text.length).toBeLessThan(200_000)
    await server?.stop()
    const big = await serve(
      reader(Array.from({ length: 700 }, (_, n) => row(n + 1))),
    )
    const capped = (await (await big(farmId)).json()) as StatusSummary
    expect(capped.printers).toHaveLength(STATUS_SUMMARY_MAX_PRINTERS)
    expect(capped).toMatchObject({ total: 700, truncated: true })
  })

  test('another farm is refused as an unknown farm and never leaks rows', async () => {
    const stub = reader([row(1)])
    const get = await serve(stub)
    const denied = await get(otherFarmId)
    expect(denied.status).toBe(404)
    expect(await denied.text()).not.toContain('printer-1')
    expect((await get('not-a-uuid')).status).toBe(400)
    expect(stub.list).toHaveBeenCalledTimes(1)
  })

  test('requires a session and only accepts GET', async () => {
    const get = await serve(reader([row(1)]))
    const anonymous = await fetch(
      `${server!.url.origin}/api/farms/${farmId}/status-summary`,
    )
    expect(anonymous.status).toBe(401)
    const post = await fetch(
      `${server!.url.origin}/api/farms/${farmId}/status-summary`,
      { method: 'POST', headers: { cookie: 'session=x' } },
    )
    expect(post.status).toBe(405)
    expect((await get(farmId)).status).toBe(200)
  })
})
