import { vitestPostgresOptions } from '../helpers/vitest-postgres.ts'
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

it.runIf(
  process.env.OPENFARM_TEST_PHYSICAL_PG === '1' ||
    process.env.OPENFARM_PG === 'docker',
)(
  'registers and withdraws two similar spools against the sandbox library',
  async () => {
    const ledgerPath = process.env.OPENFARM_PHYSICAL_RESOURCE_LEDGER
    const fixture = disposablePostgres({
      ...vitestPostgresOptions('physical-spool'),
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
          'unauthorized',
        ),
      ).toBeNull()
      expect(
        await registerPhysicalSpool(
          sql,
          access,
          { ...input, filamentId: 2 },
          'missing',
        ),
      ).toBeNull()
      const [first, second] = await Promise.all([
        registerPhysicalSpool(sql, access, input, 'first'),
        registerPhysicalSpool(sql, access, input, 'second'),
      ])
      if (first?.outcome !== 'registered' || second?.outcome !== 'registered')
        throw new Error('Expected both spools to be registered')
      const firstSpool = first.spool
      const secondSpool = second.spool
      expect(await registerPhysicalSpool(sql, access, input, 'first')).toEqual(
        first,
      )
      expect(
        await registerPhysicalSpool(
          sql,
          access,
          { ...input, location: 'Other' },
          'first',
        ),
      ).toEqual({ outcome: 'key-reused' })
      const concurrent = await Promise.all([
        registerPhysicalSpool(sql, access, input, 'concurrent'),
        registerPhysicalSpool(sql, access, input, 'concurrent'),
      ])
      expect(concurrent[0]).toEqual(concurrent[1])
      expect([firstSpool.spoolId, secondSpool.spoolId].sort()).toEqual([1, 2])
      expect(firstSpool.label.href).toBe(
        `/api/farms/${farmId}/spool-library/labels?spoolIds=${firstSpool.spoolId}`,
      )
      expect(firstSpool.label.href).not.toBe(secondSpool.label.href)
      await root`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at)
        VALUES ('spool-label-session', 'spool-test-owner', 0, 100, 100, 10000000)`
      await root`INSERT INTO farm.memberships (farm_id, account_id, role)
        VALUES (${farmId}, 'spool-test-owner', 'owner')`
      const labels = new PostgresSpoolDrying(sql, () => 500)
      const labelUrl = new URL(
        firstSpool.label.href,
        'https://farm.example.invalid',
      )
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
        expect.objectContaining({
          id: firstSpool.spoolId,
          name: 'Synthetic PLA',
        }),
      ])
      expect(firstSpool.binLight.status).toBe('unsupported')
      expect(await readPhysicalSpool(sql, read, firstSpool.spoolId)).toEqual(
        firstSpool,
      )
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
        { farmId, spoolId: 3 },
      ])

      const oldTake = {
        expectedLocation: input.location,
        version: firstSpool.version,
      }
      const secondTake = {
        expectedLocation: input.location,
        version: secondSpool.version,
      }
      expect(
        await withdrawPhysicalSpool(
          sql,
          access,
          firstSpool.spoolId,
          secondTake,
        ),
      ).toEqual({ outcome: 'changed' })
      await root`UPDATE farm.spools SET location = 'Gaveta B' WHERE farm_id = ${farmId} AND id = ${firstSpool.spoolId}`
      expect(
        await withdrawPhysicalSpool(sql, access, firstSpool.spoolId, oldTake),
      ).toEqual({ outcome: 'changed' })
      await root`UPDATE farm.spools SET location = ${input.location} WHERE farm_id = ${farmId} AND id = ${firstSpool.spoolId}`
      expect(
        await withdrawPhysicalSpool(sql, access, firstSpool.spoolId, oldTake),
      ).toEqual({ outcome: 'changed' })
      const current = await readPhysicalSpool(sql, read, firstSpool.spoolId)
      if (!current?.location)
        throw new Error('Expected the spool back in the original bin')
      const take = {
        expectedLocation: current.location,
        version: current.version,
      }
      const outcomes = await Promise.all([
        withdrawPhysicalSpool(sql, access, firstSpool.spoolId, take),
        withdrawPhysicalSpool(sql, access, firstSpool.spoolId, take),
      ])
      expect(outcomes.map((result) => result?.outcome).sort()).toEqual([
        'already-unlocated',
        'withdrawn',
      ])
      expect(
        await readPhysicalSpool(sql, read, firstSpool.spoolId),
      ).toMatchObject({
        location: null,
      })
      expect(await registerPhysicalSpool(sql, access, input, 'first')).toEqual(
        first,
      )
      expect(await readPhysicalSpool(sql, read, secondSpool.spoolId)).toEqual(
        secondSpool,
      )

      await root`UPDATE farm.integration_app_grants SET disabled_at = 1, disabled_reason = 'revoked' WHERE id = ${grantId}`
      expect(
        await withdrawPhysicalSpool(
          sql,
          access,
          secondSpool.spoolId,
          secondTake,
        ),
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
