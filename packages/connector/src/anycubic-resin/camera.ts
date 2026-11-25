/**
 * Camera source of one browser lease. `video/startCapture` and `stopCapture`
 * are printer writes: refused until qualified, and each is sent at most once.
 * The FLV stream on port 18088 goes to the existing H.264 WebRTC media path.
 */
import type { AnycubicCameraSource } from '../anycubic/camera.ts'
import { DriverRefusalError } from '../control/driver-refusal.ts'
import type { PhotonResinSession } from './session.ts'

export function createPhotonResinCameraSource(input: {
  host: string
  port: number
  qualified: boolean
  session: () => PhotonResinSession | undefined
  onRefused?: (reason: string) => void
}): AnycubicCameraSource {
  let started: PhotonResinSession | undefined
  let attempted = false
  function refuse(
    refusal: 'unsupported-action' | 'state',
    reason: string,
  ): never {
    input.onRefused?.(reason)
    throw new DriverRefusalError(refusal, reason)
  }
  return {
    kind: 'stock',
    host: input.host,
    port: input.port,
    async startCapture(signal) {
      if (!input.qualified)
        refuse(
          'unsupported-action',
          'Photon LAN camera is not qualified for this model and firmware',
        )
      const session = input.session()
      if (attempted || signal.aborted || !session)
        refuse(
          'state',
          attempted
            ? 'The camera start of this viewing is not sent again'
            : 'The Photon LAN session is not open',
        )
      attempted = true
      const result = await session.startCamera()
      // A refused start sent nothing, so there is nothing to stop.
      if (result.outcome !== 'refused') started = session
      if (result.outcome !== 'confirmed' || !result.state.camera)
        refuse(
          'state',
          result.outcome === 'confirmed'
            ? 'The printer reports no camera stream'
            : result.reason,
        )
      return result.state.camera.url
    },
    async stopCapture() {
      const session = started
      started = undefined
      // A closed session already ended the stream on the printer.
      if (session?.state().connected) await session.stopCamera()
    },
  }
}
