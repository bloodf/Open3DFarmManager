import { describe, expect, it } from 'vitest'
import { decodeAnycubicReport } from '../../packages/connector/src/anycubic/report.ts'

const decode = (data: unknown) =>
  decodeAnycubicReport(Buffer.from(JSON.stringify({ data })))

describe('Anycubic environmental reports', () => {
  it('decodes fan percentages, chamber light and ACE slots', () => {
    expect(
      decode({
        fan_speed_pct: 0,
        aux_fan_speed_pct: 40,
        box_fan_level: 100,
        lights: [
          { type: 3, status: 1 },
          { type: 2, status: 0 },
        ],
        multi_color_box: [
          {
            id: 0,
            slots: [
              {
                index: 1,
                type: 'PLA',
                color: [1, 128, 255],
                status: 5,
                consumables_percent: 45,
              },
            ],
          },
        ],
      }),
    ).toEqual({
      kind: 'observation',
      fans: { part: 0, aux: 40, chamber: 100 },
      light: { chamber: false },
      materials: [
        {
          slot: '0:1',
          materialType: 'PLA',
          colorHex: '0180FFFF',
          active: true,
          remainingPercent: 45,
        },
      ],
    })
  })
  it('keeps absent or invalid values absent', () => {
    expect(
      decode({
        fan_speed_pct: 101,
        aux_fan_speed_pct: -1,
        lights: [{ type: 2 }],
      }),
    ).toEqual({ kind: 'ignored' })
    expect(decode({ multi_color_box: [] })).toEqual({
      kind: 'observation',
      materials: [],
    })
    expect(decode({ type: 2, status: 1 })).toEqual({
      kind: 'observation',
      light: { chamber: true },
    })
  })
})
