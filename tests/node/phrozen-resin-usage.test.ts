import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { resinLedgerEntry } from '../../apps/farm/common/resin-ledger/entry.ts'
import type { ResinLedgerRecord } from '../../apps/farm/server/utils/resin-ledger/record.ts'
import { summarizeResinLedger } from '../../apps/farm/server/utils/resin-ledger/summary.ts'
import { connectPhrozen } from '../../packages/connector/src/phrozen/index.ts'
import {
  openPhrozenResinAccounting,
  phrozenRunKey,
  type PhrozenResinLedger,
} from '../../packages/connector/src/phrozen/resin-usage.ts'
import { startPhrozenSimulator } from '../../packages/sim-tools/src/phrozen-simulator.ts'
import fixture from '../fixtures/phrozen/synthetic-revo-14k-v153.json' with { type: 'json' }

// Printer clock in seconds; the ledger clock in milliseconds.
const T = 1_800_000_000
const ms = (seconds: number) => (T + seconds) * 1000

/**
 * The existing ledger's entry schema and summary over an in-memory table, so
 * every assertion reads the state the real ledger would show.
 */
function memoryLedger() {
  const records: ResinLedgerRecord[] = []
  const calls: unknown[] = []
  let mode: 'store' | 'refuse' | 'throw' | 'store-then-throw' | 'hang' = 'store'
  let readFails = false
  const add = (entry: unknown, recordedAt: number) =>
    records.push({
      id: String(records.length),
      recordedAt,
      entry: resinLedgerEntry.parse(entry),
    })
  const port: PhrozenResinLedger = {
    async vatReading() {
      if (readFails) throw new Error('ledger read failed')
      const { vat, vatVolumeMl } = summarizeResinLedger(records)
      return vat && vatVolumeMl
        ? {
            vatName: vat.name,
            volumeMl: vatVolumeMl.value,
            recordedAt: Math.max(vat.recordedAt, vatVolumeMl.recordedAt),
          }
        : null
    },
    async record(_printerKey, entry) {
      calls.push(entry)
      if (mode === 'refuse') return false
      if (mode === 'throw') throw new Error('lost')
      if (mode === 'hang') return new Promise<boolean>(() => {})
      // A server clock only moves forward.
      add(entry, Math.max(...records.map((r) => r.recordedAt)) + 1)
      if (mode === 'store-then-throw') throw new Error('lost')
      return true
    },
  }
  return {
    port,
    records,
    calls,
    set mode(value: typeof mode) {
      mode = value
    },
    set readFails(value: boolean) {
      readFails = value
    },
    /** An operator's vat change and measured volume. */
    manual(volumeMl: number, at: number) {
      add({ kind: 'vat', name: 'Cuba 1', source: 'manual' }, at - 1)
      add(
        {
          kind: 'volume',
          target: 'vat',
          name: 'Cuba 1',
          volumeMl,
          source: 'manual',
        },
        at,
      )
    },
    volume: () => summarizeResinLedger(records).vatVolumeMl,
  }
}

async function setup(t: TestContext, timeoutMs = 1000) {
  const sim = await startPhrozenSimulator(fixture)
  t.after(sim.close)
  const printer = await connectPhrozen('127.0.0.1', {
    ...sim,
    timeoutMs: 500,
    confirmTimeoutMs: 150,
    pollMs: 5,
  })
  sim.reset()
  const directory = mkdtempSync(join(tmpdir(), 'phrozen-resin-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'resin.json')
  const ledger = memoryLedger()
  const open = () =>
    openPhrozenResinAccounting({ path, ledger: ledger.port, timeoutMs })

  /** A run on the simulated printer, read back from its task history. */
  async function run(
    start: number,
    report: Parameters<typeof sim.endPrint>[0],
  ) {
    const taskId = sim.beginPrint('part.ctb', T + start)
    sim.endPrint({ endTime: T + start + 60, layers: 150, ...report })
    const usage = await printer.readTaskUsage(taskId)
    assert.ok(usage)
    return usage
  }
  return { sim, printer, ledger, open, run }
}

test('debits the reported volume once, across repeats and restarts', async (t) => {
  const { printer, ledger, open, run } = await setup(t)
  ledger.manual(500, ms(0))
  const usage = await run(100, { volumeMl: 12.34 })
  assert.equal(usage.volumeMl, 12.34)
  assert.equal(usage.status, 'completed')
  const accounting = open()

  const outcomes = await Promise.all(
    [1, 2, 3].map(() => accounting.recordRun('revo-1', usage)),
  )
  assert.deepEqual(
    outcomes.map((o) => 'duplicate' in o && o.duplicate),
    [false, true, true],
  )
  const reread = await printer.readTaskUsage(usage.taskId)
  assert.ok(reread)
  await open().recordRun('revo-1', reread)
  // A rebound printer key is still the same physical run.
  await open().recordRun('revo-renamed', reread)

  assert.deepEqual(ledger.volume(), {
    value: 487.66,
    source: 'reported',
    recordedAt: ms(0) + 1,
  })
  assert.equal(ledger.calls.length, 1)
  assert.deepEqual(
    open()
      .list()
      .map(({ key, status, usedMl, remainingMl }) => ({
        key,
        status,
        usedMl,
        remainingMl,
      })),
    [
      {
        key: phrozenRunKey(usage.board, usage.taskId),
        status: 'applied',
        usedMl: 12.34,
        remainingMl: 487.66,
      },
    ],
  )
})

test('consecutive runs subtract from each other, including a stopped run', async (t) => {
  const { ledger, open, run } = await setup(t)
  ledger.manual(100, ms(-10))
  const accounting = open()

  await accounting.recordRun(
    'revo-1',
    await run(-5, { volumeMl: 10, endTime: T - 4 }),
  )
  const stopped = await run(100, { volumeMl: 2.5, taskStatus: 3, layers: 20 })
  assert.equal(stopped.status, 'stopped')
  await accounting.recordRun('revo-1', stopped)

  assert.equal(ledger.volume()?.value, 87.5)
})

for (const [label, report] of [
  ['absent', {}],
  ['zero', { volumeMl: 0 }],
  ['negative', { volumeMl: -3 }],
  ['text', { volumeMl: '12' }],
] as const) {
  test(`${label} volume stays unknown, then is debited once if it arrives`, async (t) => {
    const { sim, printer, ledger, open, run } = await setup(t)
    ledger.manual(500, ms(0))
    const usage = await run(100, report)
    assert.equal(usage.volumeMl, null)

    const first = await open().recordRun('revo-1', usage)
    assert.ok('key' in first)
    assert.deepEqual(
      [first.status, first.reason, first.usedMl, first.remainingMl],
      ['unknown', 'usage-missing', null, null],
    )
    assert.equal(ledger.volume()?.value, 500)
    assert.equal(ledger.calls.length, 0)

    sim.amendTask(usage.taskId, { CurrentLayerTalVolume: 4 })
    const late = await printer.readTaskUsage(usage.taskId)
    assert.ok(late)
    await open().recordRun('revo-1', late)
    await open().recordRun('revo-1', late)
    assert.equal(ledger.volume()?.value, 496)
    assert.equal(ledger.calls.length, 1)
  })
}

for (const [mode, stored] of [
  ['throw', false],
  ['store-then-throw', true],
] as const) {
  test(`an uncertain append (${mode}) is never retried`, async (t) => {
    const { ledger, open, run } = await setup(t)
    ledger.manual(500, ms(0))
    const usage = await run(100, { volumeMl: 10 })
    ledger.mode = mode
    const accounting = open()

    const first = await accounting.recordRun('revo-1', usage)
    assert.equal(first.status, 'uncertain')
    ledger.mode = 'store'
    await accounting.recordRun('revo-1', usage)
    await open().recordRun('revo-1', usage)

    assert.equal(ledger.calls.length, 1)
    assert.equal(ledger.volume()?.value, stored ? 490 : 500)
  })
}

test('a run after an unaccounted one stays unknown until a new reading', async (t) => {
  const { ledger, open, run } = await setup(t)
  ledger.manual(500, ms(0))
  const accounting = open()
  ledger.mode = 'throw'
  await accounting.recordRun('revo-1', await run(100, { volumeMl: 10 }))
  ledger.mode = 'store'

  const blocked = await accounting.recordRun(
    'revo-1',
    await run(200, { volumeMl: 5 }),
  )
  assert.equal(blocked.reason, 'prior-usage-unaccounted')
  assert.equal(ledger.volume()?.value, 500)

  ledger.manual(470, ms(300))
  await accounting.recordRun('revo-1', await run(400, { volumeMl: 5 }))
  assert.equal(ledger.volume()?.value, 465)
})

test('an append that outlives the timeout or the process becomes uncertain', async (t) => {
  const { ledger, open, run } = await setup(t, 50)
  ledger.manual(500, ms(0))
  const usage = await run(100, { volumeMl: 10 })
  ledger.mode = 'hang'
  const accounting = open()

  const inFlight = accounting.recordRun('revo-1', usage)
  while (!ledger.calls.length)
    await new Promise((resolve) => setTimeout(resolve, 1))
  const restarted = open()
  assert.deepEqual(
    restarted.list().map((e) => [e.status, e.reason]),
    [['uncertain', 'restart-while-pending']],
  )
  assert.equal((await inFlight).status, 'uncertain')
  ledger.mode = 'store'
  await restarted.recordRun('revo-1', usage)
  assert.equal(ledger.calls.length, 1)

  const [entry] = restarted.list('uncertain')
  assert.ok(entry)
  assert.equal(
    restarted.resolveUncertain(entry.key, 'rejected').status,
    'rejected',
  )
  await restarted.recordRun('revo-1', usage)
  assert.equal(ledger.calls.length, 1)
  assert.throws(() => restarted.resolveUncertain(entry.key, 'applied'))
})

test('a refused append is recorded and not retried', async (t) => {
  const { ledger, open, run } = await setup(t)
  ledger.manual(500, ms(0))
  const usage = await run(100, { volumeMl: 10 })
  ledger.mode = 'refuse'

  assert.equal((await open().recordRun('revo-1', usage)).status, 'rejected')
  ledger.mode = 'store'
  await open().recordRun('revo-1', usage)

  assert.equal(ledger.calls.length, 1)
  assert.equal(ledger.volume()?.value, 500)
})

for (const [reason, reading, volumeMl, beginTime] of [
  ['vat-reading-missing', null, 10, 100],
  ['reading-not-before-run', [500, ms(130)], 10, 100],
  ['usage-exceeds-reading', [5, ms(0)], 10, 100],
  ['run-time-missing', [500, ms(0)], 10, -T],
] as const) {
  test(`leaves the vat unknown or unchanged: ${reason}`, async (t) => {
    const { ledger, open, run } = await setup(t)
    if (reading) ledger.manual(reading[0], reading[1])
    const usage = await run(beginTime, { volumeMl, endTime: T + 160 })

    const outcome = await open().recordRun('revo-1', usage)

    assert.equal(outcome.reason, reason)
    assert.equal(ledger.volume()?.value ?? null, reading?.[0] ?? null)
    assert.equal(ledger.calls.length, 0)
  })
}

test('defers a running print without journaling it', async (t) => {
  const { sim, printer, ledger, open } = await setup(t)
  ledger.manual(500, ms(0))
  const taskId = sim.beginPrint('part.ctb', T + 100)
  const running = await printer.readTaskUsage(taskId)
  assert.ok(running)
  const accounting = open()

  assert.deepEqual(await accounting.recordRun('revo-1', running), {
    status: 'deferred',
    reason: 'run-not-settled',
  })
  assert.deepEqual(accounting.list(), [])

  sim.endPrint({ volumeMl: 8, endTime: T + 160 })
  const finished = await printer.readTaskUsage(taskId)
  assert.ok(finished)
  await accounting.recordRun('revo-1', finished)
  assert.equal(ledger.volume()?.value, 492)
})

test('a failed ledger read claims nothing, so the run can be recorded later', async (t) => {
  const { ledger, open, run } = await setup(t)
  ledger.manual(500, ms(0))
  const usage = await run(100, { volumeMl: 10 })
  const accounting = open()
  ledger.readFails = true

  await assert.rejects(accounting.recordRun('revo-1', usage), /read failed/)
  assert.deepEqual(accounting.list(), [])
  ledger.readFails = false
  await accounting.recordRun('revo-1', usage)
  assert.equal(ledger.volume()?.value, 490)
})

test('an unrecorded task yields no usage and a failed query is an error', async (t) => {
  const { sim, printer } = await setup(t)

  assert.equal(await printer.readTaskUsage('no-such-task'), undefined)
  sim.misbehave(321, 1)
  await assert.rejects(
    printer.readTaskUsage('no-such-task'),
    /details unavailable/,
  )
})
