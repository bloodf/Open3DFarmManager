import { appendFileSync } from 'node:fs'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import { PostgresSpoolDrying } from '../../apps/farm/server/storage/postgres-spool-drying.ts'
import { searchIntegrationSpools } from '../../apps/farm/server/utils/integration-inventory-ledger.ts'
import {
  physicalSpoolId,
  readPhysicalSpool,
  registerPhysicalSpool,
  registration,
  withdrawPhysicalSpool,
} from '../../apps/farm/server/utils/integration-spool-physical.ts'
import { disposablePostgres } from '../helpers/disposable-postgres.ts'

describe('physical spool input', () => {
  it('preserves safe numeric identities and normalizes new bin names', () => {
    expect(physicalSpoolId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER)
    for (const invalid of ['9007199254740992', '0', '1.0', '01', '1e2'])
      expect(physicalSpoolId(invalid)).toBeNull()
    expect(
      registration.parse({ filamentId: 1, location: ' Gaveta A ' }),
    ).toEqual({
      filamentId: 1,
      location: 'Gaveta A',
    })
    for (const location of [' ', 'A\nB', 'A\0B', 'á'.repeat(257)])
      expect(registration.safeParse({ filamentId: 1, location }).success).toBe(
        false,
      )
  })
})

it.runIf(process.env.OPENFARM_TEST_PHYSICAL_PG === '1')(
  'registers and withdraws two similar spools against the sandbox library',
  async () => {
    const ledgerPath = process.env.OPENFARM_PHYSICAL_RESOURCE_LEDGER
    const fixture = disposablePostgres({
      name: 'physical-spool',
      isolated: true,
      ledger: (entry) => {
        if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(entry) + '\n')
      },
    })
    let usage: ReturnType<typeof postgres> | undefined
    try {
      const root = await fixture.start()
      const farmId = crypto.randomUUID()
      const appId = crypto.randomUUID()
      const grantId = crypto.randomUUID()
      const anotherAppId = crypto.randomUUID()
      const access = {
        appId,
        farmId,
        grantIds: [grantId],
        scope: 'inventory:write' as const,
      }
      const read = { ...access, scope: 'inventory:read' as const }
      await root`INSERT INTO farm.farms (id, sandbox) VALUES (${farmId}, true)`
      await root`INSERT INTO farm.session_accounts (id) VALUES ('spool-test-owner')`
      await root`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by)
        VALUES (${appId}, ${farmId}, 'Synthetic shop', true, 0, 'spool-test-owner'),
               (${anotherAppId}, ${farmId}, 'Another app', true, 0, 'spool-test-owner')`
      await root`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by)
        VALUES (${grantId}, ${appId}, ${farmId}, ARRAY['inventory:read','inventory:write'], 0, 'spool-test-owner')`
      await root`INSERT INTO farm.spool_filaments (farm_id, id, name, density, diameter, registered_at)
        VALUES (${farmId}, 1, 'Synthetic PLA', 1.24, 1.75, 0)`
      await root`CREATE ROLE physical_spool_test NOLOGIN`
      await root`GRANT farm_spool_features, farm_spool_library, farm_job_history_reader, farm_integration_apps TO physical_spool_test`
      usage = postgres(fixture.connectionString, {
        max: 3,
        onnotice: () => {},
        connection: { role: 'physical_spool_test', search_path: 'pg_catalog' },
      })
      const sql = usage
      // Use the same DB privileges as the deployed spool usage runtime.
      const [role] = await sql`SELECT current_user AS name`
      expect(role?.name).toBe('physical_spool_test')

      const input = { filamentId: 1, location: 'Gaveta A' }
      expect(
        await registerPhysicalSpool(
          sql,
          { ...access, appId: anotherAppId },
          input,
        ),
      ).toBeNull()
      expect(
        await registerPhysicalSpool(sql, access, { ...input, filamentId: 2 }),
      ).toBeNull()
      const [first, second] = await Promise.all([
        registerPhysicalSpool(sql, access, input),
        registerPhysicalSpool(sql, access, input),
      ])
      if (!first || !second)
        throw new Error('Expected both spools to be registered')
      expect([first.spoolId, second.spoolId].sort()).toEqual([1, 2])
      expect(first.label.href).toBe(
        `/api/farms/${farmId}/spool-library/labels?spoolIds=${first.spoolId}`,
      )
      expect(first.label.href).not.toBe(second.label.href)
      await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
        VALUES ('spool-label-session', 'spool-test-owner', 0, 100, 100, 10000000)`
      await root`INSERT INTO farm.memberships (farm_id, account_id, role)
        VALUES (${farmId}, 'spool-test-owner', 'owner')`
      const labels = new PostgresSpoolDrying(sql, () => 500)
      const labelUrl = new URL(first.label.href, 'https://farm.example.invalid')
      expect(
        await labels.run(
          {
            farmId,
            sessionRecordId: 'spool-label-session',
            policy: { idleTimeoutMs: 10000 },
          },
          'labels',
          { spoolIds: [Number(labelUrl.searchParams.get('spoolIds'))] },
        ),
      ).toEqual([
        expect.objectContaining({ id: first.spoolId, name: 'Synthetic PLA' }),
      ])
      expect(first.binLight.status).toBe('unsupported')
      expect(await readPhysicalSpool(sql, read, first.spoolId)).toEqual(first)
      const found = await searchIntegrationSpools(sql, [farmId], {
        limit: 10,
        farmId,
        color: null,
        material: null,
        availability: 'any',
        minRemainingGrams: null,
      })
      expect(
        found.data.map(({ spoolId, farmId }) => ({ spoolId, farmId })),
      ).toEqual([
        { farmId, spoolId: 1 },
        { farmId, spoolId: 2 },
      ])

      const oldTake = {
        expectedLocation: input.location,
        version: first.version,
      }
      const secondTake = {
        expectedLocation: input.location,
        version: second.version,
      }
      expect(
        await withdrawPhysicalSpool(sql, access, first.spoolId, secondTake),
      ).toEqual({ outcome: 'changed' })
      await root`UPDATE farm.spools SET location = 'Gaveta B' WHERE farm_id = ${farmId} AND id = ${first.spoolId}`
      expect(
        await withdrawPhysicalSpool(sql, access, first.spoolId, oldTake),
      ).toEqual({ outcome: 'changed' })
      await root`UPDATE farm.spools SET location = ${input.location} WHERE farm_id = ${farmId} AND id = ${first.spoolId}`
      expect(
        await withdrawPhysicalSpool(sql, access, first.spoolId, oldTake),
      ).toEqual({ outcome: 'changed' })
      const current = await readPhysicalSpool(sql, read, first.spoolId)
      if (!current?.location)
        throw new Error('Expected the spool back in the original bin')
      const take = {
        expectedLocation: current.location,
        version: current.version,
      }
      const outcomes = await Promise.all([
        withdrawPhysicalSpool(sql, access, first.spoolId, take),
        withdrawPhysicalSpool(sql, access, first.spoolId, take),
      ])
      expect(outcomes.map((result) => result?.outcome).sort()).toEqual([
        'already-unlocated',
        'withdrawn',
      ])
      expect(await readPhysicalSpool(sql, read, first.spoolId)).toMatchObject({
        location: null,
      })
      expect(await readPhysicalSpool(sql, read, second.spoolId)).toEqual(second)

      await root`UPDATE farm.integration_app_grants SET disabled_at = 1, disabled_reason = 'revoked' WHERE id = ${grantId}`
      expect(
        await withdrawPhysicalSpool(sql, access, second.spoolId, secondTake),
      ).toBeNull()
    } finally {
      try {
        await usage?.end({ timeout: 2 })
      } finally {
        await fixture.stop()
      }
    }
  },
  45_000,
)
