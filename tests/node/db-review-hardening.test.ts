import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const migration = async (name: string) =>
  readFile(
    new URL(`../../infra/db/migrations/${name}`, import.meta.url),
    'utf8',
  )

test('0090 bounds audit retention to database time and rejects NULL prune inputs', async () => {
  const sql = await migration('0090_review_601_retention.up.sql')

  assert.match(sql, /clock_timestamp\(\)/i)
  assert.match(sql, /occurred_at\s*<=?/i)
  assert.match(sql, /7776000000/)
  assert.match(sql, /IF\s+(?:telemetry_days|.*IS NULL)/is)
  assert.match(sql, /telemetry_days\s+IS\s+NULL/i)
  assert.match(sql, /job_history_days\s+IS\s+NULL/i)
  assert.match(sql, /batch_size\s+IS\s+NULL/i)
  assert.match(sql, /Invalid telemetry retention settings/i)
})

test('0091 removes reader revoked_at update while retaining last_seen_at update', async () => {
  const sql = await migration('0091_review_602_session_grants.up.sql')

  for (const role of ['farm_printer_state_reader', 'farm_job_history_reader']) {
    assert.match(
      sql,
      new RegExp(
        `REVOKE\\s+UPDATE\\s*\\(\\s*revoked_at\\s*\\)\\s+ON\\s+farm\\.account_sessions\\s+FROM\\s+${role}`,
        'i',
      ),
    )
  }
  assert.match(
    sql,
    /GRANT\s+UPDATE\s*\(\s*last_seen_at\s*\)\s+ON\s+farm\.account_sessions\s+TO\s+farm_printer_state_reader/i,
  )
  assert.match(
    sql,
    /GRANT\s+UPDATE\s*\(\s*last_seen_at\s*\)\s+ON\s+farm\.account_sessions\s+TO\s+farm_job_history_reader/i,
  )
})

test('down migrations reverse the forward changes', async () => {
  const [retentionDown, grantsDown] = await Promise.all([
    migration('0090_review_601_retention.down.sql'),
    migration('0091_review_602_session_grants.down.sql'),
  ])
  assert.match(
    retentionDown,
    /CREATE OR REPLACE FUNCTION farm\.prune_telemetry/i,
  )
  assert.match(
    retentionDown,
    /CREATE OR REPLACE FUNCTION farm\.prune_integration_audit/i,
  )
  assert.match(
    grantsDown,
    /GRANT\s+UPDATE\s*\(\s*last_seen_at\s*,\s*revoked_at\s*\)/i,
  )
})
