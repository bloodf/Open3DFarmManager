// SPDX-License-Identifier: MIT
import {
  selectCrealityCamera,
  streamCrealityJpegs,
} from '../creality/camera.ts'
import { openCrealityWebRtcSource } from '../creality/camera-webrtc.ts'
import { openAnycubicCameraSource } from '../anycubic/camera-media.ts'
import {
  selectAnycubicCamera,
  type AnycubicCameraSource,
} from '../anycubic/camera.ts'
import { openBambuCameraSource } from '../bambu/camera-media.ts'
import { selectBambuCamera, type BambuCameraSource } from '../bambu/camera.ts'
import { readBambuCredentials } from '../bambu/credentials.ts'
import {
  getRtspHelperStatusSync,
  type HelperExecutable,
  type RtspHelperStatus,
} from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import type { CameraRuntimeConfig } from '../config/camera.ts'
import type { ConnectorIdentity } from '../identity/store.ts'
import type { AssignmentRef } from '../webrtc/readonly-session.ts'
import { createMoonrakerSnapshotSource } from '../moonraker/snapshot.ts'
import { createSdcpCameraOpener } from '../sdcp/camera.ts'
import { createSdcpVideo, type SdcpVideo } from '../sdcp/video.ts'
import { ConnectorCameraMedia } from './camera-media.ts'

type ConfiguredBambuCamera = Extract<
  CameraRuntimeConfig['cameras'][number]['source'],
  { kind: 'bambu-lan' }
>

function readConfiguredBambuCamera(
  camera: ConfiguredBambuCamera,
  helper: HelperExecutable,
) {
  const { address: host, model, port, caFile, pinSha256, ffmpeg } = camera
  if (
    (!caFile && !pinSha256) ||
    ffmpeg.path === helper.path ||
    ffmpeg.sha256 === helper.sha256
  )
    return undefined
  try {
    const { password: accessCode } = readBambuCredentials(camera)
    const source: BambuCameraSource = {
      model,
      host,
      accessCode,
      ...(port === undefined ? {} : { port }),
      ...(caFile ? { caFile } : {}),
      ...(pinSha256 ? { pinSha256 } : {}),
    }
    const selected = selectBambuCamera(source)
    if (selected.kind === 'jpeg' || caFile) return { source, ffmpeg }
  } catch {
    return undefined
  }
}

export type RtspCameraEntryStatus = Readonly<
  | {
      cameraId: string
      assignmentId: string
      kind: 'rtsp'
      available: boolean
      status: 'available' | 'unavailable'
      reason?: 'helper-unavailable' | undefined
      message: string
    }
  | {
      cameraId: string
      assignmentId: string
      kind: 'moonraker-snapshot'
      available: true
      status: 'available'
      reason?: undefined
      message: string
    }
  | {
      cameraId: string
      assignmentId: string
      kind: 'bambu-lan'
      available: boolean
      status: 'available' | 'unavailable'
      message: string
    }
>

export type RtspCameraRuntimeStatus = Readonly<{
  helper: RtspHelperStatus
  available: boolean
  status: 'available' | 'unavailable'
  reason?: 'helper-unavailable' | undefined
  message: string
  cameras: readonly RtspCameraEntryStatus[]
}>

export function getRtspCameraStatus(
  config: CameraRuntimeConfig,
  /** Absent means the shipped (empty) video qualification. */
  sdcpVideo: SdcpVideo = createSdcpVideo(),
): RtspCameraRuntimeStatus {
  const helper = getRtspHelperStatusSync(config.helper)
  const cameras: RtspCameraEntryStatus[] = config.cameras.map((camera) => {
    if (
      'kind' in camera.source &&
      camera.source.kind === 'moonraker-snapshot'
    ) {
      return Object.freeze({
        cameraId: camera.cameraId,
        assignmentId: camera.assignmentId,
        kind: 'moonraker-snapshot' as const,
        available: true as const,
        status: 'available' as const,
        message: 'Moonraker snapshot camera is available',
      })
    }
    if ('kind' in camera.source && camera.source.kind === 'bambu-lan') {
      const configured = readConfiguredBambuCamera(camera.source, config.helper)
      const available =
        configured !== undefined &&
        getRtspHelperStatusSync(configured.ffmpeg).available
      return Object.freeze({
        cameraId: camera.cameraId,
        assignmentId: camera.assignmentId,
        kind: 'bambu-lan' as const,
        available,
        status: available ? ('available' as const) : ('unavailable' as const),
        message: available
          ? 'Bambu camera available'
          : 'Bambu camera unavailable',
      })
    }
    if (
      'kind' in camera.source &&
      camera.source.kind === 'sdcp-rtsp' &&
      !sdcpVideo.offered(camera.source)
    )
      return Object.freeze({
        cameraId: camera.cameraId,
        assignmentId: camera.assignmentId,
        kind: 'rtsp' as const,
        available: false,
        status: 'unavailable' as const,
        message: 'SDCP video stream is not qualified for this model',
      })
    return Object.freeze({
      cameraId: camera.cameraId,
      assignmentId: camera.assignmentId,
      kind: 'rtsp' as const,
      available: helper.available,
      status: helper.status,
      ...(helper.reason ? { reason: helper.reason } : {}),
      message: helper.message,
    })
  })
  return Object.freeze({
    helper,
    available: helper.available,
    status: helper.status,
    ...(helper.reason ? { reason: helper.reason } : {}),
    message: helper.message,
    cameras: Object.freeze(cameras),
  })
}

export async function checkRtspCameraStatus(
  config: CameraRuntimeConfig,
): Promise<RtspCameraRuntimeStatus> {
  return getRtspCameraStatus(config)
}

/** Builds one ConnectorCameraMedia per RTC peer from the opt-in camera config.
 * Source locations stay behind opaque handles in this closure. */
export async function createCameraMediaFactory(input: {
  config: CameraRuntimeConfig
  identity: ConnectorIdentity
  agentId: string
  farmId: string
  assignmentRefs: readonly AssignmentRef[]
  /** SDCP stream state; the signed control path fills it. */
  sdcpVideo?: SdcpVideo
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
  /** One printer-controlled source per viewing of a Photon resin camera. */
  photonResin?: (assignmentId: string) => AnycubicCameraSource
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
  // Vendor MJPEG cameras from the runtime file reuse the same local encoder.
  const configured = config.cameras.flatMap((camera, index) =>
    'kind' in camera.source &&
    (camera.source.kind === 'creality-mjpeg' ||
      camera.source.kind === 'flashforge-mjpeg')
      ? [
          {
            handle: 'camera-' + index,
            host: camera.source.address,
            port: camera.source.port,
          },
        ]
      : [],
  )
  const configuredCreality = new Map(
    configured.map(({ handle, host, port }) => {
      selectCrealityCamera({ host, port })
      return [handle, Object.freeze({ host, port })] as const
    }),
  )
  const crealityWebRtc = new Map(
    config.cameras.flatMap((camera, index) => {
      const source = camera.source
      if (!('kind' in source) || source.kind !== 'creality-webrtc') return []
      const { address: host, port } = source
      selectCrealityCamera({ host, port })
      return [['camera-' + index, Object.freeze({ host, port })] as const]
    }),
  )
  const configuredAnycubic = new Map(
    config.cameras.flatMap((camera, index) => {
      const entry = camera.source
      if (!('kind' in entry)) return []
      let source: AnycubicCameraSource
      if (entry.kind === 'anycubic-rinkhals') {
        source = { kind: 'rinkhals', host: entry.address, port: entry.port }
      } else if (entry.kind === 'kobra-x-flv') {
        source = {
          kind: entry.kind,
          host: entry.address,
          port: entry.port,
          path: entry.path,
        }
      } else {
        return []
      }
      selectAnycubicCamera(source)
      return [['camera-' + index, Object.freeze(source)] as const]
    }),
  )
  const photonResin = new Map(
    config.cameras.flatMap((camera, index) => {
      const open = input.photonResin
      if (
        !open ||
        !('kind' in camera.source) ||
        camera.source.kind !== 'anycubic-photon-resin'
      )
        return []
      const { assignmentId } = camera
      return [['camera-' + index, () => open(assignmentId)] as const]
    }),
  )
  const sdcpSources = new Map(
    config.cameras.flatMap((camera, index) => {
      const source = camera.source
      if (!('kind' in source) || source.kind !== 'sdcp-rtsp') return []
      return [['camera-' + index, Object.freeze({ ...source })] as const]
    }),
  )
  // Shared by every peer: one viewer per printer at a time.
  const sdcpVideo = input.sdcpVideo ?? createSdcpVideo()
  const openSdcpCamera = createSdcpCameraOpener({ video: sdcpVideo })
  const snapshots = new Map(
    config.cameras.flatMap((camera, index) => {
      if (
        !('kind' in camera.source) ||
        camera.source.kind !== 'moonraker-snapshot'
      )
        return []
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
  const cameras = config.cameras.flatMap((camera, index) =>
    'kind' in camera.source &&
    (camera.source.kind === 'bambu-lan' ||
      // An unqualified SDCP camera is not offered at all.
      (camera.source.kind === 'sdcp-rtsp' && !sdcpVideo.offered(camera.source)))
      ? []
      : [
          {
            cameraId: camera.cameraId,
            scope: { farmId, agentId, printerId: camera.assignmentId },
            sourceHandle: 'camera-' + index,
          },
        ],
  )
  const configuredBambu = config.cameras.flatMap((camera) => {
    if (!('kind' in camera.source) || camera.source.kind !== 'bambu-lan')
      return []
    const configured = readConfiguredBambuCamera(camera.source, helper)
    return configured ? [{ ...camera, ...configured }] : []
  })
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
  const suppliedBambu = input.bambu
  const bambu = new Map(
    [
      ...configuredBambu,
      ...(suppliedBambu?.cameras.map((camera) => ({
        ...camera,
        ffmpeg: suppliedBambu.ffmpeg,
      })) ?? []),
    ].flatMap((camera, index) => {
      if (
        (selectBambuCamera(camera.source).kind === 'rtsps' &&
          !camera.source.caFile) ||
        (!camera.source.caFile && !camera.source.pinSha256) ||
        camera.ffmpeg.path === helper.path ||
        camera.ffmpeg.sha256 === helper.sha256
      )
        return []
      const handle = 'bambu-camera-' + index
      cameras.push({
        cameraId: camera.cameraId,
        scope: { farmId, agentId, printerId: camera.assignmentId },
        sourceHandle: handle,
      })
      return [
        [
          handle,
          {
            source: Object.freeze({ ...camera.source }),
            ffmpeg: Object.freeze({ ...camera.ffmpeg }),
          },
        ],
      ] as const
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
  let active = 0
  const factory = (onViolation: (reason: string) => void) =>
    new ConnectorCameraMedia({
      native: { Video, RtpPacketizationConfig, H264RtpPacketizer },
      expectedAgentId: agentId,
      assignmentRefs: input.assignmentRefs,
      // An SDCP stream that is off is not offered to this peer.
      cameras: cameras.filter(({ sourceHandle }) => {
        const sdcp = sdcpSources.get(sourceHandle)
        return !sdcp || !!sdcpVideo.destination(sdcp.mainboardId)
      }),
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
        const anycubicSource =
          photonResin.get(handle)?.() ??
          anycubic.get(handle) ??
          configuredAnycubic.get(handle)
        if (anycubicSource && (anycubicFfmpeg ?? helper)) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Anycubic camera admission expired')
          return openAnycubicCameraSource({
            source: anycubicSource,
            ffmpeg: anycubicFfmpeg ?? helper,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
          })
        }
        const webRtc = crealityWebRtc.get(handle)
        if (webRtc) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Creality camera admission expired')
          // The printer already sends H.264: no encoder process.
          return openCrealityWebRtcSource({
            ...webRtc,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
          })
        }
        const crealitySource =
          creality.get(handle) ?? configuredCreality.get(handle)
        if (crealitySource && (crealityFfmpeg ?? helper)) {
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
            ffmpeg: crealityFfmpeg ?? helper,
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
        const bambuCamera = bambu.get(handle)
        if (bambuCamera) {
          if (
            !isCurrent() ||
            signal.aborted ||
            expiresAtMonoMs <= performance.now() ||
            expiresAtMonoMs - performance.now() > 30000
          )
            throw Error('Bambu camera admission expired')
          return openBambuCameraSource({
            ...bambuCamera,
            isCurrent,
            signal: AbortSignal.any([
              signal,
              AbortSignal.timeout(
                Math.max(1, Math.ceil(expiresAtMonoMs - performance.now())),
              ),
            ]),
          })
        }
        const sdcpSource = sdcpSources.get(handle)
        if (sdcpSource)
          return openSdcpCamera({
            source: sdcpSource,
            executable: helper,
            signal,
            expiresAtMonoMs,
            isCurrent,
          })
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
  return Object.assign(factory, {
    assignmentIds: [...new Set(cameras.map(({ scope }) => scope.printerId))],
    getCameraStatus: () => getRtspCameraStatus(config, sdcpVideo),
  })
}
