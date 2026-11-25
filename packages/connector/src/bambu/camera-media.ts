// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { once } from 'node:events'
import type { CameraAccessUnit } from '../camera/session.ts'
import type { HelperExecutable } from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import { startBambuRtspsBridge } from './rtsps-bridge.ts'
import {
  selectBambuCamera,
  streamBambuJpegs,
  type BambuCameraSource,
} from './camera.ts'

/** FFmpeg emits an AUD before every access unit. Keep the final unit until EOF. */
export async function* readBambuH264(
  chunks: AsyncIterable<Buffer>,
  /** Remote streams have their own frame rate: stamp units by arrival time. */
  realTime = false,
): AsyncGenerator<CameraAccessUnit> {
  let pending = Buffer.alloc(0)
  let timestampUs = 0
  const startedMs = performance.now()
  const stamp = () =>
    realTime
      ? (timestampUs = Math.max(
          timestampUs + 1,
          Math.round((performance.now() - startedMs) * 1000),
        ))
      : (timestampUs += 100000)
  for await (const chunk of chunks) {
    pending = Buffer.concat([pending, chunk])
    if (pending.length > 8 * 1024 * 1024)
      throw Error('Bambu camera encoded frame too large')
    const starts: number[] = []
    for (let i = 0; i + 4 < pending.length; i++) {
      if (
        pending[i] === 0 &&
        pending[i + 1] === 0 &&
        pending[i + 2] === 1 &&
        (pending[i + 3]! & 31) === 9
      )
        starts.push(i > 0 && pending[i - 1] === 0 ? i - 1 : i)
    }
    for (let i = 1; i < starts.length; i++) {
      const data = Buffer.from(pending.subarray(starts[i - 1], starts[i]))
      yield {
        data,
        keyframe: hasIdr(data),
        timestampUs: stamp(),
      }
    }
    if (starts.length) pending = pending.subarray(starts[starts.length - 1])
  }
  if (pending.length)
    yield {
      data: pending,
      keyframe: hasIdr(pending),
      timestampUs: realTime ? stamp() : timestampUs + 100000,
    }
}
function hasIdr(data: Buffer) {
  for (let i = 0; i + 3 < data.length; i++)
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1 &&
      (data[i + 3]! & 31) === 5
    )
      return true
  return false
}

/** Secrets stay out of argv, stderr, and DTOs on both camera paths. */
export async function openBambuCameraSource(input: {
  source: BambuCameraSource
  ffmpeg: HelperExecutable
  signal: AbortSignal
  jpegStream?: typeof streamBambuJpegs
  isCurrent?: () => boolean
}): Promise<AsyncIterable<CameraAccessUnit>> {
  const source = { ...input.source }
  const selected = selectBambuCamera(source)
  if (selected.kind === 'rtsps' && !source.caFile)
    throw Error('Bambu RTSPS camera CA required')
  const executable = { ...input.ffmpeg }
  if (
    !isAbsolute(executable.path) ||
    !/^[a-f\d]{64}$/.test(executable.sha256) ||
    createHash('sha256')
      .update(await readFile(executable.path))
      .digest('hex') !== executable.sha256
  )
    throw Error('Invalid Bambu camera encoder')
  const caPem = source.caFile ? await readFile(source.caFile) : undefined
  return (async function* () {
    if (input.signal.aborted) return
    const bridge =
      selected.kind === 'rtsps'
        ? await startBambuRtspsBridge({
            host: source.host,
            port: selected.port,
            accessCode: source.accessCode,
            caPem: caPem!,
            signal: input.signal,
          })
        : undefined
    const controller = new AbortController()
    const signal = AbortSignal.any([input.signal, controller.signal])
    const args = ['-hide_banner', '-loglevel', 'quiet', '-nostdin']
    if (selected.kind === 'rtsps') {
      args.push(
        '-protocol_whitelist',
        'pipe,tcp,rtsp',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'copy',
        '-bsf:v',
        'h264_mp4toannexb,h264_metadata=aud=insert',
        '-f',
        'h264',
        'pipe:1',
      )
    } else {
      args.push(
        '-protocol_whitelist',
        'pipe',
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'mjpeg',
        '-framerate',
        '10',
        '-i',
        'pipe:0',
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-x264-params',
        'aud=1:keyint=10',
        '-f',
        'h264',
        'pipe:1',
      )
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(executable.path, args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        signal,
        killSignal: 'SIGKILL',
      })
    } catch {
      await bridge?.close()
      throw Error('Bambu camera media unavailable')
    }
    const stdin = child.stdin!,
      stdout = child.stdout!
    let failed = false
    child.on('error', () => {
      failed = true
    })
    const closed = new Promise<void>((resolve) =>
      child.once('close', (code) => {
        if (code !== 0) failed = true
        resolve()
      }),
    )
    stdin.on('error', () => {})
    const feed = (async () => {
      try {
        if (selected.kind === 'rtsps') {
          // The bridge URL is generated here (hex token path); nothing to escape.
          stdin.end(
            `ffconcat version 1.0\nfile '${bridge!.url}'\noption rtsp_transport tcp\n`,
          )
        } else {
          for await (const jpeg of (input.jpegStream ?? streamBambuJpegs)({
            host: source.host,
            port: selected.port,
            accessCode: source.accessCode,
            ...(caPem ? { caPem } : {}),
            ...(source.pinSha256 ? { pinSha256: source.pinSha256 } : {}),
            signal,
          })) {
            if (!stdin.write(jpeg)) await once(stdin, 'drain', { signal })
          }
          stdin.end()
        }
      } catch {
        failed = true
        controller.abort()
      }
    })()
    try {
      for await (const unit of readBambuH264(
        stdout,
        selected.kind === 'rtsps',
      )) {
        if (signal.aborted || (input.isCurrent && !input.isCurrent())) return
        yield unit
      }
      await closed
      if (failed && !input.signal.aborted)
        throw Error('Bambu camera media unavailable')
    } catch {
      if (!input.signal.aborted) throw Error('Bambu camera media unavailable')
    } finally {
      controller.abort()
      stdin.destroy()
      stdout.destroy()
      await closed
      await feed
      await bridge?.close()
    }
  })()
}
