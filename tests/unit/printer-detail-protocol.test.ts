// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/network-guard.ts'
import {
  assemblePrinterDetailFrames,
  createPrinterDetailSubscriptions,
  decodePrinterDetailFrame,
  encodePrinterDetailFrames,
  MAX_PRINTER_DETAIL_WIRE_BYTES,
} from '../../packages/farm-protocol/src/printer-detail.ts'

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

describe('printer detail protocol', () => {
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
        MAX_PRINTER_DETAIL_WIRE_BYTES,
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
