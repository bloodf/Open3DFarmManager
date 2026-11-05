import { spawnSync } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
const state = {
  printerKey: 'sim-1',
  state: 'idle' as const,
  progress: 0,
  observedAt: 1000,
}
function scratch() {
  return mkdtempSync(join(tmpdir(), 'open3d-queue-test-'))
}

test('opening policy runs under the lock before any queue recovery or creation', () => {
  const dir = scratch()
  try {
    const log = join(dir, 'telemetry.jsonl')
    const compact = join(dir, 'telemetry.compact')
    assert.throws(
      () =>
        new TelemetryQueue(
          dir,
          1000,
          {},
          {
            beforeRecovery() {
              assert.equal(existsSync(join(dir, 'telemetry.lock')), true)
              assert.equal(existsSync(log), false)
              throw new Error('denied')
            },
          },
        ),
      /denied/,
    )
    assert.equal(existsSync(log), false)
    assert.equal(existsSync(join(dir, 'telemetry.lock')), false)

    const queue = new TelemetryQueue(dir, 1000)
    queue.enqueue(state, 1000)
    queue.close()
    appendFileSync(log, '{"partial":')
    writeFileSync(compact, 'candidate', { mode: 0o600 })
    const before = readFileSync(log)
    assert.throws(
      () =>
        new TelemetryQueue(
          dir,
          1001,
          {},
          {
            beforeRecovery() {
              throw new Error('denied')
            },
          },
        ),
      /denied/,
    )
    assert.deepEqual(readFileSync(log), before)
    assert.equal(readFileSync(compact, 'utf8'), 'candidate')
    assert.equal(existsSync(join(dir, 'telemetry.lock')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('opening policy rejects asynchronous and non-undefined results', () => {
  const dir = scratch()
  try {
    for (const result of [
      Promise.reject(new Error('denied')),
      1,
      {
        get then() {
          throw new Error('then getter')
        },
      },
    ]) {
      assert.throws(() =>
        Reflect.construct(TelemetryQueue, [
          dir,
          1000,
          {},
          {
            beforeRecovery: () => result,
          },
        ]),
      )
      assert.equal(existsSync(join(dir, 'telemetry.jsonl')), false)
      assert.equal(existsSync(join(dir, 'telemetry.lock')), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('outage queue survives restart, repeats unacknowledged batches and persists FIFO acknowledgement', () => {
  const dir = scratch()
  try {
    let queue = new TelemetryQueue(dir, 1000)
    const first = queue.enqueue(state, 1000).eventId
    const second = queue.enqueue({ ...state, state: 'printing' }, 1001).eventId
    queue.close()
    queue = new TelemetryQueue(dir, 1002)
    const batch = queue.batch(1002).records
    assert.deepEqual(
      batch.map((r) => r.eventId),
      [first, second],
    )
    assert.deepEqual(queue.batch(1002).records, batch)
    batch[0]!.state.printerKey = 'mutated'
    assert.equal(queue.batch(1002).records[0]!.state.printerKey, 'sim-1')
    assert.throws(() => queue.acknowledge([second], 1002), /FIFO/)
    queue.acknowledge([first], 1002)
    const third = queue.enqueue(state, 1003).eventId
    assert.throws(() => queue.acknowledge([first, second], 1003), /FIFO/)
    queue.close()
    queue = new TelemetryQueue(dir, 1004)
    assert.deepEqual(
      queue.batch(1004).records.map((r) => r.eventId),
      [second, third],
    )
    queue.acknowledge([second, third], 1004)
    assert.equal(queue.depth, 0)
    queue.close()
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('retention expires at the exact boundary and capacity drops oldest with explicit loss counts', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000, {
      maxBytes: 400,
      maxAgeMs: 100,
    })
    const first = queue.enqueue(state, 1000).eventId
    const second = queue.enqueue(state, 1001).eventId
    const result = queue.enqueue(state, 1002)
    assert.equal(result.loss.capacity, 1)
    assert.deepEqual(
      queue.batch(1002).records.map((r) => r.eventId),
      [second, result.eventId],
    )
    assert.ok(!queue.batch(1002).records.some((r) => r.eventId === first))
    assert.ok(lstatSync(join(dir, 'telemetry.jsonl')).size <= 400)
    const expired = queue.batch(1101)
    assert.equal(expired.loss.expired, 1)
    assert.equal(expired.records.length, 1)
    assert.equal(queue.batch(1102).loss.expired, 1)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('batch has an exact JSON byte bound and records are never removed on read', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    queue.enqueue({ ...state, printerKey: 'impressora-🖨️' }, 1000)
    queue.enqueue(state, 1000)
    const record = queue.batch(1000, 1).records
    const size = Buffer.byteLength(JSON.stringify(record))
    assert.equal(queue.batch(1000, 10, size - 1).records.length, 0)
    assert.deepEqual(queue.batch(1000, 10, size).records, record)
    assert.equal(queue.depth, 2)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('only an unterminated tail is discarded during recovery', () => {
  const dir = scratch()
  try {
    let queue = new TelemetryQueue(dir, 1000)
    const id = queue.enqueue(state, 1000).eventId
    queue.close()
    const path = join(dir, 'telemetry.jsonl')
    appendFileSync(path, '{"eventId":')
    queue = new TelemetryQueue(dir, 1001)
    assert.equal(queue.recovery.partialTail, true)
    assert.equal(queue.batch(1001).records[0]!.eventId, id)
    queue.close()
    appendFileSync(path, 'not JSON\n')
    const before = readFileSync(path)
    assert.throws(() => new TelemetryQueue(dir, 1002))
    assert.deepEqual(readFileSync(path), before)
    assert.equal(existsSync(join(dir, 'telemetry.lock')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('a second owner and a stale lock fail closed', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    assert.throws(() => new TelemetryQueue(dir, 1000), /EEXIST/)
    queue.enqueue(state, 1000)
    queue.close()
    writeFileSync(join(dir, 'telemetry.lock'), '{"pid":0}', { mode: 0o600 })
    assert.throws(() => new TelemetryQueue(dir, 1001), /EEXIST/)
    assert.equal(existsSync(join(dir, 'telemetry.lock')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('reject commands, clock regression, unsafe paths and oversized records', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000, { maxBytes: 256 })
    assert.throws(() =>
      queue.enqueue({ ...state, action: 'pause' } as typeof state, 1000),
    )
    assert.throws(
      () => queue.enqueue({ ...state, printerKey: 'x'.repeat(128) }, 1000),
      /size/,
    )
    assert.throws(() => queue.enqueue(state, 999), /regressed/)
    queue.enqueue(state, 1000)
    queue.close()
    assert.throws(() => queue.batch(1000), /closed/)
    assert.throws(() => new TelemetryQueue(dir, 999), /regressed/)
    const unsafe = join(dir, 'unsafe')
    symlinkSync(join(dir, 'telemetry.jsonl'), unsafe)
    assert.throws(() => new TelemetryQueue(unsafe, 1000))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('reopening expires old records and reports recovery losses', () => {
  const dir = scratch()
  try {
    let queue = new TelemetryQueue(dir, 1000, { maxAgeMs: 100 })
    queue.enqueue(state, 1000)
    queue.close()
    queue = new TelemetryQueue(dir, 1100, { maxAgeMs: 100 })
    assert.equal(queue.recovery.expired, 1)
    assert.equal(queue.depth, 0)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('complete invalid UTF-8 and duplicate IDs are preserved and rejected', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    queue.enqueue(state, 1000)
    queue.close()
    const path = join(dir, 'telemetry.jsonl')
    const valid = readFileSync(path)
    appendFileSync(path, valid)
    assert.throws(() => new TelemetryQueue(dir, 1001), /Duplicate/)
    assert.deepEqual(readFileSync(path), Buffer.concat([valid, valid]))
    const invalid = Buffer.concat([valid, Buffer.from([0xff, 0x0a])])
    writeFileSync(path, invalid)
    assert.throws(() => new TelemetryQueue(dir, 1001))
    assert.deepEqual(readFileSync(path), invalid)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sparse acknowledgements cannot silently discard records', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    queue.enqueue(state, 1000)
    assert.throws(() => queue.acknowledge(new Array(1), 1000), /FIFO/)
    assert.equal(queue.depth, 1)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('recover one orphan compaction file but reject a symlink without touching its target', () => {
  const dir = scratch()
  try {
    let queue = new TelemetryQueue(dir, 1000)
    const id = queue.enqueue(state, 1000).eventId
    queue.close()
    const temporary = join(dir, 'telemetry.compact')
    writeFileSync(temporary, 'interrupted replacement', { mode: 0o600 })
    queue = new TelemetryQueue(dir, 1001)
    assert.equal(existsSync(temporary), false)
    assert.equal(queue.batch(1001).records[0]!.eventId, id)
    queue.close()
    const target = join(dir, 'untouched')
    writeFileSync(target, 'unchanged', { mode: 0o600 })
    symlinkSync(target, temporary)
    assert.throws(() => new TelemetryQueue(dir, 1002), /private files/)
    assert.equal(readFileSync(target, 'utf8'), 'unchanged')
    assert.equal(lstatSync(temporary).isSymbolicLink(), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('oversized incomplete tail is preserved rather than silently truncated', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    queue.close()
    const path = join(dir, 'telemetry.jsonl')
    appendFileSync(path, 'x'.repeat(65537))
    assert.throws(() => new TelemetryQueue(dir, 1000), /Oversized partial/)
    assert.equal(lstatSync(path).size, 65537)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('another OS process cannot acquire an active queue', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    const module = new URL(
      '../../packages/connector/src/cloud/queue.ts',
      import.meta.url,
    ).href
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { TelemetryQueue } from ${JSON.stringify(module)}; try { new TelemetryQueue(process.argv[1], 1000); process.exitCode = 2 } catch (error) { if (error.code !== 'EEXIST') throw error }`,
        dir,
      ],
      { encoding: 'utf8', timeout: 5000 },
    )
    assert.equal(child.status, 0, child.stderr)
    queue.enqueue(state, 1000)
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('append rejects a substituted symlink and invalidates the instance', () => {
  const dir = scratch()
  try {
    const queue = new TelemetryQueue(dir, 1000)
    const path = join(dir, 'telemetry.jsonl')
    const target = join(dir, 'untouched')
    writeFileSync(target, 'unchanged', { mode: 0o600 })
    rmSync(path)
    symlinkSync(target, path)
    assert.throws(() => queue.enqueue(state, 1000))
    assert.throws(() => queue.batch(1000), /requires recovery/)
    assert.equal(readFileSync(target, 'utf8'), 'unchanged')
    queue.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
