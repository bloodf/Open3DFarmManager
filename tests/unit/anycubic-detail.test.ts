import { expect, test } from 'vitest'
import { anycubicPrinterDetail } from '../../packages/connector/src/anycubic/printer-detail.ts'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'
import {
  createPrinterDetailSession,
  createVendorDetailSources,
} from '../../packages/connector/src/runtime/printer-detail-session.ts'
import { decodePrinterDetailFrame } from '../../packages/farm-protocol/src/printer-detail.ts'
import { withNetworkGuard } from '../../packages/sim-tools/src/mocks/index.ts'

test('Anycubic detail uses reported values and withdraws them on disconnect', async () => {
  await withNetworkGuard(async () => {
    const vendor = createVendorDetailSources()
    const source = vendor.register('kobra', anycubicPrinterDetail)
    const frames: unknown[] = []
    const session = createPrinterDetailSession(
      (key) => (key === 'kobra' || key === 'other' ? source : undefined),
      (key) => key === 'kobra',
      (wires) => frames.push(...wires.map(decodePrinterDetailFrame)),
    )
    try {
      const subscribe = (printerKey: string) =>
        session.receive(
          JSON.stringify({ v: 1, t: 'detail.subscribe', printerKey }),
        )
      subscribe('other')
      const { kind, ...report } = decodeAnycubicReport(
        Buffer.from(
          JSON.stringify({
            data: {
              curr_nozzle_temp: 201,
              fan_speed_pct: 37,
              lights: [{ type: 2, status: 0 }],
            },
          }),
        ),
      )
      expect(kind).not.toBe('invalid')
      vendor.observe({
        printerKey: 'kobra',
        state: 'printing',
        progress: 0.25,
        observedAt: 1,
        ...report,
      })
      expect(frames).toEqual([])
      subscribe('kobra')
      expect(frames).toEqual([
        {
          v: 1,
          t: 'detail.update',
          printerKey: 'kobra',
          seq: 1,
          vendor: 'anycubic',
          capabilities: ['job', 'heaters', 'fans', 'lights'],
          detail: {
            print: { state: 'printing', message: '', progress: 0.25 },
            heaters: [{ name: 'extruder', temperature: 201 }],
            fans: [{ name: 'part', speed: 0.37 }],
            lights: [{ name: 'chamber', red: 0, green: 0, blue: 0, white: 0 }],
          },
        },
      ])
      vendor.invalidate('kobra')
      expect(frames.at(-1)).toMatchObject({
        seq: 2,
        capabilities: ['job'],
        detail: { print: { state: 'offline' } },
      })
    } finally {
      session.close()
    }
  })
})
