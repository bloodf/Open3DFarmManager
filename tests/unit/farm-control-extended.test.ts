import { describe, expect, it } from 'vitest'
import {
  advertisedExtended,
  buildExtendedArgs,
  requiresExtendedConfirmation,
  unsupportedExtended,
} from '../../apps/farm/app/utils/farm-control-extended.ts'
describe('extended farm controls', () => {
  it('builds bounded arguments', () => {
    expect(buildExtendedArgs('set_temperature', 'extruder', '300')).toEqual({
      heater: 'extruder',
      target_c: 300,
    })
    expect(buildExtendedArgs('set_temperature', 'bed', '121')).toBeUndefined()
    expect(
      buildExtendedArgs('set_temperature', 'chamber', '66'),
    ).toBeUndefined()
    expect(buildExtendedArgs('set_fan', 'part', '101')).toBeUndefined()
    expect(buildExtendedArgs('set_fan', 'part', '50')).toEqual({
      fan: 'part',
      percent: 50,
    })
    expect(buildExtendedArgs('home', '', '')).toEqual({ axes: ['x', 'y', 'z'] })
    expect(buildExtendedArgs('set_light', 'off', '')).toEqual({ on: false })
    expect(buildExtendedArgs('set_speed', 'sport', '')).toEqual({
      level: 'sport',
    })
  })
  it('accepts the numeric model a number input produces', () => {
    expect(buildExtendedArgs('set_temperature', 'extruder', 215)).toEqual({
      heater: 'extruder',
      target_c: 215,
    })
    expect(buildExtendedArgs('set_fan', 'part', 80)).toEqual({
      fan: 'part',
      percent: 80,
    })
    expect(buildExtendedArgs('set_fan', 'part', 101)).toBeUndefined()
  })
  it('lists the commands a printer does not advertise', () => {
    expect(unsupportedExtended(['pause', 'home', 'set_light'])).toEqual([
      'set_temperature',
      'set_fan',
      'set_speed',
      'firmware_restart',
      'emergency_stop',
      'load_filament',
      'unload_filament',
    ])
    expect(unsupportedExtended(undefined)).toEqual([])
  })
  it('only shows advertised actions and identifies confirmations', () => {
    expect(advertisedExtended(['home', 'pause'])).toEqual(['home'])
    expect(advertisedExtended(undefined)).toEqual([])
    for (const action of [
      'home',
      'firmware_restart',
      'emergency_stop',
    ] as const)
      expect(requiresExtendedConfirmation(action)).toBe(true)
  })
})
