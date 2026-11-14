import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { parseBoundedJson } from '../../../../../packages/farm-protocol/src/json.ts'
import { PairingProofAudience } from '../../../../../packages/farm-protocol/src/pairing-proof.ts'
import { ConfigurationCapabilityV1 } from '../../../../../packages/farm-protocol/src/configuration-capability.ts'

const Metadata = z.strictObject({
  issuer: PairingProofAudience,
  kid: ConfigurationCapabilityV1.shape.kid,
  publicKeySpki: z.string().regex(/^[A-Za-z0-9_-]{59}$/),
})
const File = z.strictObject({
  version: z.literal(1),
  issuer: PairingProofAudience,
  kid: ConfigurationCapabilityV1.shape.kid,
  privateKeyPkcs8: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
})
function privateFile(stat: Stats): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    process.platform === 'win32' ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 2 ||
    stat.size > 4096
  )
    throw new Error('Invalid private configuration issuer file')
}
function unchanged(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
/** A provisioned file is not authority. Its key must match the independently configured public pin. */
export async function loadConfigurationIssuerKey(
  path: string,
  expected: Readonly<{
    issuer: string
    kid: string
    publicKeySpki: string
  }>,
): Promise<Readonly<{ signingKey: CryptoKey; verificationKey: CryptoKey }>> {
  const metadata = Metadata.parse(expected)
  if (!isAbsolute(path) || path.length > 2048 || path.includes('\0'))
    throw new Error('Invalid configuration issuer path')
  const before = await lstat(path)
  privateFile(before)
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  const bytes = Buffer.alloc(4097)
  let privateDer: Buffer | undefined
  let privateBytes: Uint8Array<ArrayBuffer> | undefined
  try {
    const opened = await file.stat()
    privateFile(opened)
    if (!unchanged(before, opened))
      throw new Error('Configuration issuer file changed')
    let size = 0
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    privateFile(after)
    if (size !== opened.size || size > 4096 || !unchanged(opened, after))
      throw new Error('Configuration issuer file changed')
    const value = File.parse(
      parseBoundedJson(
        new TextDecoder('utf-8', { fatal: true }).decode(
          bytes.subarray(0, size),
        ),
        {
          maxBytes: 4096,
          maxDepth: 2,
          maxValues: 8,
          maxStringChars: 256,
        },
      ),
    )
    if (value.issuer !== metadata.issuer || value.kid !== metadata.kid)
      throw new Error('Configuration issuer metadata mismatch')
    privateDer = Buffer.from(value.privateKeyPkcs8, 'base64url')
    const publicDer = Buffer.from(metadata.publicKeySpki, 'base64url')
    if (
      privateDer.length !== 48 ||
      privateDer.toString('base64url') !== value.privateKeyPkcs8 ||
      publicDer.length !== 44 ||
      publicDer.toString('base64url') !== metadata.publicKeySpki
    )
      throw new Error('Invalid configuration issuer encoding')
    privateBytes = new Uint8Array(privateDer)
    const signingKey = await crypto.subtle.importKey(
      'pkcs8',
      privateBytes,
      'Ed25519',
      false,
      ['sign'],
    )
    const verificationKey = await crypto.subtle.importKey(
      'spki',
      new Uint8Array(publicDer),
      'Ed25519',
      false,
      ['verify'],
    )
    const payload = new TextEncoder().encode(
      'Open3DFarmManager/configuration-issuer-key-check/v1\0',
    )
    const signature = await crypto.subtle.sign('Ed25519', signingKey, payload)
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        verificationKey,
        signature,
        payload,
      ))
    )
      throw new Error('Configuration issuer key mismatch')
    return Object.freeze({ signingKey, verificationKey })
  } finally {
    bytes.fill(0)
    privateDer?.fill(0)
    privateBytes?.fill(0)
    await file.close()
  }
}
