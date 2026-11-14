import { readPrivateJsonFile } from '../config/local.ts'
import {
  KOBRALINK_CREDENTIAL_MAX_BYTES,
  KobraLinkRuntimeBinding,
  parseKobraLinkCredential,
} from './configuration.ts'
import {
  createKobraLinkClient,
  type KobraLinkOptions,
  type PrinterObservation,
} from './client.ts'

export { KobraLinkRuntimeBinding }

/** Poll telemetry and recover only explicitly transient disconnected sessions. */
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
    let reconnectDelay = 30_000
    let reconnectAt: number | undefined
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
          if (status.availability === 'available') {
            reconnectDelay = 30_000
            reconnectAt = undefined
          } else if (status.connectionReason) {
            const now = performance.now()
            reconnectAt ??= now + reconnectDelay
            if (now >= reconnectAt && !signal.aborted) {
              // Reserve the next slot before awaiting, including failed attempts.
              reconnectDelay = Math.min(reconnectDelay * 2, 300_000)
              reconnectAt = now + reconnectDelay
              await client.reconnect({
                id: binding.id,
                deviceId: binding.deviceId,
              })
            }
          }
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
  return parseKobraLinkCredential(
    binding,
    readPrivateJsonFile(binding.credentialFile, {
      maxBytes: KOBRALINK_CREDENTIAL_MAX_BYTES,
    }),
  )
}
