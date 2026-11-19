import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto'

const ALG = 'aes-256-gcm'
const NONCE_BYTES = 12
const KEY_BYTES = 32
const INFO = Buffer.from('open3dfarmmanager/sign-in-provider/v1', 'utf8')

export type SealedSecret = {
  ciphertext: Buffer
  nonce: Buffer
}

function deriveKey(master: string): Buffer {
  if (typeof master !== 'string' || master.length < 32)
    throw new Error('sign-in provider encryption key unavailable')
  return Buffer.from(hkdfSync('sha256', master, '', INFO, KEY_BYTES))
}

/** AES-256-GCM. Ciphertext is ciphertext||tag; nonce is 12 random bytes. */
export function sealClientSecret(plain: string, master: string): SealedSecret {
  if (typeof plain !== 'string' || plain.length < 1 || plain.length > 512)
    throw new Error('invalid client secret')
  if (!/^[\x21-\x7E]+$/.test(plain)) throw new Error('invalid client secret')
  const key = deriveKey(master)
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALG, key, nonce)
  const body = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return { ciphertext: body, nonce }
}

export function openClientSecret(sealed: SealedSecret, master: string): string {
  if (
    !Buffer.isBuffer(sealed.ciphertext) ||
    !Buffer.isBuffer(sealed.nonce) ||
    sealed.nonce.length !== NONCE_BYTES ||
    sealed.ciphertext.length < 16 ||
    sealed.ciphertext.length > 1024
  )
    throw new Error('invalid sealed secret')
  const key = deriveKey(master)
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - 16)
  const data = sealed.ciphertext.subarray(0, sealed.ciphertext.length - 16)
  const decipher = createDecipheriv(ALG, key, sealed.nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString(
    'utf8',
  )
}
