// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict'
import { appendFile, mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { sampleRtcMemory, summarizeRtcMemory } from './rtc-memory-sampler.ts'

if (process.env.OPENFARM_RTC_MEMORY !== '1')
  throw Error(
    'Set OPENFARM_RTC_MEMORY=1 to enable the sustained RTC memory run',
  )
if (process.platform !== 'linux')
  throw Error('The slow-consumer harness requires Linux SIGSTOP and /proc')
const durationMs = Number(
  process.env.OPENFARM_RTC_MEMORY_DURATION_MS ?? 600_000,
)
const intervalMs = Number(process.env.OPENFARM_RTC_MEMORY_INTERVAL_MS ?? 5_000)
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 3000 ||
  !Number.isSafeInteger(intervalMs) ||
  intervalMs < 100 ||
  intervalMs > 10000
)
  throw Error('Invalid RTC memory run configuration')
const output = resolve(
  process.env.OPENFARM_RTC_MEMORY_OUTPUT ??
    '/tmp/openfarm-rtc-memory-' + Date.now() + '.jsonl',
)
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
const directory = await realpath(dirname(output))
const checkout = await realpath(new URL('..', import.meta.url))
const location = relative(checkout, directory)
if (!location.startsWith('..' + '/') && !isAbsolute(location))
  throw Error('RTC memory evidence must stay outside the checkout')
// Exclusive creation prevents truncating another task's evidence.
const file = await open(output, 'ax', 0o600)
await file.close()
const ledger = output + '.resources.jsonl'
await writeFile(
  ledger,
  JSON.stringify({ event: 'connector-start', pid: process.pid, output }) + '\n',
  { flag: 'ax', mode: 0o600 },
)
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
const dirty =
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
    .length > 0
const { createRtcMemoryHarness } =
  await import('../tests/helpers/rtc-memory-harness.ts')
const harness = await createRtcMemoryHarness(ledger)
const abort = new AbortController()
const interrupt = () => abort.abort()
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  await harness.renew()
  const started = performance.now()
  const samples: (ReturnType<typeof sampleRtcMemory> &
    ReturnType<typeof harness.observe>)[] = []
  let nextSample = 0,
    nextRenewal = 18000,
    nextTick = 1000
  const record = async () => {
    const observed = harness.observe()
    if (!observed.failure) assert.equal(observed.ready, 3)
    const sample = {
      ...sampleRtcMemory(performance.now() - started, observed),
      ...observed,
    }
    samples.push(sample)
    await appendFile(output, JSON.stringify(sample) + '\n')
  }
  await record()
  await harness.pressure(record)
  while (performance.now() - started < durationMs) {
    if (abort.signal.aborted) throw Error('RTC memory run interrupted')
    const elapsed = performance.now() - started
    if (elapsed >= nextRenewal && durationMs - elapsed > 3000) {
      await harness.renew()
      nextRenewal = performance.now() - started + 18000
      await harness.pressure(record)
    }
    if (elapsed >= nextTick) {
      harness.tick()
      nextTick = elapsed + 1000
    }
    if (elapsed >= nextSample) {
      await record()
      nextSample = elapsed + intervalMs
    }
    await delay(
      Math.min(100, Math.max(1, durationMs - (performance.now() - started))),
    )
  }
  await record()
  const last = samples.at(-1)
  assert.ok(last)
  assert.ok(
    last.suppressedStatusFrames > 0,
    'Real status backpressure must engage',
  )
  assert.ok(
    last.peakBufferedAmountBytes <= last.statusBoundBytes,
    'Status queue exceeded its hard bound',
  )
  const consumer = await harness.observeConsumer()
  assert.equal(consumer.kind, 'observation')
  if (consumer.kind === 'observation') {
    assert.equal(consumer.ready, 3)
    assert.ok(consumer.statuses > 0 && consumer.cameraPackets > 0)
  }
  const summary = {
    ...summarizeRtcMemory(samples, last.statusBoundBytes),
    boundsHit: last.boundHits > 0,
    commit,
    dirty,
    durationMs: last.elapsedMs,
    connectorPid: process.pid,
    runtime: process.version,
    native: last.native,
    generations: last.generations,
    suppressedStatusFrames: last.suppressedStatusFrames,
    peakBufferedAmountBytes: last.peakBufferedAmountBytes,
    cameraSentFrames: last.cameraSentFrames,
    consumer,
  }
  await writeFile(
    output + '.summary.json',
    JSON.stringify(summary, null, 2) + '\n',
    { flag: 'ax', mode: 0o600 },
  )
  process.stdout.write(JSON.stringify({ output, summary }) + '\n')
} catch (error) {
  await writeFile(
    output + '.failure.json',
    JSON.stringify(
      {
        commit,
        dirty,
        error: String(error),
        observed: harness.observe(),
        memory: process.memoryUsage(),
      },
      null,
      2,
    ) + '\n',
    { flag: 'ax', mode: 0o600 },
  )
  throw error
} finally {
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  await harness.close()
  await appendFile(
    ledger,
    JSON.stringify({ event: 'connector-closed', pid: process.pid }) + '\n',
  )
}
