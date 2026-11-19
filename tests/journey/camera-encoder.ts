// SPDX-License-Identifier: MIT
/**
 * Offline camera fixture for the vendor journeys (Creality, Anycubic).
 *
 * The journeys run on machines without a system FFmpeg. By default the
 * Connector runs a pinned stand-in encoder that honours the process contract
 * of the vendor MJPEG path (`-f mjpeg -i pipe:0 ... -f h264 pipe:1`, input on
 * stdin, exit 0 at end of input, non-zero on malformed argv or input) and,
 * for every JPEG it reads, writes the next access unit of a pre-encoded H264
 * clip. The clip is real Constrained Baseline H264 (64x48, IDR every 10
 * frames, an AUD before every access unit), so the browser decodes it and the
 * decoded frame count rises exactly as it does with FFmpeg.
 *
 * The real encoder stays an explicit qualification, shared with the camera
 * loopback tests: `OPENFARM_CAMERA_FFMPEG_QUALIFY=1` (optionally
 * `OPENFARM_CAMERA_FFMPEG`) makes the harness use FFmpeg and fail when it is
 * missing instead of falling back.
 *
 * Both fixtures were produced once with:
 *   ffmpeg -f lavfi -i testsrc2=size=64x48:rate=10 -frames:v 10 -an
 *     -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p
 *     -profile:v baseline -x264-params aud=1:keyint=10 -f h264
 *   (SEI removed with -bsf:v filter_units=remove_types=6)
 *   ffmpeg -f lavfi -i testsrc2=size=32x24 -frames:v 1 -c:v mjpeg -q:v 10
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  FFMPEG_QUALIFICATION_ENV,
  qualificationEncoder,
} from '../helpers/camera-encoder.ts'

const GOP_BASE64 = [
  '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',
].join('')
const FRAME_BASE64 = [
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAyAP/bAEMACBQUFxQXGxsbGxsb',
  'IB4gISEhICAgICEhISQkJCoqKiQkJCEhJCQoKCoqLi8uKysqKy8vMjIyPDw5OUZGSFZWZ//E',
  'AHoAAAMBAAAAAAAAAAAAAAAAAAQGBQcBAQEBAQAAAAAAAAAAAAAAAAYEBQIQAAIBAwIEBwAD',
  'AQAAAAAAAAECERIAA0FRBCETMWEzIjIUgbEjQnFSEQABAgQGAQUBAQAAAAAAAAABAhESAAME',
  'MUEhInEyYYGxNFGyEzP/wAARCAAYACADASIAAhEAAxEA/9oADAMBAAIRAxEAPwDLicz5GVNB',
  'P9QAAJJJPID/AE24YuL4/GxUPBKhvbiin/qqKY8ZuTiIJ4hIqZukQkwXCGWAO8bc9rYFK9Do',
  '0+v39KTNNdVM706e7wvFvbo3Kt6AQ+gVuhCmL65DDADTGdyrbp/tuLlEcJ8uRCNCxIGRfxOa',
  'fzYMgn0mJB9JBBHcESCPEWzcNxXFywxvpJ5JAA1JIgCx8pp+IgjE6s7UsZ6Qd6kqJ2HMzz3F',
  'm8OavkqYyMzK0A+ZS5LUkbjtHPYWjXd1lU4ionlRwjhixZm3dvXOZFUkqpLpEmAkEpyJYKZv',
  'tw3XHKVzL5x+vyyU1sbL5x+vyyU1s8eo4E83ny1cq/SpXF7i66a3IXuLrpra5cwK/wAVcj3E',
  '/wD/2Q==',
].join('')

/** sha256 of the decoded fixtures; a corrupted constant fails loudly. */
const GOP_SHA256 =
  '9761c3b3ef2d363b947aebfdb71233569a0ee2edca47a27cd6c7224be8bd377e'
const FRAME_SHA256 =
  'f75a2fb9df02c576196d0a3582b020270b62b2ae1c68094b4775b0d18a6f9781'

/** Bash is only the launcher: `exec -a` keeps the helper path as argv[0]. */
const LAUNCHER = '/bin/bash'

function decoded(base64: string, sha256: string, name: string): Buffer {
  const bytes = Buffer.from(base64, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== sha256)
    throw new Error(`Journey camera ${name} fixture is corrupted`)
  return bytes
}

/** One pre-encoded 32x24 JPEG test pattern for the simulated camera. */
export function journeyCameraFrame(): Buffer {
  return decoded(FRAME_BASE64, FRAME_SHA256, 'JPEG')
}

/**
 * Stand-in body, run with `node -e`. It is single-quoted in the launcher, so
 * it must not contain a single quote (checked when the helper is written).
 */
const STAND_IN_SOURCE = String.raw`
const args = process.argv.slice(1)
const fail = (code) => process.exit(code)
const expect = (flag, value) => {
  const at = args.indexOf(flag)
  if (at < 0 || args[at + 1] !== value) fail(65)
}
if (!args.includes("-nostdin") || !args.includes("-an")) fail(65)
expect("-f", "mjpeg")
expect("-i", "pipe:0")
expect("-c:v", "libx264")
expect("-pix_fmt", "yuv420p")
const x264 = args[args.indexOf("-x264-params") + 1] ?? ""
if (!x264.split(":").includes("aud=1")) fail(65)
const tail = args.slice(-3)
if (tail[0] !== "-f" || tail[1] !== "h264" || tail[2] !== "pipe:1") fail(65)

const gop = Buffer.from(__GOP__, "base64")
const units = []
for (let i = 0; i + 4 < gop.length; i++)
  if (gop[i] === 0 && gop[i + 1] === 0 && gop[i + 2] === 0 &&
      gop[i + 3] === 1 && (gop[i + 4] & 31) === 9) units.push(i)
if (units.length === 0 || units[0] !== 0) fail(70)
const access = units.map((start, n) => gop.subarray(start, units[n + 1] ?? gop.length))

let pending = Buffer.alloc(0)
let frames = 0
const eoi = Buffer.from([0xff, 0xd9])
process.stdin.on("data", (chunk) => {
  pending = Buffer.concat([pending, chunk])
  for (;;) {
    if (pending.length < 2) return
    if (pending[0] !== 0xff || pending[1] !== 0xd8) fail(66)
    const end = pending.indexOf(eoi, 2)
    if (end < 0) return
    pending = pending.subarray(end + 2)
    process.stdout.write(access[frames++ % access.length])
  }
})
process.stdin.on("end", () => {
  if (pending.length) fail(66)
  process.stdout.end(() => process.exit(0))
})
`

export type JourneyCameraEncoder = Readonly<{
  /** Absolute path the Connector runs; ps shows it as the process argv[0]. */
  path: string
  sha256: string
  /** `stand-in` (default) or `ffmpeg` (qualification). */
  kind: 'stand-in' | 'ffmpeg'
  /** One JPEG frame for the simulated camera. */
  frame: Buffer
  dispose(): Promise<void>
}>

async function pinned(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function standIn(): Promise<JourneyCameraEncoder> {
  const node = process.execPath
  if (!isAbsolute(node) || /[\s'"$`\\]/.test(node))
    throw new Error('Journey camera stand-in needs a plain absolute Node path')
  if (!existsSync(LAUNCHER))
    throw new Error(`Journey camera stand-in needs ${LAUNCHER}`)
  const gop = decoded(GOP_BASE64, GOP_SHA256, 'H264')
  const body = STAND_IN_SOURCE.replace(
    '__GOP__',
    JSON.stringify(gop.toString('base64')),
  )
  if (body.includes("'"))
    throw new Error('Journey camera stand-in body must not contain a quote')
  const directory = await mkdtemp(join(tmpdir(), 'journey-camera-encoder-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    const path = join(directory, 'stand-in-ffmpeg')
    await writeFile(
      path,
      `#!${LAUNCHER}\nexec -a "$0" ${node} -e '${body}' -- "$@"\n`,
      { mode: 0o700, flag: 'wx' },
    )
    await chmod(path, 0o700)
    return {
      path,
      sha256: await pinned(path),
      kind: 'stand-in',
      frame: journeyCameraFrame(),
      dispose,
    }
  } catch (error) {
    await dispose()
    throw error
  }
}

/** The real FFmpeg, resolved through symlinks so ps shows the pinned path. */
async function realFfmpeg(): Promise<JourneyCameraEncoder> {
  let configured: string
  try {
    configured = qualificationEncoder().path
  } catch (error) {
    throw new Error(
      `${FFMPEG_QUALIFICATION_ENV}=1 needs FFmpeg on PATH or OPENFARM_CAMERA_FFMPEG`,
      { cause: error },
    )
  }
  const path = await realpath(configured)
  return {
    path,
    sha256: await pinned(path),
    kind: 'ffmpeg',
    frame: journeyCameraFrame(),
    dispose: async () => {},
  }
}

/** Stand-in by default; the real encoder only under the explicit opt-in. */
export function createJourneyCameraEncoder(): Promise<JourneyCameraEncoder> {
  return process.env[FFMPEG_QUALIFICATION_ENV] === '1'
    ? realFfmpeg()
    : standIn()
}
