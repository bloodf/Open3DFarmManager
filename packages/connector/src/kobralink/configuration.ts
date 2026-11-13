import { z } from 'zod'

/**
 * Leaf module for KobraLink configuration schemas. It must not import the
 * collector configuration or the runtime, which both depend on it.
 */
export const KOBRALINK_CREDENTIAL_MAX_BYTES = 4096

export const KobraLinkRuntimeBinding = z.strictObject({
  backend: z.literal('kobralink'),
  version: z.literal(2),
  bridgeInstance: z.string().min(1).max(128),
  origin: z.string().min(1).max(2048),
  deviceId: z.string().min(1).max(128),
  id: z
    .string()
    .regex(/^[A-Za-z0-9_-]+$/)
    .max(128),
  printerKey: z.string().min(1).max(128),
  revision: z.number().int().positive(),
  credentialFile: z.string().min(1).max(4096),
})
export type KobraLinkRuntimeBinding = z.infer<typeof KobraLinkRuntimeBinding>

const Credential = z.strictObject({
  version: z.literal(1),
  bridgeInstance: z.string(),
  origin: z.string(),
  deviceId: z.string(),
  id: z.string(),
  printerKey: z.string(),
  revision: z.number().int(),
  name: z.string().min(1).max(128),
  email: z.email().max(254),
  password: z.string().min(8).max(256),
})

/** Validates already-read private credential JSON against its binding. */
export function parseKobraLinkCredential(
  binding: KobraLinkRuntimeBinding,
  input: unknown,
) {
  const credential = Credential.parse(input)
  for (const key of [
    'bridgeInstance',
    'origin',
    'deviceId',
    'id',
    'printerKey',
    'revision',
  ] as const)
    if (credential[key] !== binding[key])
      throw Error('KobraLink credential context mismatch')
  return credential
}
