import { describe, expect, it } from 'vitest'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'

describe('AMS telemetry', () => {
  it('decodes material and external spool', () => {
    expect(
      decodeBambuReport({
        print: {
          ams: {
            tray_now: '0',
            ams: [
              {
                id: '0',
                tray: [
                  {
                    id: '0',
                    tray_type: 'PLA',
                    tray_color: 'ff0000ff',
                    remain: 42,
                  },
                ],
              },
            ],
          },
          vt_tray: { remain: -1 },
        },
      }),
    ).toMatchObject({
      materials: [
        {
          slot: 'ams:0:0',
          materialType: 'PLA',
          colorHex: 'FF0000FF',
          remainingPercent: 42,
          active: true,
        },
        { slot: 'external', active: false },
      ],
    })
  })
  it('omits unknown remaining and malformed arrays', () => {
    expect(
      decodeBambuReport({
        print: { ams: { ams: [{ id: '0', tray: [{ id: '0', remain: -1 }] }] } },
      }),
    ).toEqual({ kind: 'observation', materials: [{ slot: 'ams:0:0' }] })
    expect(
      decodeBambuReport({
        print: { ams: { ams: [null, { id: '99', tray: [] }] } },
      }),
    ).toEqual({ kind: 'observation' })
  })
})
