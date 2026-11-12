import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTHORITY_AUDIT_MAX_BYTES,
  recordAuthorityStale,
} from '../../packages/connector/src/runtime/pause-authority-audit.ts'

function directory(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'pause-authority-audit-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test('each stale transition appends one private durable audit line', (t) => {
  const data = directory(t)
  const failures: unknown[] = []
  recordAuthorityStale(data, 'expired', (v) => failures.push(v), 1000)
  recordAuthorityStale(data, 'revoked', (v) => failures.push(v), 2000)
  const path = join(data, 'pause-journal', 'authority-audit.jsonl')
  assert.deepEqual(failures, [])
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.deepEqual(
    readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [
      { at: 1000, event: 'stale', reason: 'expired' },
      { at: 2000, event: 'stale', reason: 'revoked' },
    ],
  )
})

test('a symlinked, shared or full audit file is refused with a diagnostic', (t) => {
  const data = directory(t)
  const journal = join(data, 'pause-journal')
  mkdirSync(journal, { mode: 0o700 })
  const target = join(data, 'elsewhere')
  writeFileSync(target, '', { mode: 0o600 })
  symlinkSync(target, join(journal, 'authority-audit.jsonl'))
  const failures: unknown[] = []
  recordAuthorityStale(data, 'clock', (v) => failures.push(v))
  assert.equal(readFileSync(target, 'utf8'), '')

  const shared = directory(t)
  mkdirSync(join(shared, 'pause-journal'), { mode: 0o700 })
  writeFileSync(join(shared, 'pause-journal', 'authority-audit.jsonl'), '', {
    mode: 0o644,
  })
  recordAuthorityStale(shared, 'clock', (v) => failures.push(v))

  const full = directory(t)
  mkdirSync(join(full, 'pause-journal'), { mode: 0o700 })
  writeFileSync(
    join(full, 'pause-journal', 'authority-audit.jsonl'),
    'x'.repeat(AUTHORITY_AUDIT_MAX_BYTES),
    { mode: 0o600 },
  )
  recordAuthorityStale(full, 'clock', (v) => failures.push(v))
  assert.deepEqual(failures, [
    { kind: 'pause-audit-failed' },
    { kind: 'pause-audit-failed' },
    { kind: 'pause-audit-failed' },
  ])
})
