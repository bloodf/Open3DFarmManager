// spec-derived, not captured: the Spoolman fake below follows the
// `PUT /api/v1/spool/{id}/use` contract in https://donkie.github.io/Spoolman/
// (body `use_weight` grams or `use_length` mm; 200 returns the spool).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  openFilamentRunJournal,
  type FilamentRunJournal,
} from '../../packages/connector/src/control/filament-run-journal.ts'
import {
  createFilamentRunAccounting,
  filamentRunKey,
  type ActiveSpoolRef,
  type RunCompletion,
} from '../../packages/connector/src/spoolman/filament-run.ts'
import { serveTestServer, type TestServer } from './serve.ts'

type Mode = 'ok' | 'reject' | 'server-error' | 'drop'
let dir: string
let server: TestServer
let used: Map<number, number>
let calls: { id: number; body: Record<string, number> }[]
let mode: Mode

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'filament-run-'))
  used = new Map()
  calls = []
  mode = 'ok'
  server = await serveTestServer(async (request) => {
    const match = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(
      new URL(request.url).pathname,
    )
    if (request.method !== 'PUT' || !match)
      return new Response(null, { status: 404 })
    const id = Number(match[1])
    const body = (await request.json()) as Record<string, number>
    calls.push({ id, body })
    if (mode === 'reject') return new Response(null, { status: 404 })
    if (mode === 'server-error') return new Response(null, { status: 503 })
    // The use is applied before the answer is lost.
    used.set(id, (used.get(id) ?? 0) + (body.use_weight ?? 0))
    if (mode === 'drop') throw new Error('connection lost')
    return Response.json({ id, used_weight: used.get(id) })
  })
})
afterEach(async () => {
  await server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const path = () => join(dir, 'filament-run.json')
function setup(journal?: FilamentRunJournal) {
  const j = journal ?? openFilamentRunJournal({ path: path() })
  return {
    journal: j,
    accounting: createFilamentRunAccounting({
      journal: j,
      origin: server.url.origin,
      timeoutMs: 2000,
    }),
  }
}
const spool = (
  spoolId: number,
  source: ActiveSpoolRef['source'] = 'assignment',
): ActiveSpoolRef[] => [{ tool: 'T0', spoolId, source }]
function run(over: Partial<RunCompletion> = {}): RunCompletion {
  return {
    printerKey: 'printer-1',
    endedAt: 1_000,
    outcome: 'completed',
    usage: [{ tool: 'T0', grams: 12.5 }],
    spoolsAtStart: spool(7),
    spoolsAtEnd: spool(7),
    ...over,
  }
}

test('a completed run debits the active spool once, however often it repeats', async () => {
  const { accounting } = setup()
  const first = await accounting.completeRun(run())
  expect(first).toMatchObject([
    { status: 'applied', spoolId: 7, duplicate: false },
  ])
  const repeats = await Promise.all([
    accounting.completeRun(run()),
    accounting.completeRun(run()),
    accounting.completeRun(run()),
  ])
  for (const outcome of repeats.flat()) expect(outcome.duplicate).toBe(true)
  expect(calls).toEqual([{ id: 7, body: { use_weight: 12.5 } }])
  expect(used.get(7)).toBe(12.5)
})

test('length is sent as use_length only when grams are not measured', async () => {
  const { accounting } = setup()
  await accounting.completeRun(
    run({ usage: [{ tool: 'T0', millimetres: 4200 }] }),
  )
  expect(calls).toEqual([{ id: 7, body: { use_length: 4200 } }])
})

test('out-of-order completions each apply once and a replay of the older run changes nothing', async () => {
  const { accounting } = setup()
  const later = run({ endedAt: 2_000, usage: [{ tool: 'T0', grams: 3 }] })
  const earlier = run({ endedAt: 1_000, usage: [{ tool: 'T0', grams: 5 }] })
  await accounting.completeRun(later)
  await accounting.completeRun(earlier)
  await accounting.completeRun(later)
  await accounting.completeRun(earlier)
  expect(calls.map((call) => call.body.use_weight).sort()).toEqual([3, 5])
  expect(used.get(7)).toBe(8)
})

test('a printer job id keys the run attempt even when the end time differs', async () => {
  const { accounting } = setup()
  await accounting.completeRun(run({ runId: 'job-9', endedAt: 1_000 }))
  const again = await accounting.completeRun(
    run({ runId: 'job-9', endedAt: 1_001 }),
  )
  expect(again[0]?.duplicate).toBe(true)
  expect(calls).toHaveLength(1)
  expect(filamentRunKey(run(), 'T0')).not.toBe(
    filamentRunKey(run({ endedAt: 5 }), 'T0'),
  )
})

test('missing usage stays unknown and a later event with usage still debits once', async () => {
  const { accounting, journal } = setup()
  const none = await accounting.completeRun(run({ usage: undefined }))
  expect(none).toMatchObject([{ status: 'unknown', reason: 'usage-missing' }])
  const zero = await accounting.completeRun(run({ usage: [{ tool: 'T0' }] }))
  expect(zero).toMatchObject([{ status: 'unknown', reason: 'usage-missing' }])
  expect(calls).toHaveLength(0)
  const later = await accounting.completeRun(run())
  expect(later).toMatchObject([{ status: 'applied', duplicate: false }])
  await accounting.completeRun(run())
  expect(calls).toHaveLength(1)
  expect(journal.list('unknown').map((e) => e.reason)).toEqual(['superseded'])
})

test('unresolved tool, no active spool and unfinished runs record unknown without a debit', async () => {
  const { accounting } = setup()
  expect(
    await accounting.completeRun(
      run({ endedAt: 1, usage: [{ tool: 'unknown', millimetres: 900 }] }),
    ),
  ).toMatchObject([{ status: 'unknown', reason: 'tool-unresolved' }])
  expect(
    await accounting.completeRun(
      run({ endedAt: 2, spoolsAtStart: [], spoolsAtEnd: [] }),
    ),
  ).toMatchObject([
    { status: 'unknown', reason: 'no-active-spool', spoolId: null },
  ])
  expect(
    await accounting.completeRun(run({ endedAt: 3, outcome: 'cancelled' })),
  ).toMatchObject([{ status: 'unknown', reason: 'run-not-completed' }])
  expect(calls).toHaveLength(0)
})

test('a spool changed mid-run is not attributed to either spool', async () => {
  const { accounting } = setup()
  expect(
    await accounting.completeRun(run({ spoolsAtEnd: spool(8) })),
  ).toMatchObject([{ status: 'unknown', reason: 'spool-changed', spoolId: 7 }])
  expect(
    await accounting.completeRun(run({ endedAt: 2, spoolsAtEnd: [] })),
  ).toMatchObject([{ status: 'unknown', reason: 'spool-changed' }])
  expect(calls).toHaveLength(0)
})

test('printers whose Moonraker reports to Spoolman are record-only', async () => {
  const { accounting } = setup()
  const outcome = await accounting.completeRun(
    run({
      spoolsAtStart: spool(7, 'moonraker'),
      spoolsAtEnd: spool(7, 'moonraker'),
    }),
  )
  expect(outcome).toMatchObject([
    { status: 'record-only', spoolId: 7, reason: 'moonraker-reports' },
  ])
  expect(calls).toHaveLength(0)
})

test('a lost response is uncertain, survives restart and is never retried', async () => {
  mode = 'drop'
  const first = setup()
  expect(await first.accounting.completeRun(run())).toMatchObject([
    { status: 'uncertain', reason: 'http-500' },
  ])
  mode = 'ok'
  const repeat = await first.accounting.completeRun(run())
  expect(repeat[0]).toMatchObject({ status: 'uncertain', duplicate: true })
  const reopened = setup()
  await reopened.accounting.completeRun(run())
  expect(calls).toHaveLength(1)
  expect(reopened.accounting.uncertain()).toHaveLength(1)
  const key = reopened.accounting.uncertain()[0]!.key
  reopened.journal.resolveUncertain(key, 'applied')
  expect(reopened.journal.get(key)).toMatchObject({
    status: 'applied',
    reason: 'operator-reconciled',
  })
  expect(() => reopened.journal.resolveUncertain(key, 'applied')).toThrow()
})

test('a server error is uncertain; a definite refusal is rejected, neither retried', async () => {
  mode = 'server-error'
  const { accounting } = setup()
  expect(await accounting.completeRun(run({ endedAt: 1 }))).toMatchObject([
    { status: 'uncertain', reason: 'http-503' },
  ])
  mode = 'reject'
  expect(await accounting.completeRun(run({ endedAt: 2 }))).toMatchObject([
    { status: 'rejected', reason: 'http-404' },
  ])
  mode = 'ok'
  await accounting.completeRun(run({ endedAt: 1 }))
  await accounting.completeRun(run({ endedAt: 2 }))
  expect(calls).toHaveLength(2)
})

test('a transport failure is uncertain', async () => {
  const journal = openFilamentRunJournal({ path: path() })
  const accounting = createFilamentRunAccounting({
    journal,
    origin: server.url.origin,
    fetch: () => Promise.reject(new TypeError('socket hang up')),
  })
  expect(await accounting.completeRun(run())).toMatchObject([
    { status: 'uncertain', reason: 'response-lost' },
  ])
})

test('an entry pending when the process stopped becomes uncertain on reopen', async () => {
  const journal = openFilamentRunJournal({ path: path() })
  const key = filamentRunKey(run(), 'T0')
  journal.claim({
    key,
    printerKey: 'printer-1',
    tool: 'T0',
    spoolId: 7,
    status: 'pending',
    reason: null,
    grams: 12.5,
    millimetres: null,
  })
  const reopened = openFilamentRunJournal({ path: path() })
  expect(reopened.get(key)).toMatchObject({
    status: 'uncertain',
    reason: 'restart-while-pending',
  })
  const { accounting } = setup(reopened)
  const outcome = await accounting.completeRun(run())
  expect(outcome[0]).toMatchObject({ status: 'uncertain', duplicate: true })
  expect(calls).toHaveLength(0)
})

test('the pending entry is on disk before the Spoolman call is made', async () => {
  let seen: string | undefined
  const journal = openFilamentRunJournal({ path: path() })
  const accounting = createFilamentRunAccounting({
    journal,
    origin: server.url.origin,
    fetch: async (...args) => {
      seen = (
        JSON.parse(readFileSync(path(), 'utf8')) as {
          entries: { status: string }[]
        }
      ).entries[0]?.status
      return fetch(...args)
    },
  })
  await accounting.completeRun(run())
  expect(seen).toBe('pending')
})

test('a Spoolman origin that is not canonical is refused', () => {
  const journal = openFilamentRunJournal({ path: path() })
  expect(() =>
    createFilamentRunAccounting({
      journal,
      origin: 'http://user:pw@127.0.0.1:1',
    }),
  ).toThrow()
})
