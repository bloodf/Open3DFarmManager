import { describe, expect, it } from 'vitest'
import { decodeBambuReport } from '../../packages/connector/src/bambu/report.ts'

describe('Bambu job telemetry', () => {
  it('maps a full report', () => {
    expect(
      decodeBambuReport({
        print: {
          subtask_name: 'part.3mf',
          gcode_file: 'part.gcode',
          layer_num: 3,
          total_layer_num: 20,
          mc_remaining_time: 12,
          mc_percent: 40,
        },
      }),
    ).toEqual({
      kind: 'observation',
      filename: 'part.3mf',
      currentLayer: 3,
      totalLayer: 20,
      estimatedRemainingSeconds: 720,
      progress: 0.4,
    })
  })
  it('keeps delta fields absent and falls back to gcode file', () => {
    expect(
      decodeBambuReport({ print: { gcode_file: 'part.gcode', layer_num: 0 } }),
    ).toEqual({ kind: 'observation', filename: 'part.gcode', currentLayer: 0 })
  })
  it('ignores malformed job fields', () => {
    expect(
      decodeBambuReport({
        print: {
          subtask_name: '',
          layer_num: -1,
          total_layer_num: 1.5,
          mc_remaining_time: 'bad',
        },
      }),
    ).toEqual({ kind: 'observation' })
  })
})
