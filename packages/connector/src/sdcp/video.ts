/**
 * State of each configured resin camera stream, shared by the signed control
 * driver (the only sender of Cmd 386), the camera media path and the detail
 * page. cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0 @ f977215, Cmd 386:
 * the reply carries "the RTSP protocol address". The printer reports no stream
 * state, so `on` means only "this Connector asked, or the printer said a stream
 * is open"; after a restart nothing is known and the stream is shown as off.
 */
import type { LocalDestination } from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import {
  sdcpVideoOffered,
  sdcpVideoQualified,
  type SdcpQualification,
} from './models.ts'

/** The name of the stream in the signed `power` command's `device`. */
export const SDCP_CAMERA_DEVICE = 'Câmera'

/** Only an RTSP stream on the configured printer address is accepted. */
export function sdcpVideoDestination(
  value: unknown,
  address: string,
): LocalDestination {
  if (typeof value === 'string' && value.length <= 1024) {
    const url = URL.canParse(value) ? new URL(value) : undefined
    if (
      url?.protocol === 'rtsp:' &&
      url.hostname === address &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.port !== '0' &&
      url.pathname.startsWith('/')
    )
      return Object.freeze({
        address,
        port: url.port ? Number(url.port) : 554,
        path: url.pathname,
      })
  }
  throw new Error('SDCP video address rejected')
}

type Camera = Readonly<{ mainboardId: string; model: string }>

export function createSdcpVideo(
  options: {
    /** Boards with a camera entry in the local runtime file. */
    boards?: readonly string[] | undefined
    /** Local composition only; the shipped list is empty. */
    qualified?: readonly SdcpQualification[] | undefined
  } = {},
) {
  const boards = new Set(options.boards)
  const streams = new Map<string, { destination?: LocalDestination }>()
  const offered = (camera: Camera) =>
    boards.has(camera.mainboardId) &&
    sdcpVideoOffered(camera.model, options.qualified)
  return {
    offered,
    qualified: (camera: Camera, firmwareVersion: string) =>
      offered(camera) &&
      sdcpVideoQualified(camera.model, firmwareVersion, options.qualified),
    status: (board: string): 'on' | 'off' =>
      streams.has(board) ? 'on' : 'off',
    destination: (board: string) => streams.get(board)?.destination,
    /** A stream is or may be open; any known address is kept. */
    mayBeOn(board: string) {
      if (!streams.has(board)) streams.set(board, {})
    },
    on(board: string, destination: LocalDestination) {
      streams.set(board, { destination })
    },
    off(board: string) {
      streams.delete(board)
    },
  }
}
export type SdcpVideo = ReturnType<typeof createSdcpVideo>
