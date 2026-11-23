// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto'
import type { ConnectionOptions } from 'node:tls'

export function createKobraXMqttTlsOptions(
  ca?: string,
  pinSha256?: string,
): Pick<ConnectionOptions, 'rejectUnauthorized' | 'ca'> & {
  checkServerIdentity?: ConnectionOptions['checkServerIdentity']
} {
  const pin = pinSha256?.replaceAll(':', '').toLowerCase()
  if (pin !== undefined && !/^[a-f0-9]{64}$/.test(pin))
    throw new Error('Invalid Kobra X certificate fingerprint')
  return {
    rejectUnauthorized: true,
    ...(ca !== undefined ? { ca } : {}),
    ...(pin !== undefined
      ? {
          checkServerIdentity: (_host, cert) => {
            const actual = cert.raw
              ? createHash('sha256').update(cert.raw).digest('hex')
              : ''
            return actual === pin
              ? undefined
              : new Error('Kobra X printer certificate fingerprint mismatch')
          },
        }
      : {}),
  }
}
