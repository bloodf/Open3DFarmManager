import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('alert actions retain the acting app and the reader selects only that app’s history', () => {
  const migration = source(
    'infra/db/migrations/0098_integration_alert_lifecycle.up.sql',
  )
  const post = source(
    'apps/farm/server/api/integrations/v1/alerts/[id]/[alertId].post.ts',
  )
  const get = source('apps/farm/server/api/integrations/v1/alerts/[id].get.ts')
  expect(migration).toMatch(
    /CREATE TABLE farm\.integration_alert_actions[\s\S]*app_id uuid NOT NULL[\s\S]*acted_at bigint NOT NULL/,
  )
  expect(post).toMatch(
    /INSERT INTO farm\.integration_alert_actions \(alert_id, app_id, action, acted_at, silenced_until\)/,
  )
  expect(get).toMatch(/alert_id = lifecycle\.id AND app_id = \$\{appId\}::uuid/)
  expect(get).toMatch(/resolved_at IS NULL AND acknowledged_at IS NULL/)
})

test('rollback refuses to discard retained lifecycle history', () => {
  const down = source(
    'infra/db/migrations/0098_integration_alert_lifecycle.down.sql',
  )
  expect(down).toMatch(
    /LOCK TABLE farm\.integration_alert_lifecycle[\s\S]*IF EXISTS \(SELECT 1 FROM farm\.integration_alert_lifecycle\)[\s\S]*RAISE EXCEPTION[\s\S]*DROP TABLE farm\.integration_alert_lifecycle/,
  )
})

test('connector advertises every configured camera assignment', () => {
  const agent = source('packages/connector/src/runtime/agent.ts')
  expect(agent).toMatch(
    /cameraAssignments: config\.camera\.cameras\.map\(\s*\(camera\) => camera\.assignmentId,?\s*\)/,
  )
})
