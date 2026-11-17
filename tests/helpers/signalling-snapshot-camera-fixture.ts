// SPDX-License-Identifier: MIT
import { isAbsolute } from 'node:path'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import {
  CameraFixture as RtspCameraFixture,
  cameraRuntimeSection as rtspRuntimeSection,
} from './signalling-camera-fixture.ts'

const SnapshotCameraFixture = z.strictObject({
  kind: z.literal('moonraker-snapshot'),
  helperPath: z.string().refine(isAbsolute),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotPort: z.number().int().min(1).max(65535),
})

/** Retain the original strict RTSP fixture and opt snapshots in separately. */
export const CameraFixture = z.union([RtspCameraFixture, SnapshotCameraFixture])
export type CameraFixture = z.infer<typeof CameraFixture>
export function cameraFixtureFromEnv(): CameraFixture | undefined {
  const raw = process.env.SIGNALLING_HTTPS_CAMERA
  return raw === undefined ? undefined : CameraFixture.parse(JSON.parse(raw))
}

export function cameraRuntimeSection(
  camera: CameraFixture,
  assignmentId: string,
) {
  if (!('kind' in camera)) return rtspRuntimeSection(camera, assignmentId)
  const ffmpeg = { path: camera.helperPath, sha256: camera.helperSha256 }
  return {
    helper: ffmpeg,
    maxSessions: 1,
    cameras: [
      {
        cameraId: 'fixture-camera',
        assignmentId,
        source: {
          kind: camera.kind,
          address: '127.0.0.1',
          port: camera.snapshotPort,
          path: '/?action=snapshot',
          ffmpeg,
        },
      },
    ],
  }
}
