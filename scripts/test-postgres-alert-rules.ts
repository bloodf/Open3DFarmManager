import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import postgres from 'postgres'
import { alertRulesStore } from '../apps/farm/server/storage/alert-rules-postgres.ts'

const port = Number(process.env.ALERT_RULES_SYNTHETIC_TEST_PORT)
if (
  process.argv.length !== 2 ||
  process.env.ALERT_RULES_SYNTHETIC_TEST_DISPOSABLE !== 'yes' ||
  !Number.isInteger(port) ||
  port < 1024 ||
  port > 65535
)
  throw new Error('Explicit disposable loopback PostgreSQL port required')

const sql = postgres({
  host: '127.0.0.1',
  port,
  database: 'fixture',
  username: 'fixture',
  password: '',
  connect_timeout: 3,
})
const owner = `alert_owner_${randomUUID()}`
const farm = randomUUID()
const app = randomUUID()
const grant = randomUUID()
try {
  await sql`INSERT INTO farm.session_accounts (id) VALUES (${owner})`
  await sql`INSERT INTO farm.farms (id) VALUES (${farm})`
  await sql`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}, ${owner}, 'owner')`
  await sql`INSERT INTO farm.integration_apps (id, farm_id, name, sandbox, created_at, created_by) VALUES (${app}, ${farm}, 'alerts', false, 1, ${owner})`
  await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, created_at, created_by) VALUES (${grant}, ${app}, ${farm}, ARRAY['alerts:manage'], 1, ${owner})`
  const store = alertRulesStore(sql)
  const change = (grantId = grant) =>
    store.manage(app, farm, [grantId], async (settings) => {
      await settings.writeRule('error', false)
      return true
    })
  assert.deepEqual(await change(), { value: true })
  await sql`UPDATE farm.memberships SET role = 'viewer' WHERE farm_id = ${farm} AND account_id = ${owner}`
  assert.equal(await change(), null, 'former owner denied')
  await sql`UPDATE farm.memberships SET role = 'owner' WHERE farm_id = ${farm} AND account_id = ${owner}`
  const missingScope = randomUUID()
  const approval = randomUUID()
  await sql`INSERT INTO farm.integration_app_grants (id, app_id, farm_id, scopes, requires_approval, created_at, created_by) VALUES
    (${missingScope}, ${app}, ${farm}, ARRAY['printers:read'], false, 2, ${owner}),
    (${approval}, ${app}, ${farm}, ARRAY['alerts:manage'], true, 3, ${owner})`
  assert.equal(await change(missingScope), null, 'missing scope denied')
  assert.equal(await change(approval), null, 'approval required denied')
  console.log('alert rules authorization checks passed')
} finally {
  await sql.end({ timeout: 3 })
}
