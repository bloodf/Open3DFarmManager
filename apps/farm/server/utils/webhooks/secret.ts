import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'
import {
  credentialReadKey,
  credentialWriteKey,
} from '../sealed-credential-key.ts'

const PREFIX = 'O3W1.'
const INFO = Buffer.from('open3dfarmmanager/webhook/v1')

function key(master: string) {
  if (master.length < 32) throw new Error('webhook encryption key unavailable')
  return Buffer.from(hkdfSync('sha256', master, '', INFO, 32))
}

export function sealWebhookSecret(plain: string, master: string) {
  const write = credentialWriteKey(master)
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(write.key), nonce)
  const packed = Buffer.concat([
    write.prefix,
    nonce,
    cipher.update(plain, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return PREFIX + packed.toString('base64url')
}

export function openWebhookSecret(value: string, master: string) {
  if (!value.startsWith(PREFIX)) return { secret: value, legacy: true }
  const packed = Buffer.from(value.slice(PREFIX.length), 'base64url')
  if (packed.length < 4 + 16 + 12 + 16)
    throw new Error('invalid sealed webhook secret')
  const nonce = packed.subarray(20, 32)
  const read = credentialReadKey(master, packed)
  const dataTag = read.ciphertext.subarray(12)
  const tag = dataTag.subarray(dataTag.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', key(read.key), nonce)
  decipher.setAuthTag(tag)
  return {
    secret: Buffer.concat([
      decipher.update(dataTag.subarray(0, -16)),
      decipher.final(),
    ]).toString('utf8'),
    legacy: false,
  }
}
