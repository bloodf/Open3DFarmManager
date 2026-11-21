import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createConfiguredExternalModule } from '../../../apps/farm/server/utils/spool-library/legacy-api/external-config.ts'
import {
  LEGACY_API_MODULES,
  type LegacyApiModule,
} from '../../../apps/farm/server/utils/spool-library/legacy-handler.ts'
import { validateSpoolLibraryRole } from '../../../apps/farm/server/utils/spool-library/role-policy.ts'
import { startHarness, type Harness } from './harness.ts'

const fixture = (name: string) =>
  readFileSync(
    new URL(`../../fixtures/spoolman/aux/${name}`, import.meta.url),
    'utf8',
  )
const inventory = JSON.parse(
  readFileSync(
    new URL(
      '../../../docs/compatibility/spoolman-endpoint-inventory.json',
      import.meta.url,
    ),
    'utf8',
  ),
)

describe('external filament library', () => {
  let catalog: Server
  let requests: string[] = []
  let h: Harness
  let token: string
  before(async () => {
    catalog = createServer((req, res) => {
      requests.push(
        `${req.method} ${req.url} auth=${req.headers.authorization ?? 'none'}`,
      )
      const name = (req.url ?? '').replace(/^\//, '')
      if (name !== 'filaments.json' && name !== 'materials.json') {
        res.statusCode = 404
        return res.end()
      }
      res.setHeader('content-type', 'application/json')
      res.end(fixture(name))
    })
    await new Promise<void>((done) => catalog.listen(0, '127.0.0.1', done))
    const url = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}/`
    const external = createConfiguredExternalModule({
      SPOOLMAN_EXTERNAL_DB_URL: url,
    })
    const modules: LegacyApiModule[] = [
      ...LEGACY_API_MODULES.filter((m) => m.name !== 'external-filament'),
      external,
    ]
    h = await startHarness(2, modules)
    token = h.token(0, 'read')
  })
  after(async () => {
    await h.close()
    await new Promise((done) => catalog.close(done))
  })

  it('is registered in the default module list', () => {
    assert.ok(LEGACY_API_MODULES.some((m) => m.name === 'external-filament'))
  })

  it('answers 500 before the first sync, then serves the synced catalog', async () => {
    const first = await h.call(token, 'GET', '/api/v1/external/filament')
    assert.equal(first.status, 500)
    let ready = first
    for (let i = 0; i < 50 && ready.status !== 200; i++) {
      await new Promise((done) => setTimeout(done, 50))
      ready = await h.call(token, 'GET', '/api/v1/external/filament')
    }
    assert.equal(ready.status, 200)
    assert.deepEqual(
      ready.body.map((f: any) => f.id),
      ['acme_petg_blue_1000_175_n', 'acme_pla_red_1000_175_n'],
    )
    assert.ok(ready.headers['etag'])
    assert.ok(
      requests.length >= 2 &&
        requests.every((line) => line.endsWith('auth=none')),
      'no credential is forwarded',
    )

    const search = await h.call(
      token,
      'GET',
      '/api/v1/external/filament/search?query=acme%20petg',
    )
    assert.equal(search.status, 200)
    assert.equal(search.headers['x-total-count'], '1')
    assert.equal(search.body[0].name, 'Blue')

    const materials = await h.call(token, 'GET', '/api/v1/external/material')
    assert.equal(materials.status, 200)
    assert.deepEqual(materials.body, [
      { material: 'PLA', density: 1.24, extruder_temp: 210, bed_temp: 60 },
      { material: 'PETG', density: 1.27, extruder_temp: 240, bed_temp: 80 },
      { material: 'Nylon', density: 1.14 },
    ])
    assert.equal(
      (await h.call(token, 'POST', '/api/v1/external/material')).status,
      405,
    )
    const bad = await h.call(token, 'GET', '/api/v1/external/filament/search')
    assert.equal(bad.status, 422)
  })

  it('without a configured library the endpoints answer as upstream does before a sync', async () => {
    const bare = await startHarness(1)
    try {
      const t = bare.token(0, 'read')
      assert.equal(
        (await bare.call(t, 'GET', '/api/v1/external/filament')).status,
        500,
      )
      assert.equal(
        (await bare.call(t, 'GET', '/api/v1/external/material')).status,
        500,
      )
      const search = await bare.call(
        t,
        'GET',
        '/api/v1/external/filament/search?query=acme',
      )
      assert.deepEqual(search.body, [])
      assert.equal(search.headers['x-total-count'], '0')
    } finally {
      await bare.close()
    }
  })
})

describe('every pinned HTTP route', () => {
  let h: Harness
  let token: string
  before(async () => {
    h = await startHarness(1)
    token = h.token(0, 'write')
  })
  after(() => h.close())

  /** Tag linking has no storage yet (no tag table in migration 0089). */
  const UNSERVED = new Set([
    'POST /api/v1/filament/{filament_id}/tag',
    'DELETE /api/v1/filament/{filament_id}/tag/{uid}',
    'POST /api/v1/spool/{spool_id}/tag',
    'DELETE /api/v1/spool/{spool_id}/tag/{uid}',
    'POST /api/v1/tag/scan',
  ])
  const SAMPLE: Record<string, string> = {
    entity_type: 'spool',
    key: 'x',
    filament_id: '1',
    spool_id: '1',
    vendor_id: '1',
    uid: '04A2B3C4',
    location: 'Dry%20box',
    field: 'location',
  }

  it('serves every HTTP endpoint of the inventory except the documented tag routes', async () => {
    const http = inventory.endpoints.filter((e: any) => e.transport === 'http')
    assert.ok(http.length >= 45)
    const unserved: string[] = []
    for (const endpoint of http) {
      const path = (endpoint.path as string).replace(
        /\{(\w+)\}/g,
        (_m, name) => SAMPLE[name] ?? '1',
      )
      const response = await h.call(
        token,
        endpoint.method,
        `${path}${path.includes('?') ? '' : '?fmt=json&group_by=material&q=a&query=a'}`,
      )
      const claimed = !(
        response.status === 404 && response.text === '{"message":"Not Found"}'
      )
      if (!claimed) unserved.push(endpoint.id)
      assert.notEqual(response.status, 401, endpoint.id)
      assert.notEqual(response.status, 503, endpoint.id)
    }
    assert.deepEqual(new Set(unserved), UNSERVED)
  })
})

describe('runtime role', () => {
  it('without farm_spool_features the registry and settings cannot be written, reads still work', async () => {
    const probe = await startHarness(1)
    const role = 'spoolman_aux_plain_' + randomUUID().replaceAll('-', '')
    await probe.admin`CREATE ROLE ${probe.admin(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE farm_spool_library`
    // Credentials come from the probe's farm; the plain role serves them.
    const plain = await startHarnessFor(probe, role)
    try {
      const t = probe.token(0, 'write')
      assert.equal(
        (await plain.call(t, 'GET', '/api/v1/setting/currency')).status,
        200,
      )
      assert.equal(
        (await plain.call(t, 'GET', '/api/v1/field/spool')).status,
        200,
      )
      const write = await plain.call(
        t,
        'POST',
        '/api/v1/setting/currency',
        undefined,
        { raw: JSON.stringify('"USD"') },
      )
      assert.equal(write.status, 503)
      assert.deepEqual(write.body, { message: 'Service Unavailable' })
      const field = await plain.call(t, 'POST', '/api/v1/field/spool/x', {
        name: 'X',
        field_type: 'text',
      })
      assert.equal(field.status, 503)
      // Location renames need only the spool library's own grants.
      assert.equal(
        (await plain.call(t, 'PATCH', '/api/v1/location/a', { name: 'b' }))
          .status,
        200,
      )
      await validateSpoolLibraryRole(plain.runtimeSql)
    } finally {
      await plain.close()
      await probe.close()
    }
  })
})

/** Serve the probe's farms through a runtime connection using `role`. */
async function startHarnessFor(probe: Harness, role: string) {
  const postgres = (await import('postgres')).default
  const { PostgresSpoolLibrary } =
    await import('../../../apps/farm/server/storage/postgres-spool-library.ts')
  const { handleLegacyRequest } =
    await import('../../../apps/farm/server/utils/spool-library/legacy-handler.ts')
  const { classifyLegacyBody } =
    await import('../../../apps/farm/server/utils/spool-library/legacy-api/body.ts')
  const runtimeSql = postgres({
    host: '127.0.0.1',
    port: Number(process.env['AUX_PG_PORT']),
    database: 'fixture',
    username: role,
    password: '',
    ssl: false,
    max: 2,
    onnotice: () => {},
    connection: { search_path: 'pg_catalog' },
  })
  void probe
  const store = new PostgresSpoolLibrary(runtimeSql, () =>
    Date.UTC(2026, 10, 21, 8, 0, 0),
  )
  return {
    runtimeSql,
    async call(
      token: string,
      method: string,
      path: string,
      body?: unknown,
      options?: { raw?: string },
    ) {
      const raw =
        options?.raw ?? (body === undefined ? undefined : JSON.stringify(body))
      const result = await handleLegacyRequest(store, {
        method,
        pathname: `/spoolman/${token}${path}`,
        body: classifyLegacyBody(raw, 'application/json'),
      })
      return { status: result.status, body: result.body as any }
    },
    close: () => runtimeSql.end({ timeout: 3 }),
  }
}
