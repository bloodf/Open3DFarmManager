// SPDX-License-Identifier: MIT
import { setTimeout as delay } from 'node:timers/promises'
import { parseWebcamsResult } from './discovery-parse.ts'

export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
export const SNAPSHOT_TIMEOUT_MS = 2000
export const SNAPSHOT_INTERVAL_MS = 1000

/** Validate JPEG segment framing before passing bytes to the local decoder. */
function validateJpeg(jpeg: Buffer) {
  if (
    jpeg.length < 4 ||
    jpeg.readUInt16BE(0) !== 0xffd8 ||
    jpeg.readUInt16BE(jpeg.length - 2) !== 0xffd9
  )
    throw Error('Snapshot is not JPEG')
  let offset = 2
  let dimensions = false
  while (offset < jpeg.length - 2) {
    if (jpeg[offset++] !== 0xff) break
    while (jpeg[offset] === 0xff) offset++
    const marker = jpeg[offset++]
    if (marker === undefined || offset + 2 > jpeg.length) break
    const size = jpeg.readUInt16BE(offset)
    if (size < 2 || offset + size > jpeg.length - 2) break
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (
        size < 8 ||
        !jpeg.readUInt16BE(offset + 3) ||
        !jpeg.readUInt16BE(offset + 5)
      )
        break
      dimensions = true
    }
    if (marker === 0xda) {
      if (dimensions && size >= 6 && offset + size < jpeg.length - 2) return
      break
    }
    offset += size
  }
  throw Error('Snapshot is not JPEG')
}

/** One shared reader per configured camera bounds concurrent peers and retries. */
export function createMoonrakerSnapshotSource(input: {
  webcamOrigin: string
  snapshotUrl: string
}) {
  const origin = new URL(input.webcamOrigin)
  if (
    !/^https?:$/.test(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.href !== origin.origin + '/'
  )
    throw Error('Invalid webcam origin')
  const webcam = parseWebcamsResult(
    {
      webcams: [
        {
          name: 'snapshot',
          snapshot_url: input.snapshotUrl,
        },
      ],
    },
    origin.origin,
  )[0]
  if (!webcam?.snapshotUrl) throw Error('Invalid webcam snapshot URL')
  const url = webcam.snapshotUrl
  let nextAt = 0
  let busy = false
  return {
    async read(signal: AbortSignal): Promise<Buffer> {
      signal.throwIfAborted()
      if (busy || performance.now() < nextAt) throw Error('Snapshot rate limit')
      busy = true
      nextAt = performance.now() + SNAPSHOT_INTERVAL_MS
      const controller = new AbortController()
      const deadline = AbortSignal.any([
        signal,
        controller.signal,
        AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),
      ])
      try {
        const response = await fetch(url, {
          signal: deadline,
          redirect: 'error',
        })
        if (!response.ok || !response.body) throw Error('Snapshot unavailable')
        if (
          response.headers
            .get('content-type')
            ?.split(';')[0]
            ?.trim()
            .toLowerCase() !== 'image/jpeg'
        )
          throw Error('Snapshot is not JPEG')
        const length = response.headers.get('content-length')
        if (
          length &&
          (!/^\d+$/.test(length) || Number(length) > SNAPSHOT_MAX_BYTES)
        )
          throw Error('Snapshot too large')
        const chunks: Uint8Array[] = []
        let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > SNAPSHOT_MAX_BYTES) throw Error('Snapshot too large')
          chunks.push(chunk)
        }
        const jpeg = Buffer.concat(chunks, bytes)
        validateJpeg(jpeg)
        return jpeg
      } finally {
        controller.abort()
        busy = false
      }
    },
    async *stream(signal: AbortSignal): AsyncGenerator<Buffer> {
      while (!signal.aborted) {
        while (performance.now() < nextAt) {
          await delay(
            Math.max(1, Math.ceil(nextAt - performance.now())),
            undefined,
            {
              signal,
            },
          )
        }
        yield await this.read(signal)
      }
    },
  }
}
