/**
 * SDCP request frames. Command numbers and payload keys:
 * - cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215: Cmd 0, 128
 *   {Filename, StartLayer}, 129 pause, 130 stop, 131 continue.
 * - ELEGOO-3D/elegoo-link @ ec2d226,
 *   src/lan/adapters/elegoo_fdm_cc/elegoo_fdm_cc_message_adapter.cpp: the
 *   Centauri Carbon start payload and command mapping table.
 *
 * - History (320 {}, 321 {Id}) and video stream (386 {Enable}):
 *   cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, built only
 *   for profiles that declare them (resin).
 *
 * No other command is ever built. bjan/pycentauri @ 2f6d9ed
 * docs/PROTOCOL.md reports that an unknown command or an unexpected payload
 * shape can kill the Carbon's firmware process, and the running print with it.
 */
import { randomBytes } from 'node:crypto'
import { DriverRefusalError } from '../control/driver-refusal.ts'
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
    throw new DriverRefusalError('invalid-command', 'Invalid SDCP file name', {
      userMessage:
        'Escolha um arquivo de impressão compatível com a impressora.',
    })
  return name
}

export function buildSdcpCommand(
  model: string,
  action: SdcpAction | 'status',
  args: Record<string, unknown> = {},
): { Cmd: number; Data: Record<string, unknown> } {
  const profile = sdcpProfile(model)
  if (!profile)
    throw new DriverRefusalError('unsupported-action', 'Unsupported SDCP model')
  const allowed = action === 'start_print' ? ['file'] : []
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new DriverRefusalError(
      'invalid-command',
      `Unexpected SDCP argument for ${action}`,
    )
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
      throw new DriverRefusalError(
        'unsupported-action',
        `Unsupported SDCP action '${String(action)}'`,
      )
  }
}

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/
export const isSdcpTaskId = (value: unknown): value is string =>
  typeof value === 'string' && TASK_ID.test(value)

function requireFeature(model: string, feature: 'history' | 'camera') {
  if (!sdcpProfile(model)?.[feature])
    throw new DriverRefusalError(
      'unsupported-action',
      `SDCP ${feature} is not documented for this model`,
    )
}

/** Read-only print history: the id list, or the details of those ids. */
export function buildSdcpHistoryCommand(
  model: string,
  ids?: readonly string[],
): { Cmd: 320 | 321; Data: Record<string, unknown> } {
  requireFeature(model, 'history')
  if (!ids) return { Cmd: 320, Data: {} }
  if (!ids.length || ids.length > 16 || !ids.every(isSdcpTaskId))
    throw new DriverRefusalError('invalid-command', 'Invalid SDCP task ids')
  return { Cmd: 321, Data: { Id: [...ids] } }
}

export function buildSdcpVideoCommand(
  model: string,
  enable: boolean,
): { Cmd: number; Data: Record<string, unknown> } {
  requireFeature(model, 'camera')
  return { Cmd: 386, Data: { Enable: enable ? 1 : 0 } }
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
