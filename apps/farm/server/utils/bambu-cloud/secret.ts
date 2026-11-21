import { credentialReadKey, credentialWriteKey } from '../sealed-credential-key.ts'
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

const ALG = 'aes-256-gcm'
const NONCE_BYTES = 12
const KEY_BYTES = 32
const TAG_BYTES = 16
const INFO = Buffer.from('open3dfarmmanager/bambu-cloud/v1', 'utf8')
const MAX_PLAIN = 4096

export type SealedSecret = {
  ciphertext: Buffer
  nonce: Buffer
}

function deriveKey(master: string): Buffer {
  if (typeof master !== 'string' || master.length < 32)
    throw new Error('bambu cloud encryption key unavailable')
  return Buffer.from(hkdfSync('sha256', master, '', INFO, KEY_BYTES))
}

/** AES-256-GCM. Ciphertext is ciphertext||tag; nonce is 12 random bytes. */
export function sealBambuCloudSecret(
  plain: string,
  master: string,
): SealedSecret {
  if (
    typeof plain !== 'string' ||
    plain.length < 1 ||
    plain.length > MAX_PLAIN ||
    !/^[\x21-\x7E]+$/.test(plain)
  )
    throw new Error('invalid bambu cloud token')
  const write = credentialWriteKey(master)
  const key = deriveKey(write.key)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALG, key, nonce)
  const body = Buffer.concat([
    write.prefix,
    cipher.update(plain, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { ciphertext: body, nonce }
}

export function openBambuCloudSecret(
  sealed: SealedSecret,
  master: string,
): string {
  if (
    !Buffer.isBuffer(sealed.ciphertext) ||
    !Buffer.isBuffer(sealed.nonce) ||
    sealed.nonce.length !== NONCE_BYTES ||
    sealed.ciphertext.length < TAG_BYTES ||
    sealed.ciphertext.length > MAX_PLAIN + TAG_BYTES + 20
  )
    throw new Error('invalid sealed bambu cloud token')
  const read = credentialReadKey(master, sealed.ciphertext)
  const key = deriveKey(read.key)
  const ciphertext = read.ciphertext
  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES)
  const data = ciphertext.subarray(
    0,
    ciphertext.length - TAG_BYTES,
  )
  const decipher = createDecipheriv(ALG, key, sealed.nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  )
}
