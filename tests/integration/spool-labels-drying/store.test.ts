import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import postgres from 'postgres'
import { PostgresSpoolDrying } from '../../../apps/farm/server/storage/postgres-spool-drying.ts'

test('farm members can record and read histories without crossing farms', async () => {
  const sql = postgres(process.env.SPOOL_DRYING_TEST_DATABASE_URL!, { max: 2 })
  const features = postgres(process.env.SPOOL_DRYING_FEATURE_DATABASE_URL!, {
    max: 2,
  })
  try {
    const a = randomUUID(),
      b = randomUUID()
    await sql`INSERT INTO farm.farms (id) VALUES (${a}::uuid), (${b}::uuid)`
    for (const who of ['owner', 'viewer', 'other']) {
      await sql`INSERT INTO farm.session_accounts (id) VALUES (${who})`
      await sql`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${who},${who},0,100,100,10000000)`
      await sql`INSERT INTO farm.memberships (farm_id,account_id,role) VALUES (${who === 'other' ? b : a}::uuid,${who},${who === 'viewer' ? 'viewer' : 'owner'})`
    }
    await sql`INSERT INTO farm.spool_filaments (farm_id,id,name,material,density,diameter,registered_at) VALUES (${a}::uuid,1,'PLA','PLA',1.24,1.75,100),(${b}::uuid,1,'PETG','PETG',1.27,1.75,100)`
    await sql`INSERT INTO farm.spools (farm_id,id,filament_id,registered_at) VALUES (${a}::uuid,1,1,100),(${b}::uuid,1,1,100)`
    const store = new PostgresSpoolDrying(features, () => 500)
    const authority = (farmId: string, sessionRecordId: string) => ({
      farmId,
      sessionRecordId,
      policy: { idleTimeoutMs: 10000 },
    })
    const owner = authority(a, 'owner'),
      other = authority(b, 'other')
    const drying = (await store.run(owner, 'drying-create', {
      spoolId: 1,
      startedAt: 200,
      endedAt: null,
      temperatureCelsius: 45,
      notes: 'teste',
    })) as { id: string }
    await store.run(owner, 'drying-end', { id: drying.id, endedAt: 300 })
    const history = (await store.run(owner, 'drying-list', { spoolId: 1 })) as {
      endedAt: number
    }[]
    assert.equal(history[0]?.endedAt, 300)
    await store.run(owner, 'humidity-create', {
      spoolId: 1,
      humidityPercent: 33,
      source: 'manual',
      recordedAt: 400,
    })
    assert.equal(
      ((await store.run(owner, 'humidity-list', { spoolId: 1 })) as unknown[])
        .length,
      1,
    )
    assert.equal(
      ((await store.run(other, 'humidity-list', { spoolId: 1 })) as unknown[])
        .length,
      0,
    )
    assert.equal(
      ((await store.run(other, 'drying-list', { spoolId: 1 })) as unknown[])
        .length,
      0,
    )
    await assert.rejects(
      store.run(other, 'drying-end', { id: drying.id, endedAt: 350 }),
      { status: 404 },
    )
    await assert.rejects(
      store.run(authority(a, 'other'), 'drying-list', { spoolId: 1 }),
      { status: 404 },
    )
    await assert.rejects(
      store.run(authority(a, 'viewer'), 'humidity-create', {
        spoolId: 1,
        humidityPercent: 33,
        source: 'manual',
        recordedAt: 400,
      }),
      { status: 403 },
    )
    assert.equal(
      ((await store.run(owner, 'labels', { spoolIds: [1] })) as unknown[])
        .length,
      1,
    )
    await assert.rejects(store.run(owner, 'labels', { spoolIds: [1, 2] }), {
      status: 404,
    })
  } finally {
    await features.end()
    await sql.end()
  }
})
