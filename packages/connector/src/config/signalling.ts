import { z } from 'zod'
import {
  PairingProofAudience,
  PairingProofOrigin,
} from '../../../farm-protocol/src/pairing-proof.ts'
import { BrowserDeviceUuid } from '../../../farm-protocol/src/browser-device-proof.ts'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'

export const RuntimeSignalling = z
  .strictObject({
    endpoint: z.string().max(2048),
    origin: PairingProofOrigin,
    audience: PairingProofAudience,
    retryMinMs: z.number().int().min(100).max(300000).default(1000),
    retryMaxMs: z.number().int().min(100).max(300000).default(30000),
  })
  .refine((value) => {
    try {
      const target = new URL(value.endpoint)
      return (
        value.retryMinMs <= value.retryMaxMs &&
        new URL(value.origin).protocol === 'https:' &&
        target.href === value.endpoint &&
        target.protocol === 'wss:' &&
        target.host === new URL(value.origin).host &&
        target.pathname === '/api/signalling/connector' &&
        !target.search &&
        !target.hash &&
        !target.username &&
        !target.password
      )
    } catch {
      return false
    }
  }, 'Expected the exact configured WSS Connector endpoint')

/** Untrusted lookup hint only. Server JWT, PoP and current records authorize it. */
export function credentialLookupId(token: string): string {
  if (token.length > 8192) throw Error('Invalid credential lookup encoding')
  const parts = token.split('.')
  if (
    parts.length !== 3 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    throw Error('Invalid credential lookup encoding')
  const payload = parts[1]!
  const bytes = Buffer.from(payload, 'base64url')
  if (bytes.toString('base64url') !== payload)
    throw Error('Invalid credential lookup encoding')
  const value = parseBoundedJson(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    {
      maxBytes: 8192,
      maxDepth: 4,
      maxValues: 64,
      maxStringChars: 4096,
    },
  )
  return z.object({ jti: BrowserDeviceUuid }).parse(value).jti
}
