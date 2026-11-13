import { z } from 'zod'
import { readPrivateJsonFile } from '../config/local.ts'
import {
  createKobraLinkClient,
  type KobraLinkOptions,
  type PrinterObservation,
} from './client.ts'

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

/** Read-only polling. No signup, reconnect, provisioning or printer commands. */
export function createKobraLinkRuntimeSubscription(input: {
  binding: KobraLinkRuntimeBinding
  allowedOrigins: readonly string[]
  signal: AbortSignal
  fetch?: KobraLinkOptions['fetch']
  onStatus: (status: PrinterObservation) => void
  onUnavailable: () => void
}) {
  const binding = KobraLinkRuntimeBinding.parse(input.binding)
  const controller = new AbortController()
  const signal = AbortSignal.any([input.signal, controller.signal])
  const client = createKobraLinkClient({
    signal,
    origin: binding.origin,
    allowedOrigins: input.allowedOrigins,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  })
  const credential = readKobraLinkCredential(binding)
  const close = () => {
    controller.abort()
    client.clearSession()
  }
  const done = (async () => {
    let authenticated = false
    let delay = 1000
    try {
      while (!signal.aborted) {
        try {
          if (!authenticated) {
            await client.authenticate({
              ownership: 'fresh_owned',
              mode: 'signin',
              name: credential.name,
              email: credential.email,
              password: credential.password,
            })
            authenticated = true
          }
          if (signal.aborted) break
          const status = await client.getPrinterObservation({
            id: binding.id,
            deviceId: binding.deviceId,
          })
          if (signal.aborted) break
          input.onStatus(status)
          delay = 1000
        } catch (error) {
          if (signal.aborted) break
          input.onUnavailable()
          client.clearSession()
          authenticated = false
          if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'identity_changed'
          )
            break
          delay = Math.min(delay * 2, 30000)
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            signal.removeEventListener('abort', finish)
            resolve()
          }
          const timer = setTimeout(finish, delay)
          signal.addEventListener('abort', finish, { once: true })
          if (signal.aborted) finish()
        })
      }
    } finally {
      client.clearSession()
    }
  })()
  return { done, close }
}

export function readKobraLinkCredential(binding: KobraLinkRuntimeBinding) {
  const credential = Credential.parse(
    readPrivateJsonFile(binding.credentialFile, { maxBytes: 4096 }),
  )
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
