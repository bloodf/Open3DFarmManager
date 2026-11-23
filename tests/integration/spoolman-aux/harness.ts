// Shared fixture for the Spoolman auxiliary API integration tests (#545).
//
// scripts/test-spoolman-aux-api.mjs starts one disposable PostgreSQL container,
// applies the migrations, creates the runtime login role and exports its
// location in the environment. Each test file builds one farm-scoped harness
// from that: the real PostgreSQL storage, the real legacy handler and a
// loopback HTTP server shaped like apps/farm/server/routes/spoolman/[...path].ts.
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres, { type Sql } from 'postgres'
import { PostgresSpoolLibrary } from '../../../apps/farm/server/storage/postgres-spool-library.ts'
import { classifyLegacyBody } from '../../../apps/farm/server/utils/spool-library/legacy-api/body.ts'
import type { LegacyApiModule } from '../../../apps/farm/server/utils/spool-library/legacy-handler.ts'
import {
  LEGACY_API_MODULES,
  handleLegacyRequest,
} from '../../../apps/farm/server/utils/spool-library/legacy-handler.ts'

export interface CallResult {
  status: number
  body: any
  text: string
  headers: Record<string, string>
}

export interface Harness {
  admin: Sql
  /** Raw HTTP base, for requests that must not carry a credential path. */
  farms: string[]
  /** Legacy credential token of `access` for farm index `farm`. */
  token(farm: number, access: 'read' | 'write'): string
  call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
    options?: { raw?: string; contentType?: string },
  ): Promise<CallResult>
  close(): Promise<void>
}

const env = (name: string): string => {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} is not set: run node scripts/test-spoolman-aux-api.mjs`,
    )
  return value
}

export async function startHarness(
  farmCount = 2,
  modules: readonly LegacyApiModule[] = LEGACY_API_MODULES,
  runtimeRole: string = env('AUX_PG_ROLE'),
): Promise<Harness> {
  const port = Number(env('AUX_PG_PORT'))
  const connect = (username: string) =>
    postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username,
      password: env('AUX_PG_PASSWORD'),
      ssl: false,
      max: 4,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { search_path: 'pg_catalog' },
    })
  const admin = connect('fixture')
  const runtime = connect(runtimeRole)
  const clock = Date.UTC(2026, 10, 21, 8, 0, 0)
  const store = new PostgresSpoolLibrary(runtime, () => clock)

  const farms: string[] = []
  const tokens = new Map<string, string>()
  for (let i = 0; i < farmCount; i++) {
    const farm = randomUUID()
    const account = `acc-${farm}`
    const session = `session-${farm}`
    farms.push(farm)
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${session}, ${account}, 0, ${clock}, ${clock}, ${clock + 86_400_000})`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${account}, 'owner')`
    for (const access of ['read', 'write'] as const) {
      const issued = await store.issueLegacyCredential({
        sessionRecordId: session,
        policy: { idleTimeoutMs: 1e12 },
        farmId: farm,
        label: `${access}-${i}`,
        access,
      })
      if (!issued.ok) throw new Error(`credential: ${issued.reason}`)
      tokens.set(`${i}:${access}`, issued.value.token)
    }
  }

  const server: Server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const url = req.url ?? '/'
    const at = url.indexOf('?')
    let raw: string | undefined
    if (['POST', 'PATCH', 'PUT'].includes(req.method ?? '')) {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      raw = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
    }
    const result = await handleLegacyRequest(
      store,
      {
        method: req.method ?? 'GET',
        pathname: at === -1 ? url : url.slice(0, at),
        query: new URLSearchParams(at === -1 ? '' : url.slice(at + 1)),
        body: classifyLegacyBody(raw, req.headers['content-type']),
      },
      modules,
    )
    res.statusCode = result.status
    for (const [k, v] of Object.entries(result.headers ?? {}))
      res.setHeader(k, v)
    if (!res.hasHeader('content-type'))
      res.setHeader('Content-Type', 'application/json')
    res.end(
      typeof result.body === 'string'
        ? result.body
        : JSON.stringify(result.body),
    )
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    admin,
    farms,
    token(farm, access) {
      const token = tokens.get(`${farm}:${access}`)
      if (!token) throw new Error('unknown credential')
      return token
    },
    async call(token, method, path, body, options) {
      const headers: Record<string, string> = {}
      const payload =
        options?.raw ?? (body === undefined ? undefined : JSON.stringify(body))
      if (payload !== undefined)
        headers['Content-Type'] = options?.contentType ?? 'application/json'
      const response = await fetch(`${base}/spoolman/${token}${path}`, {
        method,
        headers,
        body: payload ?? null,
      })
      const text = await response.text()
      let parsed: any = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // Not JSON: keep the text (CSV, plain 500).
      }
      return {
        status: response.status,
        body: parsed,
        text,
        headers: Object.fromEntries(response.headers.entries()),
      }
    },
    async close() {
      await new Promise((done) => server.close(done))
      await runtime.end({ timeout: 3 })
      await admin.end({ timeout: 3 })
    },
  }
}

/** Seed one vendor, filament and spool through the HTTP API; returns their ids. */
export async function seedInventory(
  h: Harness,
  token: string,
  tag: string,
  spool: Record<string, unknown> = {},
) {
  const vendor = await h.call(token, 'POST', '/api/v1/vendor', {
    name: `${tag} Vendor`,
    comment: `${tag} vendor note`,
  })
  const filament = await h.call(token, 'POST', '/api/v1/filament', {
    name: `${tag} PETG`,
    vendor_id: vendor.body.id,
    material: 'PETG',
    density: 1.27,
    diameter: 1.75,
    weight: 1000,
    article_number: `ART-${tag}`,
    color_hex: 'FF0000',
  })
  const created = await h.call(token, 'POST', '/api/v1/spool', {
    filament_id: filament.body.id,
    ...spool,
  })
  return { vendor: vendor.body, filament: filament.body, spool: created.body }
}
