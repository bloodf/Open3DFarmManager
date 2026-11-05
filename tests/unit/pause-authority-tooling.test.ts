import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { Sql } from 'postgres'
import { testPostgresPauseAuthority } from '../helpers/postgres-pause-authority-integration.ts'

for (const cleanupFails of [false, true]) {
  test(`partial role setup is cleaned; cleanup failure=${cleanupFails}`, async () => {
    const setupError = new Error('second role creation failed')
    const cleanupError = new Error('role removal failed')
    const statements: string[] = []
    let creations = 0
    const admin = ((parts: TemplateStringsArray | string) => {
      if (typeof parts === 'string') return parts
      const query = parts.join('?')
      statements.push(query)
      if (query.startsWith('CREATE ROLE') && ++creations === 2)
        return Promise.reject(setupError)
      if (query.startsWith('DROP ROLE') && cleanupFails)
        return Promise.reject(cleanupError)
      return Promise.resolve([])
    }) as unknown as Sql
    await assert.rejects(testPostgresPauseAuthority(admin, 15433), (error) => {
      if (!cleanupFails) return error === setupError
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [setupError, cleanupError])
      return true
    })
    assert.deepEqual(
      statements.map((sql) => sql.split(' ').slice(0, 2).join(' ')),
      ['CREATE ROLE', 'CREATE ROLE', 'DROP ROLE'],
    )
  })
}

test('restart handoff rejects every registered worktree before connecting to PG', () => {
  const checkout = fileURLToPath(new URL('../../', import.meta.url))
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(listed.status, 0)
  const roots = listed.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9))
  assert.ok(roots.length > 0)
  for (const sibling of roots) {
    const result = spawnSync(
      process.execPath,
      ['scripts/test-postgres-pause-authority.ts', 'prepare-restart'],
      {
        cwd: checkout,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE: 'yes',
          PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT: '15433',
          PAUSE_AUTHORITY_SYNTHETIC_RESTART_BASE: `${sibling}/must-not-be-written`,
        },
      },
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /outside every repository worktree/)
    assert.doesNotMatch(result.stderr, /ECONNREFUSED|PostgresError/)
  }
})
