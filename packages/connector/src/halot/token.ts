import { createCipheriv } from 'node:crypto'

// docs/protocols/halot.md, "Password and token". The cipher is the printer's,
// not a security measure of ours: it protects nothing on the wire.

/** 1 to 8 ASCII characters; the printer rejects a longer password's token. */
export const HALOT_PASSWORD = /^[ -~]{1,8}$/

const KEY = Buffer.from('a85e9d68', 'ascii')
const LOWER_BLOCK = Buffer.from('ac47b00288156e5c', 'hex')

/** Single DES in ECB with PKCS#7 padding. */
function encrypt(password: string) {
  // OpenSSL 3 only ships DES as 3DES; three equal keys are single DES.
  const cipher = createCipheriv(
    'des-ede3-ecb',
    Buffer.concat([KEY, KEY, KEY]),
    null,
  )
  return Buffer.concat([cipher.update(password, 'ascii'), cipher.final()])
}

/**
 * The tokens to try, in order. The first is what the CL-60 printer compares;
 * the second is the other form two public clients record for this length.
 */
export function halotTokens(password: string): readonly string[] {
  if (!HALOT_PASSWORD.test(password)) throw Error('Invalid HALOT password')
  const full = encrypt(password)
  const other =
    password.length === 8
      ? full.subarray(0, 8)
      : password.length > 4
        ? Buffer.concat([full, LOWER_BLOCK])
        : undefined
  return [full, ...(other ? [other] : [])].map((bytes) =>
    bytes.toString('base64'),
  )
}
