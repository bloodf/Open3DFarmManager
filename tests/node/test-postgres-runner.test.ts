import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  MIGRATION_ROUND_TRIP,
  MIGRATION_PREFIX_ROUND_TRIP,
  PG_SUITE_CONTRACTS,
  discoverPostgresSuites,
  formatSummary,
  planJobs,
  runSuites,
} from '../../scripts/test-postgres.ts'

test('discovers test-postgres-*.ts suites sorted and ignores the runner itself', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pg-runner-discovery-'))
  try {
    for (const name of [
      'test-postgres-b.ts',
      'test-postgres-a.ts',
      'test-postgres.ts', // the runner must not discover itself
      'test-postgres-notes.md',
      'unrelated.ts',
    ])
      await writeFile(join(dir, name), '// fixture\n')
    assert.deepEqual(await discoverPostgresSuites(dir), [
      'test-postgres-a.ts',
      'test-postgres-b.ts',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('every discovered suite has a contract and the round trip runs first', async () => {
  const discovered = await discoverPostgresSuites(
    new URL('../../scripts/', import.meta.url),
  )
  assert.ok(discovered.length >= 20, `expected every suite, got ${discovered}`)
  assert.deepEqual(discovered, Object.keys(PG_SUITE_CONTRACTS).sort())
  const jobs = planJobs(discovered)
  assert.equal(jobs[0], MIGRATION_ROUND_TRIP)
  assert.equal(jobs[1], MIGRATION_PREFIX_ROUND_TRIP)
  assert.equal(jobs.length, discovered.length + 2)
})

test('pause authority uses its asserted migration prefix', () => {
  assert.equal(
    PG_SUITE_CONTRACTS['test-postgres-pause-authority.ts']?.migrations,
    '0018_pause_authority',
  )
})

test('contracts carry admitted markers and a migration state', () => {
  for (const [suite, contract] of Object.entries(PG_SUITE_CONTRACTS)) {
    assert.ok(
      contract.migrations === 'full' ||
        contract.migrations === 'none' ||
        contract.migrations === 'self' ||
        /^\d{4}_[a-z][a-z0-9_]*$/.test(contract.migrations),
      `${suite}: migration state`,
    )
    if (contract.fixture)
      assert.ok(
        /^[A-Z0-9_]+$/.test(contract.fixture.admitted),
        `${suite}: admitted env name`,
      )
    if (contract.selfContained) {
      assert.ok(/^[A-Z0-9_]+$/.test(contract.selfContained.admitted))
      assert.ok(/^[A-Z0-9_]+$/.test(contract.selfContained.image))
    }
    assert.ok(
      contract.fixture || contract.selfContained,
      `${suite}: one execution mode`,
    )
  }
})

test('stops every started fixture before the next job and names failures', async () => {
  const events: string[] = []
  const order = ['migration-round-trip', 'suite-a', 'suite-b', 'suite-c']
  const results = await runSuites({
    order,
    start: async (name) => {
      events.push(`start:${name}`)
      if (name === 'suite-c') throw new Error('no port available')
      return { name }
    },
    invoke: async (name) => {
      events.push(`invoke:${name}`)
      if (name === 'suite-b') throw new Error('assertion exploded\nstack line')
    },
    stop: async (name) => {
      events.push(`stop:${name}`)
    },
  })
  assert.deepEqual(events, [
    'start:migration-round-trip',
    'invoke:migration-round-trip',
    'stop:migration-round-trip',
    'start:suite-a',
    'invoke:suite-a',
    'stop:suite-a',
    'start:suite-b',
    'invoke:suite-b',
    'stop:suite-b', // stop still runs after a failed invoke
    'start:suite-c', // start failure: no invoke, no stop for this job
  ])
  assert.deepEqual(
    results.map((result) => [result.name, result.ok]),
    [
      ['migration-round-trip', true],
      ['suite-a', true],
      ['suite-b', false],
      ['suite-c', false],
    ],
  )
  assert.match(results[2]?.error ?? '', /assertion exploded/)
  assert.match(results[3]?.error ?? '', /fixture: no port available/)
})

test('a failing fixture cleanup marks the job failed and is reported', async () => {
  const results = await runSuites({
    order: ['suite-x'],
    start: async () => ({}),
    invoke: async () => {},
    stop: async () => {
      throw new Error('container still present')
    },
  })
  assert.equal(results[0]?.ok, false)
  assert.match(results[0]?.error ?? '', /cleanup: container still present/)
})

test('summary names failing suites and counts passes and failures', () => {
  const text = formatSummary([
    { name: 'migration-round-trip', ok: true, ms: 1200 },
    { name: 'test-postgres-good.ts', ok: true, ms: 3400 },
    {
      name: 'test-postgres-broken.ts',
      ok: false,
      ms: 500,
      error: 'catalog length mismatch',
    },
  ])
  assert.match(text, /ok {3}migration-round-trip \(1\.2s\)/)
  assert.match(text, /ok {3}test-postgres-good\.ts \(3\.4s\)/)
  assert.match(
    text,
    /FAIL test-postgres-broken\.ts \(0\.5s\) — catalog length mismatch/,
  )
  assert.match(text, /3 jobs, 2 passed, 1 failed/)
  assert.match(text, /failing: test-postgres-broken\.ts/)
  assert.ok(
    !formatSummary([{ name: 'a', ok: true, ms: 1 }]).includes('failing'),
  )
})
