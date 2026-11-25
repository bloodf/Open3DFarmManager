/**
 * Camera media of a resin board. This path writes nothing to the printer: it
 * relays the RTSP stream whose address the signed video command obtained
 * (see ./video.ts). alfiedennen/sdcp-saturn-4-ultra @ d253519 README.md: the
 * stream is single client in practice, so one viewer per printer is served.
 */
import {
  getRtspHelperStatusSync,
  openHelperSource,
  type HelperExecutable,
} from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import type { SdcpVideo } from './video.ts'

export function createSdcpCameraOpener(options: {
  video: Pick<SdcpVideo, 'destination'>
  openSource?: typeof openHelperSource
  helperAvailable?: (executable: HelperExecutable) => boolean
}) {
  const busy = new Set<string>()
  const openSource = options.openSource ?? openHelperSource
  const helperAvailable =
    options.helperAvailable ??
    ((executable) => getRtspHelperStatusSync(executable).available)
  return async function open(input: {
    source: { mainboardId: string; address: string }
    executable: HelperExecutable
    signal: AbortSignal
    expiresAtMonoMs: number
    isCurrent: () => boolean
  }) {
    const board = input.source.mainboardId
    const admitted = () =>
      !input.signal.aborted &&
      input.isCurrent() &&
      input.expiresAtMonoMs > performance.now()
    if (!helperAvailable(input.executable))
      throw Object.assign(new Error('RTSP helper unavailable'), {
        code: 'HELPER_EXECUTABLE',
      })
    if (!admitted())
      throw new DriverRefusalError('state', 'SDCP camera admission expired')
    const destination = options.video.destination(board)
    if (!destination || destination.address !== input.source.address)
      throw new DriverRefusalError('state', 'SDCP camera stream is off')
    if (busy.has(board))
      throw new DriverRefusalError('state', 'SDCP camera is already streaming')
    busy.add(board)
    try {
      const stream = await openSource({
        executable: input.executable,
        sourceHandle: board,
        resolveLocal: (handle) => (handle === board ? destination : undefined),
        signal: input.signal,
        expiresAtMonoMs: input.expiresAtMonoMs,
        generation: 1,
        isAdmitted: admitted,
      })
      // The helper ends on stop, abort, lease expiry and stream failure.
      void stream.closed.catch(() => {}).then(() => busy.delete(board))
      return stream
    } catch (error) {
      busy.delete(board)
      throw error
    }
  }
}
