import { PrinterDetailStreamUpdate } from '../../../farm-protocol/src/printer-detail.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'

export function anycubicPrinterDetail(
  printer: PrinterState,
  seq: number,
  options: { cameraId?: string | undefined; vendor?: 'kobra-x' } = {},
) {
  const online = printer.state !== 'offline'
  const heaters = [
    { name: 'extruder', temperature: printer.toolTemperatureCelsius },
    { name: 'heater_bed', temperature: printer.bedTemperatureCelsius },
  ].filter(({ temperature }) => temperature !== undefined)
  const fans = Object.entries(printer.fans ?? {}).flatMap(([name, percent]) =>
    percent === undefined ? [] : [{ name, speed: percent / 100 }],
  )
  const light = printer.light?.chamber
  const detail = {
    print: {
      state: printer.state,
      // The printer's own fault or pause reason (`anycubic/alerts.ts`).
      message: online ? (printer.statusMessage ?? '') : '',
      ...(online && {
        file:
          printer.filename && !/[\uD800-\uDFFF]/u.test(printer.filename)
            ? printer.filename
            : undefined,
        elapsedSeconds: printer.printDuration,
        progress: printer.progress,
        currentLayer: printer.currentLayer,
        totalLayers: printer.totalLayer,
      }),
    },
    ...(options.cameraId && {
      webcams: [
        {
          name: 'Câmera da impressora',
          uid: options.cameraId,
          enabled: true,
          rotation: 0,
          flipHorizontal: false,
          flipVertical: false,
        },
      ],
    }),
    ...(online && {
      ...(heaters.length && { heaters }),
      ...(fans.length && { fans }),
      ...(light !== undefined && {
        lights: [
          { name: 'chamber', red: 0, green: 0, blue: 0, white: Number(light) },
        ],
      }),
      ...(printer.materials && { materials: printer.materials }),
    }),
  }
  const parsed = PrinterDetailStreamUpdate.safeParse({
    v: 1,
    t: 'detail.update',
    printerKey: printer.printerKey,
    seq,
    vendor: options.vendor ?? 'anycubic',
    capabilities: [
      'job',
      ...(detail.heaters ? ['heaters'] : []),
      ...(detail.fans ? ['fans'] : []),
      ...(detail.lights ? ['lights'] : []),
      ...(detail.materials ? ['materials'] : []),
      ...(detail.webcams ? ['webcams'] : []),
    ],
    detail,
  })
  return parsed.success ? parsed.data : undefined
}
