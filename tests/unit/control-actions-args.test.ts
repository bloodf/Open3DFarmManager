import { describe, it, expect } from 'vitest'
import {
  ControlArguments,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { controlWithinLimits } from '../../packages/connector/src/runtime/control-limits.ts'
const cases = [
  ['pause', {}],
  ['resume', {}],
  ['cancel', {}],
  ['emergency_stop', {}],
  ['firmware_restart', {}],
  ['set_temperature', { heater: 'extruder', target_c: 200 }],
  ['set_fan', { fan: 'part', percent: 100 }],
  ['home', { axes: ['x', 'z'] }],
  ['set_light', { on: true }],
  ['set_speed', { level: 'sport' }],
  ['start_print', { file: 'part.gcode' }],
] as const
describe('extended control arguments', () => {
  for (const [action, args] of cases)
    it(action, () => {
      expect(ControlArguments.safeParse({ action, args }).success).toBe(true)
      expect(
        ControlArguments.safeParse({ action, args: { ...args, unknown: true } })
          .success,
      ).toBe(false)
    })
  it('rejects invalid values', () => {
    for (const [action, args] of [
      ['set_temperature', { heater: 'bed', target_c: -1 }],
      ['set_fan', { fan: 'part', percent: 101 }],
      ['home', { axes: [] }],
      ['home', { axes: ['x', 'x'] }],
      ['set_light', { on: 1 }],
      ['set_speed', { level: 'fast' }],
      ['start_print', { file: '../part' }],
      ['start_print', { file: 'a/b' }],
      ['start_print', { file: 'a\\b' }],
    ])
      expect(ControlArguments.safeParse({ action, args }).success).toBe(false)
  })
  it('enforces connector limits and overrides', () => {
    for (const [heater, max] of [
      ['extruder', 300],
      ['bed', 120],
      ['chamber', 65],
    ] as const) {
      expect(
        controlWithinLimits('set_temperature', { heater, target_c: max }),
      ).toBe(true)
      expect(
        controlWithinLimits('set_temperature', { heater, target_c: max + 1 }),
      ).toBe(false)
    }
    expect(
      controlWithinLimits(
        'set_temperature',
        { heater: 'bed', target_c: 90 },
        { extruder: 250, bed: 80, chamber: 50 },
      ),
    ).toBe(false)
  })
  it('allows only control roles', () => {
    for (const role of ['owner', 'admin', 'operator'])
      expect(controlRoleAllowed(role)).toBe(true)
    for (const role of ['viewer', 'guest', ''])
      expect(controlRoleAllowed(role)).toBe(false)
  })
})
