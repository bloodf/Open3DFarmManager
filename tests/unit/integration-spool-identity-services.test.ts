import {
  hasCurrentSpoolObservation,
  recordInventorySnapshot,
} from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'
import {
  answerApiQuery,
  createSpoolMembershipReader,
} from '../../packages/connector/src/runtime/api-query.ts'
import { ApiQueryRequest } from '../../packages/farm-protocol/src/api-query.ts'
import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'
import { appendFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import postgres from 'postgres'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'
import { registerPhysicalSpool } from '../../apps/farm/server/utils/integration-spool-physical.ts'
import type { Sql, TransactionSql } from 'postgres'
import { expect, test, vi } from 'vitest'
import { parseSpoolmanSpoolInventory } from '../../packages/connector/src/spoolman/read.ts'
import {
  inventoryAt,
  summarizeSpoolman,
} from '../../packages/connector/src/runtime/spool-inventory.ts'
import { listObservedSpools } from '../../apps/farm/server/utils/integration-inventory-spools.ts'
import {
  listIntegrationSpoolUsage,
  searchIntegrationSpools,
  spoolSearchQuery,
  spoolUsageQuery,
} from '../../apps/farm/server/utils/integration-inventory-ledger.ts'

const farmId = '00000000-0000-4000-8000-000000000001'
const connectorA = '00000000-0000-4000-8000-000000000002'
const connectorB = '00000000-0000-4000-8000-000000000003'
const serviceA = '00000000-0000-4000-8000-000000000004'
const serviceB = '00000000-0000-4000-8000-000000000005'

function spoolInventory(
  serviceId: string,
  observedAt: number,
  spoolIds: number[],
) {
  return parseSpoolmanSpoolInventory(
    [
      {
        wire: JSON.stringify(
          spoolIds.map((id) => ({
            id,
            filament: { id: 1, name: 'PLA' },
            archived: false,
          })),
        ),
        offset: 0,
        observedAt,
      },
    ],
    { farmId, serviceId, limit: 100 },
  )
}

function observation(
  serviceId: string,
  connectorId: string,
  index = 0,
  observedAt = 1000,
  spoolIds = [1, 5],
) {
  const inventory = spoolInventory(serviceId, observedAt, spoolIds)
  const summary = summarizeSpoolman({ kind: 'observed', inventory, ageMs: 0 })!
  return {
    farmId,
    connectorId,
    observedAt,
    index,
    snapshot: inventoryAt(summary, 0, observedAt),
  }
}

test('equal numeric IDs are scoped to the service across connector changes and replacement', async () => {
  const sql = vi
    .fn()
    .mockResolvedValue([
      observation(serviceA, connectorA),
      observation(serviceA, connectorA, 1),
      observation(serviceA, connectorB),
      observation(serviceB, connectorB),
    ])
  const page = await listObservedSpools(sql as unknown as Sql, {
    farmIds: [farmId],
    cursor: null,
    limit: 10,
  })
  expect(
    page.data.map(({ serviceId, spoolKey, spool }) => [
      serviceId,
      spoolKey,
      spool.spoolId,
    ]),
  ).toEqual([
    [serviceA, serviceA + ':1', 1],
    [serviceA, serviceA + ':5', 5],
    [serviceA, serviceA + ':1', 1],
    [serviceB, serviceB + ':1', 1],
  ])
  expect(page.data.map(({ spool }) => spool.name)).toEqual([
    'PLA',
    'PLA',
    'PLA',
    'PLA',
  ])
})

test('search and usage expose only explicitly bound provenance even when spool IDs collide', async () => {
  const unbound = { farmId, spoolId: 1, serviceId: null, serviceSpoolId: null }
  const boundA = { farmId, spoolId: 2, serviceId: serviceA, serviceSpoolId: 1 }
  const boundB = { farmId, spoolId: 3, serviceId: serviceB, serviceSpoolId: 1 }
  const sql = vi.fn().mockResolvedValue([unbound, boundA, boundB])
  const search = await searchIntegrationSpools(
    sql as unknown as Sql,
    [farmId],
    spoolSearchQuery(new URLSearchParams())!,
  )
  const usage = await listIntegrationSpoolUsage(
    sql as unknown as Sql,
    [farmId],
    spoolUsageQuery(new URLSearchParams('jobId=42'))!,
  )
  const expected = [
    { farmId, spoolId: 1 },
    { ...boundA, spoolKey: serviceA + ':1' },
    { ...boundB, spoolKey: serviceB + ':1' },
  ]
  expect(search.data).toEqual(expected)
  expect(usage.data).toEqual(expected)
  for (const [statement] of sql.mock.calls) {
    expect(statement.join('')).toContain(
      'integration_physical_spool_registrations',
    )
    expect(statement.join('')).not.toContain('connector_inventory_snapshots')
  }
})

test('registration rejects untrusted snapshot data before allocating or writing a receipt', async () => {
  const observedAt = Date.now()
  const { snapshot } = observation(serviceA, connectorA, 0, observedAt, [1, 99])
  const access = {
    appId: connectorA,
    farmId,
    grantIds: [connectorB],
    scope: 'inventory:write' as const,
  }
  const input = {
    filamentId: 1,
    location: 'A',
    spoolman: { serviceId: serviceA, spoolId: 99 },
  }
  const { snapshot: capped } = observation(
    serviceA,
    connectorA,
    0,
    observedAt,
    [1, 2, 3, 4, 5, 6, 7, 8, 99],
  )
  expect(capped.total).toBe(9)
  expect(capped.spools.map(({ spoolId }) => spoolId)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8,
  ])
  const receivedAt = Date.now()
  const row = { observedAt, receivedAt, snapshot }
  for (const rows of [
    [],
    [{ ...row, snapshot: capped }],
    [{ ...row, snapshot: { ...snapshot, stale: true } }],
    [{ ...row, receivedAt: receivedAt - 30_000 }],
    [{ ...row, receivedAt: null }],
    [{ ...row, observedAt: observedAt - 1 }],
    [{ ...row, snapshot: { ...snapshot, serviceId: undefined } }],
    [{ ...row, snapshot: { ...snapshot, spools: [{ spoolId: 1 }] } }],
    [{ ...row, snapshot: { ...snapshot, serviceId: serviceB } }],
    [
      {
        ...row,
        snapshot: { ...snapshot, spools: snapshot.spools.slice(0, 1) },
      },
    ],
  ]) {
    const tx = Object.assign(
      vi.fn((parts: TemplateStringsArray) => {
        const query = parts.join('')
        if (query.includes('lock_physical_spool_observations')) return rows
        if (
          query.includes('SELECT g.id') ||
          query.includes('SELECT id FROM farm.spool_filaments')
        )
          return [{ id: 1 }]
        if (query.includes('SELECT')) return []
        throw new Error('Unexpected statement: ' + query)
      }),
      { json: (value: unknown) => value },
    )
    const sql = {
      begin: (work: (tx: TransactionSql) => Promise<unknown>) =>
        work(tx as unknown as TransactionSql),
    } as unknown as Sql
    expect(await registerPhysicalSpool(sql, access, input, 'binding')).toEqual({
      outcome: 'spool-not-observed',
    })
    expect(tx.mock.calls.map(([parts]) => parts.join('')).join('')).not.toMatch(
      /INSERT|UPDATE/,
    )
  }
})

test.each([-20_000, 20_000])(
  'binds a newly received snapshot with Connector clock skew of %i ms',
  async (skew) => {
    const receivedAt = Date.now()
    const row = observation(serviceA, connectorA, 0, receivedAt + skew)
    const tx = vi.fn(async () => [{ ...row, receivedAt }])
    expect(
      await hasCurrentSpoolObservation(
        tx as unknown as TransactionSql,
        farmId,
        {
          serviceId: serviceA,
          spoolId: 1,
        },
      ),
    ).toBe(true)
  },
)

const cappedIds = [1, 2, 3, 4, 5, 6, 7, 8, 99]

function membershipLookup(observedAt: number) {
  const reader = createSpoolMembershipReader()
  reader.update({
    kind: 'observed',
    inventory: spoolInventory(serviceA, observedAt, cappedIds),
    ageMs: 0,
  })

  const lookup = vi.fn(
    async (
      agentId: string,
      binding: { serviceId: string; spoolId: number },
      targetFarm = farmId,
    ) => {
      expect(agentId).toBe(connectorA)
      const query = ApiQueryRequest.parse({
        v: 1,
        t: 'connector.api-query',
        request_id: crypto.randomUUID(),
        kind: 'spool-membership',
        farmId: targetFarm,
        ...binding,
      })
      const reply = await answerApiQuery(
        query,
        async (request) => {
          if (request.kind !== 'spool-membership')
            throw Error('Unexpected query')
          const membership = reader.read(request)
          return membership ? { membership } : undefined
        },
        new AbortController().signal,
      )
      expect(reply.request_id).toBe(query.request_id)
      return JSON.parse(reply.wire) as unknown
    },
  )
  return { reader, lookup }
}

test('binds an omitted ninth spool only with current targeted membership', async () => {
  const receivedAt = Date.now()
  const observedAt = receivedAt + 20_000
  const { snapshot } = observation(
    serviceA,
    connectorA,
    0,
    observedAt,
    cappedIds,
  )
  const { reader, lookup } = membershipLookup(observedAt)
  expect(snapshot.spools).toHaveLength(8)
  expect(snapshot.spools.some(({ spoolId }) => spoolId === 99)).toBe(false)
  const binding = { serviceId: serviceA, spoolId: 99 }
  const access = {
    appId: connectorA,
    farmId,
    grantIds: [connectorB],
    scope: 'inventory:write' as const,
  }
  let grant = true
  const tx = Object.assign(
    vi.fn((parts: TemplateStringsArray) => {
      const query = parts.join('')
      if (query.includes('lock_physical_spool_observations'))
        return [{ agentId: connectorA, snapshot, observedAt, receivedAt }]
      if (query.includes('SELECT g.id')) return grant ? [{ id: 1 }] : []
      if (query.includes('SELECT id FROM farm.spool_filaments'))
        return [{ id: 1 }]
      if (query.includes('INSERT INTO farm.spools'))
        return [{ id: 1, location: 'A', revision: '1' }]
      return []
    }),
    { json: (value: unknown) => value },
  )
  const sql = {
    begin: (work: (tx: TransactionSql) => Promise<unknown>) =>
      work(tx as unknown as TransactionSql),
  } as unknown as Sql
  const register = (spoolman = binding, read = lookup) =>
    registerPhysicalSpool(
      sql,
      access,
      { filamentId: 1, location: 'A', spoolman },
      'binding',
      read,
    )
  expect(await register()).toMatchObject({ outcome: 'registered' })
  expect(lookup).toHaveBeenCalledWith(connectorA, binding)
  tx.mockClear()
  for (const result of [
    await register({ ...binding, spoolId: 100 }),
    await register(
      binding,
      vi.fn(async () => lookup(connectorA, binding, connectorB)),
    ),
    await register(
      binding,
      vi.fn(async () =>
        lookup(connectorA, { ...binding, serviceId: serviceB }),
      ),
    ),
    await register(
      binding,
      vi.fn(async () => ({
        kind: 'spool-membership',
        ...binding,
        spoolId: 100,
        present: true,
        observedAt,
      })),
    ),
  ])
    expect(result).toEqual({ outcome: 'spool-not-observed' })
  reader.update({ kind: 'stale', inventory: null, ageMs: null })
  expect(await register()).toEqual({ outcome: 'spool-not-observed' })
  expect(tx.mock.calls.map(([parts]) => parts.join('')).join('')).not.toMatch(
    /INSERT|UPDATE/,
  )
  grant = false
  lookup.mockClear()
  expect(await register()).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
})

const runnerFixture =
  process.env.SPOOL_BINDING_FIXTURE_ADMITTED === 'yes'
    ? process.env.SPOOL_BINDING_FIXTURE_URL
    : undefined

test.runIf(
  runnerFixture !== undefined ||
    process.env.OPENFARM_TEST_SPOOL_IDENTITY_PG === '1' ||
    process.env.OPENFARM_PG === 'docker',
)(
  'sandbox ledger joins only explicit bindings across a service replacement',
  async () => {
    const fixture = runnerFixture
      ? undefined
      : disposablePostgres({
          ...vitestPostgresOptions('spool-identity'),
          isolated: true,
          ledger: (entry) => {
            const path = process.env.OPENFARM_SPOOL_IDENTITY_RESOURCE_LEDGER
            if (path) appendFileSync(path, JSON.stringify(entry) + '\n')
          },
        })
    const runnerDb = runnerFixture ? postgres(runnerFixture) : undefined
    let reader: Sql | undefined
    let writer: Sql | undefined
    try {
      const root = runnerDb ?? (await fixture!.start())
      if (runnerDb) {
        const [identity] =
          await root`SELECT system_identifier::text AS id FROM pg_control_system()`
        expect(identity?.id).toBe(process.env.SPOOL_BINDING_FIXTURE_SYSTEM_ID)
      }
      const connectionString = runnerFixture ?? fixture!.connectionString
      const appId = crypto.randomUUID()
      const grantId = crypto.randomUUID()
      const access = {
        appId,
        farmId,
        grantIds: [grantId],
        scope: 'inventory:write' as const,
      }
      await root`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, true)`
      await root`INSERT INTO farm.session_accounts (id) VALUES ('spool-identity-owner')`
      await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
        VALUES (${appId}, ${farmId}, 'Synthetic inventory', true, 0, 'spool-identity-owner')`
      await root`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by)
        VALUES (${grantId}, ${appId}, ${farmId}, ARRAY['inventory:read','inventory:write'], 0, 'spool-identity-owner')`
      await root`INSERT INTO farm.spool_filaments (farm_id, id, name, density, diameter, registered_at)
        VALUES (${farmId}, 1, 'PLA', 1.24, 1.75, 0)`
      await root`CREATE ROLE spool_identity_writer NOLOGIN`
      await root`GRANT farm_spool_features, farm_spool_library, farm_integration_apps TO spool_identity_writer`
      writer = postgres(connectionString, {
        connection: {
          role: 'spool_identity_writer',
          application_name: 'spool_identity_writer',
        },
      })
      reader = postgres(connectionString, {
        connection: { role: 'farm_integration_apps' },
      })

      const writeDb = writer
      const otherFarm = crypto.randomUUID()
      const otherConnector = crypto.randomUUID()
      async function enroll(
        targetFarm: string,
        connectorId: string,
        serviceId: string,
      ) {
        await root`INSERT INTO farm.connector_enrollments (farm_id, agent_id, public_key_spki, fingerprint)
          VALUES (${targetFarm}, ${connectorId}, repeat('A', 59), 'SHA256:' || repeat('A', 43))`
        await root`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${connectorId}`
        await root`INSERT INTO farm.spoolman_connector_settings (farm_id, agent_id, origin, service_id, status, configured, checked_at, updated_by)
          VALUES (${targetFarm}, ${connectorId}, 'http://spoolman.invalid', ${serviceId}, 'reachable', true, 0, 'spool-identity-owner')`
      }
      async function publish(
        serviceId: string,
        connectorId = connectorA,
        {
          db = root,
          targetFarm = farmId,
          observedAt = Date.now(),
          receivedAt = Date.now(),
          stale = false,
          spoolIds = [1, 5],
        }: {
          db?: Sql | TransactionSql
          targetFarm?: string
          observedAt?: number
          receivedAt?: number
          stale?: boolean
          spoolIds?: number[]
        } = {},
      ) {
        const row = observation(serviceId, connectorId, 0, observedAt, spoolIds)
        await db`INSERT INTO farm.connector_inventory_snapshots (farm_id, agent_id, observed_at, snapshot, received_at)
          VALUES (${targetFarm}, ${connectorId}, ${row.observedAt}, ${db.json({ ...row.snapshot, stale })}, ${receivedAt})
          ON CONFLICT (farm_id, agent_id) DO UPDATE SET observed_at = EXCLUDED.observed_at, snapshot = EXCLUDED.snapshot, received_at = EXCLUDED.received_at`
      }

      const input = { filamentId: 1, location: 'A' }
      const boundAInput = {
        ...input,
        spoolman: { serviceId: serviceA, spoolId: 1 },
      }
      const rejected = { outcome: 'spool-not-observed' }
      const registerA = () =>
        registerPhysicalSpool(writeDb, access, boundAInput, 'service-a')
      expect(await registerA()).toEqual(rejected)
      await root`INSERT INTO farm.farms (id, sandbox) VALUES (${otherFarm}, true)`
      await enroll(otherFarm, otherConnector, serviceA)
      await publish(serviceA, otherConnector, { targetFarm: otherFarm })
      expect(await registerA()).toEqual(rejected)
      await publish(serviceA)
      expect(await registerA()).toEqual(rejected)
      await enroll(farmId, connectorA, serviceA)
      await publish(serviceA, connectorA, { receivedAt: Date.now() - 30_000 })
      expect(await registerA()).toEqual(rejected)
      await publish(serviceA, connectorA, { stale: true })
      expect(await registerA()).toEqual(rejected)
      await publish(serviceB)
      expect(await registerA()).toEqual(rejected)

      const receivedAt = Date.now()
      const reported = observation(serviceA, connectorA, 0, receivedAt + 60_000)
      const valid = observation(serviceA, connectorA, 0, receivedAt + 20_000)
      const source = { farmId, agentId: connectorA }
      await root.begin(async (tx) => {
        await tx`SET LOCAL ROLE farm_connector_telemetry_writer`
        await recordInventorySnapshot(tx, source, reported.snapshot, receivedAt)
        await recordInventorySnapshot(tx, source, valid.snapshot, receivedAt)
        await recordInventorySnapshot(
          tx,
          source,
          valid.snapshot,
          receivedAt + 1,
        )
      })
      const [stored] =
        await root`SELECT observed_at::float8, received_at::float8
        FROM farm.connector_inventory_snapshots WHERE farm_id = ${farmId} AND agent_id = ${connectorA}`
      expect(stored).toEqual({
        observed_at: valid.observedAt,
        received_at: receivedAt,
      })
      expect(
        await registerPhysicalSpool(
          writeDb,
          access,
          { ...boundAInput, spoolman: { serviceId: serviceA, spoolId: 99 } },
          'service-a',
        ),
      ).toEqual(rejected)
      expect(
        await root`SELECT id FROM farm.spools WHERE farm_id = ${farmId}`,
      ).toHaveLength(0)
      expect(
        await root`SELECT last_id FROM farm.spool_library_counters WHERE farm_id = ${farmId}`,
      ).toHaveLength(0)
      expect(
        await root`SELECT response FROM farm.integration_physical_spool_registrations WHERE app_id = ${appId}`,
      ).toHaveLength(0)

      const legacy = await registerPhysicalSpool(
        writer,
        access,
        input,
        'legacy',
      )
      const boundA = await registerA()
      const boundBInput = {
        ...input,
        spoolman: { serviceId: serviceB, spoolId: 1 },
      }
      await enroll(farmId, connectorB, serviceB)
      await publish(serviceB, connectorB)
      const concurrent = await Promise.all([
        registerPhysicalSpool(writer, access, boundBInput, 'service-b'),
        registerPhysicalSpool(writer, access, boundBInput, 'service-b-race'),
      ])
      const boundB = concurrent.find(
        (result) => result?.outcome === 'registered',
      )
      expect(
        concurrent.filter((result) => result?.outcome === 'already-bound'),
      ).toHaveLength(1)
      if (
        legacy?.outcome !== 'registered' ||
        boundA?.outcome !== 'registered' ||
        boundB?.outcome !== 'registered'
      )
        throw new Error('Expected all three registrations to succeed')
      expect(
        await registerPhysicalSpool(writer, access, boundAInput, 'service-a'),
      ).toEqual(boundA)
      expect(
        await registerPhysicalSpool(writer, access, boundAInput, 'duplicate'),
      ).toEqual({ outcome: 'already-bound' })
      expect(
        await registerPhysicalSpool(
          writer,
          access,
          { ...boundAInput, spoolman: { serviceId: serviceB, spoolId: 1 } },
          'service-a',
        ),
      ).toEqual({ outcome: 'key-reused' })
      await expect(
        writer`UPDATE farm.integration_physical_spool_registrations SET response = response WHERE app_id = ${appId}`,
      ).rejects.toMatchObject({ code: '42501' })

      const [job] = await root<{ id: string }[]>`INSERT INTO farm.job_history
        (farm_id, agent_id, printer_key, outcome, ended_at)
        VALUES (${farmId}, ${connectorA}, 'sandbox-printer', 'completed', 1000) RETURNING id::text AS id`
      for (const { spool } of [legacy, boundA, boundB]) {
        await root`INSERT INTO farm.spool_usage_records (id, farm_id, spool_id, job_id, grams, source, created_at)
          VALUES (${crypto.randomUUID()}, ${farmId}, ${spool.spoolId}, ${job!.id}, 8, 'manual', 1000)`
      }

      const farms = [farmId]
      const observed = { farmIds: farms, cursor: null, limit: 8 }
      const usageQuery = spoolUsageQuery(
        new URLSearchParams({ jobId: job!.id }),
      )!
      const readDb = reader
      const readUsage = () =>
        listIntegrationSpoolUsage(readDb, farms, usageQuery)
      const before = await readUsage()
      const firstObservation = await listObservedSpools(readDb, observed)
      expect(firstObservation.data[0]?.spoolKey).toBe(serviceA + ':1')
      const both = await listObservedSpools(readDb, observed)
      expect(both.data.map(({ spoolKey }) => spoolKey)).toEqual([
        serviceA + ':1',
        serviceA + ':5',
        serviceB + ':1',
        serviceB + ':5',
      ])
      await publish(serviceA, connectorA, { spoolIds: cappedIds })
      await publish(serviceB, connectorB, { spoolIds: cappedIds })
      async function registerDuringUpdate(
        update: (tx: TransactionSql) => Promise<void>,
        spoolman: { serviceId: string; spoolId: number },
        key: string,
      ) {
        const lookup = vi.fn(async () => ({
          kind: 'spool-membership',
          ...spoolman,
          present: true,
          observedAt: Date.now(),
        }))
        let registration: ReturnType<typeof registerPhysicalSpool> | undefined
        await root.begin(async (tx) => {
          await update(tx)
          registration = registerPhysicalSpool(
            writeDb,
            access,
            { ...input, spoolman },
            key,
            lookup,
          )
          // The writer must reach the observation query while the change is uncommitted.
          for (let attempt = 0; attempt < 200; attempt++) {
            await tx`SELECT pg_stat_clear_snapshot()`
            const pending = await tx`
              SELECT 1 FROM pg_stat_activity
              WHERE application_name = 'spool_identity_writer'
                AND wait_event_type = 'Lock'
                AND pg_backend_pid() = ANY(pg_blocking_pids(pid))`
            if (pending.length) return
            await delay(10)
          }
          throw new Error('Registration did not wait for the provenance update')
        })
        expect(await registration).toEqual(rejected)
        expect(lookup).not.toHaveBeenCalled()
      }

      await registerDuringUpdate(
        async (tx) => {
          await tx`UPDATE farm.connector_enrollments SET status = 'revoked' WHERE agent_id = ${connectorB}`
          await tx`INSERT INTO farm.connector_revocations (agent_id, farm_id, fingerprint, revoked_at, revoked_by)
            SELECT agent_id, farm_id, fingerprint, ${Date.now()}, 'spool-identity-owner'
            FROM farm.connector_enrollments WHERE agent_id = ${connectorB}`
        },
        { serviceId: serviceB, spoolId: 99 },
        'revoked',
      )
      await registerDuringUpdate(
        async (tx) => {
          await tx`UPDATE farm.spoolman_connector_settings SET service_id = ${serviceB}
          WHERE farm_id = ${farmId} AND agent_id = ${connectorA}`
        },
        { serviceId: serviceA, spoolId: 99 },
        'reconfigured',
      )
      expect(
        await registerPhysicalSpool(
          writeDb,
          access,
          { ...input, spoolman: { serviceId: serviceB, spoolId: 5 } },
          'replacement',
        ),
      ).toEqual(rejected)
      await root`UPDATE farm.spoolman_connector_settings SET service_id = ${serviceA}
        WHERE farm_id = ${farmId} AND agent_id = ${connectorA}`
      await registerDuringUpdate(
        async (tx) => {
          await publish(serviceB, connectorA, { db: tx })
        },
        { serviceId: serviceA, spoolId: 99 },
        'replaced-snapshot',
      )
      expect(await registerA()).toEqual(boundA)
      expect(
        await root`SELECT id FROM farm.spools WHERE farm_id = ${farmId}`,
      ).toHaveLength(3)
      expect(
        await root`SELECT response FROM farm.integration_physical_spool_registrations WHERE app_id = ${appId}`,
      ).toHaveLength(3)
      const replacement = await listObservedSpools(readDb, observed)
      expect(replacement.data[0]?.spoolKey).toBe(serviceB + ':1')
      const targetedAt = Date.now()
      await publish(serviceA, connectorA, {
        observedAt: targetedAt,
        spoolIds: cappedIds,
      })
      const { lookup } = membershipLookup(targetedAt)
      expect(
        await registerPhysicalSpool(
          writeDb,
          access,
          { ...input, spoolman: { serviceId: serviceA, spoolId: 99 } },
          'ninth-spool',
          lookup,
        ),
      ).toMatchObject({ outcome: 'registered' })
      expect(lookup).toHaveBeenCalledWith(connectorA, {
        serviceId: serviceA,
        spoolId: 99,
      })
      await root`UPDATE farm.integration_apps SET revoked_at = 1001 WHERE id = ${appId}`
      const after = await readUsage()
      expect(after).toEqual(before)
      expect(
        after.data.find(({ spoolId }) => spoolId === legacy.spool.spoolId),
      ).not.toHaveProperty('spoolKey')
      expect(
        after.data.filter(
          ({ spoolKey }) => spoolKey === replacement.data[0]?.spoolKey,
        ),
      ).toEqual([
        expect.objectContaining({
          spoolId: boundB.spool.spoolId,
          serviceId: serviceB,
          serviceSpoolId: 1,
        }),
      ])
      const search = await searchIntegrationSpools(
        readDb,
        farms,
        spoolSearchQuery(new URLSearchParams())!,
      )
      expect(search.data.map(({ spoolKey }) => spoolKey)).toEqual([
        undefined,
        serviceA + ':1',
        serviceB + ':1',
        serviceA + ':99',
      ])
    } finally {
      await Promise.all([
        reader?.end(),
        writer?.end(),
        runnerDb?.end(),
      ]).finally(() => fixture?.stop())
    }
  },
  45000,
)
