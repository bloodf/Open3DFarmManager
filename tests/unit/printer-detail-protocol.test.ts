import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  PrinterDetailCapability,
  PrinterDetailFrame,
  PrinterDetailGcodeResponse,
  PrinterDetailQueryRequest,
  PrinterDetailQueryResponse,
  PrinterDetailSubscriptions,
  PrinterDetailUpdate,
  assemblePrinterDetailFrames,
  createPrinterDetailSubscriptions,
  decodePrinterDetailFrame,
  encodePrinterDetailFrames,
  MAX_PRINTER_DETAIL_APPLICATION_BYTES,
} from '../../packages/farm-protocol/src/printer-detail.ts'
import {
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/network-guard.ts'

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

describe('printer detail stream protocol', () => {
  const base = { v: 1, printerKey: 'printer-a' }
  const subscribe = { ...base, t: 'detail.subscribe' }
  const update = {
    ...base,
    t: 'detail.update',
    seq: 1,
    capabilities: ['heaters'],
    detail: {
      toolhead: { position: [1, 2, 3, 4], homedAxes: ['x', 'y', 'z'] },
      heaters: [{ name: 'bed', temperature: 54, target: 60, power: 0.5 }],
    },
  }
  const response = {
    ...base,
    t: 'query.response',
    requestId: 'request-a',
    kind: 'config-read',
  }

  beforeAll(installNetworkGuard)
  afterAll(uninstallNetworkGuard)

  it.each([
    subscribe,
    update,
    { ...base, t: 'detail.gcode_response', seq: 2, lines: ['ok'] },
    { ...response, t: 'query.request', path: 'printer.cfg' },
    { ...response, data: { path: 'printer.cfg', text: '[printer]' } },
    { ...response, error: 'unsupported' },
  ])('round trips a $t frame', (frame) => {
    const [wire] = encodePrinterDetailFrames(frame, 'transfer-a')
    expect(decodePrinterDetailFrame(wire!)).toEqual(frame)
  })

  it.each([
    { ...subscribe, printerKey: 'p'.repeat(129) },
    { ...subscribe, other: true },
    { ...subscribe, t: 'detail.command' },
    { ...update, capabilities: ['heaters', 'heaters'] },
    {
      ...update,
      detail: { heaters: [{ ...update.detail.heaters[0], power: 2 }] },
    },
    {
      ...update,
      detail: { heaters: Array(65).fill(update.detail.heaters[0]) },
    },
    {
      ...update,
      detail: { heaters: [{ ...update.detail.heaters[0], extra: true }] },
    },
    { ...response, t: 'query.request' },
    {
      ...response,
      kind: 'temperature-store',
      data: { path: 'printer.cfg', text: '' },
    },
    { ...response, kind: 'unknown', error: 'unsupported' },
  ])('rejects invalid $t frames', (frame) => {
    expect(() => decodePrinterDetailFrame(JSON.stringify(frame))).toThrow()
    expect(() => encodePrinterDetailFrames(frame, 'transfer-a')).toThrow()
  })

  it('rejects malformed JSON, ambiguous keys, and oversized UTF-8 wire frames', () => {
    expect(() => decodePrinterDetailFrame('{')).toThrow()
    expect(() =>
      decodePrinterDetailFrame(
        '{"t":"detail.subscribe","t":"detail.unsubscribe"}',
      ),
    ).toThrow()
    const frame = {
      ...response,
      data: { path: 'printer.cfg', text: '😀'.repeat(3000) },
    }
    expect(() => decodePrinterDetailFrame(JSON.stringify(frame))).toThrow()
  })

  it('chunks large results and validates ordering, completeness and identity', () => {
    const frame = {
      ...response,
      data: { path: 'printer.cfg', text: '😀\\\n"'.repeat(4000) },
    }
    const wires = encodePrinterDetailFrames(frame, 'transfer-a')
    expect(wires.length).toBeGreaterThan(2)
    for (const wire of wires) {
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(
        MAX_PRINTER_DETAIL_APPLICATION_BYTES,
      )
      expect(decodePrinterDetailFrame(wire).t).toBe('detail.chunk')
    }
    expect(assemblePrinterDetailFrames(wires)).toEqual(frame)
    expect(() => assemblePrinterDetailFrames(wires.slice(1))).toThrow()
    expect(() => assemblePrinterDetailFrames([...wires].reverse())).toThrow()
    const wrongPrinter = wires.map((wire) =>
      JSON.stringify({
        ...decodePrinterDetailFrame(wire),
        printerKey: 'printer-b',
      }),
    )
    expect(() => assemblePrinterDetailFrames(wrongPrinter)).toThrow()
  })

  it('never emits a wire over the 2048-byte RTC application cap', () => {
    // A frame between 2 and 8 KiB used to go out whole and close the session.
    const rows = Array.from({ length: 10 }, (_, row) =>
      Array.from({ length: 10 }, (_, col) => -0.05 - row * 0.011 + col * 0.003),
    )
    const mesh = {
      ...update,
      capabilities: ['heaters', 'bed-mesh'],
      detail: {
        ...update.detail,
        bedMesh: {
          profile: 'frio',
          min: [0, 0],
          max: [220, 220],
          rows,
          probed: rows,
          profiles: ['default', 'frio'],
        },
      },
    }
    const wires = encodePrinterDetailFrames(mesh, 'transfer-a')
    expect(wires.length).toBeGreaterThan(1)
    for (const wire of wires)
      expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(
        MAX_PRINTER_DETAIL_APPLICATION_BYTES,
      )
    expect(assemblePrinterDetailFrames(wires)).toEqual(mesh)
    const small = encodePrinterDetailFrames(update, 'transfer-a')
    expect(small).toHaveLength(1)
  })

  it('deduplicates per session, releases on page leave, and closes remaining subscriptions', () => {
    const stop = vi.fn()
    const start = vi.fn(() => stop)
    const isAssigned = (key: string) => ['printer-a', 'printer-b'].includes(key)
    const first = createPrinterDetailSubscriptions(isAssigned, start)
    const second = createPrinterDetailSubscriptions(isAssigned, start)
    expect(first.receive({ ...subscribe, printerKey: 'unassigned' })).toBe(
      false,
    )
    expect(first.receive(subscribe)).toBe(true)
    first.receive(subscribe)
    first.receive({ ...subscribe, printerKey: 'printer-b' })
    second.receive(subscribe)
    expect(start.mock.calls).toHaveLength(3)
    const leave = { ...base, t: 'detail.unsubscribe' }
    first.receive(leave)
    first.receive(leave)
    expect(stop).toHaveBeenCalledTimes(1)
    first.receive(subscribe)
    first.close()
    expect(stop).toHaveBeenCalledTimes(3)
    expect(first.receive(subscribe)).toBe(false)
    second.close()
    expect(stop).toHaveBeenCalledTimes(4)
  })
})
