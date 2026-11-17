// SPDX-License-Identifier: MIT
import {
  selectCrealityCamera,
  streamCrealityJpegs,
} from '../creality/camera.ts'
import { openAnycubicCameraSource } from '../anycubic/camera-media.ts'
import {
  selectAnycubicCamera,
  type AnycubicCameraSource,
} from '../anycubic/camera.ts'
import { openBambuCameraSource } from '../bambu/camera-media.ts'
import type { BambuCameraSource } from '../bambu/camera.ts'
import type { HelperExecutable } from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import type { CameraRuntimeConfig } from '../config/camera.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { AssignmentRef } from '../webrtc/readonly-session.ts'
import { createMoonrakerSnapshotSource } from '../moonraker/snapshot.ts'
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
  creality?: {
    ffmpeg: HelperExecutable
    cameras: readonly {
      cameraId: string
      assignmentId: string
      source: { host: string; port?: number }
    }[]
  }
  anycubic?: {
    ffmpeg: HelperExecutable
    cameras: readonly {
      cameraId: string
      assignmentId: string
      source: AnycubicCameraSource
    }[]
  }
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
    config.cameras.flatMap((camera, index) =>
      'kind' in camera.source
        ? []
        : [['camera-' + index, Object.freeze({ ...camera.source })]],
    ),
  )
  const snapshots = new Map(
    config.cameras.flatMap((camera, index) => {
      if (!('kind' in camera.source)) return []
      const { address, port, path } = camera.source
      const host = address.includes(':') ? '[' + address + ']' : address
      return [
        [
          'camera-' + index,
          {
            ffmpeg: Object.freeze({ ...camera.source.ffmpeg }),
            reader: createMoonrakerSnapshotSource({
              webcamOrigin: `http://${host}:${port}`,
              snapshotUrl: path,
            }),
          },
        ],
      ] as const
    }),
  )
  const cameras = config.cameras.map((camera, index) => ({
    cameraId: camera.cameraId,
    scope: { farmId, agentId, printerId: camera.assignmentId },
    sourceHandle: 'camera-' + index,
  }))
  const anycubic = new Map(
    (input.anycubic?.cameras ?? []).map((camera, index) => {
      selectAnycubicCamera(camera.source)
      const handle = 'anycubic-camera-' + index
      cameras.push({
        cameraId: camera.cameraId,
        scope: { farmId, agentId, printerId: camera.assignmentId },
        sourceHandle: handle,
      })
      const source =
        camera.source.kind === 'rinkhals'
          ? {
              ...camera.source,
              ...(camera.source.auth
                ? { auth: Object.freeze({ ...camera.source.auth }) }
                : {}),
            }
          : { ...camera.source }
      return [handle, Object.freeze(source)] as const
    }),
  )
  const anycubicFfmpeg = input.anycubic
    ? Object.freeze({ ...input.anycubic.ffmpeg })
    : undefined
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
  const creality = new Map(
    (input.creality?.cameras ?? []).map((camera, index) => {
      selectCrealityCamera(camera.source)
      const handle = 'creality-camera-' + index
      cameras.push({
        cameraId: camera.cameraId,
        scope: { farmId, agentId, printerId: camera.assignmentId },
        sourceHandle: handle,
      })
      return [handle, Object.freeze({ ...camera.source })] as const
    }),
  )
  const crealityFfmpeg = input.creality
    ? Object.freeze({ ...input.creality.ffmpeg })
    : undefined
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
        const snapshot = snapshots.get(handle)
        if (snapshot) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Moonraker camera admission expired')
          return openBambuCameraSource({
            source: { model: 'A1', host: '127.0.0.1', accessCode: 'unused' },
            ffmpeg: snapshot.ffmpeg,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
            jpegStream: ({ signal: jpegSignal }) =>
              snapshot.reader.stream(jpegSignal),
          })
        }
        const anycubicSource = anycubic.get(handle)
        if (anycubicSource && anycubicFfmpeg) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Anycubic camera admission expired')
          return openAnycubicCameraSource({
            source: anycubicSource,
            ffmpeg: anycubicFfmpeg,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
          })
        }
        const crealitySource = creality.get(handle)
        if (crealitySource && crealityFfmpeg) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Creality camera admission expired')
          return openBambuCameraSource({
            source: {
              model: 'A1',
              host: crealitySource.host,
              accessCode: 'unused',
            },
            ffmpeg: crealityFfmpeg,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
            jpegStream: ({ signal: jpegSignal }) =>
              streamCrealityJpegs({ ...crealitySource, signal: jpegSignal }),
          })
        }
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
