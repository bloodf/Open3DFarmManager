import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'

const state = {
  printerKey: 'sim-1',
  state: 'printing' as const,
  progress: 0,
  observedAt: 1000,
}
/** Queue with three records, closed; returns their IDs and the log bytes. */
function seeded(limits = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'open3d-queue-ack-'))
  const queue = new TelemetryQueue(dir, 1000, limits)
  const ids = [0.1, 0.2, 0.3].map(
    (progress) => queue.enqueue({ ...state, progress }, 1000).eventId,
  )
  queue.close()
  const log = join(dir, 'telemetry.jsonl')
  return { dir, ids, log, bytes: readFileSync(log) }
}
const cursor = (dir: string) => join(dir, 'telemetry.ack')
const live = (queue: TelemetryQueue) =>
  queue.batch(2000).records.map((record) => record.eventId)
function reopen(dir: string, run: (queue: TelemetryQueue) => void) {
  const queue = new TelemetryQueue(dir, 2000)
  try {
    run(queue)
  } finally {
    queue.close()
  }
}

test('acknowledging a prefix records a cursor without rewriting the log', () => {
  const { dir, ids, log, bytes } = seeded()
  try {
    reopen(dir, (queue) => queue.acknowledge([ids[0]!], 2000))
    assert.deepEqual(readFileSync(log), bytes)
    assert.deepEqual(JSON.parse(readFileSync(cursor(dir), 'utf8')), {
      lastAcked: ids[0],
    })
    reopen(dir, (queue) => {
      assert.deepEqual(live(queue), ids.slice(1))
      assert.equal(queue.recovery.expired, 0)
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an emptied queue compacts the acknowledged prefix away', () => {
  const { dir, ids, log } = seeded()
  try {
    reopen(dir, (queue) => queue.acknowledge(ids, 2000))
    assert.equal(statSync(log).size, 0)
    reopen(dir, (queue) => assert.equal(queue.depth, 0))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the acknowledged prefix is compacted once it reaches the threshold', () => {
  const { dir, ids, log, bytes } = seeded()
  const lineBytes = bytes.length / 3
  try {
    const queue = new TelemetryQueue(dir, 2000, {
      compactAfterBytes: Math.ceil(lineBytes * 1.5),
    })
    try {
      queue.acknowledge([ids[0]!], 2000)
      assert.equal(statSync(log).size, bytes.length)
      queue.acknowledge([ids[1]!], 2000)
      assert.equal(statSync(log).size, lineBytes)
    } finally {
      queue.close()
    }
    reopen(dir, (q) => assert.deepEqual(live(q), [ids[2]]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('crash before the cursor rename: batch is delivered again', () => {
  const { dir, ids } = seeded()
  try {
    writeFileSync(cursor(dir) + '.tmp', JSON.stringify({ lastAcked: ids[0] }), {
      mode: 0o600,
    })
    reopen(dir, (queue) => assert.deepEqual(live(queue), ids))
    assert.equal(existsSync(cursor(dir) + '.tmp'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('crash after the cursor rename, before compaction: prefix stays acknowledged', () => {
  const { dir, ids } = seeded()
  try {
    writeFileSync(cursor(dir), JSON.stringify({ lastAcked: ids[1] }), {
      mode: 0o600,
    })
    reopen(dir, (queue) => assert.deepEqual(live(queue), [ids[2]]))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('crash during compaction: orphan removed and cursor still applied', () => {
  const { dir, ids, bytes } = seeded()
  try {
    writeFileSync(cursor(dir), JSON.stringify({ lastAcked: ids[0] }), {
      mode: 0o600,
    })
    writeFileSync(join(dir, 'telemetry.compact'), bytes.subarray(0, 10), {
      mode: 0o600,
    })
    reopen(dir, (queue) => assert.deepEqual(live(queue), ids.slice(1)))
    assert.equal(existsSync(join(dir, 'telemetry.compact')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('crash after compaction: a cursor naming a removed record drops nothing', () => {
  const { dir, ids, log, bytes } = seeded()
  try {
    const lines = bytes.toString().split('\n').filter(Boolean)
    writeFileSync(log, lines.slice(1).join('\n') + '\n')
    writeFileSync(cursor(dir), JSON.stringify({ lastAcked: ids[0] }), {
      mode: 0o600,
    })
    reopen(dir, (queue) => assert.deepEqual(live(queue), ids.slice(1)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid or unsafe cursors fail closed without changing the log', () => {
  for (const content of [
    'not json',
    '{"lastAcked":"x"}',
    '{"lastAcked":"00000000-0000-4000-8000-000000000001","extra":1}',
  ]) {
    const { dir, log, bytes } = seeded()
    try {
      writeFileSync(cursor(dir), content, { mode: 0o600 })
      assert.throws(() => new TelemetryQueue(dir, 2000), /cursor/, content)
      assert.deepEqual(readFileSync(log), bytes)
      assert.equal(existsSync(join(dir, 'telemetry.lock')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const { dir } = seeded()
  try {
    const target = join(dir, 'target')
    writeFileSync(target, '{}', { mode: 0o600 })
    symlinkSync(target, cursor(dir))
    assert.throws(() => new TelemetryQueue(dir, 2000), /private files/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
