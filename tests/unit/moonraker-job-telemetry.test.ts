import { describe, expect, it } from 'vitest'
import { parseMoonrakerSnapshot } from '../../packages/connector/src/moonraker/parse.ts'

function observe(stats: Record<string, unknown>, progress = 0.25) {
  return parseMoonrakerSnapshot(
    JSON.stringify({
      result: {
        eventtime: 1,
        status: {
          webhooks: { state: 'ready' },
          print_stats: { state: 'printing', ...stats },
          virtual_sdcard: { progress },
        },
      },
    }),
    { printerKey: 'p', observedAt: 1 },
  ).printer
}

describe('Moonraker job telemetry', () => {
  it('observes a printing job with layers', () => {
    expect(
      observe({
        filename: 'test\u0000.gcode',
        print_duration: 100,
        total_duration: 120,
        info: { current_layer: 2, total_layer: 10 },
      }),
    ).toMatchObject({
      filename: 'test.gcode',
      printDuration: 100,
      totalDuration: 120,
      currentLayer: 2,
      totalLayer: 10,
      estimatedRemainingSeconds: 300,
    })
  })
  it('accepts absent layers and idle progress', () => {
    expect(observe({ state: 'standby' }, 0)).not.toHaveProperty(
      'estimatedRemainingSeconds',
    )
    expect(observe({ filename: 'x' })).not.toHaveProperty('currentLayer')
  })
  it('omits malformed fields and bounds filenames', () => {
    const printer = observe({
      filename: 'a'.repeat(300),
      print_duration: -1,
      total_duration: 'bad',
      info: { current_layer: -1, total_layer: 1.5 },
    })
    expect(printer.filename).toHaveLength(255)
    expect(printer).not.toHaveProperty('printDuration')
    expect(printer).not.toHaveProperty('totalDuration')
    expect(printer).not.toHaveProperty('currentLayer')
    expect(printer).not.toHaveProperty('totalLayer')
  })
})
