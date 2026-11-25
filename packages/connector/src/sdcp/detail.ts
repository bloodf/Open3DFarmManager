/**
 * Printer detail page feed of a resin board: job, history and, for a qualified
 * camera, its stream switch (the signed `power` command) and viewer.
 */
import { PrinterDetailStreamUpdate } from '../../../farm-protocol/src/printer-detail.ts'
import type { PrinterState } from '../../../farm-protocol/src/state.ts'
import { readSdcpHistory, type SdcpHistoryJob } from './history.ts'
import type { SdcpEndpoint } from './session.ts'
import { SDCP_CAMERA_DEVICE } from './video.ts'

export function sdcpPrinterDetail(
  printer: PrinterState,
  seq: number,
  options: {
    cameraId?: string | undefined
    stream?: 'on' | 'off' | undefined
  } = {},
) {
  const parsed = PrinterDetailStreamUpdate.safeParse({
    v: 1,
    t: 'detail.update',
    printerKey: printer.printerKey,
    seq,
    capabilities: ['job', ...(options.cameraId ? ['webcams', 'power'] : [])],
    detail: {
      print: {
        state: printer.state,
        message: '',
        ...(printer.state !== 'offline' && printer.progress !== undefined
          ? { progress: printer.progress }
          : {}),
      },
      ...(options.cameraId && {
        powerDevices: [
          {
            name: SDCP_CAMERA_DEVICE,
            status: options.stream ?? 'off',
            locked: false,
          },
        ],
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
    },
  })
  return parsed.success ? parsed.data : undefined
}

/** SDCP documents no totals or file query here; only history is answered. */
export async function answerSdcpDetailQuery(
  endpoint: SdcpEndpoint,
  kind: string,
  signal: AbortSignal,
): Promise<
  { data: SdcpHistoryJob[] } | { error: 'unsupported' | 'unavailable' }
> {
  if (kind !== 'history') return { error: 'unsupported' }
  try {
    return { data: await readSdcpHistory(endpoint, signal) }
  } catch {
    return { error: 'unavailable' }
  }
}
