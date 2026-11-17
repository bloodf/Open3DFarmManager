import test from 'node:test'
import assert from 'node:assert/strict'
import type { Sql } from 'postgres'
import {
  parseTelemetryPruneConfig,
  pruneTelemetry,
} from '../../apps/farm/server/services/prune-telemetry.ts'

test('telemetry prune defaults are documented values and disabled by default', () => {
  assert.equal(parseTelemetryPruneConfig({ enabled: false }), undefined)
  assert.deepEqual(
    parseTelemetryPruneConfig({
      enabled: true,
      databaseUrl: 'postgresql://pruner:secret@localhost/farm',
    }),
    {
      databaseUrl: 'postgresql://pruner:secret@localhost/farm',
      intervalMs: 3600000,
      telemetryRetentionDays: 30,
      jobHistoryRetentionDays: 365,
      batchSize: 500,
    },
  )
})

test('telemetry prune rejects unsafe settings', () => {
  for (const value of [
    { enabled: true, databaseUrl: 'file:db' },
    { enabled: true, databaseUrl: 'postgres://localhost/db', intervalMs: 1 },
    {
      enabled: true,
      databaseUrl: 'postgres://localhost/db',
      telemetryRetentionDays: 0,
    },
    {
      enabled: true,
      databaseUrl: 'postgres://localhost/db',
      jobHistoryRetentionDays: 3651,
    },
    { enabled: true, databaseUrl: 'postgres://localhost/db', batchSize: 10001 },
  ])
    assert.throws(() => parseTelemetryPruneConfig(value))
})

test('prune uses a bounded configured batch inside short database timeouts', async () => {
  const statements: string[] = []
  const query = Object.assign(
    async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const statement = strings.join('?').replace(/\s+/g, ' ').trim()
      statements.push(statement)
      if (statement.startsWith('SELECT telemetry_deleted'))
        return [{ telemetryDeleted: '7', jobsDeleted: '3' }]
      return []
    },
    { begin: async <T>(work: (tx: typeof query) => Promise<T>) => work(query) },
  )
  const result = await pruneTelemetry(query as unknown as Sql, {
    telemetryRetentionDays: 30,
    jobHistoryRetentionDays: 365,
    batchSize: 17,
  })
  assert.deepEqual(result, { telemetryDeleted: 7, jobsDeleted: 3 })
  assert.match(statements[0] ?? '', /statement_timeout = '5000ms'/)
  assert.match(statements[1] ?? '', /lock_timeout = '1000ms'/)
  assert.match(
    statements[2] ?? '',
    /farm\.prune_telemetry\(\s*\?\s*,\s*\?\s*,\s*\?\s*\)/,
  )
})
