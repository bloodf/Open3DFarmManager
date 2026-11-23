import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'

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

vi.mock('nuxt/server', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).nuxtServer(),
)
vi.mock('../../apps/farm/server/utils/integration-auth-runtime.ts', async () =>
  (await import('../helpers/api-v1-contract/mocks.ts')).authRuntime(),
)

test('alert actions affect only the acting app', async () => {
  const { freshWorld, ids } =
    await import('../helpers/api-v1-contract/world.ts')
  const { tokenFor } = await import('../helpers/api-v1-contract/scenarios.ts')
  const { call } = await import('../helpers/api-v1-contract/router.ts')
  const world = freshWorld()
  const appA = world.addApp([{ scopes: ['printers:read', 'alerts:write'] }])
  const appB = world.addApp([{ scopes: ['printers:read', 'alerts:write'] }])
  const tokenA = await tokenFor(world, appA)
  const tokenB = await tokenFor(world, appB)
  const path = `/alerts/${ids.printerA1}`
  const read = async (token: string) => {
    const response = await call({ method: 'GET', path, token })
    expect(response.status).toBe(200)
    return (
      response.json as {
        alerts: {
          acknowledgedAt: number | null
          silencedUntil: number | null
          needsAttention: boolean
        }[]
      }
    ).alerts[0]!
  }
  const act = async (token: string, body: Record<string, unknown>) => {
    const response = await call({
      method: 'POST',
      path: `${path}/${ids.alertA}`,
      token,
      body,
    })
    expect(response.status).toBe(200)
  }
  const until = Date.now() + 60_000
  await act(tokenA, { action: 'silence', until })
  expect(await read(tokenA)).toMatchObject({
    silencedUntil: until,
    needsAttention: false,
  })
  expect(await read(tokenB)).toMatchObject({
    acknowledgedAt: null,
    silencedUntil: null,
    needsAttention: true,
  })
  await act(tokenB, { action: 'acknowledge' })
  expect(await read(tokenB)).toMatchObject({
    acknowledgedAt: expect.any(Number),
    needsAttention: false,
  })
  expect(await read(tokenA)).toMatchObject({
    acknowledgedAt: null,
    silencedUntil: until,
    needsAttention: false,
  })
})

test('repeated alert actions retain one state row per app', async () => {
  const { freshWorld, ids } =
    await import('../helpers/api-v1-contract/world.ts')
  const { tokenFor } = await import('../helpers/api-v1-contract/scenarios.ts')
  const { call } = await import('../helpers/api-v1-contract/router.ts')
  const world = freshWorld()
  const app = world.addApp([{ scopes: ['printers:read', 'alerts:write'] }])
  const token = await tokenFor(world, app)
  const path = `/alerts/${ids.printerA1}/${ids.alertA}`
  const until = Date.now() + 60_000
  for (const body of [
    { action: 'silence', until },
    { action: 'acknowledge' },
    { action: 'silence', until: until + 10_000 },
    { action: 'acknowledge' },
  ]) {
    const response = await call({ method: 'POST', path, token, body })
    expect(response.status).toBe(200)
  }
  expect(world.alertActionCount).toBe(1)
})
