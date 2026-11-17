import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sampleRtcMemory,
  summarizeRtcMemory,
} from '../../scripts/rtc-memory-sampler.ts'

test('RTC memory sampler records process and queue readings', () => {
  const sample = sampleRtcMemory(
    100,
    { sendQueueBytes: 12, bufferedAmountBytes: 34 },
    { rss: 1000, heapUsed: 500 } as NodeJS.MemoryUsage,
  )
  assert.deepEqual(sample, {
    elapsedMs: 100,
    rssBytes: 1000,
    heapUsedBytes: 500,
    sendQueueBytes: 12,
    bufferedAmountBytes: 34,
  })
  assert.equal(Object.isFrozen(sample), true)
})

test('RTC memory summary reports peaks and whether a configured bound was reached', () => {
  const samples = [
    sampleRtcMemory(0, { sendQueueBytes: 1, bufferedAmountBytes: 5 }, {
      rss: 100,
      heapUsed: 50,
    } as NodeJS.MemoryUsage),
    sampleRtcMemory(10, { sendQueueBytes: 8, bufferedAmountBytes: 6 }, {
      rss: 120,
      heapUsed: 70,
    } as NodeJS.MemoryUsage),
  ]
  assert.deepEqual(summarizeRtcMemory(samples, 8), {
    samples: 2,
    peakRssBytes: 120,
    firstRssBytes: 100,
    lastRssBytes: 120,
    peakHeapUsedBytes: 70,
    peakSendQueueBytes: 8,
    peakBufferedAmountBytes: 6,
    boundsHit: true,
  })
})

test('sampler rejects missing or nonfinite measurements instead of recording a false zero', () => {
  for (const invalid of [NaN, Infinity, -1]) {
    assert.throws(() =>
      sampleRtcMemory(invalid, { sendQueueBytes: 0, bufferedAmountBytes: 0 }),
    )
    assert.throws(() =>
      sampleRtcMemory(0, { sendQueueBytes: invalid, bufferedAmountBytes: 0 }),
    )
    assert.throws(() =>
      sampleRtcMemory(0, { sendQueueBytes: 0, bufferedAmountBytes: invalid }),
    )
    const usage = process.memoryUsage()
    assert.throws(() =>
      sampleRtcMemory(
        0,
        { sendQueueBytes: 0, bufferedAmountBytes: 0 },
        { ...usage, rss: invalid },
      ),
    )
    assert.throws(() =>
      sampleRtcMemory(
        0,
        { sendQueueBytes: 0, bufferedAmountBytes: 0 },
        { ...usage, heapUsed: invalid },
      ),
    )
  }
})

test('summary distinguishes a drained queue from reaching its bound', () => {
  const samples = [0, 1023, 0].map((bufferedAmountBytes, elapsedMs) =>
    sampleRtcMemory(elapsedMs, { sendQueueBytes: 0, bufferedAmountBytes }),
  )
  assert.equal(summarizeRtcMemory(samples, 1024).boundsHit, false)
  assert.equal(summarizeRtcMemory(samples, 1023).boundsHit, true)
  assert.equal(summarizeRtcMemory(samples, 1024).peakBufferedAmountBytes, 1023)
  assert.throws(() => summarizeRtcMemory([], 1024))
  assert.throws(() => summarizeRtcMemory(samples, NaN))
})

test('summary supports a long sampling history without spreading it onto the stack', () => {
  const sample = sampleRtcMemory(0, {
    sendQueueBytes: 0,
    bufferedAmountBytes: 0,
  })
  const result = summarizeRtcMemory(
    Array.from({ length: 150000 }, () => sample),
    1024,
  )
  assert.equal(result.samples, 150000)
  assert.equal(result.firstRssBytes, sample.rssBytes)
  assert.equal(result.lastRssBytes, sample.rssBytes)
})
