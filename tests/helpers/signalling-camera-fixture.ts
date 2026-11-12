import { isAbsolute } from 'node:path'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'

/**
 * Camera opt-in for the RTC farm-page row, set by the acceptance runner from
 * its task-owned RTSP simulator and verified ingest helper. Absent: no camera.
 */
export const CameraFixture = z.strictObject({
  helperPath: z.string().refine(isAbsolute),
  helperSha256: z.string().regex(/^[a-f0-9]{64}$/),
  rtspPort: z.number().int().min(1024).max(65535),
  rtspPath: z.string().regex(/^\/[A-Za-z0-9_-]{1,64}$/),
})
export type CameraFixture = z.infer<typeof CameraFixture>
export function cameraFixtureFromEnv(): CameraFixture | undefined {
  const raw = process.env.SIGNALLING_HTTPS_CAMERA
  return raw === undefined ? undefined : CameraFixture.parse(JSON.parse(raw))
}

/** Connector runtime camera section for the single fixture assignment. */
export function cameraRuntimeSection(
  camera: CameraFixture,
  assignmentId: string,
) {
  return {
    helper: { path: camera.helperPath, sha256: camera.helperSha256 },
    maxSessions: 1,
    cameras: [
      {
        cameraId: 'fixture-camera',
        assignmentId,
        source: {
          address: '127.0.0.1',
          port: camera.rtspPort,
          path: camera.rtspPath,
        },
      },
    ],
  }
}
