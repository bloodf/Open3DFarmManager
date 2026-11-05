import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { importSPKI } from 'jose'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'

/** Load only bounded public keys from a regular, non-symlink file. */
export async function loadTelemetryVerificationKeys(
  path: string,
): Promise<ReadonlyMap<string, CryptoKey>> {
  if (
    typeof path !== 'string' ||
    !path ||
    path.length > 4096 ||
    path.includes('\0')
  )
    throw new Error('Invalid telemetry key registry')
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 2 || stat.size > 65536)
      throw new Error('Invalid telemetry key registry')
    const buffer = Buffer.alloc(65537)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        size,
      )
      if (!bytesRead) break
      size += bytesRead
    }
    if (size !== stat.size || size > 65536)
      throw new Error('Invalid telemetry key registry')
    const value = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
      { maxBytes: 65536, maxDepth: 2, maxValues: 33, maxStringChars: 2048 },
    )
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid telemetry key registry')
    const entries = Object.entries(value)
    if (entries.length < 1 || entries.length > 16)
      throw new Error('Invalid telemetry key registry')
    const keys = new Map<string, CryptoKey>()
    for (const [kid, pem] of entries) {
      if (
        !/^[A-Za-z0-9_-]{1,64}$/.test(kid) ||
        typeof pem !== 'string' ||
        pem.length > 2048
      )
        throw new Error('Invalid telemetry key registry')
      const key = await importSPKI(pem, 'EdDSA')
      if (
        !(key instanceof CryptoKey) ||
        key.type !== 'public' ||
        key.algorithm.name !== 'Ed25519'
      )
        throw new Error('Invalid telemetry key registry')
      keys.set(kid, key)
    }
    return keys
  } finally {
    await file.close()
  }
}
