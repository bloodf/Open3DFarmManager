// SPDX-License-Identifier: MIT
import { openBambuCameraSource } from '../bambu/camera-media.ts'
import type { BambuCameraSource } from '../bambu/camera.ts'
import type { HelperExecutable } from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import type { CameraRuntimeConfig } from '../config/camera.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { AssignmentRef } from '../webrtc/readonly-session.ts'
import { ConnectorCameraMedia } from './camera-media.ts'

/** Builds one ConnectorCameraMedia per RTC peer from the opt-in camera config.
 * Source locations stay behind opaque handles in this closure. */
export async function createCameraMediaFactory(input: {
  config: CameraRuntimeConfig
  identity: ConnectorIdentity
  agentId: string
  farmId: string
  assignmentRefs: readonly AssignmentRef[]
  /** Trusted local configuration; never supplied by a browser. */
  bambu?: {
    ffmpeg: HelperExecutable
    cameras: readonly {
      cameraId: string
      assignmentId: string
      source: BambuCameraSource
    }[]
  }
}) {
  const { Video, RtpPacketizationConfig, H264RtpPacketizer } =
    await import('node-datachannel')
  const { openHelperSource } =
    await import('../../../../tools/rtsp-ingest/supervisor/process.ts')
  const { config, identity, agentId, farmId } = input
  const helper = Object.freeze({ ...config.helper })
  const sources = new Map(
    config.cameras.map((camera, index) => [
      'camera-' + index,
      Object.freeze({ ...camera.source }),
    ]),
  )
  const cameras = config.cameras.map((camera, index) => ({
    cameraId: camera.cameraId,
    scope: { farmId, agentId, printerId: camera.assignmentId },
    sourceHandle: 'camera-' + index,
  }))
  const bambu = new Map(
    (input.bambu?.cameras ?? []).map((camera, index) => {
      const handle = 'bambu-camera-' + index
      cameras.push({
        cameraId: camera.cameraId,
        scope: { farmId, agentId, printerId: camera.assignmentId },
        sourceHandle: handle,
      })
      return [handle, Object.freeze({ ...camera.source })] as const
    }),
  )
  const ffmpeg = input.bambu
    ? Object.freeze({ ...input.bambu.ffmpeg })
    : undefined
  let active = 0
  return (onViolation: (reason: string) => void) =>
    new ConnectorCameraMedia({
      native: { Video, RtpPacketizationConfig, H264RtpPacketizer },
      expectedAgentId: agentId,
      assignmentRefs: input.assignmentRefs,
      cameras,
      signProof: (statement) =>
        identity.signCameraPurposeProof({
          statement,
          expectedAgentId: agentId,
        }),
      openSource: (handle, signal, expiresAtMonoMs, isCurrent) => {
        const source = bambu.get(handle)
        if (source && ffmpeg) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Bambu camera admission expired')
          return openBambuCameraSource({
            source,
            ffmpeg,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
          })
        }
        return openHelperSource({
          executable: helper,
          sourceHandle: handle,
          resolveLocal: (value) => sources.get(value),
          signal,
          expiresAtMonoMs,
          generation: 1,
          isAdmitted: () => !signal.aborted && isCurrent(),
        })
      },
      acquireSlot() {
        if (active >= config.maxSessions) return undefined
        active++
        let released = false
        return () => {
          if (released) return
          released = true
          active--
        }
      },
      onViolation,
    })
}
