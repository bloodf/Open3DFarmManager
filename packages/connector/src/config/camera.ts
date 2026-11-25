// SPDX-License-Identifier: MIT
import { isAbsolute } from 'node:path'
import { BlockList, isIP } from 'node:net'
import { z } from 'zod'
import { isKobraXFlvPath, isKobraXFlvPort } from '../kobra-x/camera.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { sdcpProfile } from '../sdcp/models.ts'

const textId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
// Cameras are local devices: loopback, private and link-local ranges only.
const local = new BlockList()
for (const [net, prefix] of [
  ['127.0.0.0', 8],
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
] as const)
  local.addSubnet(net, prefix, 'ipv4')
local.addAddress('::1', 'ipv6')
local.addSubnet('fc00::', 7, 'ipv6')
local.addSubnet('fe80::', 10, 'ipv6')
// Cloud instance metadata endpoints sit inside link-local/ULA ranges.
const metadata = new BlockList()
metadata.addAddress('169.254.169.254', 'ipv4')
metadata.addAddress('fd00:ec2::254', 'ipv6')
const localAddress = (value: string) => {
  const family = isIP(value)
  return (
    family !== 0 &&
    // No zone ids, no IPv4-mapped or dotted IPv6 forms, no broadcast.
    !value.includes('%') &&
    !(family === 6 && value.includes('.')) &&
    !/^::ffff:/i.test(value) &&
    !value.endsWith('.255') &&
    !metadata.check(value, family === 4 ? 'ipv4' : 'ipv6') &&
    local.check(value, family === 4 ? 'ipv4' : 'ipv6')
  )
}
// Literal IP, port and path only: no DNS, credentials, query or fragment. The
// ingest helper re-validates; these values never leave the Connector process.
const Source = z.strictObject({
  address: z.string().refine(localAddress),
  port: z.number().int().min(1).max(65535),
  path: z
    .string()
    .max(1024)
    .regex(/^\/(?!\/)[^?#@\\\s]*$/),
})
// Vendor MJPEG cameras (`/?action=stream`): literal local address and port
// only; the path is fixed by the vendor adapter and never configurable.
const MjpegSource = (
  kind: 'creality-mjpeg' | 'anycubic-rinkhals' | 'flashforge-mjpeg',
) =>
  z.strictObject({
    kind: z.literal(kind),
    address: z.string().refine(localAddress),
    port: z.number().int().min(1).max(65535),
    path: z.literal('/?action=stream').default('/?action=stream'),
  })
const Executable = z.strictObject({
  path: z.string().refine(isAbsolute),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})
const BambuSource = z.strictObject({
  kind: z.literal('bambu-lan'),
  model: z.string().min(1).max(64),
  address: z.string().refine(localAddress),
  port: z.number().int().min(1).max(65535).optional(),
  ffmpeg: Executable,
  credentialFile: z.string().refine(isAbsolute),
  caFile: z.string().refine(isAbsolute).optional(),
  pinSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
})
const CameraRuntime = z.strictObject({
  helper: Executable,
  maxSessions: z.number().int().min(1).max(4).default(1),
  cameras: z
    .array(
      z.strictObject({
        cameraId: textId,
        assignmentId: BrowserDeviceUuid,
        source: z.union([
          Source,
          Source.extend({
            kind: z.literal('moonraker-snapshot'),
            ffmpeg: Executable,
            path: z
              .string()
              .max(2048)
              .regex(/^\/(?!\/)[^#@\\\s]*$/),
          }),
          BambuSource,
          MjpegSource('creality-mjpeg'),
          // SDCP resin boards: names the collected printer whose stream the
          // signed video command opens. The stream's port and path come from
          // its reply, and only this address is opened.
          z.strictObject({
            kind: z.literal('sdcp-rtsp'),
            address: z.ipv4().refine(localAddress),
            mainboardId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
            model: z
              .string()
              .max(128)
              .refine((model) => sdcpProfile(model)?.camera === true),
          }),
          // Parallel-7/flashforge-api-docs wiki, Adventurer-5M-Pro-Features:
          // MJPEG at :8080/?action=stream. This source only reads; starting the
          // stream is the signed, gated `set_camera_stream` command.
          MjpegSource('flashforge-mjpeg'),
          // Creality `webrtc_local` signalling; the path is fixed. Encrypted
          // signalling on the advertised videoPort is not implemented.
          z.strictObject({
            kind: z.literal('creality-webrtc'),
            address: z.ipv4().refine(localAddress),
            port: z.number().int().min(1).max(65535),
            path: z.literal('/call/webrtc_local').default('/call/webrtc_local'),
          }),
          MjpegSource('anycubic-rinkhals'),
          Source.extend({
            kind: z.literal('kobra-x-flv'),
            address: z.ipv4().refine(localAddress),
            path: z.string().refine(isKobraXFlvPath),
          }).refine(({ address, port }) => isKobraXFlvPort(address, port)),
        ]),
      }),
    )
    .min(1)
    .max(16),
})
export type CameraRuntimeConfig = z.infer<typeof CameraRuntime>

/** Opt-in camera section. Absent means no track, channel or helper. */
export function parseCameraRuntimeConfig(
  input: unknown,
  assignmentIds: readonly string[],
): CameraRuntimeConfig {
  const config = CameraRuntime.parse(input)
  const seen = new Set<string>()
  for (const camera of config.cameras) {
    if (
      !assignmentIds.includes(camera.assignmentId) ||
      seen.has(camera.assignmentId)
    )
      throw new Error('Camera assignment does not match runtime assignments')
    seen.add(camera.assignmentId)
  }
  return config
}
