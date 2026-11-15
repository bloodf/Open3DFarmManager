// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { openBambuCameraSource, readBambuH264 } from '../bambu/camera-media.ts'
import type { CameraAccessUnit } from '../camera/session.ts'
import type { HelperExecutable } from '../../../../tools/rtsp-ingest/supervisor/process.ts'
import {
  selectAnycubicCamera,
  selectAnycubicStream,
  streamAnycubicJpegs,
  type AnycubicCameraSource,
} from './camera.ts'

export async function openAnycubicCameraSource(input: {
  source: AnycubicCameraSource
  ffmpeg: HelperExecutable
  signal: AbortSignal
  isCurrent: () => boolean
}): Promise<AsyncIterable<CameraAccessUnit>> {
  const source =
    input.source.kind === 'rinkhals'
      ? {
          ...input.source,
          ...(input.source.auth ? { auth: { ...input.source.auth } } : {}),
        }
      : { ...input.source }
  selectAnycubicCamera(source)
  if (source.kind === 'rinkhals') {
    return openBambuCameraSource({
      source: { model: 'A1', host: source.host, accessCode: 'unused' },
      ffmpeg: input.ffmpeg,
      signal: input.signal,
      isCurrent: input.isCurrent,
      jpegStream: ({ signal }) => streamAnycubicJpegs({ source, signal }),
    })
  }
  const executable = { ...input.ffmpeg }
  try {
    if (
      !isAbsolute(executable.path) ||
      !/^[a-f\d]{64}$/.test(executable.sha256) ||
      createHash('sha256')
        .update(await readFile(executable.path))
        .digest('hex') !== executable.sha256
    )
      throw Error()
  } catch {
    throw Error('Invalid Anycubic camera encoder')
  }
  return (async function* () {
    let timestampUs = 0
    for (let attempt = 0; attempt <= 3; attempt++) {
      if (input.signal.aborted || !input.isCurrent()) return
      const controller = new AbortController()
      const signal = AbortSignal.any([input.signal, controller.signal])
      let captureStarted = false
      let child: ReturnType<typeof spawn> | undefined
      let closed: Promise<void> = Promise.resolve()
      let feed: Promise<void> = Promise.resolve()
      try {
        // Even a failed activation may have enabled the camera light.
        captureStarted = true
        const url = selectAnycubicStream(
          source,
          await source.startCapture(signal),
        )
        if (signal.aborted || !input.isCurrent()) return
        const args = ['-hide_banner', '-loglevel', 'quiet', '-nostdin']
        if (url.protocol === 'http:') args.push('-f', 'flv', '-i', 'pipe:0')
        else
          args.push(
            '-protocol_whitelist',
            'pipe,tcp,rtsp',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            'pipe:0',
          )
        args.push(
          '-an',
          '-c:v',
          'copy',
          '-bsf:v',
          'h264_mp4toannexb,h264_metadata=aud=insert',
          '-f',
          'h264',
          'pipe:1',
        )
        const encoder = spawn(executable.path, args, {
          stdio: ['pipe', 'pipe', 'ignore'],
          signal,
          killSignal: 'SIGKILL',
        })
        child = encoder
        let failed = false
        encoder.on('error', () => {
          failed = true
        })
        closed = new Promise<void>((resolve) =>
          encoder.once('close', (code) => {
            failed ||= code !== 0
            resolve()
          }),
        )
        encoder.stdin.on('error', () => {})
        feed = (async () => {
          try {
            if (url.protocol === 'rtsp:') {
              const quote = (value: string) =>
                "'" + value.replaceAll("'", "'\\''") + "'"
              encoder.stdin.end(
                `ffconcat version 1.0\nfile ${quote(url.toString())}\noption rtsp_transport tcp\n`,
              )
            } else {
              // Node's request does not follow redirects. Credentials cannot be forwarded.
              const req = request(url, { signal, timeout: 5000 })
              req.on('timeout', () => req.destroy(Error('Camera timeout')))
              try {
                const response = await new Promise<
                  import('node:http').IncomingMessage
                >((resolve, reject) => {
                  req.once('response', resolve)
                  req.once('error', reject)
                  req.end()
                })
                try {
                  if (response.statusCode !== 200) throw Error()
                  for await (const chunk of response) {
                    if (!encoder.stdin.write(chunk))
                      await once(encoder.stdin, 'drain', { signal })
                  }
                  encoder.stdin.end()
                } finally {
                  response.destroy()
                }
              } finally {
                req.destroy()
              }
            }
          } catch {
            failed = true
            controller.abort()
          }
        })()
        for await (const unit of readBambuH264(encoder.stdout)) {
          if (signal.aborted || !input.isCurrent()) return
          yield { ...unit, timestampUs: (timestampUs += 100000) }
        }
        await closed
        if (failed) throw Error()
      } catch {
        if (input.signal.aborted || !input.isCurrent()) return
      } finally {
        controller.abort()
        child?.stdin?.destroy()
        child?.stdout?.destroy()
        await closed
        await feed
        if (captureStarted) {
          try {
            await source.stopCapture()
          } catch {
            throw Error('Anycubic camera capture cleanup failed')
          }
        }
      }
      if (attempt === 3) throw Error('Anycubic camera unavailable')
      try {
        await delay(250 * 2 ** attempt, undefined, { signal: input.signal })
      } catch {
        return
      }
    }
  })()
}
