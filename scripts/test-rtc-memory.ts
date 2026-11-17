import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sampleRtcMemory, summarizeRtcMemory } from './rtc-memory-sampler.ts'

const enabled = process.env.OPENFARM_RTC_MEMORY === '1'
if (!enabled)
  throw new Error(
    'Set OPENFARM_RTC_MEMORY=1 to enable the sustained RTC memory run',
  )

const durationMs = Number(
  process.env.OPENFARM_RTC_MEMORY_DURATION_MS ?? 600_000,
)
const intervalMs = Number(process.env.OPENFARM_RTC_MEMORY_INTERVAL_MS ?? 5_000)
const output = resolve(
  process.env.OPENFARM_RTC_MEMORY_OUTPUT ?? '/tmp/openfarm-rtc-memory.jsonl',
)
const boundBytes = Number(
  process.env.OPENFARM_RTC_MEMORY_BOUND_BYTES ?? 1_048_576,
)
if (
  !Number.isSafeInteger(durationMs) ||
  durationMs < 1 ||
  !Number.isSafeInteger(intervalMs) ||
  intervalMs < 100 ||
  !Number.isSafeInteger(boundBytes) ||
  boundBytes < 1
)
  throw new Error('Invalid RTC memory run configuration')

// This sampler deliberately accepts queue readings through a named hook so the actual
// RTC runtime can provide its Connector observations without fabricating native values.
const source = process.env.OPENFARM_RTC_MEMORY_SOURCE
if (!source)
  throw new Error(
    'OPENFARM_RTC_MEMORY_SOURCE must point to a JSONL queue observation file',
  )
await mkdir(dirname(output), { recursive: true })
const started = Date.now()
const samples = []
let cursor = 0
while (Date.now() - started <= durationMs) {
  let sendQueueBytes = 0
  let bufferedAmountBytes = 0
  try {
    const { readFile } = await import('node:fs/promises')
    const lines = (await readFile(source, 'utf8')).trim().split('\n')
    if (lines[cursor]) {
      const observation = JSON.parse(lines[cursor++]!) as {
        sendQueueBytes: number
        bufferedAmountBytes: number
      }
      sendQueueBytes = observation.sendQueueBytes
      bufferedAmountBytes = observation.bufferedAmountBytes
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const sample = sampleRtcMemory(Date.now() - started, {
    sendQueueBytes,
    bufferedAmountBytes,
  })
  samples.push(sample)
  await appendFile(output, JSON.stringify(sample) + '\n', { mode: 0o600 })
  if (Date.now() - started >= durationMs) break
  await delay(Math.min(intervalMs, durationMs - (Date.now() - started)))
}
const summary = summarizeRtcMemory(samples, boundBytes)
process.stdout.write(JSON.stringify({ output, summary }) + '\n')
