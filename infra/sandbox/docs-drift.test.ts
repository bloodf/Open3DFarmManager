import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'

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

test('Node 22 CI uses its installed bundled Chromium', () => {
  const workflow = read('../../.github/workflows/ci.yml')
  const node22 = workflow.split('  code-node22:')[1]?.split('\n  image:')[0]
  assert.ok(node22)
  assert.match(node22, /OPENFARM_BROWSER:\s*bundled/)
  assert.match(node22, /playwright install --with-deps chromium/)
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
