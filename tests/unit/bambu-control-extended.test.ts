import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildBambuCommand } from '../../packages/connector/src/bambu/commands.ts'
import { openFixedBambuControl } from '../../packages/connector/src/bambu/control-driver.ts'
import {
  BambuDetailRefused,
  buildBambuConsoleLine,
  buildBambuExtrude,
  buildBambuJog,
} from '../../packages/connector/src/bambu/printer-detail.ts'
import { provisionBambuPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'

type Simulator = Awaited<ReturnType<typeof startBambuSimulator>>
const simulators: Simulator[] = []
afterEach(async () => {
  await Promise.all(simulators.splice(0).map((sim) => sim.close()))
})

/** One guarded request on one local connection, as the signed path sends it. */
async function send(
  action: Parameters<
    ReturnType<typeof openFixedBambuControl>['driver']['execute'] & {}
  >[0],
  args: Record<string, unknown>,
  initialState: 'IDLE' | 'RUNNING' = 'IDLE',
) {
  const sim = await startBambuSimulator({ initialState })
  simulators.push(sim)
  const directory = mkdtempSync(join(tmpdir(), 'bambu-control-extended-'))
  writeFileSync(
    join(directory, 'credentials'),
    JSON.stringify({ accessCode: 'secret' }),
    {
      mode: 0o600,
    },
  )
  chmodSync(join(directory, 'credentials'), 0o600)
  writeFileSync(join(directory, 'ca'), sim.syntheticTrust)
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
      credentialFile: join(directory, 'credentials'),
      caFile: join(directory, 'ca'),
      control: true,
    },
  )
  const controller = new AbortController()
  const control = openFixedBambuControl({
    binding,
    connectionGeneration: 1,
    clock: { monotonicNow: () => performance.now() },
    publish: () => {},
    signal: controller.signal,
    timeoutMs: 3000,
  })
  try {
    await control.prepare()
    const result = await control.driver.execute!(action, args, {
      binding,
      signal: controller.signal,
      beforeSend: () => true,
    })
    // The first report after the send settles the dispatch, and baseline
    // reports can arrive while the QoS 0 publish is still in flight inside
    // the broker; wait (bounded) until the simulator has recorded it.
    for (
      let i = 0;
      i < 100 && !sim.requests.length && !sim.gcodeLines.length;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 20))
    return { sim, result }
  } finally {
    await control.close()
  }
}

describe('Bambu jog, extrusion and console through gcode_line', () => {
  it('jogs and homes through gcode_line', async () => {
    const jog = await send('jog', { axis: 'x', distance_mm: -10.5, feed: 3000 })
    expect(jog.result).toEqual({ acknowledged: true })
    expect(jog.sim.gcodeLines).toEqual(['G91\nG1 X-10.5 F3000\nG90\n'])
    const home = await send('home', { axes: ['x', 'y'] })
    expect(home.sim.gcodeLines).toEqual(['G28 X Y\n'])
    expect(home.sim.extendedState.homed_axes).toBe('X Y')
    expect(buildBambuJog({ axis: 'z', distance_mm: 0.01, feed: 60 })).toEqual({
      print: {
        command: 'gcode_line',
        param: 'G91\nG1 Z0.01 F60\nG90\n',
        sequence_id: '0',
      },
    })
  })

  it('refuses jogs outside the E18.1 bounds before sending anything', async () => {
    for (const args of [
      { axis: 'x', distance_mm: 100.01, feed: 3000 },
      { axis: 'x', distance_mm: 0.005, feed: 3000 },
      { axis: 'x', distance_mm: 1.005, feed: 3000 },
      { axis: 'x', distance_mm: 1, feed: 59 },
      { axis: 'x', distance_mm: 1, feed: 18001 },
      { axis: 'w', distance_mm: 1, feed: 600 },
      { axis: 'x', distance_mm: Number.NaN, feed: 600 },
      { axis: 'x', distance_mm: 1, feed: 600, extra: 'G28' },
    ])
      expect(() => buildBambuCommand('jog', args)).toThrow()
    await expect(
      send('jog', { axis: 'x', distance_mm: 500, feed: 3000 }),
    ).rejects.toThrow('Bambu control unavailable')
  })

  it('extrudes through gcode_line', async () => {
    const extrude = await send('extrude', { tool: 0, length_mm: 10, feed: 300 })
    expect(extrude.result).toEqual({ acknowledged: true })
    // The simulator nozzle reads 210 °C, inside the Connector's bounds.
    expect(extrude.sim.gcodeLines).toEqual(['M83\nG1 E10 F300\nM82\n'])
    const retract = await send('extrude', { tool: 0, length_mm: -5, feed: 600 })
    expect(retract.sim.gcodeLines).toEqual(['M83\nG1 E-5 F600\nM82\n'])
  })

  it('refuses extrusion that is cold, unknown, out of bounds or on another tool', async () => {
    const ok = { tool: 0, length_mm: 10, feed: 300 }
    for (const nozzle of [25, 169.9, 300.1, undefined, Number.NaN, '210'])
      expect(() => buildBambuExtrude(ok, nozzle)).toThrow(BambuDetailRefused)
    expect(() => buildBambuExtrude(ok, 170)).not.toThrow()
    expect(() => buildBambuExtrude(ok, 300)).not.toThrow()
    for (const args of [
      { ...ok, length_mm: 100.1 },
      { ...ok, length_mm: -50.1 },
      { ...ok, length_mm: 0 },
      { ...ok, feed: 6001 },
      { ...ok, feed: 0 },
      { ...ok, tool: -1 },
      { ...ok, tool: 16 },
    ])
      expect(() => buildBambuExtrude(args, 210)).toThrow('invalid-command')
    expect(() => buildBambuExtrude({ ...ok, tool: 1 }, 210)).toThrow(
      'unsupported-action',
    )
    // A wire-supplied reading never replaces the live one.
    expect(() =>
      buildBambuCommand('extrude', { ...ok, nozzle_c: 210 }),
    ).not.toThrow()
    expect(() => buildBambuCommand('extrude', ok)).toThrow('state')
  })

  it('console lines follow the E18.1 rules', async () => {
    const idle = await send('gcode' as never, { line: 'M400' })
    expect(idle.sim.gcodeLines).toEqual(['M400\n'])
    expect(buildBambuConsoleLine('  M220 S120 ', 'RUNNING').print.param).toBe(
      'M220 S120\n',
    )
    for (const state of ['IDLE', 'FINISH'])
      expect(buildBambuConsoleLine('G28', state).print.param).toBe('G28\n')
    // Printing or paused: tuning allow-list only.
    for (const state of ['RUNNING', 'PAUSE', 'PREPARE']) {
      for (const line of ['M105', 'M114', 'M115', 'M220 S100', 'M221 S100'])
        expect(() => buildBambuConsoleLine(line, state)).not.toThrow()
      for (const line of [
        'G28',
        'G1 X10',
        'M104 S300',
        'M220 S9',
        'M220 S501',
        'M221 S49',
        'M221 S151',
        'M105 X',
        'M112',
      ])
        expect(() => buildBambuConsoleLine(line, state)).toThrow('state')
    }
    // Failed, unknown or missing state refuses everything.
    for (const state of ['FAILED', 'SLICING', undefined, 3])
      expect(() => buildBambuConsoleLine('M105', state)).toThrow('state')
    // One printable ASCII line of at most 256 bytes.
    for (const line of [
      '',
      '   ',
      'G28\nG28',
      'G28\r',
      'M117 café',
      'G'.repeat(257),
      42,
      undefined,
    ])
      expect(() => buildBambuConsoleLine(line, 'IDLE')).toThrow(
        'invalid-command',
      )
    expect(() => buildBambuConsoleLine('M'.repeat(256), 'IDLE')).not.toThrow()
    // The driver adds the live printer state; wire input cannot supply it.
    expect(() =>
      buildBambuCommand('gcode', { line: 'M105', print_state: 'IDLE' }),
    ).not.toThrow()
    expect(() => buildBambuCommand('gcode', { line: 'G28' })).toThrow('state')
    expect(() =>
      buildBambuCommand('gcode', { line: 'G28', print_state: 'IDLE', x: 1 }),
    ).toThrow('Invalid arguments')
    const refused = await send(
      'gcode' as never,
      { line: 'G28' },
      'RUNNING',
    ).catch((error: Error) => error)
    expect(refused).toBeInstanceOf(Error)
  })

  it('keeps unsupported Bambu actions unavailable', () => {
    for (const action of [
      'emergency_stop',
      'firmware_restart',
      'service',
      'run_macro',
      'motors_off',
      'z_babystep',
      'set_factor',
      'set_led',
      'set_pin',
      'queue_op',
    ])
      expect(() => buildBambuCommand(action, {})).toThrow(
        'Unsupported Bambu action',
      )
  })
})
