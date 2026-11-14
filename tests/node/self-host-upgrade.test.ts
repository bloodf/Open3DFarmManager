import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upgrade, volumes } from '../../scripts/self-host/upgrade.ts'
const options = {
  version: 'v2',
  compose: 'deploy.yml',
  backup: '/tmp/backup',
  ready: 'http://localhost/readyz',
}
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
test('dry run executes nothing', async () => {
  assert.match(
    await upgrade(
      { ...options, dryRun: true },
      async () => {
        throw Error('executed')
      },
      async () => 0,
    ),
    /pg_dump/,
  )
})
test('happy sequence never removes volumes', async () => {
  const calls: string[][] = []
  await upgrade(
    options,
    async (args) => {
      calls.push(args)
      return args.includes('config') ? JSON.stringify(config) : 'ok'
    },
    async () => 2 * 1024 ** 3,
  )
  assert.deepEqual(
    calls.map((a) => (a[0] === 'ready' ? 'ready' : a[3])),
    ['config', 'exec', 'config', 'pull', 'up', 'ready'],
  )
  assert.ok(calls.every((a) => !a.includes('down') && !a.includes('-v')))
})
test('backup failure stops before pull and redacts secrets', async () => {
  const calls: string[][] = []
  await assert.rejects(
    upgrade(
      options,
      async (args) => {
        calls.push(args)
        if (args.includes('exec')) throw Error('password=secret')
        return JSON.stringify(config)
      },
      async () => 2 * 1024 ** 3,
    ),
    (e) => !String(e).includes('secret') && String(e).includes('Restore:'),
  )
  assert.equal(calls.length, 2)
})
test('timeout gives restore instructions', async () => {
  await assert.rejects(
    upgrade(
      options,
      async (args) => (args.includes('config') ? JSON.stringify(config) : ''),
      async () => 2 * 1024 ** 3,
    ),
    /Restore:/,
  )
})
test('volume changes refused before pull', async () => {
  let reads = 0
  const calls: string[][] = []
  await assert.rejects(
    upgrade(
      options,
      async (args) => {
        calls.push(args)
        if (args.includes('config')) {
          const c = structuredClone(config)
          if (reads++) c.volumes.db.name = 'changed'
          return JSON.stringify(c)
        }
        return ''
      },
      async () => 2 * 1024 ** 3,
    ),
  )
  assert.ok(!calls.some((a) => a.includes('pull')))
  assert.throws(() =>
    volumes({ services: { postgres: { volumes: [{ type: 'bind' }] } } }),
  )
})

test('two Postgres volumes cannot replace Connector persistence', async () => {
  const invalid = structuredClone(config)
  invalid.services.postgres.volumes.push({
    type: 'volume',
    source: 'connector',
    target: '/extra',
  })
  const calls: string[][] = []
  await assert.rejects(
    upgrade(
      options,
      async (args) => {
        calls.push(args)
        return JSON.stringify({
          ...invalid,
          services: { ...invalid.services, connector: {} },
        })
      },
      async () => 2 * 1024 ** 3,
    ),
    /Backup not confirmed/,
  )
  assert.deepEqual(calls, [
    ['compose', '-f', options.compose, 'config', '--format', 'json'],
  ])
})
for (const service of ['postgres', 'connector'] as const) {
  test(`${service} requires a named volume at its data target`, () => {
    for (const change of [
      { target: '/wrong' },
      { type: 'bind' },
      { source: '' },
    ]) {
      const invalid = structuredClone(config)
      Object.assign(invalid.services[service].volumes[0]!, change)
      assert.throws(() => volumes(invalid))
    }
  })
}
