import test from 'node:test'
import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquirePrivateLock } from '../../packages/connector/src/provisioning/private-fs.ts'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-prov-lock-'))
  chmodSync(dir, 0o700)
  return dir
}

function withLock(content: string, run: (path: string) => void): void {
  const dir = scratch()
  try {
    const path = join(dir, 'provisioning.lock')
    writeFileSync(path, content, { mode: 0o600 })
    run(path)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a lock left by a previous run with the same PID is recovered', () => {
  // Legacy PID-only lock from a prior process that reused this PID after restart.
  withLock(`${process.pid}\n`, (path) => {
    const release = acquirePrivateLock(path)
    assert.notEqual(release, null)
    const body = readFileSync(path, 'utf8')
    assert.match(body, new RegExp(`^${process.pid}\\n`))
    assert.notEqual(body, `${process.pid}\n`)
    release?.()
  })
})

test('a lock with the same PID but a different start time is recovered', () => {
  const stale = `${process.pid}\n999999999999\n`
  withLock(stale, (path) => {
    const release = acquirePrivateLock(path)
    assert.notEqual(release, null)
    assert.notEqual(readFileSync(path, 'utf8'), stale)
    release?.()
  })
})

test('an empty lock file is treated as stale and replaced', () => {
  withLock('', (path) => {
    const release = acquirePrivateLock(path)
    assert.notEqual(release, null)
    assert.notEqual(readFileSync(path, 'utf8'), '')
    release?.()
  })
})

test('a live holder with a matching start time is not displaced', () => {
  const dir = scratch()
  try {
    const path = join(dir, 'provisioning.lock')
    const first = acquirePrivateLock(path)
    assert.notEqual(first, null)
    const before = readFileSync(path, 'utf8')
    assert.equal(acquirePrivateLock(path), null)
    assert.equal(readFileSync(path, 'utf8'), before)
    first?.()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
