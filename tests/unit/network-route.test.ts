import { afterEach, describe, expect, test, vi } from 'vitest'
import type { TransactionSql } from 'postgres'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/network-guard.ts'
import { farmNetwork } from '../../apps/farm/server/services/farm-network.ts'
import {
  recordDiscoveries,
  type FarmNetworkReader,
} from '../../apps/farm/server/storage/postgres-farm-network.ts'
import type { FarmRole } from '../../apps/farm/server/utils/network-projection.ts'
import type { AuthRuntime } from '../../apps/farm/server/utils/auth/runtime.ts'
import { serveTestServer, type TestServer } from './serve.ts'

vi.mock('../../apps/farm/server/services/authenticated-session.ts', () => ({
  authResponse: (event: { res: { headers: Headers } }) =>
    event.res.headers.set('Cache-Control', 'no-store'),
  authenticatedSession: vi.fn(),
  sealedSessionRecordId: async (event: { req: Request }) => {
    if (!event.req.headers.get('cookie'))
      throw Object.assign(new Error('Entre novamente.'), { status: 401 })
    return 'network-session'
  },
}))

const farmId = '11111111-1111-4111-8111-111111111111'
const otherFarmId = '22222222-2222-4222-8222-222222222222'
const agentId = '33333333-3333-4333-8333-333333333333'
const now = 1_700_000_100_000
const auth = { idleTimeoutMs: 100 } as unknown as AuthRuntime
const SECRET_HOST = '192.168.50.77'
const SECRET_SERIAL = 'SN-SECRET-0001'

const health = {
  connector: {
    version: '1.2.3',
    uptimeMs: 5000,
    queueBacklog: 2,
    storage: 'healthy',
    rtcScope: 'lan',
    leaked: 'drop-me',
  },
  printers: [
    {
      printerKey: 'printer-1',
      state: 'connected',
      lastSuccessAt: now - 1000,
      p50Ms: 20,
      p95Ms: 80,
      reconnects: 1,
      lastErrorCode: null,
    },
  ],
}
const discovery = [
  {
    vendor: 'moonraker',
    host: SECRET_HOST,
    port: 7125,
    serial: SECRET_SERIAL,
    model: 'Voron',
    name: 'Mesa 1',
    firstSeen: now - 5000,
    lastSeen: now - 1000,
    adopted: false,
  },
]

const rows = (role: FarmRole, over: Record<string, unknown> = {}) => ({
  ok: true as const,
  role,
  connectors: [
    {
      agentId,
      fingerprint: 'fp-1',
      status: 'approved' as const,
      lastSeenAt: now - 1000,
      health,
    },
  ],
  printers: [
    {
      assignmentId: '44444444-4444-4444-8444-444444444444',
      agentId,
      printerKey: 'printer-1',
      displayName: 'Mesa 1',
    },
    {
      assignmentId: '55555555-5555-4555-8555-555555555555',
      agentId,
      printerKey: 'printer-2',
      displayName: null,
    },
  ],
  discoveries: [{ agentId, observedAt: now - 1000, printers: discovery }],
  ...over,
})

/** In-process reader: only `memberOf` farms are visible, with the member's role. */
function reader(role: FarmRole, over: Record<string, unknown> = {}) {
  const read = vi.fn<FarmNetworkReader['read']>(async (input) =>
    input.farmId === farmId
      ? rows(role, over)
      : { ok: false, reason: 'forbidden' },
  )
  return { read }
}

let server: TestServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

/** Serves the handler on 127.0.0.1 port 0; thrown errors become statuses. */
async function serve(r: FarmNetworkReader) {
  server = await withNetworkGuard(() =>
    serveTestServer(async (request) => {
      const farm = new URL(request.url).pathname.split('/')[3] ?? ''
      const event = {
        req: request,
        res: { headers: new Headers() },
      } as Parameters<typeof farmNetwork>[0]
      try {
        const body = await farmNetwork(event, farm, { auth, reader: r })
        const headers = new Headers(event.res.headers)
        headers.set('content-type', 'application/json')
        return new Response(JSON.stringify(body), { headers })
      } catch (error) {
        const { status = 500 } = error as { status?: number }
        return new Response(JSON.stringify({ status }), { status })
      }
    }),
  )
  return (
    farm: string,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) =>
    fetch(`${server!.url.origin}/api/farms/${farm}/network`, {
      ...(init.method && { method: init.method }),
      headers: { cookie: 'session=x', ...init.headers },
    })
}

describe('farm network route', () => {
  test.each(['owner', 'admin'] as const)(
    '%s sees host, port and serial of discovered printers',
    async (role) => {
      const get = await serve(reader(role))
      const response = await get(farmId)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-store')
      const body = await response.json()
      expect(body.discovered).toEqual([
        expect.objectContaining({
          agentId,
          vendor: 'moonraker',
          host: SECRET_HOST,
          port: 7125,
          serial: SECRET_SERIAL,
          adopted: false,
        }),
      ])
    },
  )

  test.each(['operator', 'viewer'] as const)(
    '%s never receives addresses or serials',
    async (role) => {
      const get = await serve(reader(role))
      const response = await get(farmId)
      expect(response.status).toBe(200)
      const text = await response.text()
      for (const secret of [SECRET_HOST, SECRET_SERIAL, '7125', '"host"'])
        expect(text).not.toContain(secret)
      const body = JSON.parse(text)
      expect(body.discovered).toEqual([
        expect.objectContaining({ vendor: 'moonraker', name: 'Mesa 1' }),
      ])
      expect(body.discovered[0]).not.toHaveProperty('host')
      expect(body.discovered[0]).not.toHaveProperty('serial')
      expect(body.discovered[0]).not.toHaveProperty('port')
    },
  )

  test('lists Connectors with health and bound printers with link health', async () => {
    const get = await serve(reader('viewer'))
    const body = await (await get(farmId)).json()
    expect(body.connectors).toEqual([
      {
        agentId,
        fingerprint: 'fp-1',
        status: 'approved',
        lastSeenAt: now - 1000,
        health: {
          version: '1.2.3',
          uptimeMs: 5000,
          queueBacklog: 2,
          storage: 'healthy',
          rtcScope: 'lan',
        },
      },
    ])
    expect(body.printers).toEqual([
      expect.objectContaining({
        printerKey: 'printer-1',
        displayName: 'Mesa 1',
        link: expect.objectContaining({ state: 'connected', p95Ms: 80 }),
      }),
      expect.objectContaining({
        printerKey: 'printer-2',
        displayName: null,
        link: null,
      }),
    ])
  })

  test('a Connector that never reported keeps null health; corrupt stored data is dropped', async () => {
    const get = await serve(
      reader('owner', {
        connectors: [
          {
            agentId,
            fingerprint: 'fp-1',
            status: 'pending',
            lastSeenAt: null,
            health: null,
          },
        ],
        discoveries: [
          { agentId, observedAt: now, printers: [{ host: 'not-an-ip' }] },
        ],
      }),
    )
    const body = await (await get(farmId)).json()
    expect(body.connectors[0]).toMatchObject({ lastSeenAt: null, health: null })
    expect(body.printers.every((p: { link: unknown }) => p.link === null)).toBe(
      true,
    )
    expect(body.discovered).toEqual([])
  })

  test('refuses cross-farm access without revealing the farm', async () => {
    const r = reader('owner')
    const get = await serve(r)
    const response = await get(otherFarmId)
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain(SECRET_HOST)
    expect(r.read).toHaveBeenCalledWith(
      expect.objectContaining({ farmId: otherFarmId }),
    )
  })

  test('rejects missing session, bad farm id and non-GET methods', async () => {
    const r = reader('owner')
    const get = await serve(r)
    expect(
      (await fetch(`${server!.url.origin}/api/farms/${farmId}/network`)).status,
    ).toBe(401)
    expect((await get('not-a-uuid')).status).toBe(400)
    expect((await get(farmId, { method: 'POST' })).status).toBe(405)
    expect(r.read).not.toHaveBeenCalled()
  })

  test('maps storage failures to 503', async () => {
    const get = await serve({
      read: async () => ({ ok: false, reason: 'storage-unavailable' }),
    })
    expect((await get(farmId)).status).toBe(503)
  })
})

describe('discovery storage', () => {
  const event = (n: number, host: string) => ({
    eventId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    queuedAt: n,
    kind: 'discovery' as const,
    discovery: [{ ...discovery[0], host, vendor: 'moonraker' as const }],
  })
  const fakeTx = () => {
    const calls: unknown[][] = []
    const tx = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push([strings.join('?'), ...values])
        return Promise.resolve([])
      },
      { json: (value: unknown) => value },
    )
    return { tx: tx as unknown as TransactionSql, calls }
  }

  test('stores only the newest report of a batch, replacing the set', async () => {
    const { tx, calls } = fakeTx()
    await recordDiscoveries(tx, { farmId, agentId }, [
      event(5, '10.0.0.5'),
      event(9, '10.0.0.9'),
      event(7, '10.0.0.7'),
    ] as never)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toContain('ON CONFLICT (farm_id, agent_id) DO UPDATE')
    expect(calls[0]?.[0]).toContain('observed_at < EXCLUDED.observed_at')
    expect(calls[0]).toContain(9)
  })

  test('writes nothing when the batch has no discovery report', async () => {
    const { tx, calls } = fakeTx()
    await recordDiscoveries(tx, { farmId, agentId }, [])
    expect(calls).toHaveLength(0)
  })
})
