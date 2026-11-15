import { describe, expect, it } from 'vitest'
import {
  decodeCrealityStatus,
  createCrealityTelemetryClient,
} from '../../packages/connector/src/creality/index.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'

const full = {
  modelFanPct: 40,
  auxiliaryFanPct: 70,
  caseFanPct: 0,
  lightSw: 1,
  boxsInfo: {
    materialBoxs: [
      {
        id: 1,
        materials: [
          { id: 2, type: 'PETG', color: '#0fa7c0c', percent: 63, selected: 1 },
        ],
      },
    ],
  },
}
const expected = {
  fans: { part: 40, aux: 70, chamber: 0 },
  light: { chamber: true },
  materials: [
    {
      slot: '1:2',
      materialType: 'PETG',
      colorHex: 'FA7C0CFF',
      remainingPercent: 63,
      active: true,
    },
  ],
}
describe('Creality environmental telemetry', () => {
  it('decodes stock status and CFS fields', () => {
    expect(decodeCrealityStatus(JSON.stringify(full))).toEqual(expected)
    expect(
      decodeCrealityStatus(JSON.stringify({ boxsInfo: full.boxsInfo })),
    ).toEqual({
      materials: expected.materials,
    })
    expect(
      decodeCrealityStatus(
        JSON.stringify({
          modelFanPct: 0,
          lightSw: 0,
          boxsInfo: { materialBoxs: [] },
        }),
      ),
    ).toEqual({ fans: { part: 0 }, light: { chamber: false }, materials: [] })
    expect(decodeCrealityStatus('{}')).toEqual({})
  })
  it('ignores malformed fields and rejects ambiguous CFS inventories', () => {
    expect(
      decodeCrealityStatus(
        JSON.stringify({
          modelFanPct: -1,
          auxiliaryFanPct: 1.5,
          caseFanPct: 101,
          lightSw: 2,
          boxsInfo: {
            materialBoxs: [{ id: 1, materials: [{ id: 0 }, { id: 0 }] }],
          },
        }),
      ),
    ).toEqual({})
    expect(
      decodeCrealityStatus(
        JSON.stringify({
          boxsInfo: {
            materialBoxs: [
              {
                id: 1,
                materials: [
                  {
                    id: 0,
                    type: 'x'.repeat(65),
                    color: '#bad',
                    percent: -1,
                    selected: 3,
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toEqual({ materials: [{ slot: '1:0' }] })
  })
  it('receives simulator updates over the telemetry client', async () => {
    const simulator = await createCrealitySimulator({ state: 0 })
    let resolveReport: (value: unknown) => void = () => {}
    const received = new Promise((resolve) => {
      resolveReport = resolve
    })
    const client = createCrealityTelemetryClient({
      host: '127.0.0.1',
      port: simulator.port,
      onTelemetry(report) {
        if (report.state === 'idle') simulator.emitFrame(full)
        else resolveReport(report)
      },
    })
    try {
      expect(await received).toEqual(expected)
    } finally {
      await client.close()
      await simulator.close()
    }
  })
})
