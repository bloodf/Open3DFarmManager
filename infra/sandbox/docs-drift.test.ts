import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { parse } from 'yaml'

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), 'utf8')

test('sandbox and migration documentation matches its executable entry points', () => {
  const sandbox = read('./README.md')
  const migrations = read('../../docs/DATABASE-MIGRATIONS.md')

  assert.match(sandbox, /node scripts\/sandbox\.ts/)
  assert.doesNotMatch(sandbox, /pnpm run sandbox/)
  assert.match(migrations, /node scripts\/migrate-disposable-db\.ts/)
  assert.doesNotMatch(migrations, /bun scripts\/migrate-disposable-db\.ts/)
  assert.match(migrations, /0026.*(?:floor|durable|refus)/is)
  assert.match(migrations, /does not mean every migration can be reversed/i)
})

test('Spool Library role comment documents both required memberships', () => {
  const config = read('../../apps/farm/nuxt.config.ts')
  assert.match(config, /farm_spool_library.*farm_spool_features/)
})

type WorkflowStep = {
  uses?: string
  with?: Record<string, unknown>
  run?: string
  env?: Record<string, unknown>
}

type WorkflowJob = {
  if?: string
  steps: WorkflowStep[]
}

const ciJobs = () =>
  (
    parse(read('../../.github/workflows/ci.yml')) as {
      jobs: Record<string, WorkflowJob>
    }
  ).jobs

test('Node 22 CI runs its compatibility checks', () => {
  const node22 = ciJobs()['code-node22']
  assert.ok(node22)
  const setup = node22.steps.find((step) =>
    step.uses?.startsWith('actions/setup-node@'),
  )
  assert.match(String(setup?.with?.['node-version']), /^22\./)
  for (const command of [
    'npm run check:all',
    'node packages/connector/dist/cli.js --version',
  ]) {
    assert.ok(
      node22.steps.some((step) => step.run?.trim() === command),
      command,
    )
  }
})

test('manual browser CI uses its installed bundled Chromium for both suites', () => {
  const e2e = ciJobs().e2e
  assert.ok(e2e)
  assert.equal(e2e.if, "github.event_name == 'workflow_dispatch'")
  assert.ok(
    e2e.steps.some((step) =>
      /playwright install --with-deps chromium/.test(step.run ?? ''),
    ),
  )
  for (const command of ['npm run test:e2e:auth-session', 'npm run test:e2e']) {
    const step = e2e.steps.find(
      (candidate) => candidate.run?.trim() === command,
    )
    assert.ok(step, command)
    assert.equal(step.env?.OPENFARM_BROWSER, 'bundled', command)
  }
})

test('app and sandbox pin the same PostgreSQL image and sandbox matches .nvmrc', () => {
  const app = read('../app/docker-compose.yml')
  const sandbox = read('./compose.yml')
  const nvmrc = read('../../.nvmrc').trim()
  const appPostgres = app.match(/postgres:17@sha256:[a-f0-9]+/)?.[0]
  const sandboxPostgres = sandbox.match(/postgres:17@sha256:[a-f0-9]+/)?.[0]
  const sandboxNode = sandbox.match(/node:([0-9.]+)-bookworm-slim/)?.[1]

  assert.ok(appPostgres)
  assert.equal(sandboxPostgres, appPostgres)
  assert.equal(sandboxNode, nvmrc)
})
