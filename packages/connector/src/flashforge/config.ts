import { isIPv4 } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'
import { isLocalFormlabsHost } from '../formlabs/index.ts'

const CredentialValue = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/)

export const FlashforgeBindingSchema = z.strictObject({
  family: z.literal('flashforge'),
  printerKey: z.string().trim().min(1).max(128),
  origin: z
    .string()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value)
        return (
          value === url.origin &&
          url.protocol === 'http:' &&
          url.port !== '' &&
          url.port !== '0' &&
          isIPv4(url.hostname) &&
          isLocalFormlabsHost(url.hostname)
        )
      } catch {
        return false
      }
    }, 'Canonical local IPv4 HTTP origin with explicit port required'),
  credentialFile: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && !path.includes('\0')),
  expect: z.strictObject({
    serialNumber: CredentialValue,
    model: z.enum(['Adventurer 5M', 'Adventurer 5M Pro', 'AD5X']),
  }),
  simulated: z.boolean(),
  /** Local command opt-in, needed together with the `pause.control` entry. */
  control: z.literal(true).optional(),
})
export type FlashforgeBinding = z.infer<typeof FlashforgeBindingSchema>

const Credential = z.strictObject({
  origin: z.string(),
  serialNumber: CredentialValue,
  checkCode: CredentialValue,
})

export function readFlashforgeCredentials(binding: FlashforgeBinding) {
  try {
    const credential = Credential.parse(
      readPrivateJsonFile(binding.credentialFile, { maxBytes: 8192 }),
    )
    if (
      credential.origin !== binding.origin ||
      credential.serialNumber !== binding.expect.serialNumber
    )
      throw new Error()
    return {
      serialNumber: credential.serialNumber,
      checkCode: credential.checkCode,
    }
  } catch {
    throw new Error('Invalid private Flashforge credential')
  }
}
