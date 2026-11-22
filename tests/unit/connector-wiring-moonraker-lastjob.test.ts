import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { openQueueCollectionJournal } from '../../packages/connector/src/control/queue-collection-journal.ts'
import { createMoonrakerSubscription } from '../../packages/connector/src/moonraker/subscription.ts'
import { createLibraryJobLinks } from '../../packages/connector/src/runtime/library-job-links.ts'
import { moonrakerSimulator, waitFor } from './connector-wiring-sims.ts'

test('a terminal first Moonraker snapshot links the dispatch and allows collection confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'queue-collection-'))
  const simulator = await moonrakerSimulator({
    spoolId: 'absent',
    status: {
      print_stats: { state: 'complete', filename: 'part.gcode' },
      virtual_sdcard: { progress: 1 },
    },
  })
  const controller = new AbortController()
  const printerKey = 'printer'
  const sha256 = 'a'.repeat(64)
  const links = createLibraryJobLinks()
  const collection = openQueueCollectionJournal(join(directory, 'journal.json'))
  const sentAt = Date.now() - 1
  collection.dispatched(printerKey, sentAt)
  links.remember(printerKey, { name: 'part.gcode', sha256, plate: 1 }, sentAt)
  let first: PrinterState | undefined
  const subscription = createMoonrakerSubscription({
    assignment: { printerKey, origin: simulator.origin },
    allowedOrigins: [simulator.origin],
    limits: {
      maxMessageBytes: 262144,
      connectTimeoutMs: 1000,
      requestTimeoutMs: 1000,
      staleAfterMs: 5000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    jobFields: true,
    signal: controller.signal,
    onEvent(event) {
      if (event.kind !== 'snapshot' || first) return
      const { printer } = event
      if (printer.lastJob)
        collection.finished(printerKey, printer.lastJob.endedAt)
      first = links.attach(printer)
    },
  })
  try {
    await waitFor(() => first !== undefined, 'first Moonraker snapshot')
    expect(first).toMatchObject({
      state: 'idle',
      lastJob: {
        filename: 'part.gcode',
        outcome: 'completed',
        endedAt: first?.observedAt,
        sha256,
        plate: 1,
      },
    })
    expect(collection.read(printerKey).dispatchedAt).toBeUndefined()
    const attempt = String(first?.lastJob?.endedAt)
    expect(collection.awaiting(printerKey)).toEqual([attempt])
    expect(collection.blocked(printerKey)).toBe(true)
    collection.confirm(printerKey, attempt)
    expect(collection.blocked(printerKey)).toBe(false)
  } finally {
    controller.abort()
    await subscription.done
    await simulator.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
