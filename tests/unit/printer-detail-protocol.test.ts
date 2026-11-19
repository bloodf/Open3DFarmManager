import { describe, expect, it } from 'vitest'
import {
  PrinterDetailCapability,
  PrinterDetailFrame,
  PrinterDetailGcodeResponse,
  PrinterDetailQueryRequest,
  PrinterDetailQueryResponse,
  PrinterDetailSubscriptions,
  PrinterDetailUpdate,
} from '../../packages/farm-protocol/src/printer-detail.ts'

const base = { v: 1 as const, printer_key: 'printer_1' }
const validUpdate = {
  ...base,
  t: 'detail.update',
  seq: 0,
  heaters: [],
  fans: [],
  leds: [],
  output_pins: [],
  speed_factor: 1,
  flow_factor: 1,
  gcode_offsets: { x: 0, y: 0, z: 0 },
  print_stats: null,
  virtual_sdcard: null,
  display_status: null,
  exclude_object: null,
  bed_mesh: null,
  idle_timeout: null,
  klippy: { state: 'ready', message: null },
  host_stats: {},
}

describe('printer detail protocol', () => {
  it('supports subscribe/unsubscribe and one subscription per printer in a session', () => {
    expect(
      PrinterDetailFrame.parse({ ...base, t: 'detail.subscribe' }),
    ).toBeTruthy()
    expect(
      PrinterDetailFrame.parse({ ...base, t: 'detail.unsubscribe' }),
    ).toBeTruthy()
    const subscriptions = new PrinterDetailSubscriptions()
    expect(subscriptions.subscribe(base.printer_key)).toBe(true)
    expect(subscriptions.subscribe(base.printer_key)).toBe(false)
    expect(subscriptions.unsubscribe(base.printer_key)).toBe(true)
  })
  it('accepts bounded status updates', () => {
    expect(
      PrinterDetailUpdate.parse({
        ...validUpdate,
        heaters: [
          { name: 'extruder', temperature: 200, target: 210, power: 0.7 },
        ],
        toolhead: {
          position: { x: 1, y: 2, z: 3 },
          homed_axes: ['x', 'y', 'z'],
        },
      }),
    ).toMatchObject({ t: 'detail.update' })
  })
  it('rejects oversized, unknown-field and malformed frames', () => {
    expect(
      PrinterDetailUpdate.safeParse({ ...validUpdate, unknown: true }).success,
    ).toBe(false)
    expect(
      PrinterDetailUpdate.safeParse({
        ...validUpdate,
        heaters: Array(65).fill({
          name: 'h',
          temperature: 0,
          target: 0,
          power: 0,
        }),
      }).success,
    ).toBe(false)
    expect(
      PrinterDetailUpdate.safeParse({
        ...validUpdate,
        speed_factor: Number.NaN,
      }).success,
    ).toBe(false)
    expect(
      PrinterDetailQueryRequest.safeParse({
        ...base,
        t: 'detail.query',
        request_id: 'r',
        kind: 'files',
        offset: 0,
        limit: 101,
      }).success,
    ).toBe(false)
    expect(
      PrinterDetailQueryResponse.safeParse({
        ...base,
        t: 'detail.query_result',
        request_id: 'r',
        kind: 'files',
        ok: true,
        items: [],
        next_offset: null,
        unexpected: 1,
      }).success,
    ).toBe(false)
    expect(
      PrinterDetailFrame.safeParse({
        ...base,
        t: 'detail.gcode_response',
        lines: ['x'.repeat(70000)],
      }).success,
    ).toBe(false)
  })
  it('validates capability, response batches, and all supported query kinds', () => {
    expect(
      PrinterDetailCapability.safeParse({
        ...base,
        t: 'detail.capability',
        areas: ['fans', 'bed_mesh'],
      }).success,
    ).toBe(true)
    expect(
      PrinterDetailGcodeResponse.safeParse({
        ...base,
        t: 'detail.gcode_response',
        lines: ['ok'],
      }).success,
    ).toBe(true)
    for (const kind of [
      'files',
      'history',
      'totals',
      'config_files',
      'config_read',
      'job_queue',
      'power_devices',
      'timelapse',
      'update_status',
      'temperature_store',
    ])
      expect(
        PrinterDetailQueryRequest.safeParse({
          ...base,
          t: 'detail.query',
          request_id: 'r',
          kind,
          offset: 0,
          limit: 20,
        }).success,
      ).toBe(true)
  })
})
