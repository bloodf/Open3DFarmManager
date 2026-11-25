/**
 * SDCP request frames. Command numbers and payload keys:
 * - cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215: Cmd 0, 128
 *   {Filename, StartLayer}, 129 pause, 130 stop, 131 continue.
 * - ELEGOO-3D/elegoo-link @ ec2d226,
 *   src/lan/adapters/elegoo_fdm_cc/elegoo_fdm_cc_message_adapter.cpp: the
 *   Centauri Carbon start payload and command mapping table.
 *
 * Only these five commands are ever built. bjan/pycentauri @ 2f6d9ed
 * docs/PROTOCOL.md reports that an unknown command or an unexpected payload
 * shape can kill the Carbon's firmware process, and the running print with it.
 */
import { randomBytes } from 'node:crypto'
import { sdcpProfile, type SdcpAction, type SdcpProfile } from './models.ts'
import type { SdcpTarget } from './identity.ts'

/** A plain printable file name of the model's own file type; no path. */
export function sdcpFileName(model: string, name: unknown): string {
  const profile = sdcpProfile(model)
  if (
    !profile ||
    typeof name !== 'string' ||
    Buffer.byteLength(name) > 255 ||
    /[\\/"\x00-\x1f\x7f]/.test(name) ||
    name.includes('..') ||
    name.startsWith('.') ||
    !profile.extensions.some((end) => name.toLowerCase().endsWith(end))
  )
    throw new Error('Invalid SDCP file name')
  return name
}

export function buildSdcpCommand(
  model: string,
  action: SdcpAction | 'status',
  args: Record<string, unknown> = {},
): { Cmd: number; Data: Record<string, unknown> } {
  const profile = sdcpProfile(model)
  if (!profile) throw new Error('Unsupported SDCP model')
  const allowed = action === 'start_print' ? ['file'] : []
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected SDCP argument for ${action}`)
  switch (action) {
    case 'status':
      return { Cmd: 0, Data: {} }
    case 'pause':
      return { Cmd: 129, Data: {} }
    case 'cancel':
      return { Cmd: 130, Data: {} }
    case 'resume':
      return { Cmd: 131, Data: {} }
    case 'start_print': {
      const start = {
        Filename: sdcpFileName(model, args.file),
        StartLayer: 0,
      }
      return {
        Cmd: 128,
        Data:
          profile.family === 'fdm'
            ? {
                ...start,
                // Bed levelling on, side A, no time-lapse, no Canvas mapping.
                Calibration_switch: 1,
                PrintPlatformType: 0,
                Tlp_Switch: 0,
                slot_map: [],
              }
            : start,
      }
    }
    default:
      throw new Error(`Unsupported SDCP action '${String(action)}'`)
  }
}

export function sdcpRequest(
  target: SdcpTarget,
  profile: SdcpProfile,
  command: { Cmd: number; Data: Record<string, unknown> },
) {
  const requestId = randomBytes(16).toString('hex')
  return {
    requestId,
    frame: {
      Id: target.brandId,
      Data: {
        Cmd: command.Cmd,
        Data: command.Data,
        RequestID: requestId,
        MainboardID: target.mainboardId,
        TimeStamp: profile.timestampMs
          ? Date.now()
          : Math.floor(Date.now() / 1000),
        From: profile.from,
      },
      Topic: `sdcp/request/${target.mainboardId}`,
    },
  }
}
