import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  fstatSync,
  readSync,
  type Stats,
} from 'node:fs'
import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { validateMoonrakerInput } from '../moonraker/client.ts'

const MAX_CONFIG_BYTES = 64 * 1024
// Timing is local configuration only; these bounds are not command safety policy.
const millis = z.number().int().min(100).max(300_000)
const Limits = z
  .strictObject({
    maxMessageBytes: z
      .number()
      .int()
      .min(256)
      .max(256 * 1024)
      .default(256 * 1024),
    connectTimeoutMs: millis.default(5000),
    requestTimeoutMs: millis.default(5000),
    staleAfterMs: millis.min(1000).default(30_000),
    reconnectMinMs: millis.default(1000),
    reconnectMaxMs: millis.default(30_000),
  })
  .default({
    maxMessageBytes: 256 * 1024,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    staleAfterMs: 30_000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 30_000,
  })
const Config = z.strictObject({
  version: z.literal(1),
  allowedOrigins: z.array(z.string().min(1).max(2048)).min(1).max(16),
  printers: z
    .array(
      z.strictObject({
        printerKey: z.string().min(1).max(128),
        origin: z.string().min(1).max(2048),
      }),
    )
    .min(1)
    .max(16),
  limits: Limits,
})
export type LocalCollectorConfig = z.infer<typeof Config>

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
export function readLocalCollectorConfig(path: string): LocalCollectorConfig {
  const before = lstatSync(path)
  privateFile(before)
  if (before.size > MAX_CONFIG_BYTES)
    throw new Error('Collector configuration too large')
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = fstatSync(fd)
    privateFile(stat)
    if (
      stat.dev !== before.dev ||
      stat.ino !== before.ino ||
      stat.size > MAX_CONFIG_BYTES
    )
      throw new Error('Collector configuration changed')
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1)
    let size = 0
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null)
      if (!count) break
      size += count
    }
    if (size > MAX_CONFIG_BYTES)
      throw new Error('Collector configuration too large')
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes.subarray(0, size))
    const config = Config.parse(
      parseBoundedJson(text, {
        maxBytes: MAX_CONFIG_BYTES,
        maxDepth: 8,
        maxValues: 512,
        maxStringChars: 2048,
      }),
    )
    const keys = new Set<string>()
    for (const assignment of config.printers) {
      // Validate every printer and every allowlist entry before any queue/network.
      validateMoonrakerInput({
        assignment,
        allowedOrigins: config.allowedOrigins,
        limits: config.limits,
      })
      if (keys.has(assignment.printerKey))
        throw new Error('Duplicate collector printer key')
      keys.add(assignment.printerKey)
    }
    return config
  } finally {
    closeSync(fd)
  }
}
