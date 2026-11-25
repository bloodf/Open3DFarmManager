import { isIPv4 } from 'node:net'
import { z } from 'zod'
import { isLocalFormlabsHost } from '../formlabs/index.ts'
import { photonResinModelSupport } from './models.ts'

export const PHOTON_P1_MAX = 'Anycubic Photon P1 Max'

const LocalOrigin = z
  .string()
  .max(128)
  .refine((value) => {
    try {
      const url = new URL(value)
      return (
        url.protocol === 'http:' &&
        value === url.origin &&
        isIPv4(url.hostname) &&
        isLocalFormlabsHost(url.hostname) &&
        url.port !== '0'
      )
    } catch {
      return false
    }
  }, 'Canonical local IPv4 HTTP origin required')

const Port = z.number().int().min(1).max(65535)

/** Local collector entry (`drivers[]`, collector v8). No secret is stored. */
export const Binding = z.strictObject({
  family: z.literal('anycubic-resin'),
  printerKey: z.string().trim().min(1).max(128),
  /** The configured `/info` endpoint, normally port 18910. */
  origin: LocalOrigin,
  /** Owner-supplied SHA-256 of the broker certificate or of its public key. */
  pinSha256: z.string().regex(/^(?:[a-f0-9]{2}:?){31}[a-f0-9]{2}$/i),
  /** Simulator overrides; `/ctrl` names 8883 and the camera serves on 18088. */
  brokerPort: Port.optional(),
  cameraPort: Port.optional(),
  simulated: z.boolean(),
  expect: z.strictObject({
    serial: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
    model: z.string().superRefine((model, context) => {
      if (model !== PHOTON_P1_MAX)
        context.addIssue({
          code: 'custom',
          message: `No LAN session for ${model}: ${photonResinModelSupport(model).reason}`,
        })
    }),
  }),
})

export type PhotonResinBinding = z.infer<typeof Binding>
