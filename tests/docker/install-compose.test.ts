import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

test('compose config hardens the app and exposes readiness on loopback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openfarm-compose-'))
  try {
    const envFile = join(dir, 'app.env')
    writeFileSync(envFile, 'NUXT_DATABASE_DATABASE_URL=postgres://example\n')
    const source = resolve('infra/app/docker-compose.yml')
    // Override the env file path without creating an operator file in the checkout.
    const override = join(dir, 'override.yml')
    writeFileSync(
      override,
      `services:\n  app:\n    env_file: !override\n      - ${envFile}\n`,
    )
    const config = JSON.parse(
      execFileSync(
        'docker',
        ['compose', '-f', source, '-f', override, 'config', '--format', 'json'],
        {
          env: {
            ...process.env,
            O3DFM_DB_PASSWORD: 'test-only',
            O3DFM_APP_IMAGE: 'example.invalid/app:test',
          },
          encoding: 'utf8',
        },
      ),
    )
    const app = config.services.app
    assert.equal(app.read_only, true)
    assert.deepEqual(app.cap_drop, ['ALL'])
    assert.ok(app.security_opt.includes('no-new-privileges:true'))
    assert.equal(app.ports[0].host_ip, '127.0.0.1')
    assert.equal(app.environment.NUXT_DATABASE_MIGRATIONS, 'apply')
    assert.equal(app.depends_on.postgres.condition, 'service_healthy')
    assert.match(app.healthcheck.test.join(' '), /\/readyz/)
    assert.ok(app.cpus && app.mem_limit && app.pids_limit)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
