import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  fstatSync,
  readSync,
  type Stats,
} from 'node:fs'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

export const MAX_CONFIG_BYTES = 64 * 1024

function privateFile(stat: Stats) {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    process.platform === 'win32' ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('Invalid private collector configuration')
}

/** No final symlink, FIFO/device reads or unbounded growing-file reads. */
export function readPrivateJsonFile(
  path: string,
  options: {
    maxBytes: number
    maxStringChars?: number
  },
): unknown {
  const limit = options.maxBytes
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFIG_BYTES)
    throw new Error('Invalid private JSON limit')
  const before = lstatSync(path)
  privateFile(before)
  if (before.size > limit) throw new Error('Collector configuration too large')
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = fstatSync(fd)
    privateFile(stat)
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > limit)
      throw new Error('Collector configuration changed')
    const bytes = Buffer.alloc(limit + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > limit) throw new Error('Collector configuration too large')
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, size))
    return parseBoundedJson(text, {
      maxBytes: limit,
      maxDepth: 8,
      maxValues: 512,
      maxStringChars: options.maxStringChars ?? 2048,
    })
  } finally {
    closeSync(fd)
  }
}
