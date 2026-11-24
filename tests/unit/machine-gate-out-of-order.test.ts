import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { MoonrakerEvent } from '../../packages/connector/src/moonraker/subscription.ts'
import { TelemetryQueue } from '../../packages/connector/src/cloud/queue.ts'
import { collectIntoQueue } from '../../packages/connector/src/runtime/collect.ts'

const subscription = vi.hoisted(() => ({
  emit: undefined as ((event: MoonrakerEvent) => void) | undefined,
}))
vi.mock('../../packages/connector/src/moonraker/subscription.ts', () => ({
  createMoonrakerSubscription(input: {
    onEvent: (event: MoonrakerEvent) => void
    signal: AbortSignal
  }) {
    subscription.emit = input.onEvent
    return {
      done: new Promise<void>((resolve) =>
        input.signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
      requestCompleteRefresh() {},
    }
  },
}))

test('an out-of-order profile change is sent again on the next newer snapshot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'machine-gate-out-of-order-'))
  const queue = new TelemetryQueue(directory, Date.now())
  const controller = new AbortController()
  const refresh = { releasedAtMonoMs: 1 }
  const run = collectIntoQueue({
    config: {
      version: 1,
      allowedOrigins: ['http://127.0.0.1:7125'],
      printers: [{ printerKey: 'p', origin: 'http://127.0.0.1:7125' }],
      limits: {
        maxMessageBytes: 8192,
        connectTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        staleAfterMs: 5000,
        reconnectMinMs: 100,
        reconnectMaxMs: 100,
      },
    },
    queue,
    signal: controller.signal,
    moonrakerCollectionRefresh: new Map([['p', refresh]]),
    onDiagnostic() {},
  })
  try {
    await vi.waitFor(() => expect(subscription.emit).toBeDefined())
    const emit = (observedAt: number, model: string) =>
      subscription.emit!({
        kind: 'snapshot',
        sourceEventtime: observedAt,
        printer: {
          printerKey: 'p',
          state: 'idle',
          progress: 0,
          observedAt,
          machine: { model },
        },
      })
    const now = Date.now()
    emit(now, 'Original')
    emit(now, 'Changed')
    emit(now + 1, 'Changed')
    const states = queue
      .batch(Date.now())
      .records.flatMap((record) =>
        record.kind === 'printer-state' ? [record.state] : [],
      )
    expect(states).toHaveLength(3)
    expect(states[1]?.machine).toEqual({ model: 'Changed' })
    expect(states[2]?.machine).toEqual({ model: 'Changed' })
  } finally {
    controller.abort()
    await run
    queue.close()
    rmSync(directory, { recursive: true, force: true })
    subscription.emit = undefined
  }
})
