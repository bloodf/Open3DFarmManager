/**
 * Decodes status and response frames for control decisions.
 * Machine and print sub-status codes:
 * - cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215,
 *   "Machine Status Description" (resin: 1..4 motion/exposure, 6 paused,
 *   8 stopped, 9 complete, 10 file check).
 * - ELEGOO-3D/elegoo-link @ ec2d226, elegoo_fdm_cc_message_adapter.cpp
 *   (Centauri Carbon: 12 resuming, 13 printing, 14 error, 15..21 job phases).
 * - bjan/pycentauri @ 2f6d9ed, src/pycentauri/models.py (the `CurrenStatus`
 *   firmware spelling).
 *
 * Anything ambiguous or in transition is `unknown`, which permits no command
 * and confirms none.
 */
import type { SdcpFamily } from './models.ts'

export type SdcpPrintState =
  'idle' | 'printing' | 'paused' | 'cancelled' | 'error' | 'unknown'
export type SdcpReport = Readonly<{
  state: SdcpPrintState
  filename?: string
  currentLayer?: number
  totalLayer?: number
}>

const JOB_PHASES: Record<SdcpFamily, ReadonlySet<number>> = {
  resin: new Set([1, 2, 3, 4, 10]),
  fdm: new Set([1, 10, 13, 15, 16, 18, 19, 20, 21]),
}

const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined

function parse(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return
  }
}

export function decodeSdcpStatus(
  raw: string,
  mainboardId: string,
  family: SdcpFamily,
): SdcpReport | undefined {
  const message = parse(raw) as any
  if (message?.Topic !== `sdcp/status/${mainboardId}`) return
  const board = message.MainboardID ?? message.Data?.MainboardID
  const wire = message.Status ?? message.Data?.Status
  if (board !== mainboardId || !wire || typeof wire !== 'object') return
  let current = wire.CurrentStatus
  if (family === 'fdm') {
    current ??= wire.CurrenStatus
    if (typeof current === 'number') current = [current]
  }
  const info = wire.PrintInfo
  const phase = count(info?.Status)
  if (
    !Array.isArray(current) ||
    !current.length ||
    !current.every((value) => count(value) !== undefined) ||
    phase === undefined
  )
    return
  // Resin always reports ErrorNumber; the Carbon's status omits it.
  const error =
    info.ErrorNumber === undefined && family === 'fdm'
      ? 0
      : count(info.ErrorNumber)
  if (error === undefined) return
  const printing = current.includes(1)
  const idle = current.every((value) => value === 0)
  const state: SdcpPrintState =
    error > 0 || (family === 'fdm' && phase === 14)
      ? 'error'
      : printing
        ? phase === 6
          ? 'paused'
          : JOB_PHASES[family].has(phase)
            ? 'printing'
            : 'unknown'
        : idle
          ? phase === 8
            ? 'cancelled'
            : phase === 0 || phase === 9
              ? 'idle'
              : 'unknown'
          : 'unknown'
  const filename =
    typeof info.Filename === 'string' && info.Filename.length <= 512
      ? info.Filename.replace(/^\/local\//, '')
      : ''
  const layer = count(info.CurrentLayer),
    total = count(info.TotalLayer)
  return {
    state,
    ...(filename ? { filename } : {}),
    ...(layer !== undefined && total && layer <= total
      ? { currentLayer: layer, totalLayer: total }
      : {}),
  }
}

/** The response `Data.Data` of one request, matched by id and command. */
export function decodeSdcpResponse(
  raw: string,
  mainboardId: string,
  requestId: string,
  cmd: number,
): Record<string, unknown> | undefined {
  const message = parse(raw) as any
  if (
    message?.Topic !== `sdcp/response/${mainboardId}` ||
    message.Data?.RequestID !== requestId ||
    message.Data.MainboardID !== mainboardId ||
    message.Data.Cmd !== cmd
  )
    return
  const data = message.Data.Data
  return data && typeof data === 'object' && !Array.isArray(data)
    ? data
    : undefined
}

/** The command acknowledgement of one request; `0` is accepted. */
export function decodeSdcpAck(
  raw: string,
  mainboardId: string,
  requestId: string,
): number | undefined {
  const message = parse(raw) as any
  if (
    message?.Topic !== `sdcp/response/${mainboardId}` ||
    message.Data?.RequestID !== requestId
  )
    return
  return count(message.Data.Data?.Ack)
}
