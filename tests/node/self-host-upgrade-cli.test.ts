import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { upgrade } from '../../scripts/self-host/upgrade.ts'

test('documented upgrade command prints its dry-run plan and exits successfully', () => {
  const result = spawnSync(
    process.execPath,
    [
      resolve('scripts/self-host/upgrade.ts'),
      '--version',
      'v2',
      '--compose',
      'deploy.yml',
      '--backup',
      '/tmp/upgrade.dump',
      '--dry-run',
    ],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /preflight: validate persistent volumes and disk/)
  assert.match(result.stdout, /backup: pg_dump/)
})

test('dump failure preserves cause and removes partial backup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'self-host-upgrade-'))
  const backup = join(directory, 'partial.dump')
  const config = {
    services: {
      postgres: {
        volumes: [
          { type: 'volume', source: 'db', target: '/var/lib/postgresql/data' },
        ],
      },
      connector: {
        command: ['run', '--data-dir', '/data'],
        volumes: [{ type: 'volume', source: 'connector', target: '/data' }],
      },
      app: {
        image: 'app:v2',
        environment: { NUXT_DATABASE_MIGRATIONS: 'apply' },
      },
    },
    volumes: { db: { name: 'db' }, connector: { name: 'connector' } },
  }
  try {
    await assert.rejects(
      upgrade(
        {
          version: 'v2',
          compose: 'deploy.yml',
          backup,
          ready: 'http://localhost/readyz',
        },
        async (args, output) => {
          if (args.includes('config')) return JSON.stringify(config)
          if (output) await writeFile(output, 'partial dump')
          throw new Error('pg_dump exited with code 7')
        },
        async () => 2 * 1024 ** 3,
      ),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Restore:') &&
        error.cause instanceof Error &&
        error.cause.message === 'pg_dump exited with code 7',
    )
    await assert.rejects(readFile(backup))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
