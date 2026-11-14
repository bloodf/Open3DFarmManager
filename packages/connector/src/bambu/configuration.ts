import { isIP } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'

const host = z.string().refine((value) => {
  if (isIP(value) !== 4) return false
  const parts = value.split('.').map(Number)
  return parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
})
const endpoint = z.strictObject({ host, port: z.number().int().min(1).max(65535).default(8883) })
const path = z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'))
const schema = endpoint.extend({
  printerKey: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u),
  serial: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  credentialFile: path,
  caFile: path.optional(),
  pinSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  allowedEndpoints: z.array(endpoint).min(1).max(128),
})
export function parseBambuBinding(input: unknown) {
  const result = schema.safeParse(input)
  if (!result.success) throw new Error('Invalid Bambu binding')
  const { allowedEndpoints, ...binding } = result.data
  if (!allowedEndpoints.some((entry) => entry.host === binding.host && entry.port === binding.port))
    throw new Error('Bambu endpoint is not allowlisted')
  if (!binding.caFile && !binding.pinSha256) throw new Error('Bambu TLS trust is required')
  return Object.freeze(binding)
}
export type BambuBinding = ReturnType<typeof parseBambuBinding>
