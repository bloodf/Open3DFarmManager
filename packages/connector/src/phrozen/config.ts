import { isIPv4 } from 'node:net'
import { z } from 'zod'
import { isLocalFormlabsHost } from '../formlabs/index.ts'
import { PhrozenModel, PhrozenFirmware } from './index.ts'

const LocalOrigin = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'ws:' &&
        value === url.origin &&
        isIPv4(url.hostname) &&
        isLocalFormlabsHost(url.hostname) &&
        url.port !== '0'
      )
    } catch {
      return false
    }
  }, 'Canonical local IPv4 WebSocket origin required')

export const Binding = z.strictObject({
  family: z.literal('phrozen'),
  printerKey: z.string().trim().min(1).max(128),
  origin: LocalOrigin,
  discoveryPort: z.number().int().min(1).max(65535),
  simulated: z.boolean(),
  expect: z.strictObject({
    id: z.string().min(1).max(128),
    board: z.string().regex(/^[a-f0-9]{1,64}$/i),
    model: z.literal(PhrozenModel),
    firmware: z.enum(PhrozenFirmware),
  }),
})

export type PhrozenBinding = z.input<typeof Binding>

export function parsePhrozenBinding(
  input: unknown,
  allowedOrigins: readonly string[],
) {
  const binding = Binding.parse(input)
  if (!allowedOrigins.includes(binding.origin))
    throw Error('Phrozen origin is not allowlisted')
  return binding
}
