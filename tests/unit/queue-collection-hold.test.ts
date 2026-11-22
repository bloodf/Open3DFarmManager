// spec-derived, not captured: https://moonraker.readthedocs.io/en/latest/web_api/#job-queue-apis
// Fake driver only: no printer, simulator or network is contacted.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ControlArguments,
  ControlResultCode,
  controlSourceState,
  type ExtendedControlAction,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { withCollectionHold } from '../../packages/connector/src/control/queue-collection-hold.ts'
import {
  openQueueCollectionJournal,
  unavailableQueueCollectionJournal,
  type QueueCollectionJournal,
} from '../../packages/connector/src/control/queue-collection-journal.ts'
import type { PauseDriver } from '../../packages/connector/src/control/pause-dispatcher.ts'
import type { PrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'

const binding = Object.freeze({}) as unknown as PrinterBinding
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function journalPath() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-collection-hold-'))
  dirs.push(dir)
  return join(dir, 'queue-collection.json')
}
function fakeDriver() {
  const sent: string[] = []
  const driver: PauseDriver = {
    controls: () => ['pause', 'start_print', 'start_library_print', 'queue_op'],
    async execute(action, _args, request) {
      if (!request.beforeSend()) return { acknowledged: false }
      sent.push(action)
      return { acknowledged: true }
    },
    async pauseOnce() {
      return { acknowledged: false }
    },
    async waitForPaused() {
      return null
    },
  }
  return { driver, sent }
}
function held(journal: QueueCollectionJournal, clock = () => 1_000) {
  const fake = fakeDriver()
  const driver = withCollectionHold(fake.driver, {
    journal,
    printerKey: (b: PrinterBinding) =>
      b === binding ? 'printer-a' : undefined,
    clock,
  })
  let guards = 0
  const run = (
    action: ExtendedControlAction,
    args: Record<string, unknown> = {},
    allow = true,
  ) =>
    driver.execute!(action, args, {
      binding,
      beforeSend: () => {
        guards++
        return allow
      },
      signal: new AbortController().signal,
    })
  return { driver, run, sent: fake.sent, guards: () => guards }
}
async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { refusal?: string; resultCode?: string }
  }
  throw new Error('Expected a refusal')
}

describe('queue collection hold', () => {
  it('holds the next copy after an OpenFarm run finishes, despite duplicate reports', async () => {
    const journal = openQueueCollectionJournal(journalPath())
    const { run, sent } = held(journal)
    await run('start_print', { file: 'a.gcode' })
    expect(sent).toEqual(['start_print'])
    // The same finished run is reported on every snapshot.
    for (let i = 0; i < 5; i++) journal.finished('printer-a', 5_000)
    expect(journal.read('printer-a').attempts).toEqual([
      { id: '5000', status: 'awaiting-collection' },
    ])
    const error = await refusal(run('start_print', { file: 'b.gcode' }))
    expect(error.refusal).toBe('state')
    expect(error.resultCode).toBe('awaiting-collection')
    expect(ControlResultCode.safeParse(error.resultCode).success).toBe(true)
    expect(
      (await refusal(run('start_library_print', { sha256: 'x' }))).refusal,
    ).toBe('state')
    expect(sent).toEqual(['start_print'])
  })

  it('keeps the hold across a Connector restart and a mid-print restart', async () => {
    const path = journalPath()
    const first = held(openQueueCollectionJournal(path))
    await first.run('start_print', { file: 'a.gcode' })
    // Restart while printing: the dispatch marker survives.
    const afterStart = openQueueCollectionJournal(path)
    afterStart.finished('printer-a', 5_000)
    const restarted = openQueueCollectionJournal(path)
    // A restarted Connector re-observes the same finished run.
    restarted.finished('printer-a', 5_000)
    const again = held(restarted)
    expect((await refusal(again.run('start_print'))).resultCode).toBe(
      'awaiting-collection',
    )
    expect(again.sent).toEqual([])
    expect(restarted.read('printer-a').attempts).toHaveLength(1)
  })

  it('releases only after confirmation, and an old confirmation never clears a newer run', async () => {
    const path = journalPath()
    const journal = openQueueCollectionJournal(path)
    const hold = held(journal, () => 1_000)
    expect(hold.driver.controls!(binding)).not.toContain('confirm_collection')
    await hold.run('start_print')
    journal.finished('printer-a', 5_000)
    expect(hold.driver.controls!(binding)).toContain('confirm_collection')
    // A refused guard records nothing.
    expect(
      await hold.run('confirm_collection', { attempt: '5000' }, false),
    ).toEqual({ acknowledged: false })
    expect(journal.blocked('printer-a')).toBe(true)
    expect(await hold.run('confirm_collection', { attempt: '5000' })).toEqual({
      acknowledged: true,
    })
    expect(openQueueCollectionJournal(path).blocked('printer-a')).toBe(false)
    expect(hold.driver.controls!(binding)).not.toContain('confirm_collection')
    // The confirmation never reached the printer.
    expect(hold.sent).toEqual(['start_print'])
    // A repeated completion report for the collected run does not re-hold.
    journal.finished('printer-a', 5_000)
    expect(journal.blocked('printer-a')).toBe(false)

    const second = held(journal, () => 6_000)
    await second.run('start_print')
    journal.finished('printer-a', 9_000)
    // Replaying the first confirmation cannot release the second attempt.
    await second.run('confirm_collection', { attempt: '5000' })
    expect(journal.blocked('printer-a')).toBe(true)
    expect(journal.read('printer-a').attempts).toEqual([
      { id: '5000', status: 'collected' },
      { id: '9000', status: 'awaiting-collection' },
    ])
    await second.run('confirm_collection', { attempt: '9000' })
    expect(journal.blocked('printer-a')).toBe(false)
    await second.run('start_print')
    expect(second.sent).toEqual(['start_print', 'start_print'])
  })

  it('does not hold runs OpenFarm did not start, nor runs that ended before the start', async () => {
    const journal = openQueueCollectionJournal(journalPath())
    journal.finished('printer-a', 500)
    expect(journal.blocked('printer-a')).toBe(false)
    const hold = held(journal, () => 1_000)
    await hold.run('start_print')
    // The previous run is still reported until the new one ends.
    journal.finished('printer-a', 500)
    expect(journal.awaiting('printer-a')).toEqual([])
    journal.finished('printer-a', 2_000)
    expect(journal.blocked('printer-a')).toBe(true)
  })

  it('re-reads the hold after the guard and fails closed without a journal', async () => {
    const journal = openQueueCollectionJournal(journalPath())
    const fake = fakeDriver()
    let finishDuringGuard = false
    const driver = withCollectionHold(fake.driver, {
      journal,
      printerKey: () => 'printer-a',
      clock: () => 1_000,
    })
    const result = await driver.execute!(
      'start_print',
      {},
      {
        binding,
        beforeSend() {
          // A completion observed between the check and the send.
          if (!finishDuringGuard) journal.complete('printer-a', '3000')
          finishDuringGuard = true
          return true
        },
        signal: new AbortController().signal,
      },
    )
    expect(result).toEqual({ acknowledged: false })
    expect(fake.sent).toEqual([])

    const closed = held(unavailableQueueCollectionJournal())
    expect((await refusal(closed.run('start_print'))).refusal).toBe('state')
    expect(closed.guards()).toBe(0)
    expect(closed.driver.controls!(binding)).not.toContain('confirm_collection')
    // Other actions keep working.
    await closed.run('pause')
    expect(closed.sent).toEqual(['pause'])
  })

  it('blocks another start while the sent run has no terminal observation', async () => {
    const journal = openQueueCollectionJournal(journalPath())
    const hold = held(journal, () => 100)
    await hold.run('start_print')
    expect((await refusal(hold.run('start_print'))).refusal).toBe('state')
    journal.finished('printer-a', 150)
    expect(journal.awaiting('printer-a')).toEqual(['150'])
    expect(hold.sent).toEqual(['start_print'])
  })

  it('does not record a start refused at the send guard', async () => {
    const journal = openQueueCollectionJournal(journalPath())
    const hold = held(journal, () => 100)
    await hold.run('start_print', {}, false)
    journal.finished('printer-a', 200)
    expect(journal.blocked('printer-a')).toBe(false)
    expect(journal.awaiting('printer-a')).toEqual([])
  })

  it('refuses a corrupt journal file at open', () => {
    const path = journalPath()
    writeFileSync(path, '{"version":1,"printers":{"p":{"attempts":"x"}}}')
    expect(() => openQueueCollectionJournal(path)).toThrow()
  })

  it('defines confirm_collection in the signed control protocol', () => {
    expect(
      ControlArguments.safeParse({
        action: 'confirm_collection',
        args: { attempt: '1732280000000' },
      }).success,
    ).toBe(true)
    for (const attempt of ['', '-1', '01', 'abc', '12345678901234567'])
      expect(
        ControlArguments.safeParse({
          action: 'confirm_collection',
          args: { attempt },
        }).success,
      ).toBe(false)
    expect(controlSourceState('confirm_collection', 'idle')).toBe(true)
    expect(controlSourceState('confirm_collection', 'printing')).toBe(false)
    expect(controlSourceState('confirm_collection', 'paused')).toBe(false)
    expect(controlSourceState('confirm_collection', 'unknown')).toBe(false)
  })
})
