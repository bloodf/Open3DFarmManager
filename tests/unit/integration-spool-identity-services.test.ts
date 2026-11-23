import { appendFileSync } from 'node:fs'
import postgres from 'postgres'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'
import { registerPhysicalSpool } from '../../apps/farm/server/utils/integration-spool-physical.ts'
import type { Sql } from 'postgres'
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

function observation(serviceId: string, connectorId: string, index = 0) {
  const inventory = parseSpoolmanSpoolInventory(
    [
      {
        wire: JSON.stringify(
          [1, 5].map((id) => ({
            id,
            filament: { id: 1, name: 'PLA' },
            archived: false,
          })),
        ),
        offset: 0,
        observedAt: 1000,
      },
    ],
    { farmId, serviceId, limit: 100 },
  )
  const summary = summarizeSpoolman({ kind: 'observed', inventory, ageMs: 0 })!
  return {
    farmId,
    connectorId,
    observedAt: 1000,
    index,
    snapshot: inventoryAt(summary, 0, 1000),
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

test.runIf(process.env.OPENFARM_TEST_SPOOL_IDENTITY_PG === '1')(
  'sandbox ledger joins only explicit bindings across a service replacement',
  async () => {
    const fixture = disposablePostgres({
      name: 'spool-identity',
      isolated: true,
      ledger: (entry) => {
        const path = process.env.OPENFARM_SPOOL_IDENTITY_RESOURCE_LEDGER
        if (path) appendFileSync(path, JSON.stringify(entry) + '\n')
      },
    })
    let reader: Sql | undefined
    let writer: Sql | undefined
    try {
      const root = await fixture.start()
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
      writer = postgres(fixture.connectionString, {
        connection: { role: 'spool_identity_writer' },
      })
      reader = postgres(fixture.connectionString, {
        connection: { role: 'farm_integration_apps' },
      })

      const input = { filamentId: 1, location: 'A' }
      const legacy = await registerPhysicalSpool(
        writer,
        access,
        input,
        'legacy',
      )
      const boundAInput = {
        ...input,
        spoolman: { serviceId: serviceA, spoolId: 1 },
      }
      const boundA = await registerPhysicalSpool(
        writer,
        access,
        boundAInput,
        'service-a',
      )
      const boundBInput = {
        ...input,
        spoolman: { serviceId: serviceB, spoolId: 1 },
      }
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

      async function publish(serviceId: string, connectorId = connectorA) {
        const row = observation(serviceId, connectorId)
        await root`INSERT INTO farm.connector_inventory_snapshots (farm_id, agent_id, observed_at, snapshot)
          VALUES (${farmId}, ${connectorId}, ${row.observedAt}, ${root.json(row.snapshot)})
          ON CONFLICT (farm_id, agent_id) DO UPDATE SET snapshot = EXCLUDED.snapshot`
      }
      const farms = [farmId]
      const observed = { farmIds: farms, cursor: null, limit: 8 }
      const usageQuery = spoolUsageQuery(
        new URLSearchParams({ jobId: job!.id }),
      )!
      const readDb = reader
      const readUsage = () =>
        listIntegrationSpoolUsage(readDb, farms, usageQuery)
      await publish(serviceA)
      const before = await readUsage()
      const firstObservation = await listObservedSpools(readDb, observed)
      expect(firstObservation.data[0]?.spoolKey).toBe(serviceA + ':1')
      await publish(serviceB, connectorB)
      const both = await listObservedSpools(readDb, observed)
      expect(both.data.map(({ spoolKey }) => spoolKey)).toEqual([
        serviceA + ':1',
        serviceA + ':5',
        serviceB + ':1',
        serviceB + ':5',
      ])
      await publish(serviceB)
      const replacement = await listObservedSpools(readDb, observed)
      expect(replacement.data[0]?.spoolKey).toBe(serviceB + ':1')
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
      ])
    } finally {
      await Promise.all([reader?.end(), writer?.end()]).finally(() =>
        fixture.stop(),
      )
    }
  },
  45000,
)
