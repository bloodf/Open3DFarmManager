import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { moonrakerLastJob } from '../../packages/connector/src/moonraker/normalize.ts'
import { moonrakerFilamentUsage } from '../../packages/connector/src/runtime/job-filament-usage.ts'
import { jobsFromEvents } from '../../apps/farm/server/services/job-history-core.ts'
import { recordJobs } from '../../apps/farm/server/storage/job-history-store.ts'

test('Moonraker length converts using active spool diameter and density', () => {
  const [usage] = [
    moonrakerFilamentUsage(250.5, [
      {
        slot: 'external',
        active: true,
        filamentDiameterMm: 1.75,
        filamentDensityGramsPerCm3: 1.24,
      },
    ]),
  ]
  assert.equal(usage?.tool, 'external')
  assert.equal(usage?.millimetres, 250.5)
  assert.ok(Math.abs((usage?.grams ?? 0) - 0.747128656) < 0.000001)
})

test('unknown spool properties and tool allocation stay absent', () => {
  assert.deepEqual(moonrakerFilamentUsage(15, undefined), {
    tool: 'unknown',
    millimetres: 15,
  })
  assert.deepEqual(
    moonrakerFilamentUsage(15, [
      { slot: 'a', active: true },
      { slot: 'b', active: true },
    ]),
    { tool: 'unknown', millimetres: 15 },
  )
})

test('Moonraker terminal job carries reported filament length only', () => {
  const job = moonrakerLastJob(
    {
      webhooks: { state: 'ready' },
      print_stats: { state: 'complete', filament_used: 42.25 },
    },
    1_700_000_000_000,
  )
  assert.equal(job?.filamentUsedMillimetres, 42.25)
  assert.equal(
    moonrakerLastJob(
      {
        webhooks: { state: 'ready' },
        print_stats: { state: 'complete', filament_used: 'unknown' },
      },
      1,
    )?.filamentUsedMillimetres,
    undefined,
  )
})

test('Bambu report records explicit used grams by slot, not spool metadata', () => {
  const decoded = decodeBambuReport({
    print: {
      gcode_state: 'FINISH',
      ams: {
        ams: [
          {
            id: '0',
            tray: [
              { id: '0', used_g: '12.5', remain: 50, tray_weight: '1000' },
              { id: '1', remain: 0, tray_weight: '0' },
            ],
          },
        ],
      },
    },
  })
  assert.equal(decoded.kind, 'observation')
  if (decoded.kind !== 'observation') return
  assert.deepEqual(decoded.filamentUsage, [{ tool: 'ams:0:0', grams: 12.5 }])
})

test('job history preserves per-tool measurements and omits absent usage', () => {
  const jobs = jobsFromEvents([
    {
      kind: 'printer-state',
      state: {
        printerKey: 'printer-1',
        lastJob: {
          outcome: 'completed',
          endedAt: 10,
          filamentUsage: [
            { tool: 'ams:0:0', grams: 12.5 },
            { tool: 'external', millimetres: 8 },
          ],
        },
      },
    },
    {
      kind: 'printer-state',
      state: {
        printerKey: 'printer-2',
        lastJob: { outcome: 'completed', endedAt: 11 },
      },
    },
  ] as never)
  assert.deepEqual(jobs[0]?.filamentUsage, [
    { tool: 'ams:0:0', grams: 12.5 },
    { tool: 'external', millimetres: 8 },
  ])
  assert.equal('filamentUsage' in (jobs[1] ?? {}), false)
})

test('job storage serializes known usage and keeps unknown usage null', async () => {
  const statements: unknown[][] = []
  const tx = ((parts: TemplateStringsArray, ...values: unknown[]) => {
    statements.push(values)
    return Promise.resolve([])
  }) as never
  await recordJobs(
    tx,
    {
      farmId: 'farm',
      agentId: 'connector',
    },
    [
      {
        printerKey: 'printer',
        outcome: 'completed',
        endedAt: 10,
        filamentUsage: [{ tool: 'external', millimetres: 12, grams: 0.03 }],
      },
      { printerKey: 'printer', outcome: 'failed', endedAt: 11 },
    ],
  )
  assert.equal(
    statements[0]?.[7],
    JSON.stringify([{ tool: 'external', millimetres: 12, grams: 0.03 }]),
  )
  assert.equal(statements[1]?.[7], null)
})
