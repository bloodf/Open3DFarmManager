import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { drainTelemetryOnce } from '../../packages/connector/src/cloud/drain.ts'
import { ingestTelemetry } from '../../apps/farm/server/services/telemetry.ts'
import { MemoryTelemetryStore } from '../helpers/memory-telemetry-store.ts'

const queueModule = new URL(
  '../../packages/connector/src/cloud/queue.ts',
  import.meta.url,
).href
const drainModule = new URL(
  '../../packages/connector/src/cloud/drain.ts',
  import.meta.url,
).href
const id = '00000000-0000-4000-8000-000000000001'
const context = { farmId: id, agentId: id, printerKeys: new Set(['synthetic']) }

test(
  'hard crash after acceptance recovers the lock automatically and replays idempotently',
  { timeout: 10000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'open3d-crash-'))
    const script = `
    import { TelemetryQueue } from ${JSON.stringify(queueModule)}
    import { drainTelemetryOnce } from ${JSON.stringify(drainModule)}
    const queue = new TelemetryQueue(process.argv[1], 1000)
    for (const progress of [0.1, 0.2]) queue.enqueue({ printerKey: 'synthetic', state: 'printing', progress, observedAt: 1000 }, 1000)
    await drainTelemetryOnce(queue, async body => {
      process.stdout.write(body + '\\n')
      setInterval(() => {}, 1000)
      return new Promise(() => {})
    }, () => 1000, new AbortController().signal)
  `
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, directory],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const exited = once(child, 'exit')
    const lines = createInterface({ input: child.stdout })
    let queue: TelemetryQueue | undefined
    try {
      const [body] = await once(lines, 'line', {
        signal: AbortSignal.timeout(5000),
      })
      const records = JSON.parse(body) as { eventId: string }[]
      assert.equal(records.length, 2)
      assert.throws(() => new TelemetryQueue(directory, 1000), /EEXIST/)
      const store = new MemoryTelemetryStore()
      const accepted = await ingestTelemetry(body, context, store)
      assert.equal(accepted.ok, true)
      assert.equal(store.size, 2)
      assert.equal(child.kill('SIGKILL'), true)
      const [, signal] = await exited
      assert.equal(signal, 'SIGKILL')
      // The killed owner cannot be running, so the restart takes over its lock.
      queue = new TelemetryQueue(directory, 1001)
      assert.equal(queue.recoveredStaleLock, true)
      assert.deepEqual(
        queue.batch(1001).records.map((record) => record.eventId),
        records.map((record) => record.eventId),
      )
      const result = await drainTelemetryOnce(
        queue,
        async (replay) => {
          assert.equal(replay, body)
          const result = await ingestTelemetry(replay, context, store)
          if (!result.ok) throw new Error(result.reason)
          return result.acceptedEventIds
        },
        () => 1001,
        new AbortController().signal,
      )
      assert.equal(result.status, 'delivered')
      assert.equal(store.size, 2)
      assert.equal(queue.depth, 0)
      queue.close()
      queue = new TelemetryQueue(directory, 1002)
      assert.equal(queue.depth, 0)
    } finally {
      lines.close()
      child.kill('SIGKILL')
      await exited.catch(() => {})
      queue?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  },
)
