import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'

type Options = {
  signal: AbortSignal
  onEvent(event: { kind: 'snapshot'; printer: PrinterState }): void
}
const captured: { options?: Options } = {}

vi.mock('../../packages/connector/src/moonraker/subscription.ts', () => ({
  createMoonrakerSubscription(options: Options) {
    captured.options = options
    return {
      done: new Promise<void>((resolve) =>
        options.signal.addEventListener('abort', () => resolve()),
      ),
      requestCompleteRefresh() {},
    }
  },
}))

const { collectIntoQueue } =
  await import('../../packages/connector/src/runtime/collect.ts')
const { TelemetryQueue } =
  await import('../../packages/connector/src/cloud/queue.ts')

const origin = 'http://127.0.0.1:7125'
const printerKey = 'printer-a'

function snapshot(observedAt: number, nozzle: number): PrinterState {
  return {
    printerKey,
    state: 'idle',
    progress: 0,
    observedAt,
    machine: { toolCount: 1, nozzleDiametersMm: [nozzle] },
  } as PrinterState
}

describe('collection machine profile gate with out-of-order snapshots', () => {
  let directory: string
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'collect-machine-gate-'))
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('resends a changed machine block dropped with an out-of-order row', async () => {
    const queue = new TelemetryQueue(join(directory, 'queue'), Date.now())
    const controller = new AbortController()
    const sent: PrinterState[] = []
    const enqueue = queue.enqueue.bind(queue)
    queue.enqueue = (state, now) => {
      sent.push(state)
      return enqueue(state, now)
    }
    // A pending release makes snapshots that are not newer out of order.
    const refresh = new Map([[printerKey, { releasedAtMonoMs: 1 }]])
    const collection = collectIntoQueue({
      config: {
        version: 1,
        allowedOrigins: [origin],
        printers: [{ printerKey, origin }],
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
      moonrakerCollectionRefresh: refresh,
      onDiagnostic() {},
    })
    try {
      await vi.waitFor(() => expect(captured.options).toBeDefined())
      const emit = (printer: PrinterState) =>
        captured.options!.onEvent({ kind: 'snapshot', printer })
      emit(snapshot(2000, 0.4))
      emit(snapshot(1000, 0.6))
      emit(snapshot(3000, 0.6))
      expect(sent.map((state) => state.machine?.nozzleDiametersMm)).toEqual([
        [0.4],
        [0.6],
        [0.6],
      ])
    } finally {
      controller.abort()
      await collection
      queue.close()
    }
  })
})
