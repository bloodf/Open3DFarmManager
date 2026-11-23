import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import postgres from 'postgres'
import { PostgresSpoolUsage } from '../../../apps/farm/server/storage/postgres-spool-usage.ts'
import { gramsFromMillimetres } from '../../../apps/farm/server/services/spool-usage-ledger.ts'
import { validateSpoolUsageRole } from '../../../apps/farm/server/services/spool-usage-role.ts'
import { toCsv } from '../../../apps/farm/server/services/spool-usage-csv.ts'

const admin = postgres(process.env.SPOOL_USAGE_TEST_DATABASE_URL!, { max: 2 })
const features = postgres(process.env.SPOOL_USAGE_FEATURE_DATABASE_URL!, {
  max: 3,
})
test.after(async () => {
  await features.end()
  await admin.end()
})

const A = randomUUID()
const B = randomUUID()
const agentA = randomUUID()
const agentB = randomUUID()
const printerA = randomUUID()
const printerB = randomUUID()
const store = new PostgresSpoolUsage(features, () => 500)
const authority = (farmId: string, sessionRecordId: string) => ({
  farmId,
  sessionRecordId,
  policy: { idleTimeoutMs: 10000 },
})
const owner = authority(A, 'owner')
const operator = authority(A, 'operator')
const viewer = authority(A, 'viewer')
const other = authority(B, 'other')
const rows = <T>(value: unknown) => value as T[]

async function job(
  farm: string,
  agent: string,
  key: string,
  endedAt: number,
  usage: unknown,
  seconds = 600,
): Promise<number> {
  const inserted = await admin<
    { id: string }[]
  >`INSERT INTO farm.job_history (farm_id,agent_id,printer_key,outcome,total_duration_seconds,ended_at,filament_usage) VALUES (${farm}::uuid,${agent}::uuid,${key},'completed',${seconds},${endedAt},${admin.json(usage as never)}) RETURNING id::text`
  return Number(inserted[0]!.id)
}
const spoolUsed = async (farm: string, id: number) =>
  Number(
    (
      await admin`SELECT used_weight FROM farm.spools WHERE farm_id=${farm}::uuid AND id=${id}`
    )[0]!.used_weight,
  )
const alerts = async (filamentId: number) =>
  (
    await admin`SELECT body FROM farm.integration_webhook_outbox WHERE farm_id=${A}::uuid AND body->'data'->'alert'->>'id'=${'low-stock:' + filamentId}`
  ).map((r) => r.body as { data: { alert: { kind: string } } })

test('setup', async () => {
  await admin`INSERT INTO farm.farms (id) VALUES (${A}::uuid), (${B}::uuid)`
  for (const [who, farm, role] of [
    ['owner', A, 'owner'],
    ['operator', A, 'operator'],
    ['viewer', A, 'viewer'],
    ['other', B, 'owner'],
  ] as const) {
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${who})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${who},${who},0,100,100,10000000)`
    await admin`INSERT INTO farm.memberships (farm_id,account_id,role) VALUES (${farm}::uuid,${who},${role})`
  }
  for (const [farm, agent, printer] of [
    [A, agentA, printerA],
    [B, agentB, printerB],
  ] as const) {
    await admin`INSERT INTO farm.connector_enrollments (agent_id,farm_id,public_key_spki,fingerprint) VALUES (${agent}::uuid,${farm}::uuid,${'a'.repeat(59)},${'b'.repeat(50)})`
    await admin`UPDATE farm.connector_enrollments SET status='approved' WHERE agent_id=${agent}::uuid`
    await admin`INSERT INTO farm.printer_assignments (id,farm_id,agent_id,printer_key,created_at,created_by) VALUES (${printer}::uuid,${farm}::uuid,${agent}::uuid,'p1',100,'owner')`
  }
  // Farm A: PLA (filament 1) with two spools, PETG (filament 2) with one. Farm B reuses the same ids.
  await admin`INSERT INTO farm.spool_filaments (farm_id,id,name,material,density,diameter,weight,price,registered_at) VALUES (${A}::uuid,1,'PLA Red','PLA',1.24,1.75,1000,25,100),(${A}::uuid,2,'PETG Blue','PETG',1.27,1.75,500,20,100),(${B}::uuid,1,'PLA B','PLA',1.24,1.75,1000,99,100)`
  await admin`INSERT INTO farm.spools (farm_id,id,filament_id,initial_weight,price,location,registered_at) VALUES (${A}::uuid,1,1,1000,30,'shelf',100),(${A}::uuid,2,1,1000,NULL,'dry box',100),(${A}::uuid,3,2,500,NULL,'shelf',100),(${B}::uuid,1,1,1000,99,'shelf',100)`
  await admin`INSERT INTO farm.spool_slot_assignments (farm_id,id,spool_id,printer_id,slot_kind,slot_index,assigned_at,unassigned_at) VALUES (${A}::uuid,${randomUUID()}::uuid,1,${printerA}::uuid,'ams',0,100,NULL),(${A}::uuid,${randomUUID()}::uuid,2,${printerA}::uuid,'ams',1,100,NULL),(${A}::uuid,${randomUUID()}::uuid,3,${printerA}::uuid,'toolhead',0,100,300000)`
  const app = randomUUID()
  await admin`INSERT INTO farm.integration_apps (id,farm_id,name,sandbox,created_at,created_by) VALUES (${app}::uuid,${A}::uuid,'alerts',false,100,'owner')`
  await admin`INSERT INTO farm.integration_app_grants (id,app_id,farm_id,scopes,created_at,created_by) VALUES (${randomUUID()}::uuid,${app}::uuid,${A}::uuid,ARRAY['events:subscribe'],100,'owner')`
  await admin`INSERT INTO farm.integration_webhooks (id,app_id,url,events,signing_secret,created_at) VALUES (${randomUUID()}::uuid,${app}::uuid,'https://example.invalid/hook',ARRAY['printer.alert.raised'],'secret',100)`
})

test('the usage login holds exactly the combined least-privilege roles', async () => {
  await validateSpoolUsageRole(features)
  await assert.rejects(validateSpoolUsageRole(admin), /Invalid spool usage/)
})

test('finished job records usage per slot spool once and lowers remaining weight', async () => {
  const id = await job(A, agentA, 'p1', 1_000_000, [
    { tool: 'slot-0', grams: 100 },
    { tool: 'slot-1', millimetres: 1000 },
    { tool: 'slot-9', grams: 5 },
  ])
  assert.deepEqual(await store.recordJob(A, id), { records: 2, alerts: 0 })
  assert.deepEqual(await store.recordJob(A, id), { records: 0, alerts: 0 })
  const mm = gramsFromMillimetres(1000, 1.75, 1.24)
  assert.equal(await spoolUsed(A, 1), 100)
  assert.ok(Math.abs((await spoolUsed(A, 2)) - mm) < 1e-9)
  const used =
    await admin`SELECT first_used_at::float8 AS f, last_used_at::float8 AS l FROM farm.spools WHERE farm_id=${A}::uuid AND id=1`
  assert.deepEqual([used[0]!.f, used[0]!.l], [1_000_000, 1_000_000])

  const list = rows<{
    spoolId: number
    grams: number
    cost: number
    source: string
    jobId: number
  }>(
    (
      (await store.run(viewer, 'usage-list', { jobId: id })) as {
        records: unknown
      }
    ).records,
  )
  assert.equal(list.length, 2)
  const first = list.find((r) => r.spoolId === 1)!
  assert.equal(first.source, 'telemetry')
  assert.equal(first.cost, (30 / 1000) * 100) // spool price / initial weight * grams
  const second = list.find((r) => r.spoolId === 2)!
  assert.ok(Math.abs(second.cost - (25 / 1000) * mm) < 1e-9) // filament price fallback
})

test('a spool unassigned before job start and an unmapped printer are not charged', async () => {
  const before = await spoolUsed(A, 3)
  const late = await job(A, agentA, 'p1', 1_000_000 + 1, [
    { tool: 'T0', grams: 40 },
  ])
  assert.equal((await store.recordJob(A, late)).records, 0)
  const ghost = await job(A, randomUUID(), 'nope', 1_000_000 + 2, [
    { tool: 'slot-0', grams: 40 },
  ])
  assert.equal((await store.recordJob(A, ghost)).records, 0)
  assert.equal(await spoolUsed(A, 3), before)
  assert.equal(await spoolUsed(A, 1), 100)
})

test('sweep records new jobs once and stays inside each farm', async () => {
  const mine = await job(A, agentA, 'p1', 2_000_000, [
    { tool: 'slot-0', grams: 10 },
  ])
  await job(B, agentB, 'p1', 2_000_001, [{ tool: 'slot-0', grams: 10 }])
  const result = await store.sweep({ sinceMs: 1e9 })
  assert.equal(result.records, 1) // farm B has no slot assignment; the unmapped jobs add nothing
  assert.equal(await spoolUsed(A, 1), 110)
  assert.equal(await spoolUsed(B, 1), 0)
  assert.equal((await store.sweep({ sinceMs: 1e9 })).records, 0)
  const rec =
    await admin`SELECT job_id::float8 AS job FROM farm.spool_usage_records WHERE farm_id=${A}::uuid AND job_id=${mine}`
  assert.equal(rec.length, 1)
})

test('low stock raises one alert per crossing and again only after a restock', async () => {
  await store.run(owner, 'filament-threshold', {
    filamentId: 1,
    thresholdGrams: 1850,
  })
  // remaining for filament 1 is about 1887 g: above the threshold, so far no alert
  assert.equal((await alerts(1)).length, 0)
  const crossing = (await store.run(operator, 'usage-record', {
    spoolId: 1,
    grams: 50,
  })) as { id: string; alerted: boolean }
  assert.equal(crossing.alerted, true)
  const raised = await alerts(1)
  assert.equal(raised.length, 1)
  assert.equal(raised[0]!.data.alert.kind, 'low-slot')
  await store.run(operator, 'usage-record', { spoolId: 1, grams: 20 })
  assert.equal((await alerts(1)).length, 1) // not repeated while low

  // A correction that lifts stock above the threshold re-arms the alert.
  await store.run(operator, 'usage-correct', { id: crossing.id, grams: 0 })
  const low = (await store.run(viewer, 'low-stock-list', {})) as {
    filaments: { filamentId: number; low: boolean }[]
  }
  assert.equal(low.filaments.find((f) => f.filamentId === 1)!.low, false)
  await store.run(operator, 'usage-record', { spoolId: 1, grams: 100 })
  assert.equal((await alerts(1)).length, 2)

  // The farm default applies to filaments without their own threshold.
  await store.run(owner, 'settings-set', {
    defaultLowStockThresholdGrams: 300,
    currency: 'BRL',
  })
  await store.run(operator, 'usage-record', { spoolId: 3, grams: 250 })
  assert.equal((await alerts(2)).length, 1)
  await store.run(operator, 'usage-record', { spoolId: 3, grams: 10 })
  assert.equal((await alerts(2)).length, 1)
  assert.equal((await alerts(2))[0]!.data.alert.kind, 'low-slot')
})

test('spool used weight always equals the sum of its usage records', async () => {
  const mismatch =
    await admin`SELECT s.id::float8 AS id FROM farm.spools s WHERE s.used_weight <> COALESCE((SELECT sum(u.grams) FROM farm.spool_usage_records u WHERE u.farm_id=s.farm_id AND u.spool_id=s.id),0) AND abs(s.used_weight - COALESCE((SELECT sum(u.grams) FROM farm.spool_usage_records u WHERE u.farm_id=s.farm_id AND u.spool_id=s.id),0)) > 1e-9`
  assert.equal(mismatch.length, 0)
  const corrected =
    await admin`SELECT corrected_by FROM farm.spool_usage_records WHERE farm_id=${A}::uuid AND grams=0`
  assert.deepEqual(
    corrected.map((r) => r.corrected_by),
    ['operator'],
  )
})

test('reports group usage and cost and list inventory with the low-stock list', async () => {
  const byFilament = (await store.run(viewer, 'report-usage', {
    groupBy: 'filament',
  })) as {
    currency: string
    rows: { filamentId: number; records: number; grams: number; cost: number }[]
  }
  assert.equal(byFilament.currency, 'BRL')
  const pla = byFilament.rows.find((r) => r.filamentId === 1)!
  assert.equal(pla.records, 6)
  const petg = byFilament.rows.find((r) => r.filamentId === 2)!
  assert.equal(petg.grams, 260)
  assert.ok(Math.abs(petg.cost - (20 / 500) * 260) < 1e-9)

  const byPrinter = (await store.run(viewer, 'report-usage', {
    groupBy: 'printer',
  })) as { rows: { printerKey: string | null; records: number }[] }
  assert.deepEqual(
    byPrinter.rows.map((r) => [r.printerKey, r.records]).sort(),
    [
      ['p1', 3],
      [null, 5],
    ].sort(),
  )
  const byJob = (await store.run(viewer, 'report-usage', {
    groupBy: 'job',
  })) as { rows: { jobId: number | null }[] }
  assert.equal(byJob.rows.filter((r) => r.jobId !== null).length, 2)
  const byPeriod = (await store.run(viewer, 'report-usage', {
    groupBy: 'period',
    period: 'month',
    from: 0,
    to: 3_000_000,
  })) as { rows: { period: string; records: number }[] }
  assert.deepEqual(
    byPeriod.rows.map((r) => [r.period, r.records]),
    [['1970-01-01', 8]],
  )
  await assert.rejects(
    store.run(viewer, 'report-usage', { groupBy: 'drop table' }),
    { status: 400 },
  )

  const inventory = (await store.run(viewer, 'report-inventory', {})) as {
    groups: {
      material: string
      location: string
      spools: number
      remainingGrams: number
    }[]
    lowStock: { filamentId: number }[]
  }
  const shelfPla = inventory.groups.find(
    (g) => g.material === 'PLA' && g.location === 'shelf',
  )!
  assert.equal(shelfPla.remainingGrams, 1000 - (100 + 10 + 0 + 20 + 100))
  assert.deepEqual(
    inventory.lowStock.map((f) => f.filamentId),
    [1, 2],
  )

  const csv = toCsv(['material', 'location', 'spools'], inventory.groups)
  assert.match(csv, /^material,location,spools\r\nPETG,shelf,1\r\n/)
  assert.equal(
    toCsv(['a'], [{ a: '=1+1' }, { a: 'x,"y"' }]),
    `a\r\n'=1+1\r\n"x,""y"""\r\n`,
  )
})

test('another farm can neither read nor change this farm data', async () => {
  const mine = (await store.run(other, 'usage-list', {})) as {
    records: unknown[]
  }
  assert.equal(mine.records.length, 0)
  const rep = (await store.run(other, 'report-usage', {
    groupBy: 'filament',
  })) as { rows: unknown[] }
  assert.equal(rep.rows.length, 0)
  const inv = (await store.run(other, 'report-inventory', {})) as {
    groups: { remainingGrams: number }[]
  }
  assert.equal(inv.groups.length, 1)
  assert.equal(inv.groups[0]!.remainingGrams, 1000)

  const [record] =
    await admin`SELECT id FROM farm.spool_usage_records WHERE farm_id=${A}::uuid LIMIT 1`
  await assert.rejects(
    store.run(other, 'usage-correct', { id: record!.id, grams: 1 }),
    { status: 404 },
  )
  await assert.rejects(
    store.run(other, 'usage-record', { spoolId: 3, grams: 5 }),
    { status: 404 },
  )
  await assert.rejects(
    store.run(other, 'filament-threshold', {
      filamentId: 2,
      thresholdGrams: 1,
    }),
    { status: 404 },
  )
  await assert.rejects(store.run(authority(A, 'other'), 'usage-list', {}), {
    status: 404,
  })
  await assert.rejects(
    store.run(authority(A, 'other'), 'report-inventory', {}),
    { status: 404 },
  )
  assert.equal((await store.recordJob(B, 1)).records, 0)
  assert.equal(await spoolUsed(B, 1), 0)
  assert.equal(await spoolUsed(A, 3), 260)
  const stillThere =
    await admin`SELECT low_stock_threshold_grams FROM farm.spool_filaments WHERE farm_id=${A}::uuid AND id=2`
  assert.equal(stillThere[0]!.low_stock_threshold_grams, null)
  const settingsB = (await store.run(other, 'settings-get', {})) as {
    currency: string
    defaultLowStockThresholdGrams: number | null
  }
  assert.deepEqual(settingsB, {
    currency: 'USD',
    defaultLowStockThresholdGrams: null,
  })
})

test('role and input rules', async () => {
  await assert.rejects(
    store.run(viewer, 'usage-record', { spoolId: 1, grams: 5 }),
    { status: 403 },
  )
  await assert.rejects(
    store.run(viewer, 'usage-correct', { id: randomUUID(), grams: 5 }),
    { status: 403 },
  )
  await assert.rejects(
    store.run(operator, 'settings-set', { currency: 'EUR' }),
    { status: 403 },
  )
  await assert.rejects(store.run(owner, 'settings-set', { currency: 'eur' }), {
    status: 400,
  })
  await assert.rejects(store.run(owner, 'settings-set', {}), { status: 400 })
  await assert.rejects(
    store.run(operator, 'usage-record', { spoolId: 1, grams: -1 }),
    { status: 400 },
  )
  await assert.rejects(
    store.run(operator, 'usage-record', {
      spoolId: 1,
      grams: 5,
      source: 'telemetry',
    }),
    { status: 400 },
  )
  await assert.rejects(
    store.run(operator, 'usage-record', { spoolId: 99, grams: 5 }),
    { status: 404 },
  )
  await assert.rejects(
    store.run(operator, 'usage-record', {
      spoolId: 1,
      grams: 5,
      jobId: 987654,
    }),
    { status: 404 },
  )
  await assert.rejects(
    store.run(operator, 'usage-correct', { id: randomUUID(), grams: 5 }),
    { status: 404 },
  )
  await assert.rejects(store.run(authority(A, 'nobody'), 'usage-list', {}), {
    status: 401,
  })
})
