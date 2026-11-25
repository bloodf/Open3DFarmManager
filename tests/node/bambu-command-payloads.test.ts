/**
 * Temperature, fan and filament requests against the Bambu simulator. Each
 * outcome is read from the reports the simulator publishes over MQTT. Initial
 * report fragments are reference-derived; no printer is contacted.
 */
import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { createBambuControlTransport } from '../../packages/connector/src/bambu/control-transport.ts'
import {
  bambuChamberMaxC,
  buildBambuCommand,
} from '../../packages/connector/src/bambu/commands.ts'
import { openFixedBambuControl } from '../../packages/connector/src/bambu/control-driver.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { provisionBambuPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { dualNozzleReport } from '../fixtures/bambu-reference-derived.ts'

type Print = Record<string, any>
type Action = Parameters<
  NonNullable<ReturnType<typeof openFixedBambuControl>['driver']['execute']>
>[0]

async function eventually(condition: () => boolean, what: string) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    if (performance.now() > deadline) throw Error(`Timed out: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function world(
  t: TestContext,
  options: { model?: string; initialReport?: Record<string, unknown> } = {},
) {
  const sim = await startBambuSimulator({
    initialState: 'IDLE',
    initialTargetTemperature: 220,
    reportIntervalMs: 10,
    ...(options.initialReport ? { initialReport: options.initialReport } : {}),
  })
  const directory = mkdtempSync(join(tmpdir(), 'bambu-payloads-'))
  const credentialFile = join(directory, 'credentials')
  const caFile = join(directory, 'ca')
  writeFileSync(credentialFile, JSON.stringify({ accessCode: 'secret' }), {
    mode: 0o600,
  })
  writeFileSync(caFile, sim.syntheticTrust)
  // An independent subscriber: what the printer (simulator) reports.
  let print: Print = {}
  const controller = new AbortController()
  const observer = createBambuControlTransport({
    host: sim.host,
    port: sim.port,
    serial: 'SYNTHETIC',
    credentials: { username: 'bblp', password: 'secret' },
    caPem: sim.syntheticTrust,
    limits: {
      maxFrameBytes: 131072,
      connectTimeoutMs: 3000,
      maxInflight: 64,
      reconnectDelayMs: 100,
      maxReconnects: 0,
    },
    signal: controller.signal,
    onConnection: () => {},
    onReport: (payload) => {
      print = JSON.parse(payload.toString('utf8')).print ?? print
    },
  })
  t.after(async () => {
    controller.abort()
    await observer.done
    await sim.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await eventually(() => !!print.gcode_state, 'first report')
  const printerKey = 'printer-1'
  const binding = provisionBambuPrinter(
    {
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: printerKey,
    },
    {
      printerKey,
      serial: 'SYNTHETIC',
      host: sim.host,
      port: sim.port,
      allowedEndpoints: [{ host: sim.host, port: sim.port }],
      credentialFile,
      caFile,
      control: true,
      ...(options.model ? { model: options.model } : {}),
    },
  )
  /** One signed-path attempt; returns the exact request put on the wire. */
  async function run(action: string, args: Record<string, unknown>) {
    const abort = new AbortController()
    const control = openFixedBambuControl({
      binding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: () => {},
      signal: abort.signal,
      timeoutMs: 3000,
    })
    const published = () =>
      sim.calls.all
        .map((call) => JSON.parse(call.payload.toString()))
        .filter((value) => !value.pushing && !value.info)
    const before = published().length
    try {
      await control.prepare()
      await control.driver.execute!(action as Action, args, {
        binding,
        signal: abort.signal,
        beforeSend: () => true,
      })
      await eventually(() => published().length > before, `${action} sent`)
      return published().at(-1)
    } finally {
      await control.close()
    }
  }
  const reported = (check: (value: Print) => boolean, what: string) =>
    eventually(() => check(print), what)
  return { sim, run, reported, print: () => print }
}

test('nozzle and bed targets are reported back (G-code form)', async (t) => {
  const f = await world(t)
  assert.deepEqual(
    await f.run('set_temperature', { heater: 'extruder', target_c: 215 }),
    {
      print: { command: 'gcode_line', param: 'M104 S215\n', sequence_id: '1' },
    },
  )
  await f.reported((p) => p.nozzle_target_temper === 215, 'nozzle target')
  assert.deepEqual(
    await f.run('set_temperature', { heater: 'bed', target_c: 65 }),
    { print: { command: 'gcode_line', param: 'M140 S65\n', sequence_id: '1' } },
  )
  await f.reported((p) => p.bed_target_temper === 65, 'bed target')
})

test('H2D-like printer: bed, chamber and air-duct fan requests', async (t) => {
  const f = await world(t, {
    model: 'H2D',
    initialReport: dualNozzleReport(),
  })
  assert.deepEqual(
    await f.run('set_temperature', { heater: 'bed', target_c: 90 }),
    { print: { command: 'set_bed_temp', temp: 90, sequence_id: '1' } },
  )
  await f.reported((p) => p.bed_target_temper === 90, 'bed target')
  assert.deepEqual(
    await f.run('set_temperature', { heater: 'chamber', target_c: 55 }),
    { print: { command: 'set_ctt', ctt_val: 55, sequence_id: '1' } },
  )
  await f.reported((p) => p.ctt === 55, 'chamber target')
  for (const [index, fan] of ['part', 'aux', 'chamber'].entries()) {
    const percent = 30 + index * 20
    assert.deepEqual(await f.run('set_fan', { fan, percent }), {
      print: {
        command: 'set_fan',
        fan_index: index + 1,
        speed: percent,
        sequence_id: '1',
      },
    })
    await f.reported(
      (p) => p.device.airduct.parts[index].state === percent,
      `${fan} fan`,
    )
  }
})

test('part, aux and chamber fans over M106 are reported back', async (t) => {
  const f = await world(t)
  for (const [fan, number, field, percent, pwm, step] of [
    ['part', 1, 'cooling_fan_speed', 100, 255, '15'],
    ['aux', 2, 'big_fan1_speed', 60, 153, '9'],
    ['chamber', 3, 'big_fan2_speed', 0, 0, '0'],
  ] as const) {
    assert.deepEqual(await f.run('set_fan', { fan, percent }), {
      print: {
        command: 'gcode_line',
        param: `M106 P${number} S${pwm}\n`,
        sequence_id: '1',
      },
    })
    await f.reported((p) => p[field] === step, `${fan} fan`)
    const decoded = decodeBambuReport({ print: f.print() })
    assert.ok(decoded.kind === 'observation')
    assert.equal(decoded.fans?.[fan], percent)
  }
})

test('chamber targets are refused without a supporting model', async (t) => {
  const f = await world(t, { model: 'P1S', initialReport: { ctt: 0 } })
  await assert.rejects(
    f.run('set_temperature', { heater: 'chamber', target_c: 40 }),
  )
  assert.deepEqual(f.sim.requests, [])
  assert.equal(f.print().ctt, 0)
  for (const model of [undefined, 'P1S', 'X1C', 'A1', 'constructor'])
    assert.equal(bambuChamberMaxC(model), undefined)
  assert.equal(bambuChamberMaxC('X1E'), 60)
  assert.equal(bambuChamberMaxC('H2D_Pro'), 65)
  assert.throws(() =>
    buildBambuCommand('set_temperature', {
      heater: 'chamber',
      target_c: 66,
      chamber_max_c: 65,
    }),
  )
})

test('loads, switches and unloads standard AMS trays', async (t) => {
  const f = await world(t)
  assert.deepEqual(await f.run('load_filament', { tray: 5 }), {
    print: {
      command: 'ams_change_filament',
      ams_id: 1,
      target: 5,
      slot_id: 1,
      curr_temp: 220,
      tar_temp: 220,
      sequence_id: '1',
    },
  })
  await f.reported((p) => p.ams.tray_now === '5', 'tray 5 loaded')
  // Selecting another tray is another load.
  await f.run('load_filament', { tray: 2 })
  await f.reported((p) => p.ams.tray_now === '2', 'tray 2 loaded')
  assert.deepEqual(await f.run('unload_filament', {}), {
    print: {
      command: 'ams_change_filament',
      ams_id: 0,
      target: 255,
      slot_id: 255,
      curr_temp: 220,
      tar_temp: 220,
      sequence_id: '1',
    },
  })
  await f.reported((p) => p.ams.tray_now === '255', 'unloaded')
})

test('loads and unloads an AMS HT unit', async (t) => {
  const f = await world(t, { initialReport: dualNozzleReport() })
  const load = await f.run('load_filament', { tray: 128 })
  assert.deepEqual(
    [load.print.ams_id, load.print.target, load.print.slot_id],
    [128, 128, 0],
  )
  await f.reported(
    (p) =>
      p.ams.tray_now === '128' && p.device.extruder.info[0].snow === 128 << 8,
    'HT loaded',
  )
  const unload = await f.run('unload_filament', {})
  assert.deepEqual(
    [unload.print.ams_id, unload.print.target, unload.print.slot_id],
    [128, 255, 255],
  )
  await f.reported(
    (p) =>
      p.ams.tray_now === '255' && p.device.extruder.info[0].snow === 0xffff,
    'HT unloaded',
  )
})

test('second-nozzle target request, built but not advertised', async (t) => {
  const f = await world(t, { initialReport: dualNozzleReport() })
  assert.deepEqual(
    await f.run('set_tool_temperature', { tool: 1, target_c: 240 }),
    {
      print: {
        command: 'set_nozzle_temp',
        extruder_index: 1,
        target_temp: 240,
        sequence_id: '1',
      },
    },
  )
  await f.reported(
    (p) => p.device.extruder.info[1].temp >> 16 === 240,
    'left nozzle target',
  )
  assert.equal(f.print().device.extruder.info[0].temp >> 16, 0)
  assert.throws(() =>
    buildBambuCommand('set_tool_temperature', { tool: 2, target_c: 200 }),
  )
})
