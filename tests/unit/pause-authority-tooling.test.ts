import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
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
// The child kill bound stays below the case budget so a stalled child reports
// its own diagnostic.
const CHILD_TIMEOUT_MS = 5000
const CASE_TIMEOUT_MS = 30000

function git(args: string[]) {
  const result = spawnSync('git', args, {
    cwd: checkout,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  })
  assert.equal(
    result.status,
    0,
    `git ${args[0]} failed: ${JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
    })}`,
  )
}

test(
  'restart handoff rejects the checkout and test-owned linked worktrees before connecting to PG',
  { timeout: CASE_TIMEOUT_MS },
  (t) => {
    // Linked worktrees owned by this test, not other tasks' checkouts that can
    // appear or vanish mid-run. Orphan worktrees have no files, so a plain
    // `git worktree remove` cleans them and their unborn branch leaves no ref.
    const parent = mkdtempSync(join(tmpdir(), 'o3dfm-handoff-worktrees-'))
    const owned: string[] = []
    t.after(() => {
      for (const root of owned) git(['worktree', 'remove', root])
      rmdirSync(parent)
    })
    for (const name of ['first', 'second']) {
      const root = join(parent, name)
      git([
        'worktree',
        'add',
        '--quiet',
        '--orphan',
        '-b',
        `test-handoff-${randomUUID()}`,
        root,
      ])
      owned.push(root)
    }
    for (const sibling of [checkout, ...owned]) {
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
