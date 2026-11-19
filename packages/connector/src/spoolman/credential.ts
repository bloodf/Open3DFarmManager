import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'

/** Private Connector custody record. Never leaves the Connector. */
export const SpoolmanCredential = z.strictObject({
  origin: z.string().min(1).max(2048),
  token: z.string().min(1).max(256).optional(),
  username: z.string().min(1).max(256).optional(),
  password: z.string().min(1).max(256).optional(),
})
export type SpoolmanCredential = z.infer<typeof SpoolmanCredential>

/** Authorization header value for a credential, or undefined without one. */
export function spoolmanAuthorization(
  credential: Pick<SpoolmanCredential, 'token' | 'username' | 'password'>,
): string | undefined {
  if (credential.token) return `Bearer ${credential.token}`
  if (credential.username && credential.password)
    return `Basic ${Buffer.from(
      `${credential.username}:${credential.password}`,
      'utf8',
    ).toString('base64')}`
  return undefined
}

/**
 * Reads the private credential file for an origin. A missing, unsafe or
 * foreign-origin file yields no header: the read then fails closed as
 * unauthorized instead of sending secrets to another origin.
 */
export function readSpoolmanAuthorization(
  credentialFile: string | undefined,
  origin: string,
): string | undefined {
  if (!credentialFile) return undefined
  try {
    const credential = SpoolmanCredential.parse(
      readPrivateJsonFile(credentialFile, { maxBytes: 4096 }),
    )
    return credential.origin === origin
      ? spoolmanAuthorization(credential)
      : undefined
  } catch {
    return undefined
  }
}
