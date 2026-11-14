import { describe, expect, it } from 'vitest'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'
import { PrinterState } from '@open3dfarmmanager/farm-protocol'

const context = { printerKey: 'test-printer', observedAt: 1_800_000_000_000 }

function createMoonrakerSnapshotWire(
  status: Record<string, unknown>,
  eventtime = 42.5,
) {
  return JSON.stringify({
    result: {
      eventtime,
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0.5 },
        ...status,
      },
    },
  })
}

describe('Moonraker fan and light telemetry', () => {
  it('extracts fan percentages from fan, fan_generic aux, fan_generic chamber objects', () => {
    const wire = createMoonrakerSnapshotWire({
      fan: { speed: 0.6 },
      'fan_generic aux': { speed: 1.0 },
      'fan_generic chamber': { speed: 0.25 },
    })
    const { printer } = parseMoonrakerSnapshot(wire, context)
    expect(printer.fans).toEqual({
      part: 60,
      aux: 100,
      chamber: 25,
    })
  })

  it('supports fan_generic part/aux_fan/chamber_fan variants', () => {
    const wire = createMoonrakerSnapshotWire({
      'fan_generic part_fan': { speed: 0.5 },
      'fan_generic aux_fan': { speed: 0.8 },
      'fan_generic chamber_fan': { speed: 0.1 },
    })
    const { printer } = parseMoonrakerSnapshot(wire, context)
    expect(printer.fans).toEqual({
      part: 50,
      aux: 80,
      chamber: 10,
    })
  })

  it('extracts chamber light from output_pin caselight', () => {
    const wireOn = createMoonrakerSnapshotWire({
      'output_pin caselight': { value: 1.0 },
    })
    expect(parseMoonrakerSnapshot(wireOn, context).printer.light).toEqual({
      chamber: true,
    })

    const wireOff = createMoonrakerSnapshotWire({
      'output_pin caselight': { value: 0 },
    })
    expect(parseMoonrakerSnapshot(wireOff, context).printer.light).toEqual({
      chamber: false,
    })
  })

  it('omits fans and light fields when absent from Moonraker status', () => {
    const wire = createMoonrakerSnapshotWire({})
    const { printer } = parseMoonrakerSnapshot(wire, context)
    expect(printer).not.toHaveProperty('fans')
    expect(printer).not.toHaveProperty('light')
  })

  it('handles partial fan presence without inventing missing fans', () => {
    const wire = createMoonrakerSnapshotWire({
      fan: { speed: 0.4 },
    })
    const { printer } = parseMoonrakerSnapshot(wire, context)
    expect(printer.fans).toEqual({
      part: 40,
    })
    expect(printer.fans).not.toHaveProperty('aux')
    expect(printer.fans).not.toHaveProperty('chamber')
    expect(printer).not.toHaveProperty('light')
  })

  it('clamps and rounds fan speeds appropriately', () => {
    const wire = createMoonrakerSnapshotWire({
      fan: { speed: 0.333 },
      'fan_generic aux': { speed: 1.5 },
      'fan_generic chamber': { speed: -0.2 },
    })
    const { printer } = parseMoonrakerSnapshot(wire, context)
    expect(printer.fans).toEqual({
      part: 33,
      aux: 100,
      chamber: 0,
    })
  })
})

describe('Bambu fan and light telemetry contract', () => {
  it('allows PrinterState to accept Bambu decoded fans (0-100) and chamber light', () => {
    const state = PrinterState.parse({
      printerKey: 'bambu-x1c',
      state: 'printing',
      progress: 0.5,
      observedAt: 1_800_000_000_000,
      fans: {
        part: Math.round((15 / 15) * 100),
        aux: Math.round((7 / 15) * 100),
        chamber: 0,
      },
      light: {
        chamber: true,
      },
    })
    expect(state.fans).toEqual({
      part: 100,
      aux: 47,
      chamber: 0,
    })
    expect(state.light).toEqual({
      chamber: true,
    })
  })
})

describe('PrinterState schema accepts fans and light for all vendors', () => {
  it('validates a complete printer state with fans and light', () => {
    const valid = PrinterState.parse({
      printerKey: 'any-vendor',
      state: 'idle',
      progress: 0,
      observedAt: 12345,
      fans: {
        part: 100,
        aux: 50,
        chamber: 0,
      },
      light: {
        chamber: true,
      },
    })
    expect(valid.fans).toEqual({ part: 100, aux: 50, chamber: 0 })
    expect(valid.light).toEqual({ chamber: true })
  })

  it('rejects invalid fan percent or non-integer', () => {
    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        fans: { part: 101 },
      }).success,
    ).toBe(false)

    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        fans: { part: -1 },
      }).success,
    ).toBe(false)

    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        fans: { part: 50.5 },
      }).success,
    ).toBe(false)
  })

  it('rejects unknown fan keys or unknown light keys due to strictObject', () => {
    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        fans: { extra: 50 },
      }).success,
    ).toBe(false)

    expect(
      PrinterState.safeParse({
        printerKey: 'p',
        state: 'idle',
        progress: 0,
        observedAt: 1,
        light: { extra: true },
      }).success,
    ).toBe(false)
  })
})
