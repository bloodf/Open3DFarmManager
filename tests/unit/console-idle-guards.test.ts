import { randomUUID } from 'node:crypto'
import { describe, expect, it, onTestFinished } from 'vitest'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { openFixedMoonrakerPause } from '../../packages/connector/src/moonraker/pause-driver.ts'
import { startMoonrakerMock } from '../../packages/sim-tools/src/mocks/moonraker-mock.ts'
import { guardIdleConsole } from '../../packages/connector/src/moonraker/console-idle.ts'
import {
  consoleAllowedWhilePrinting,
  idleConsoleClass,
  ConsoleRefusal,
} from '../../packages/connector/src/moonraker/control-console.ts'

const snapshot = () => ({
  status: {
    webhooks: { state: 'ready' },
    print_stats: { state: 'standby' },
    toolhead: {
      homed_axes: 'xyz',
      position: [100, 100, 100, 0],
      extruder: 'extruder',
    },
    gcode_move: {
      absolute_coordinates: true,
      absolute_extrude: true,
      gcode_position: [100, 100, 100, 0],
      speed: 50,
      speed_factor: 1,
      extrude_factor: 1,
    },
    extruder: { temperature: 200, can_extrude: true },
  },
})

const config = {
  status: {
    configfile: {
      settings: {
        stepper_x: { position_min: 0, position_max: 200 },
        stepper_y: { position_min: 0, position_max: 200 },
        stepper_z: { position_min: 0, position_max: 200 },
        extruder: { max_temp: 250 },
        heater_bed: { max_temp: 120 },
      },
    },
  },
}

const guard = (
  line: string,
  state: unknown = snapshot(),
  settings: unknown = config,
) => guardIdleConsole(line, state, settings)

describe('idle console guards', () => {
  it('refuses unhomed axes', () => {
    const state = snapshot()
    state.status.toolhead.homed_axes = 'yz'
    expect(() => guard('G1 X110 F3000', state)).toThrow('Eixo não referenciado')
  })
  it.each([
    'G1 X201 F3000',
    'G1 X151 F3000',
    'G1 X110 F9001',
    'G1 X140 Y140 F3000',
    'G1 E11 F300',
    'M104 S251',
    'M140 S121',
  ])('refuses unsafe %s', (line) => {
    expect(() => guard(line)).toThrow(ConsoleRefusal)
  })
  it('accepts bounded moves and heater targets with fresh state', () => {
    expect(() => guard('G1 X110 E5 F3000')).not.toThrow()
    expect(() => guard('M104 S200')).not.toThrow()
  })
  it('fails closed on missing state and unclassifiable commands', () => {
    expect(() => guard('G1 X110', {})).toThrow(ConsoleRefusal)
    for (const line of [
      'MY_MACRO',
      'QUERY_MY_MACRO',
      'G92 X0',
      'G2 X10',
      'M112',
    ])
      expect(idleConsoleClass(line)).toBe('refused')
  })
  it('guards homing and mesh calibration', () => {
    expect(idleConsoleClass('G28')).toBe('guarded')
    expect(idleConsoleClass('BED_MESH_CALIBRATE')).toBe('guarded')
    expect(() => guard('G28')).not.toThrow()
    expect(() => guard('G28 X Y')).not.toThrow()
    for (const line of ['G28 X0', 'G28 X X', 'G28 A', 'BED_MESH_CALIBRATE X=1'])
      expect(() => guard(line)).toThrow(ConsoleRefusal)
    expect(() => guard('G28', {}, {})).toThrow(ConsoleRefusal)
    expect(() => guard('BED_MESH_CALIBRATE')).toThrow(ConsoleRefusal)
    const meshed: {
      status: { configfile: { settings: Record<string, unknown> } }
    } = structuredClone(config)
    Object.assign(meshed.status.configfile.settings, {
      bed_mesh: { mesh_min: '20, 20', mesh_max: [180, 180] },
    })
    expect(() => guard('BED_MESH_CALIBRATE', snapshot(), meshed)).not.toThrow()
    const unhomed = snapshot()
    unhomed.status.toolhead.homed_axes = 'xy'
    expect(() => guard('BED_MESH_CALIBRATE', unhomed, meshed)).toThrow(
      'Eixo não referenciado',
    )
    meshed.status.configfile.settings.bed_mesh = {
      mesh_min: '20, 20',
      mesh_max: [250, 180],
    }
    expect(() => guard('BED_MESH_CALIBRATE', snapshot(), meshed)).toThrow(
      ConsoleRefusal,
    )
  })
  it('keeps queries and the printing allow-list', () => {
    expect(idleConsoleClass('M105')).toBe('safe')
    expect(consoleAllowedWhilePrinting('M220 S120')).toBe(true)
    expect(consoleAllowedWhilePrinting('G1 X10')).toBe(false)
  })
})

describe('idle console dispatch', () => {
  it('refuses a heater target before sending and sends a bounded target once', async () => {
    const mock = await startMoonrakerMock({
      configfileSettings: { heater_bed: { max_temp: 100 } },
    })
    onTestFinished(() => mock.close())
    const allowedOrigins = [mock.origin]
    const binding = createPrinterBindingRegistry({ allowedOrigins }).provision({
      assignment_id: randomUUID(),
      farm_id: randomUUID(),
      agent_id: randomUUID(),
      printer_key: 'idle-console',
      moonraker_origin: mock.origin,
    })
    let writes = 0
    async function execute(line: string) {
      const { signal } = new AbortController()
      const fixed = openFixedMoonrakerPause({
        binding,
        allowedOrigins,
        limits: {
          maxMessageBytes: 4096,
          connectTimeoutMs: 1500,
          requestTimeoutMs: 1500,
          staleAfterMs: 5000,
          reconnectMinMs: 40,
          reconnectMaxMs: 160,
        },
        connectionGeneration: 1,
        clock: { monotonicNow: () => performance.now() },
        publish: () => {},
        signal,
        objects: ['webhooks', 'toolhead', 'gcode_move', 'configfile'],
        gcodeConsole: true,
      })
      try {
        await fixed.prepare()
        return await fixed.driver.execute!(
          'gcode',
          { line },
          {
            binding,
            signal,
            beforeSend: () => {
              writes++
              return true
            },
          },
        )
      } finally {
        await fixed.close()
      }
    }
    await expect(execute('M140 S101')).rejects.toMatchObject({
      code: 'limit',
      refusal: 'invalid-command',
    })
    expect(writes).toBe(0)
    expect(mock.control.gcodeScripts).toEqual([])
    await execute('M140 S100')
    expect(writes).toBe(1)
    expect(mock.control.gcodeScripts).toEqual(['M140 S100'])
  })
})
