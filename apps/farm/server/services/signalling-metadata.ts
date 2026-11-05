import { z } from 'zod'
import type { RequestEvent } from 'nuxt/server'
import {
  PairingProofOrigin,
  PairingProofAudience,
} from '../../../../packages/farm-protocol/src/pairing-proof.ts'

const EnabledMetadata = z.strictObject({
  enabled: z.literal(true),
  origin: PairingProofOrigin.refine((value) => value.startsWith('https://')),
  audience: PairingProofAudience,
})
export const SignallingMetadata = z.discriminatedUnion('enabled', [
  z.strictObject({
    enabled: z.literal(false),
    origin: z.null(),
    audience: z.null(),
  }),
  EnabledMetadata,
])
export type SignallingMetadata = Readonly<z.infer<typeof SignallingMetadata>>
export type EnabledSignallingMetadata = Readonly<
  z.infer<typeof EnabledMetadata>
>
export const DISABLED_SIGNALLING_METADATA: SignallingMetadata = Object.freeze({
  enabled: false,
  origin: null,
  audience: null,
})
/** Validates public fields only; this does not publish readiness or grant authority. */
export function validatedSignallingMetadata(config: {
  origin: string
  audience: string
}): EnabledSignallingMetadata {
  return Object.freeze(
    EnabledMetadata.parse({
      enabled: true,
      origin: config.origin,
      audience: config.audience,
    }),
  )
}
/** Use a portable Nuxt response directly, without H3 response-header aliases. */
export function signallingMetadataResponse(
  event: Pick<RequestEvent, 'res'>,
  metadata: SignallingMetadata,
): SignallingMetadata {
  event.res.headers.set('Cache-Control', 'no-store')
  event.res.headers.set('Pragma', 'no-cache')
  return Object.freeze(SignallingMetadata.parse(metadata))
}
