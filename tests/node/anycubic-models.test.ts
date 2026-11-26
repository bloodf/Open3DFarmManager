// SPDX-License-Identifier: AGPL-3.0-or-later
// Kobra 4 (20028) and Kobra S1 Max (20029) against the loopback simulator.
// Simulator only: synthetic, reference-derived wire; no printer is contacted.
// Sources: docs/fullfarmmanager/evidence/anycubic-fdm-models.md.
import assert from 'node:assert/strict'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  anycubicControls,
  buildAnycubicControlCommand,
} from '../../packages/connector/src/anycubic/control-support.ts'
import {
  ANYCUBIC_QUALIFIED_WRITES,
  anycubicUnqualifiedMessage,
  type AnycubicQualification,
} from '../../packages/connector/src/anycubic/models.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import { provisionAnycubicPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createAnycubicCollection } from '../../packages/connector/src/runtime/anycubic-collection.ts'
import { createFarmSnapshotSource } from '../../packages/connector/src/runtime/farm-snapshot-provider.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createPrinterDetailSources } from '../../packages/connector/src/runtime/printer-detail-session.ts'
import type { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  ANYCUBIC_SIM_FIRMWARE,
  startAnycubicSimulator,
} from '../../packages/sim-tools/src/anycubic-simulator.ts'

type ModelId = keyof typeof ANYCUBIC_SIM_FIRMWARE
const MODELS = Object.keys(ANYCUBIC_SIM_FIRMWARE) as ModelId[]
const QUALIFIED: AnycubicQualification[] = MODELS.map((modelId) => ({
  modelId,
  firmwareVersion: ANYCUBIC_SIM_FIRMWARE[modelId],
}))

async function fixture(
  t: TestContext,
  modelId: ModelId,
  options: { firmware?: string; confirmCommands?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'anycubic-models-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const passwordFile = join(directory, 'password.json')
  await writeFile(passwordFile, JSON.stringify('synthetic'), { mode: 0o600 })
  const sim = await startAnycubicSimulator({
    modelId,
    credentials: { username: 'synthetic', password: 'synthetic' },
    reportIntervalMs: 100,
    ...options,
  })
  t.after(() => sim.close())
  const local = {
    printerKey: 'printer',
    host: sim.host,
    port: sim.port,
    modelId,
    deviceId: 'SYNTHETIC',
    username: 'synthetic',
    passwordFile,
    pinSha256: createHash('sha256')
      .update(new X509Certificate(sim.syntheticTrust).raw)
      .digest('hex'),
  }
  const binding = provisionAnycubicPrinter(
    {
      assignment_id: randomUUID(),
      printer_key: 'printer',
      farm_id: randomUUID(),
      agent_id: randomUUID(),
    },
    local,
  )
  return { sim, local, binding }
}

function router(qualified?: readonly AnycubicQualification[]) {
  return createPauseDriverRouter({
    allowedOrigins: [],
    limits: {} as never,
    clock: { monotonicNow: () => performance.now() },
    observe: () => true,
    ...(qualified ? { anycubicQualifiedWrites: qualified } : {}),
  })
}

type Router = ReturnType<typeof router>
type Binding = Awaited<ReturnType<typeof fixture>>['binding']

/** One command per attempt, as the dispatcher does it. */
async function run(
  routes: Router,
  binding: Binding,
  action: Parameters<Router['execute']>[0],
  args: Record<string, unknown> = {},
) {
  const signal = new AbortController().signal
  await routes.prepare({ binding, signal })
  try {
    return await routes.execute(action, args, {
      binding,
      signal,
      beforeSend: () => true,
    })
  } finally {
    await routes.closeAttempt(binding)
  }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (check()) return
    await delay(25)
  }
  assert.fail('Condition never held')
}

test('the shipped write list is empty and no new model offers anything', () => {
  assert.deepEqual(ANYCUBIC_QUALIFIED_WRITES, [])
  for (const modelId of MODELS)
    assert.deepEqual(
      anycubicControls(modelId, ANYCUBIC_SIM_FIRMWARE[modelId]),
      [],
    )
  // A pair only counts for a model the table knows.
  assert.deepEqual(
    anycubicControls('20026', '2.4.6.7', [
      { modelId: '20026', firmwareVersion: '2.4.6.7' },
    ]),
    [],
  )
  // The Kobra 3 set does not read the list.
  assert.deepEqual(anycubicControls('20024'), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'set_light',
    'start_print',
  ])
})

test('a qualified pair never offers start, and light only on the S1 Max', () => {
  const common = [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
  ] as const
  assert.deepEqual(anycubicControls('20028', 'sim-kobra-4', QUALIFIED), [
    ...common,
  ])
  assert.deepEqual(anycubicControls('20029', '2.6.9.6', QUALIFIED), [
    ...common,
    'set_light',
  ])
  assert.deepEqual(anycubicControls('20029', '2.7.1.4', QUALIFIED), [])
  assert.throws(() =>
    buildAnycubicControlCommand('set_light', { on: true }, '20028'),
  )
  const bed = { heater: 'bed', target_c: 110 }
  assert.throws(() =>
    buildAnycubicControlCommand('set_temperature', bed, '20028'),
  )
  assert.doesNotThrow(() =>
    buildAnycubicControlCommand('set_temperature', bed, '20029'),
  )
  const lamp = (modelId: string) =>
    (
      buildAnycubicControlCommand('set_light', { on: true }, modelId) as {
        data: { type: number }
      }
    ).data.type
  assert.equal(lamp('20029'), 2)
  assert.equal(lamp('20024'), 3)
})

test('the listed models and the Kobra 3 get a detail feed, an unknown id none', () => {
  const ids = ['20024', '20028', '20029', '20026']
  const sources = createPrinterDetailSources({
    assignments: [],
    collection: {
      version: 5,
      printers: [],
      allowedOrigins: [],
      limits: {},
      anycubic: {
        printers: ids.map((modelId) => ({ printerKey: modelId, modelId })),
      },
    },
  } as never)
  assert.deepEqual(
    ids.map((id) => sources.sourceFor(id) !== undefined),
    [true, true, true, false],
  )
})

test('report rules apply to the listed models only', () => {
  const info = Buffer.from(
    JSON.stringify({
      type: 'info',
      action: 'report',
      data: {
        state: 'busy',
        temp: { curr_chamber_temp: 43, target_chamber_temp: 0 },
        box_fan_level: 20,
        project: { state: 'resumed', pause: 0, progress: 42 },
      },
    }),
  )
  const s1 = decodeAnycubicReport(info, '20029') as Record<string, unknown>
  assert.equal(s1.state, 'printing')
  assert.equal(s1.chamberTemperatureCelsius, 43)
  assert.equal(s1.chamberTargetCelsius, 0)
  const k4 = decodeAnycubicReport(info, '20028') as Record<string, unknown>
  assert.equal(k4.state, 'printing')
  assert.equal(k4.chamberTemperatureCelsius, undefined)
  assert.equal(k4.fans, undefined)
  assert.deepEqual(s1.fans, { chamber: 20 })
  const k3 = decodeAnycubicReport(info, '20024') as Record<string, unknown>
  assert.equal(k3.state, undefined)
  assert.equal(k3.chamberTemperatureCelsius, undefined)

  const lights = Buffer.from(
    JSON.stringify({
      type: 'light',
      data: {
        lights: [
          { type: 2, status: 1 },
          { type: 3, status: 1 },
        ],
      },
    }),
  )
  assert.deepEqual(decodeAnycubicReport(lights, '20028'), { kind: 'ignored' })
  assert.deepEqual(decodeAnycubicReport(lights, '20029'), {
    kind: 'observation',
    light: { chamber: true },
  })
})

for (const modelId of MODELS)
  test(
    `${modelId}: status is read, lost and recovered without any request`,
    { timeout: 30_000 },
    async (t) => {
      const { sim, local } = await fixture(t, modelId)
      sim.setPrintProgress(25)
      const controller = new AbortController()
      const seen: PrinterState[] = []
      let lost = 0
      // The farm snapshot refuses an observation whose field stamps it does not
      // know, so every collected one goes through it.
      const source = createFarmSnapshotSource({
        assignmentRefs: [
          {
            assignmentId: randomUUID(),
            agentId: randomUUID(),
            printerKey: 'printer',
          },
        ],
      })
      const refused: unknown[] = []
      const collection = createAnycubicCollection({
        binding: local,
        signal: controller.signal,
        onObservation: (value) => {
          try {
            source.observe(value)
          } catch (error) {
            refused.push(error)
          }
          seen.push(value.printer as PrinterState)
        },
        onUnavailable: () => lost++,
      })
      t.after(async () => {
        controller.abort()
        await collection.done
      })
      const latest = () => seen.at(-1)
      await until(
        () =>
          latest()?.state === 'printing' &&
          latest()?.toolTemperatureCelsius === 215,
      )
      assert.equal(latest()!.progress, 0.25)
      assert.equal(latest()!.bedTemperatureCelsius, 60)
      assert.equal(
        latest()!.chamberTemperatureCelsius,
        modelId === '20029' ? 43 : undefined,
      )
      assert.deepEqual(
        latest()!.light,
        modelId === '20029' ? { chamber: false } : undefined,
      )

      await sim.setOnline(false)
      await until(() => lost > 0)
      const before = seen.length
      await delay(1500)
      assert.equal(seen.length, before)

      sim.finishPrint()
      await sim.setOnline(true)
      // The job ended while the link was down: idle, with no job to name.
      await until(() => latest()?.state === 'idle')
      assert.equal(latest()!.progress, 0)
      assert.equal(latest()!.lastJob, undefined)
      sim.setPrintProgress(60)
      await until(
        () => latest()?.state === 'printing' && latest()?.progress === 0.6,
      )
      assert.deepEqual(refused, [])
      assert.deepEqual(sim.writes, [])
      assert.deepEqual(sim.queries, [])
    },
  )

for (const modelId of MODELS)
  test(`${modelId}: with the shipped list nothing is published`, async (t) => {
    const { sim, binding } = await fixture(t, modelId)
    sim.setPrintProgress(25)
    const routes = router()
    await routes.detect(binding)
    assert.deepEqual(routes.controls(binding), [])
    assert.equal(
      routes.startUnavailableMessage?.(binding),
      anycubicUnqualifiedMessage(modelId),
    )
    await assert.rejects(
      routes.prepare({ binding, signal: new AbortController().signal }),
      { userMessage: anycubicUnqualifiedMessage(modelId) },
    )
    assert.deepEqual(sim.writes, [])
    assert.deepEqual(sim.queries, [])
  })

test('another firmware than the qualified one offers and sends nothing', async (t) => {
  const { sim, binding } = await fixture(t, '20029', { firmware: '2.7.1.4' })
  sim.setPrintProgress(25)
  const routes = router(QUALIFIED)
  await routes.detect(binding)
  assert.deepEqual(routes.controls(binding), [])
  await assert.rejects(run(routes, binding, 'pause'))
  assert.deepEqual(sim.writes, [])
})

for (const modelId of MODELS)
  test(
    `${modelId}: a qualified pair confirms each command from the printer's report`,
    { timeout: 30_000 },
    async (t) => {
      const { sim, binding } = await fixture(t, modelId)
      sim.setPrintProgress(25)
      const routes = router(QUALIFIED)
      await routes.detect(binding)
      assert.deepEqual(
        routes.controls(binding),
        anycubicControls(modelId, ANYCUBIC_SIM_FIRMWARE[modelId], QUALIFIED),
      )

      await run(routes, binding, 'set_temperature', {
        heater: 'extruder',
        target_c: 205,
      })
      await run(routes, binding, 'set_fan', { fan: 'part', percent: 40 })
      if (modelId === '20029')
        await run(routes, binding, 'set_light', { on: true })
      else
        await assert.rejects(run(routes, binding, 'set_light', { on: true }), {
          refusal: 'unsupported-action',
        })
      await assert.rejects(
        run(routes, binding, 'start_print', { file: 'part.gcode' }),
        { refusal: 'unsupported-action' },
      )
      await run(routes, binding, 'pause')
      assert.equal(sim.lifecycle.state, 'paused')
      await run(routes, binding, 'resume')
      assert.equal(sim.lifecycle.state, 'printing')
      await run(routes, binding, 'cancel')
      assert.equal(sim.lifecycle.state, 'idle')
      // Idle: a job setting is refused before any write.
      await assert.rejects(
        run(routes, binding, 'set_fan', { fan: 'part', percent: 10 }),
        { refusal: 'state' },
      )

      assert.deepEqual(
        sim.writes.map(({ type, action }) => `${type}/${action}`),
        [
          'print/update',
          'print/update',
          ...(modelId === '20029' ? ['light/control'] : []),
          'print/pause',
          'print/resume',
          'print/stop',
        ],
      )
      assert.deepEqual(sim.writes[0]!.data, {
        taskid: '-1',
        settings: { target_nozzle_temp: 205 },
      })
    },
  )

test(
  'an unconfirmed command is sent once and never again',
  { timeout: 30_000 },
  async (t) => {
    const { sim, binding } = await fixture(t, '20029', {
      confirmCommands: false,
    })
    sim.setPrintProgress(25)
    const routes = router(QUALIFIED)
    await routes.detect(binding)
    await assert.rejects(run(routes, binding, 'pause'), /timeout/)
    await delay(1000)
    assert.deepEqual(
      sim.writes.map(({ action }) => action),
      ['pause'],
    )
  },
)
