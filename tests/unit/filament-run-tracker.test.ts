import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { PrinterState } from '@open3dfarmmanager/farm-protocol'
import { openFilamentRunJournal } from '../../packages/connector/src/control/filament-run-journal.ts'
import {
  createFilamentRunAccounting,
  type ActiveSpoolRef,
  type RunCompletion,
} from '../../packages/connector/src/spoolman/filament-run.ts'
import {
  createActiveSpoolReader,
  createFilamentRunTracker,
} from '../../packages/connector/src/spoolman/filament-run-tracker.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'filament-run-tracker-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const state = (
  value: PrinterState['state'],
  observedAt: number,
  lastJob?: PrinterState['lastJob'],
): PrinterState => ({
  printerKey: 'p',
  state: value,
  progress: value === 'idle' ? 1 : 0.5,
  observedAt,
  ...(lastJob ? { lastJob } : {}),
})

function tracker(spools: () => Promise<readonly ActiveSpoolRef[]>) {
  const runs: RunCompletion[] = []
  const controller = new AbortController()
  const value = createFilamentRunTracker({
    accounting: {
      async completeRun(run) {
        runs.push(run)
        return []
      },
    },
    readSpools: spools,
    signal: controller.signal,
  })
  return { runs, tracker: value, controller }
}

const t0: ActiveSpoolRef[] = [{ tool: 'T0', spoolId: 7, source: 'assignment' }]

test('a watched run is completed once, with its start and end spools', async () => {
  const { runs, tracker: t } = tracker(async () => t0)
  t.observe(state('printing', 10))
  t.observe(state('printing', 11))
  const job = {
    outcome: 'completed',
    endedAt: 20,
    filamentUsedMillimetres: 9,
  } as const
  t.observe(state('idle', 20, job))
  t.observe(state('idle', 21, job))
  t.observe(state('idle', 22, job))
  await t.idle()
  expect(runs).toEqual([
    {
      printerKey: 'p',
      endedAt: 20,
      outcome: 'completed',
      usage: [{ tool: 'T0', millimetres: 9 }],
      spoolsAtStart: t0,
      spoolsAtEnd: t0,
    },
  ])
})

test('a job that ended before the run was watched is never accounted', async () => {
  const { runs, tracker: t } = tracker(async () => t0)
  // After a restart the printer still shows its previous finished job.
  t.observe(state('idle', 30, { outcome: 'completed', endedAt: 5 }))
  t.observe(state('printing', 31, { outcome: 'completed', endedAt: 5 }))
  t.observe(state('idle', 32, { outcome: 'completed', endedAt: 5 }))
  await t.idle()
  expect(runs).toEqual([])
})

test('an unreadable spool source leaves attribution unknown instead of guessing', async () => {
  const journal = openFilamentRunJournal({ path: join(dir, 'runs.json') })
  const uses: unknown[] = []
  const accounting = createFilamentRunAccounting({
    journal,
    origin: 'http://127.0.0.1:9',
    fetch: async (...args) => {
      uses.push(args)
      return new Response(null, { status: 200 })
    },
  })
  const t = createFilamentRunTracker({
    accounting,
    readSpools: async () => {
      throw Error('Moonraker unreachable')
    },
    signal: new AbortController().signal,
  })
  t.observe(state('printing', 1))
  t.observe(
    state('idle', 2, {
      outcome: 'completed',
      endedAt: 2,
      filamentUsedMillimetres: 40,
    }),
  )
  await t.idle()
  expect(uses).toEqual([])
  expect(journal.list()).toMatchObject([
    { status: 'unknown', reason: 'tool-unresolved' },
  ])
})

test('nothing is claimed once the Connector is shutting down', async () => {
  const { runs, tracker: t, controller } = tracker(async () => t0)
  t.observe(state('printing', 1))
  t.observe(state('idle', 2, { outcome: 'completed', endedAt: 2 }))
  controller.abort()
  await t.idle()
  expect(runs).toEqual([])
})

test('a spool whose tracking moved between Moonraker and an assignment mid-run is not debited', async () => {
  const journal = openFilamentRunJournal({ path: join(dir, 'runs.json') })
  const uses: unknown[] = []
  const accounting = createFilamentRunAccounting({
    journal,
    origin: 'http://127.0.0.1:9',
    fetch: async (...args) => {
      uses.push(args)
      return new Response(null, { status: 200 })
    },
  })
  const outcome = await accounting.completeRun({
    printerKey: 'p',
    endedAt: 1,
    outcome: 'completed',
    usage: [{ tool: 'T0', grams: 3 }],
    spoolsAtStart: [{ tool: 'T0', spoolId: 7, source: 'assignment' }],
    spoolsAtEnd: [{ tool: 'T0', spoolId: 7, source: 'moonraker' }],
  })
  expect(outcome).toMatchObject([
    { status: 'unknown', reason: 'spool-changed' },
  ])
  expect(uses).toEqual([])
})

test('the reader prefers Moonraker’s spool and falls back to assignments only when Moonraker has no Spoolman', async () => {
  const assignments = {
    listForPrinter: async () => [{ printerKey: 'p', slot: 'T0', spoolId: 7 }],
  }
  const reader = (respond: () => Response) =>
    createActiveSpoolReader({
      moonraker: new Map([
        ['p', { origin: 'http://127.0.0.1:9', headers: async () => ({}) }],
      ]),
      assignments,
      fetch: async () => respond(),
    })
  const signal = new AbortController().signal
  expect(
    await reader(() => Response.json({ result: { spool_id: 42 } }))(
      'p',
      signal,
    ),
  ).toEqual([{ tool: 'external', spoolId: 42, source: 'moonraker' }])
  expect(
    await reader(() => new Response(null, { status: 404 }))('p', signal),
  ).toEqual(t0)
  expect(
    await reader(() => Response.json({ result: { spool_id: null } }))(
      'p',
      signal,
    ),
  ).toEqual(t0)
  // An uncertain answer never falls back: Moonraker might be reporting usage.
  await expect(
    reader(() => new Response(null, { status: 503 }))('p', signal),
  ).rejects.toThrow()
})
