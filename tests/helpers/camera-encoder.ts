// SPDX-License-Identifier: MIT
/**
 * Camera encoder fixtures for the camera loopback tests.
 *
 * The default tests run on machines without a system FFmpeg (the desktop does
 * not ship one). They use a small pinned stand-in executable that honours the
 * same process contract the connector relies on: input on stdin, Annex B H264
 * with an AUD before every access unit on stdout, exit 0 at end of input and a
 * non-zero exit on malformed input or credentials in argv.
 *
 * Real encoder coverage stays available as an explicit qualification. Set
 * `OPENFARM_CAMERA_FFMPEG_QUALIFY=1` (optionally `OPENFARM_CAMERA_FFMPEG` to an
 * absolute path) to run the FFmpeg-backed variants; a requested qualification
 * without a usable FFmpeg fails instead of skipping.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { HelperExecutable } from '../../tools/rtsp-ingest/supervisor/process.ts'

export const FFMPEG_QUALIFICATION_ENV = 'OPENFARM_CAMERA_FFMPEG_QUALIFY'

/** `false` when enabled, otherwise the skip reason shown by node:test. */
export const ffmpegQualificationSkip: string | false =
  process.env[FFMPEG_QUALIFICATION_ENV] === '1'
    ? false
    : `real FFmpeg qualification is opt-in (${FFMPEG_QUALIFICATION_ENV}=1)`

export interface DisposableEncoder {
  ffmpeg: HelperExecutable
  dispose(): void
}

function pin(path: string): HelperExecutable {
  return Object.freeze({
    path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  })
}

const FAKE_ENCODER_SOURCE = String.raw`
const args = process.argv.slice(2)
const fail = (code) => process.exit(code)
for (const arg of args)
  for (const secret of forbidden) if (arg.includes(secret)) fail(64)
const input = args.indexOf('-i')
if (input < 0 || args[input + 1] !== 'pipe:0') fail(65)
const formatFlag = args.lastIndexOf('-f', input)
if (formatFlag < 0) fail(65)
const format = args[formatFlag + 1]
const tail = args.slice(-3)
if (tail[0] !== '-f' || tail[1] !== 'h264' || tail[2] !== 'pipe:1') fail(65)
if (!args.includes('-nostdin') || !args.includes('-an')) fail(65)

const filler = (byte) => Buffer.alloc(24, byte)
const aud = Buffer.from([0, 0, 0, 1, 9, 0xf0])
const sps = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x0a, 0xda, 0x0f])
const pps = Buffer.from([0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80])
function emit(key) {
  const slice = key
    ? Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), filler(0x88)])
    : Buffer.concat([Buffer.from([0, 0, 0, 1, 0x41]), filler(0x9a)])
  process.stdout.write(Buffer.concat(key ? [aud, sps, pps, slice] : [aud, slice]))
}

let pending = Buffer.alloc(0)
let frames = 0
let flvHeader = false
function drainMjpeg() {
  for (;;) {
    if (pending.length < 2) return
    if (pending[0] !== 0xff || pending[1] !== 0xd8) fail(66)
    const end = pending.indexOf(Buffer.from([0xff, 0xd9]), 2)
    if (end < 0) return
    pending = pending.subarray(end + 2)
    emit(frames++ % 10 === 0)
  }
}
function drainFlv() {
  if (!flvHeader) {
    if (pending.length < 13) return
    if (pending.toString('latin1', 0, 3) !== 'FLV') fail(66)
    pending = pending.subarray(pending.readUInt32BE(5) + 4)
    flvHeader = true
  }
  for (;;) {
    if (pending.length < 11) return
    const size = pending.readUIntBE(1, 3)
    if (pending.length < 11 + size + 4) return
    const type = pending[0]
    const data = pending.subarray(11, 11 + size)
    if (pending.readUInt32BE(11 + size) !== 11 + size) fail(66)
    pending = pending.subarray(11 + size + 4)
    if (type !== 9) continue
    if ((data[0] & 15) !== 7) fail(66)
    if (data[1] === 1) emit(data[0] >> 4 === 1)
  }
}
const drain = format === 'mjpeg' ? drainMjpeg : format === 'flv' ? drainFlv : () => fail(67)
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk])
  drain()
})
process.stdin.on('end', () => {
  if (pending.length) fail(66)
  process.stdout.end(() => process.exit(0))
})
`

/**
 * Writes the stand-in encoder to a private temporary directory and pins it.
 * Any argv entry containing one of `forbidden` makes the process exit 64, so a
 * credential leak into argv surfaces as a media failure in the test.
 */
export function createFakeEncoder(forbidden: string[] = []): DisposableEncoder {
  const node = process.execPath
  if (!isAbsolute(node) || /\s/.test(node))
    throw Error(
      'Fake camera encoder needs an absolute Node path without spaces',
    )
  const dir = mkdtempSync(join(tmpdir(), 'openfarm-camera-encoder-'))
  try {
    const path = join(dir, 'fake-ffmpeg')
    writeFileSync(
      path,
      `#!${node}\n'use strict'\nconst forbidden = ${JSON.stringify(forbidden)}\n${FAKE_ENCODER_SOURCE}`,
      { mode: 0o700 },
    )
    chmodSync(path, 0o700)
    return {
      ffmpeg: pin(path),
      dispose: () => rmSync(dir, { recursive: true, force: true }),
    }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** Resolves the real FFmpeg for the opt-in qualification; never skips silently. */
export function qualificationEncoder(): HelperExecutable {
  const configured = process.env.OPENFARM_CAMERA_FFMPEG
  const path =
    configured ?? execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim()
  if (!isAbsolute(path))
    throw Error('FFmpeg qualification requires an absolute encoder path')
  return pin(path)
}

/** Minimal FLV with AVC video tags; the first one is a keyframe. */
export function syntheticFlv(frames = 4): Buffer {
  const header = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0])
  const tags = Array.from({ length: frames }, (_, i) => {
    const data = Buffer.concat([
      Buffer.from([i === 0 ? 0x17 : 0x27, 1, 0, 0, 0]),
      Buffer.alloc(16, 0x5a),
    ])
    const tag = Buffer.alloc(11 + data.length + 4)
    tag[0] = 9
    tag.writeUIntBE(data.length, 1, 3)
    tag.writeUIntBE(i * 100, 4, 3)
    data.copy(tag, 11)
    tag.writeUInt32BE(11 + data.length, 11 + data.length)
    return tag
  })
  return Buffer.concat([header, ...tags])
}

/** Real FFmpeg fixtures for the qualification variants. */
export function ffmpegFixtures(path: string) {
  const run = (args: string[]) =>
    execFileSync(path, ['-hide_banner', '-loglevel', 'error', ...args])
  return {
    jpeg: run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32',
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      'pipe:1',
    ]),
    flv: run([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=32x32:r=10',
      '-frames:v',
      '4',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-f',
      'flv',
      'pipe:1',
    ]),
  }
}
