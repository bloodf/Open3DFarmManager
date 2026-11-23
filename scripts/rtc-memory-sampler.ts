import { memoryUsage } from 'node:process'

export type RtcMemorySample = Readonly<{
  elapsedMs: number
  rssBytes: number
  heapUsedBytes: number
  sendQueueBytes: number
  bufferedAmountBytes: number
}>

export type RtcMemorySummary = Readonly<{
  samples: number
  peakRssBytes: number
  firstRssBytes: number
  lastRssBytes: number
  peakHeapUsedBytes: number
  peakSendQueueBytes: number
  peakBufferedAmountBytes: number
  boundsHit: boolean
}>

export function sampleRtcMemory(
  elapsedMs: number,
  queues: { sendQueueBytes: number; bufferedAmountBytes: number },
  usage = memoryUsage(),
): RtcMemorySample {
  for (const value of [
    elapsedMs,
    usage.rss,
    usage.heapUsed,
    queues.sendQueueBytes,
    queues.bufferedAmountBytes,
  ]) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error('Invalid RTC memory measurement')
  }
  return Object.freeze({
    elapsedMs,
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    sendQueueBytes: queues.sendQueueBytes,
    bufferedAmountBytes: queues.bufferedAmountBytes,
  })
}

export function summarizeRtcMemory(
  samples: readonly RtcMemorySample[],
  boundBytes: number,
): RtcMemorySummary {
  if (!samples.length || !Number.isSafeInteger(boundBytes) || boundBytes < 0)
    throw new Error('Invalid RTC memory summary input')
  const peak = (key: keyof RtcMemorySample) =>
    samples.reduce((maximum, sample) => Math.max(maximum, sample[key]), 0)
  return Object.freeze({
    samples: samples.length,
    peakRssBytes: peak('rssBytes'),
    firstRssBytes: samples[0]!.rssBytes,
    lastRssBytes: samples.at(-1)!.rssBytes,
    peakHeapUsedBytes: peak('heapUsedBytes'),
    peakSendQueueBytes: peak('sendQueueBytes'),
    peakBufferedAmountBytes: peak('bufferedAmountBytes'),
    boundsHit: samples.some(
      (sample) =>
        sample.sendQueueBytes >= boundBytes ||
        sample.bufferedAmountBytes >= boundBytes,
    ),
  })
}
