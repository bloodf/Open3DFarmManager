import { createHash } from 'node:crypto'

const CONFIG = 'openfarm-keyring:'
const PREFIX = Buffer.from('O3K1')
const ID_BYTES = 16

type Config = { sessionSecret?: unknown; credentialEncryptionKey?: unknown; credentialEncryptionPreviousKey?: unknown }

/** Package runtime settings for stores whose existing key contract is a string. */
export function credentialKeyring(config: Config): string {
  return CONFIG + JSON.stringify({ current: config.credentialEncryptionKey, previous: config.credentialEncryptionPreviousKey, legacy: config.sessionSecret })
}

function valid(key: unknown): key is string {
  return typeof key === 'string' && key.length >= 32
}
function id(key: string): Buffer {
  return createHash('sha256').update(key).digest().subarray(0, ID_BYTES)
}
function keys(master: string): { current?: string; previous?: string; legacy?: string } | undefined {
  if (!master.startsWith(CONFIG)) return undefined
  return JSON.parse(master.slice(CONFIG.length))
}
export function credentialWriteKey(master: string): { key: string; prefix: Buffer } {
  const ring = keys(master)
  if (!ring) return { key: master, prefix: Buffer.alloc(0) }
  if (!valid(ring.current) || ring.current === ring.legacy) throw new Error('credential encryption key unavailable')
  return { key: ring.current, prefix: Buffer.concat([PREFIX, id(ring.current)]) }
}
export function credentialReadKey(master: string, ciphertext: Buffer): { key: string; ciphertext: Buffer } {
  const ring = keys(master)
  if (!ring) return { key: master, ciphertext }
  if (ciphertext.subarray(0, PREFIX.length).equals(PREFIX)) {
    const keyId = ciphertext.subarray(PREFIX.length, PREFIX.length + ID_BYTES)
    const key = [ring.current, ring.previous].find(k => valid(k) && id(k).equals(keyId))
    if (!key) throw new Error('credential encryption key unavailable')
    return { key, ciphertext: ciphertext.subarray(PREFIX.length + ID_BYTES) }
  }
  if (!valid(ring.legacy)) throw new Error('credential encryption key unavailable')
  return { key: ring.legacy, ciphertext }
}
