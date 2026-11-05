import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  decodeMovingPreflight,
  disposeMovingResources,
  pumpMovingRtspUnits,
  validateMovingPreflight,
  type MovingUnit,
} from './moving-rtsp-native-harness.ts'

function fixture() {
  const units = Array.from({ length: 30 }, (_, index) => ({
    data: new Uint8Array([index + 1]),
    keyframe: true,
    timestampUs: index * 100000,
  }))
  const fixtureSHA256 = 'a'.repeat(64)
  const preflight = {
    fixtureSHA256,
    records: units.map((unit) => {
      const digest = createHash('sha256').update(unit.data).digest('hex')
      return {
        rawSHA256: digest,
        canonicalSHA256: digest,
        canonicalBytes: 1,
        nalCount: 1,
        packetCount: 1,
      }
    }),
  }
  return { units, preflight, fixtureSHA256 }
}

test('all-record preflight rejects fixture identity, final frame and packet/window violations before playback', () => {
  const f = fixture()
  assert.equal(
    validateMovingPreflight(f.units, f.preflight, f.fixtureSHA256).length,
    30,
  )
  assert.throws(() =>
    validateMovingPreflight(f.units, f.preflight, 'b'.repeat(64)),
  )
  f.preflight.records[29]!.packetCount = 9
  assert.throws(() =>
    validateMovingPreflight(f.units, f.preflight, f.fixtureSHA256),
  )
  f.preflight.records[29]!.packetCount = 1
  for (const row of f.preflight.records) row.canonicalBytes = 100000
  assert.throws(
    () => validateMovingPreflight(f.units, f.preflight, f.fixtureSHA256),
    /WINDOW/,
  )
})

test('sequential demand precedes each paced write and all canonical units reach the sink', async () => {
  const f = fixture(),
    events: string[] = [],
    stamps: number[] = []
  let now = 0,
    resolve: ((value: IteratorResult<MovingUnit>) => void) | undefined
  const result = await pumpMovingRtspUnits({
    ...f,
    signal: new AbortController().signal,
    deadlineMonoMs: 5000,
    current: () => true,
    now: () => now,
    wait: async (ms) => {
      now += ms
    },
    iterator: {
      next: () => {
        assert.equal(resolve, undefined)
        events.push('credit')
        return new Promise((done) => {
          resolve = done
        })
      },
    },
    write: async (unit) => {
      events.push('write')
      stamps.push(now)
      const done = resolve
      resolve = undefined
      assert.ok(done)
      done({ done: false, value: unit })
    },
    send: async () => {
      events.push('send')
      now += 3
      return true
    },
  })
  assert.equal(result.sent, 30)
  assert.equal(result.bytes, 30)
  assert.deepEqual(
    events,
    Array.from({ length: 30 }, () => ['credit', 'write', 'send']).flat(),
  )
  for (let i = 1; i < stamps.length; i++)
    assert.ok(stamps[i]! - stamps[i - 1]! >= 103)
})

test('first helper pressure failure aborts before any native admission without retry', async () => {
  const f = fixture()
  let writes = 0,
    sends = 0,
    credits = 0
  await assert.rejects(
    pumpMovingRtspUnits({
      ...f,
      signal: new AbortController().signal,
      deadlineMonoMs: 5000,
      current: () => true,
      now: () => 0,
      iterator: {
        next: async () => {
          credits++
          throw Error('pressure')
        },
      },
      write: async () => {
        writes++
      },
      send: async () => {
        sends++
        return true
      },
    }),
    /pressure/,
  )
  assert.equal(credits, 1)
  assert.ok(writes <= 1)
  assert.equal(sends, 0)
})

test('expiry during native callback cannot admit another unit or extend lease', async () => {
  const f = fixture()
  let now = 0,
    sends = 0,
    next = 0
  await assert.rejects(
    pumpMovingRtspUnits({
      ...f,
      signal: new AbortController().signal,
      deadlineMonoMs: 5000,
      current: () => true,
      now: () => now,
      iterator: {
        next: async () => ({ done: false, value: f.units[next++]! }),
      },
      write: async () => {},
      send: async () => {
        sends++
        now = 5000
        return true
      },
    }),
    /LEASE/,
  )
  assert.equal(sends, 1)
  assert.equal(next, 1)
})

test('canonical helper mismatch prevents native send', async () => {
  const f = fixture()
  let sends = 0
  await assert.rejects(
    pumpMovingRtspUnits({
      ...f,
      signal: new AbortController().signal,
      deadlineMonoMs: 5000,
      current: () => true,
      now: () => 0,
      iterator: {
        next: async () => ({
          done: false,
          value: { ...f.units[0]!, data: new Uint8Array([99]) },
        }),
      },
      write: async () => {},
      send: async () => {
        sends++
        return true
      },
    }),
    /MISMATCH/,
  )
  assert.equal(sends, 0)
})

test('cleanup attempts every independently owned disposal despite rejection', async () => {
  const closed: number[] = []
  await assert.rejects(
    disposeMovingResources([
      async () => {
        closed.push(1)
        throw Error('first')
      },
      async () => {
        closed.push(2)
      },
    ]),
    AggregateError,
  )
  assert.deepEqual(closed, [1, 2])
})

test('RPF1 exact framing binds every preflight row and rejects truncation/trailing bytes', () => {
  const f = fixture(),
    bytes = Buffer.alloc(2168)
  bytes.write('RPF1')
  bytes.writeUInt16BE(30, 4)
  for (let i = 0; i < 30; i++) {
    const at = 8 + i * 72,
      row = f.preflight.records[i]!
    Buffer.from(row.rawSHA256, 'hex').copy(bytes, at)
    Buffer.from(row.canonicalSHA256, 'hex').copy(bytes, at + 32)
    bytes.writeUInt32BE(1, at + 64)
    bytes.writeUInt16BE(1, at + 68)
    bytes.writeUInt16BE(1, at + 70)
  }
  assert.deepEqual(decodeMovingPreflight(bytes, f.fixtureSHA256), f.preflight)
  assert.throws(() =>
    decodeMovingPreflight(bytes.subarray(0, 2167), f.fixtureSHA256),
  )
  assert.throws(() =>
    decodeMovingPreflight(
      Buffer.concat([bytes, Buffer.from([0])]),
      f.fixtureSHA256,
    ),
  )
  bytes[7] = 1
  assert.throws(() => decodeMovingPreflight(bytes, f.fixtureSHA256))
})
