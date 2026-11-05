import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkSignallingWireClock,
  signallingReadBudget,
  signallingRemaining,
} from '../../apps/farm/server/services/signalling-clock.ts'
const start = { wall: 100_000, monotonic: 1000 }
const end = { wall: 100_500, monotonic: 1500 }

test('SQL duration including a stalled commit reduces remaining authorization', () => {
  assert.deepEqual(
    signallingReadBudget({
      start,
      end,
      observedAt: 100_400,
      validUntil: 108_000,
    }),
    {
      observedAt: 100_400,
      validUntil: 108_000,
      monotonicDeadline: 8600,
    },
  )
  assert.throws(() =>
    signallingReadBudget({
      start,
      end,
      observedAt: 100_400,
      validUntil: 100_900,
    }),
  )
  assert.throws(() =>
    signallingReadBudget({
      start,
      end,
      observedAt: 99_749,
      validUntil: 108_000,
    }),
  )
  assert.throws(() =>
    signallingReadBudget({
      start,
      end,
      observedAt: 100_751,
      validUntil: 108_000,
    }),
  )
})

test('wall discontinuities and monotonic regressions fail closed', () => {
  for (const bad of [
    { wall: 100_500, monotonic: 999 },
    { wall: 99_999, monotonic: 1500 },
    { wall: 101_000, monotonic: 1500 },
    { wall: 100_100, monotonic: 1500 },
  ])
    assert.throws(() =>
      signallingReadBudget({
        start,
        end: bad,
        observedAt: 100_000,
        validUntil: 108_000,
      }),
    )
})

test('fresh revalidation never extends original context or previous shorter deadline', () => {
  const authorization = signallingReadBudget({
    start,
    end,
    observedAt: 100_400,
    validUntil: 200_000,
  })
  assert.deepEqual(
    signallingRemaining({ anchor: start, now: end, authorization }),
    { remaining: 29_500, monotonicDeadline: 31_000 },
  )
  assert.deepEqual(
    signallingRemaining({
      anchor: start,
      now: end,
      authorization,
      previousDeadline: 5000,
    }),
    { remaining: 3500, monotonicDeadline: 5000 },
  )
  assert.throws(() =>
    signallingRemaining({
      anchor: start,
      now: { wall: 130_000, monotonic: 31_000 },
      authorization,
    }),
  )
})

test('endpoint uses one request interval and rejects expired arrivals and stalled crypto', () => {
  assert.equal(
    checkSignallingWireClock({
      requestStart: start,
      responseEnd: end,
      issuedAt: 99_750,
      expiresAt: 108_000,
    }),
    9000,
  )
  assert.throws(() =>
    checkSignallingWireClock({
      requestStart: start,
      responseEnd: end,
      issuedAt: 99_749,
      expiresAt: 108_000,
    }),
  )
  assert.throws(() =>
    checkSignallingWireClock({
      requestStart: start,
      responseEnd: end,
      issuedAt: 100_751,
      expiresAt: 108_000,
    }),
  )
  assert.throws(() =>
    checkSignallingWireClock({
      requestStart: start,
      responseEnd: end,
      issuedAt: 100_000,
      expiresAt: 100_500,
    }),
  )
  const authorization = signallingReadBudget({
    start,
    end,
    observedAt: 100_400,
    validUntil: 108_000,
  })
  assert.throws(() =>
    signallingRemaining({
      anchor: start,
      now: { wall: 108_000, monotonic: 9000 },
      authorization,
    }),
  )
})
