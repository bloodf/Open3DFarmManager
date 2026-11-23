import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  buildMoonrakerCommand,
  supportedMoonrakerActions,
} from '../../packages/connector/src/moonraker/commands.ts'
import {
  snapmakerU1ToolHeaters,
  SNAPMAKER_U1_MARKER,
} from '../../packages/connector/src/moonraker/u1-marker.ts'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import {
  SNAPMAKER_U1_TOOL_COUNT,
  isSnapmakerU1Model,
  mapSnapmakerU1Tools,
} from '../../packages/connector/src/moonraker/u1-tools.ts'

/** Fixtures are JSONC: a leading `//` comment names the source, then plain JSON. */
function fixture(name: string): any {
  const text = readFileSync(
    new URL(`../fixtures/moonraker/u1/${name}`, import.meta.url),
    'utf8',
  )
  expect(text).toMatch(/^\/\/ (recorded|spec-derived, not captured)/)
  return JSON.parse(
    text.replace(/^\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
  )
}

describe('Snapmaker U1 four tools', () => {
  test('reports four identities with temperatures, target and active tool', () => {
    const { objects, status } = fixture('four-tools.jsonc')
    const mapped = mapSnapmakerU1Tools(status, objects)
    expect(mapped.model).toBe('snapmaker-u1')
    expect(mapped.tools).toHaveLength(SNAPMAKER_U1_TOOL_COUNT)
    expect(mapped.tools.map((t) => [t.tool, t.object])).toEqual([
      ['T0', 'extruder'],
      ['T1', 'extruder1'],
      ['T2', 'extruder2'],
      ['T3', 'extruder3'],
    ])
    expect(mapped.activeTool).toBe('T2')
    expect(mapped.tools.map((t) => t.active)).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(mapped.tools[2]).toMatchObject({
      celsius: 215.4,
      targetCelsius: 215,
      reported: true,
    })
    expect(mapped.tools.map((t) => t.filamentDetected)).toEqual([
      true,
      false,
      true,
      true,
    ])
  })

  test('recognises the declared model only', () => {
    for (const model of [
      'Snapmaker U1',
      'snapmaker-u1',
      'U1',
      ' snapmaker_u1 ',
    ])
      expect(isSnapmakerU1Model(model)).toBe(true)
    for (const model of [
      'Klipper',
      'Sovol SV06',
      'U10',
      'Snapmaker A350',
      '',
      undefined,
      null,
    ])
      expect(isSnapmakerU1Model(model)).toBe(false)
  })
})

describe('Snapmaker U1 missing fields stay unknown', () => {
  const { objects, status } = fixture('missing-fields.jsonc')
  const mapped = mapSnapmakerU1Tools(status, objects)

  test('still reports all four tools', () => {
    expect(mapped.tools.map((t) => t.tool)).toEqual(['T0', 'T1', 'T2', 'T3'])
  })

  test('absent active tool is unknown, not false', () => {
    expect(mapped.activeTool).toBeNull()
    expect(mapped.tools.map((t) => t.active)).toEqual([null, null, null, null])
  })

  test('absent or invalid temperatures are null', () => {
    expect(mapped.tools[0]).toMatchObject({
      celsius: 24.5,
      targetCelsius: null,
    })
    expect(mapped.tools[1]).toMatchObject({ celsius: null, targetCelsius: 0 })
    expect(mapped.tools[2]).toMatchObject({ celsius: null, targetCelsius: 200 })
  })

  test('unlisted tool is unreported with every field unknown', () => {
    expect(mapped.tools[3]).toEqual({
      index: 3,
      tool: 'T3',
      object: 'extruder3',
      reported: false,
      active: null,
      celsius: null,
      targetCelsius: null,
      filamentDetected: null,
    })
  })

  test('filament stays unknown without a state or a mappable sensor name', () => {
    expect(mapped.tools.map((t) => t.filamentDetected)).toEqual([
      null,
      null,
      null,
      null,
    ])
  })

  test('an empty status maps to four unknown tools', () => {
    const empty = mapSnapmakerU1Tools({})
    expect(empty.activeTool).toBeNull()
    expect(empty.tools.every((t) => !t.reported && t.celsius === null)).toBe(
      true,
    )
  })

  test('a non-object status is rejected, not guessed', () => {
    expect(() => mapSnapmakerU1Tools('nope')).toThrow(TypeError)
  })
})

describe('Snapmaker U1 signed tool heater mapping', () => {
  const { objects } = fixture('four-tools.jsonc')
  test('advertises only tools with a detected heater', () => {
    expect(snapmakerU1ToolHeaters(objects)).toEqual([
      { tool: 0, maxC: 300 },
      { tool: 1, maxC: 300 },
      { tool: 2, maxC: 300 },
      { tool: 3, maxC: 300 },
    ])
    expect(snapmakerU1ToolHeaters(['extruder2', 'extruder4'])).toEqual([
      { tool: 2, maxC: 300 },
    ])
  })

  test('the builder only targets a detected U1 extruder and keeps generic behavior', () => {
    const args = { tool: 1, target_c: 200 }
    const detected = [...objects, 'print_stats', SNAPMAKER_U1_MARKER]
    expect(
      buildMoonrakerCommand('set_tool_temperature', args, detected),
    ).toEqual({
      method: 'printer.gcode.script',
      params: { script: 'SET_HEATER_TEMPERATURE HEATER=extruder1 TARGET=200' },
    })
    expect(() =>
      buildMoonrakerCommand(
        'set_tool_temperature',
        args,
        detected.filter((name) => name !== 'extruder1'),
      ),
    ).toThrow()
    expect(() =>
      buildMoonrakerCommand('set_tool_temperature', args, objects),
    ).toThrow()
  })
})

describe('generic Klipper is unchanged', () => {
  const generic = fixture('generic-klipper.jsonc')
  const wire = JSON.stringify(generic)

  test('is not a U1', () => {
    expect(isSnapmakerU1Model('Klipper + Moonraker genérico')).toBe(false)
  })

  test('snapshot normalisation ignores the U1 module', () => {
    const { printer } = parseMoonrakerSnapshot(wire, {
      printerKey: 'k1',
      observedAt: 1000,
    })
    expect(printer).toEqual({
      printerKey: 'k1',
      observedAt: 1000,
      state: 'printing',
      progress: 0.25,
      filename: 'benchy.gcode',
      printDuration: 120,
      estimatedRemainingSeconds: 360,
    })
  })

  test('generic command support still follows the object list', () => {
    const actions = supportedMoonrakerActions([
      'webhooks',
      'toolhead',
      'extruder',
      'heater_bed',
      'print_stats',
    ])
    expect(actions).toEqual(
      expect.arrayContaining(['pause', 'resume', 'cancel', 'set_temperature']),
    )
    expect(
      buildMoonrakerCommand(
        'set_temperature',
        { heater: 'extruder', target_c: 200 },
        ['extruder'],
      ).method,
    ).toBe('printer.gcode.script')
  })
})
