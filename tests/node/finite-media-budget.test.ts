import test from 'node:test'
import assert from 'node:assert/strict'
import { FiniteMediaBudget } from '../../packages/webrtc-experiment/real-identity/finite-media-budget.ts'

test('copies without alias, preserves timestamps and wraps internal RTP safely', () => {
  let now = 0
  const units: {
    data: Uint8Array
    keyframe: boolean
    timestampUs: number
    rtpTimestamp: number
  }[] = []
  const budget = new FiniteMediaBudget({
    now: () => now,
    deadline: 30000,
    send: (unit) => {
      units.push(unit)
      return true
    },
  })
  const backing = new Uint8Array([7, 8, 9, 10])
  assert.equal(
    budget.trySend({
      data: backing.subarray(1, 3),
      timestampUs: 0,
      keyframe: true,
    }),
    true,
  )
  backing[1] = 42
  assert.deepEqual([...units[0]!.data], [8, 9])
  assert.notEqual(units[0]!.data.buffer, backing.buffer)
  now = 100
  const timestampUs = Number.MAX_SAFE_INTEGER
  assert.equal(
    budget.trySend({ data: new Uint8Array([1]), timestampUs, keyframe: false }),
    true,
  )
  assert.equal(
    units[1]!.rtpTimestamp,
    Number(((BigInt(timestampUs) * 9n) / 100n) % 4294967296n),
  )
  assert.equal(
    budget.trySend({ data: new Uint8Array([1]), timestampUs, keyframe: false }),
    false,
  )
  assert.equal(budget.snapshot().terminal, true)
})

test('caps 60 frames, 4 MiB and 10 fps without a pending queue', () => {
  let now = 0,
    calls = 0
  const make = () =>
    new FiniteMediaBudget({
      now: () => now,
      deadline: 30000,
      send: () => {
        calls++
        return true
      },
    })
  const frames = make()
  for (let i = 0; i < 60; i++) {
    now = i * 100
    assert.equal(
      frames.trySend({
        data: new Uint8Array([1]),
        timestampUs: i,
        keyframe: i === 0,
      }),
      true,
    )
  }
  assert.deepEqual(frames.snapshot(), { terminal: true, frames: 60, bytes: 60 })
  assert.equal(
    frames.trySend({
      data: new Uint8Array([1]),
      timestampUs: 60,
      keyframe: false,
    }),
    false,
  )
  now = 0
  const bytes = make()
  for (let i = 0; i < 16; i++) {
    now = i * 100
    assert.equal(
      bytes.trySend({
        data: new Uint8Array(262144),
        timestampUs: i,
        keyframe: i === 0,
      }),
      true,
    )
  }
  assert.deepEqual(bytes.snapshot(), {
    terminal: true,
    frames: 16,
    bytes: 4194304,
  })
  now = 0
  const rate = make()
  assert.equal(
    rate.trySend({ data: new Uint8Array([1]), timestampUs: 0, keyframe: true }),
    true,
  )
  now = 99
  assert.equal(
    rate.trySend({
      data: new Uint8Array([1]),
      timestampUs: 1,
      keyframe: false,
    }),
    false,
  )
  assert.equal(rate.snapshot().terminal, true)
  assert.equal(calls, 77)
})

test('invalid input, lease, sink failure and close stop admission permanently', () => {
  let now = 0,
    calls = 0
  const make = (
    send = () => {
      calls++
      return true
    },
  ) => new FiniteMediaBudget({ now: () => now, deadline: 1000, send })
  for (const [input, timestamp] of [
    [new Uint8Array(), 0],
    [new Uint8Array(262145), 0],
    [new Uint8Array([1]), -1],
    [new Uint8Array([1]), Number.MAX_SAFE_INTEGER + 1],
    [new Uint8Array(new SharedArrayBuffer(1)), 0],
  ] as const) {
    const budget = make()
    assert.equal(
      budget.trySend({ data: input, timestampUs: timestamp, keyframe: true }),
      false,
    )
    assert.equal(
      budget.trySend({
        data: new Uint8Array([1]),
        timestampUs: 1,
        keyframe: false,
      }),
      false,
    )
  }
  const failed = make(() => false)
  assert.equal(
    failed.trySend({
      data: new Uint8Array([1]),
      timestampUs: 0,
      keyframe: true,
    }),
    false,
  )
  assert.equal(failed.snapshot().terminal, true)
  const closed = make()
  closed.close()
  assert.equal(
    closed.trySend({
      data: new Uint8Array([1]),
      timestampUs: 0,
      keyframe: true,
    }),
    false,
  )
  const expired = make()
  now = 1000
  assert.equal(
    expired.trySend({
      data: new Uint8Array([1]),
      timestampUs: 0,
      keyframe: true,
    }),
    false,
  )
  assert.equal(calls, 0)
  assert.throws(
    () =>
      new FiniteMediaBudget({
        now: () => 0,
        deadline: 30001,
        send: () => true,
      }),
  )
})

test('clock regression and reentrant sends fail closed', () => {
  let now = 10
  const input = { data: new Uint8Array([1]), timestampUs: 0, keyframe: true }
  const clock = new FiniteMediaBudget({
    now: () => now,
    deadline: 1000,
    send: () => true,
  })
  now = 9
  assert.equal(clock.trySend(input), false)
  assert.equal(clock.snapshot().terminal, true)
  now = 10
  let nested = true
  const budget = new FiniteMediaBudget({
    now: () => now,
    deadline: 1000,
    send: () => {
      nested = budget.trySend({ ...input, timestampUs: 1 })
      return true
    },
  })
  assert.equal(budget.trySend(input), false)
  assert.equal(nested, false)
  assert.equal(budget.snapshot().terminal, true)
})
