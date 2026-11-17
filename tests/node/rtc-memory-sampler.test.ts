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
