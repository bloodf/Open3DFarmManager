// SPDX-License-Identifier: MIT
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
      openSource: (handle, signal, expiresAtMonoMs) =>
        openHelperSource({
          executable: helper,
          sourceHandle: handle,
          resolveLocal: (value) => sources.get(value),
          signal,
          expiresAtMonoMs,
          generation: 1,
          isAdmitted: () => !signal.aborted,
        }),
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
