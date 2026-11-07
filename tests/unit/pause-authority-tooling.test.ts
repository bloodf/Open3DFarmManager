import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
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

const checkout = fileURLToPath(new URL('../../', import.meta.url))
// The registered worktree count grows with the local checkout, so the
// rejection coverage is partitioned into bounded cases. One case per group
// keeps every worktree covered by the real CLI without one fixed test
// deadline absorbing the whole list.
const WORKTREES_PER_CASE = 4
// A child must be killed before its case deadline, and both must stay below
// the case budget so a stalled child reports its own diagnostic.
const CHILD_TIMEOUT_MS = 5000
const CASE_TIMEOUT_MS = 30000

function registeredWorktrees(): string[] {
  const listed = spawnSync('git', ['worktree', 'list', '--porcelain', '-z'], {
    cwd: checkout,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(
    listed.status,
    0,
    `git worktree list failed: ${JSON.stringify({
      status: listed.status,
      signal: listed.signal,
      error: listed.error?.message,
      stderr: listed.stderr,
    })}`,
  )
  const roots = listed.stdout
    .split('\0')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice(9))
  assert.ok(roots.length > 0, 'no registered worktree found')
  return roots
}

const worktrees = registeredWorktrees()

for (let index = 0; index < worktrees.length; index += WORKTREES_PER_CASE) {
  const group = worktrees.slice(index, index + WORKTREES_PER_CASE)
  const first = index + 1
  const last = index + group.length
  test(
    `restart handoff rejects every registered worktree before connecting to PG (worktrees ${first}-${last} of ${worktrees.length})`,
    { timeout: CASE_TIMEOUT_MS },
    () => {
      for (const sibling of group) {
        // The parent directory exists, so the private handoff path is only
        // rejected by the worktree guard and never by a missing directory.
        assert.ok(existsSync(sibling), `missing worktree root ${sibling}`)
        const base = `${sibling}/must-not-be-written`
        const result = spawnSync(
          process.execPath,
          ['scripts/test-postgres-pause-authority.ts', 'prepare-restart'],
          {
            cwd: checkout,
            encoding: 'utf8',
            timeout: CHILD_TIMEOUT_MS,
            killSignal: 'SIGKILL',
            env: {
              ...process.env,
              PAUSE_AUTHORITY_SYNTHETIC_TEST_DISPOSABLE: 'yes',
              PAUSE_AUTHORITY_SYNTHETIC_TEST_PORT: '15433',
              PAUSE_AUTHORITY_SYNTHETIC_RESTART_BASE: base,
            },
          },
        )
        const diagnostic = JSON.stringify({
          sibling,
          status: result.status,
          signal: result.signal,
          error: result.error?.message,
          stderr: result.stderr,
        })
        assert.equal(result.status, 1, `unexpected child exit: ${diagnostic}`)
        assert.match(
          result.stderr,
          /outside every repository worktree/,
          `unexpected rejection reason: ${diagnostic}`,
        )
        assert.doesNotMatch(
          result.stderr,
          /ECONNREFUSED|PostgresError/,
          `child reached PostgreSQL: ${diagnostic}`,
        )
        for (const path of [
          base,
          base + '.private.json',
          base + '.catalog.json',
        ]) {
          assert.equal(
            existsSync(path),
            false,
            `child wrote a handoff file: ${diagnostic}`,
          )
        }
      }
    },
  )
}
