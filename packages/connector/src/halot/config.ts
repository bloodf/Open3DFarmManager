import { isIPv4 } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { readPrivateJsonFile } from '../config/private-json.ts'
import { isLocalFormlabsHost } from '../formlabs/index.ts'
import { HALOT_MODEL_NAMES } from './models.ts'
import { HALOT_PASSWORD } from './token.ts'

/** Set-up is by address: no source gives the HALOT discovery datagram. */
const LocalOrigin = z
  .string()
  .max(128)
  .refine((value) => {
    const url = URL.parse(value)
    return (
      url !== null &&
      url.protocol === 'ws:' &&
      value === url.origin &&
      isIPv4(url.hostname) &&
      isLocalFormlabsHost(url.hostname) &&
      url.port !== '0'
    )
  }, 'Canonical local IPv4 WebSocket origin required')

export const Binding = z.strictObject({
  family: z.literal('halot'),
  printerKey: z.string().trim().min(1).max(128),
  /** `ws://<ip>:18188` on a printer. */
  origin: LocalOrigin,
  /** Private JSON `{ origin, password }` with the printer's network password. */
  passwordFile: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && !path.includes('\0')),
  simulated: z.boolean(),
  /** Declared by the owner: no HALOT reply names the model. */
  expect: z.strictObject({ model: z.enum(HALOT_MODEL_NAMES) }),
})

export type HalotBinding = z.infer<typeof Binding>

export function parseHalotBinding(
  input: unknown,
  allowedOrigins: readonly string[],
) {
  const binding = Binding.parse(input)
  if (!allowedOrigins.includes(binding.origin))
    throw Error('HALOT origin is not allowlisted')
  return binding
}

const Credential = z.strictObject({
  origin: LocalOrigin,
  password: z.string().regex(HALOT_PASSWORD),
})

/** Never include the file's content in an error. */
export function readHalotPassword(binding: HalotBinding): string {
  try {
    const credential = Credential.parse(
      readPrivateJsonFile(binding.passwordFile, { maxBytes: 8192 }),
    )
    if (credential.origin !== binding.origin) throw Error()
    return credential.password
  } catch {
    throw Error('Invalid private HALOT password file')
  }
}
