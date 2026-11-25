// Runs only through scripts/test-postgres-observation-followups.ts, against a
// disposable PostgreSQL fixture with every migration applied.
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import postgres, { type Sql, type TransactionSql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import alertsRoute from '../../apps/farm/server/api/integrations/v1/alerts/[id].get.ts'
import { recordInventorySnapshot } from '../../apps/farm/server/storage/postgres-inventory-snapshot.ts'

const runtime = vi.hoisted(() => ({
  pool: undefined as unknown,
  store: undefined as unknown,
}))
vi.mock('nuxt/server', () => ({
  defineEventHandler: <T>(handler: T) => handler,
  useRuntimeConfig: () => ({}),
}))
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', () => ({
  integrationAuthRuntime: () => ({ store: runtime.store }),
  integrationAuthPool: () => runtime.pool,
}))

const url =
  process.env.OBSERVATION_FOLLOWUPS_FIXTURE_ADMITTED === 'yes'
    ? process.env.OBSERVATION_FOLLOWUPS_FIXTURE_URL
    : undefined

const farmId = randomUUID()
const agentId = randomUUID()
const assignmentId = randomUUID()
const serviceId = randomUUID()
const owner = 'observation-followups-owner'

const inventory = (observedServiceId: string) => ({
  observedAt: Date.now(),
  stale: false,
  total: 0,
  serviceId: observedServiceId,
  spools: [],
})

describe.skipIf(!url)('PostgreSQL', () => {
  let admin: Sql

  const record = (tx: TransactionSql, observedServiceId: string) =>
    recordInventorySnapshot(
      tx,
      { farmId, agentId },
      inventory(observedServiceId),
      0,
    )

  beforeAll(async () => {
    admin = postgres(url!, { max: 4, onnotice: () => {} })
    await admin`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, true)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
    await admin`INSERT INTO farm.connector_enrollments (farm_id, agent_id, public_key_spki, fingerprint)
      VALUES (${farmId}, ${agentId}, repeat('A', 59), 'SHA256:' || repeat('A', 43))`
    await admin`UPDATE farm.connector_enrollments SET status = 'approved' WHERE agent_id = ${agentId}`
    // A declared service ID keeps the row selected whatever the snapshot says.
    await admin`INSERT INTO farm.spoolman_connector_settings
      (farm_id, agent_id, origin, service_id, status, configured, checked_at, updated_by)
      VALUES (${farmId}, ${agentId}, 'http://spoolman.invalid', ${serviceId}, 'reachable', true, 0, ${owner})`
    await admin`INSERT INTO farm.printer_assignments (id, farm_id, agent_id, printer_key, created_at, created_by)
      VALUES (${assignmentId}, ${farmId}, ${agentId}, 'simulator', 1, ${owner})`
    await admin.begin((tx) => record(tx, serviceId))
  })

  afterAll(async () => {
    await admin?.end({ timeout: 3 })
  })

  it.each([
    'lock_physical_spool_observations_with_freshness',
    'lock_physical_spool_observations_with_receipt',
    'lock_physical_spool_observations',
  ])('%s and a snapshot write take their locks in one order', async (name) => {
    const options = {
      max: 1,
      onnotice: () => {},
      connection: { lock_timeout: 5000 },
    }
    const writer = postgres(url!, options)
    const binder = postgres(url!, options)
    const observed = randomUUID()
    let bound: Promise<unknown[]> | undefined
    try {
      const [session] = await binder`SELECT pg_backend_pid() AS pid`
      await writer.begin(async (tx) => {
        // The row lock a snapshot upsert takes before its AFTER trigger.
        await tx`SELECT 1 FROM farm.connector_inventory_snapshots
            WHERE farm_id = ${farmId} AND agent_id = ${agentId} FOR UPDATE`
        bound = binder.begin(async (other) => [
          ...(await other`SELECT agent_id, snapshot
              FROM farm.${other(name)}(${farmId}::uuid, ${serviceId}::uuid)`),
        ])
        bound.catch(() => {})
        await vi.waitFor(
          async () => {
            const [activity] = await admin`SELECT wait_event_type AS wait
                FROM pg_stat_activity WHERE pid = ${session!.pid}`
            expect(activity?.wait).toBe('Lock')
          },
          { timeout: 5000, interval: 20 },
        )
        // The waiting binder must not already hold the settings row.
        await admin.begin(
          (probe) => probe`SELECT 1 FROM farm.spoolman_connector_settings
              WHERE farm_id = ${farmId} AND agent_id = ${agentId} FOR UPDATE NOWAIT`,
        )
        // The real write; its trigger updates the settings row.
        await record(tx, observed)
        await delay(50)
      })
      // The binder sees the write it waited for.
      expect(await bound).toEqual([
        {
          agent_id: agentId,
          snapshot: expect.objectContaining({ serviceId: observed }),
        },
      ])
      const [settings] =
        await admin`SELECT observed_service_id AS id FROM farm.spoolman_connector_settings
            WHERE farm_id = ${farmId} AND agent_id = ${agentId}`
      expect(settings?.id).toBe(observed)
    } finally {
      await bound?.catch(() => {})
      await writer.end({ timeout: 3 })
      await binder.end({ timeout: 3 })
    }
  })

  const asIntegrationRole = (statement: string) =>
    admin.begin(async (tx) => {
      await tx`SET LOCAL ROLE farm_integration_apps`
      return [...(await tx.unsafe(statement, [farmId, serviceId]))]
    })

  it.each([
    'lock_physical_spool_observations($1::uuid, $2::uuid)',
    'lock_physical_spool_observations_with_receipt($1::uuid, $2::uuid)',
    'read_physical_spool_observations_with_receipt($1::uuid, $2::uuid)',
    'lock_spool_observation_provenance($1::uuid, $2::uuid, false)',
  ])('refuses the integration role farm.%s', async (call) => {
    await expect(
      asIntegrationRole('SELECT * FROM farm.' + call),
    ).rejects.toMatchObject({
      code: '42501',
      message: expect.stringContaining('permission denied for function'),
    })
  })

  it.each([
    'lock_physical_spool_observations_with_freshness',
    'read_physical_spool_observations_with_freshness',
  ])('lets the integration role call farm.%s', async (name) => {
    const rows = await asIntegrationRole(
      `SELECT agent_id FROM farm.${name}($1::uuid, $2::uuid)`,
    )
    expect(rows).toEqual([{ agent_id: agentId }])
  })

  it('flags alerts opened after the read and not past or current ones', async () => {
    const now = 10_000
    for (const [key, openedAt, resolvedAt] of [
      ['past', now - 1000, now - 500],
      ['current', now, null],
      ['future', now + 1, null],
    ] as const)
      await admin`INSERT INTO farm.integration_alert_lifecycle
        (printer_id, alert_key, kind, label, message, opened_at, resolved_at)
        VALUES (${assignmentId}, ${key}, 'error', ${key}, ${key}, ${openedAt}, ${resolvedAt})`
    runtime.pool = admin
    runtime.store = {
      readPrinter: async () => ({
        id: assignmentId,
        farmId,
        printerKey: 'simulator',
        sandbox: true,
        state: null,
        observedAt: null,
      }),
    }
    const scopes = ['printers:read']
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const response = (await alertsRoute({
        req: { url: `http://farm.example/alerts/${assignmentId}` },
        res: { headers: new Headers() },
        context: {
          params: { id: assignmentId },
          integrationAuth: {
            appId: randomUUID(),
            scopes,
            grants: [{ farmId, printerAssignmentId: null, scopes }],
          },
        },
      } as never)) as unknown as {
        alerts: {
          label: string
          timestampSkewed: boolean
          openedAt: number | null
          resolvedAt: number | null
        }[]
      }
      expect(
        Object.fromEntries(
          response.alerts.map((alert) => [
            alert.label,
            [alert.timestampSkewed, alert.openedAt, alert.resolvedAt],
          ]),
        ),
      ).toEqual({
        past: [false, now - 1000, now - 500],
        current: [false, now, null],
        future: [true, null, null],
      })
    } finally {
      clock.mockRestore()
    }
  })
})
