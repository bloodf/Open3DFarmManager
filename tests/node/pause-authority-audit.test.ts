import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
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

test('a symlinked or shared audit file and a non-private journal directory are refused', (t) => {
  const failures: unknown[] = []
  const linked = directory(t)
  const journal = join(linked, 'pause-journal')
  mkdirSync(journal, { mode: 0o700 })
  const target = join(linked, 'elsewhere')
  writeFileSync(target, '', { mode: 0o600 })
  symlinkSync(target, join(journal, 'authority-audit.jsonl'))
  recordAuthorityStale(linked, 'clock', (v) => failures.push(v))
  assert.equal(readFileSync(target, 'utf8'), '')

  const shared = directory(t)
  mkdirSync(join(shared, 'pause-journal'), { mode: 0o700 })
  writeFileSync(join(shared, 'pause-journal', 'authority-audit.jsonl'), '', {
    mode: 0o644,
  })
  recordAuthorityStale(shared, 'clock', (v) => failures.push(v))

  const openDirectory = directory(t)
  mkdirSync(join(openDirectory, 'pause-journal'))
  chmodSync(join(openDirectory, 'pause-journal'), 0o755)
  recordAuthorityStale(openDirectory, 'clock', (v) => failures.push(v))

  const linkedDirectory = directory(t)
  const real = join(linkedDirectory, 'real')
  mkdirSync(real, { mode: 0o700 })
  symlinkSync(real, join(linkedDirectory, 'pause-journal'))
  recordAuthorityStale(linkedDirectory, 'clock', (v) => failures.push(v))
  assert.equal(existsSync(join(real, 'authority-audit.jsonl')), false)

  assert.deepEqual(failures, [
    { kind: 'pause-audit-failed' },
    { kind: 'pause-audit-failed' },
    { kind: 'pause-audit-failed' },
    { kind: 'pause-audit-failed' },
  ])
})

test('a full audit file rotates to .1 and recording continues', (t) => {
  const data = directory(t)
  const journal = join(data, 'pause-journal')
  mkdirSync(journal, { mode: 0o700 })
  const path = join(journal, 'authority-audit.jsonl')
  writeFileSync(path, 'x'.repeat(AUTHORITY_AUDIT_MAX_BYTES), { mode: 0o600 })
  const failures: unknown[] = []
  recordAuthorityStale(data, 'expired', (v) => failures.push(v), 5)
  assert.deepEqual(failures, [])
  assert.equal(statSync(path + '.1').size, AUTHORITY_AUDIT_MAX_BYTES)
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    at: 5,
    event: 'stale',
    reason: 'expired',
  })
})
