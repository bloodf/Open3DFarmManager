import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'
import { isLocalFormlabsHost } from '../formlabs/index.ts'
import { QIDI_MODELS } from './profiles.ts'

const Key = z.string().trim().min(1).max(128)
const LocalOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    const url = URL.parse(value)
    return (
      url !== null &&
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin === value &&
      url.port !== '0' &&
      isLocalFormlabsHost(url.hostname.replace(/^\[|\]$/g, ''))
    )
  }, 'Canonical local HTTP origin required')

export const Binding = z.strictObject({
  family: z.literal('qidi'),
  printerKey: Key,
  origin: LocalOrigin,
  simulated: z.boolean(),
  expect: z.strictObject({
    model: z.enum(QIDI_MODELS).optional(),
    firmware: Key.optional(),
    moonrakerVersion: Key,
  }),
  auth: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('trusted-lan') }),
    z.strictObject({
      kind: z.enum(['api-key', 'bearer']),
      credentialFile: z
        .string()
        .max(4096)
        .refine((path) => isAbsolute(path) && !path.includes('\0')),
    }),
  ]),
})
export type QidiBinding = z.infer<typeof Binding>

export function parseQidiBinding(
  input: unknown,
  allowedOrigins: readonly string[],
) {
  const binding = Binding.parse(input)
  if (!allowedOrigins.includes(binding.origin))
    throw Error('Qidi origin not allowlisted')
  return binding
}

const Credential = z.strictObject({
  origin: LocalOrigin,
  secret: z.string().regex(/^[!-~]{1,256}$/),
})

export function readQidiAuth(binding: QidiBinding) {
  if (binding.auth.kind === 'trusted-lan') return undefined
  try {
    const credential = Credential.parse(
      readPrivateJsonFile(binding.auth.credentialFile, { maxBytes: 8192 }),
    )
    if (credential.origin !== binding.origin) throw Error()
    return binding.auth.kind === 'api-key'
      ? { apiKey: credential.secret }
      : { bearerToken: credential.secret }
  } catch {
    throw Error('Invalid private Qidi credential')
  }
}
