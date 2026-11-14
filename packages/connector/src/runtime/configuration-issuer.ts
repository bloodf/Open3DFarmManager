import { z } from 'zod'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import { CONFIGURATION_PROTOCOL } from '../../../farm-protocol/src/configuration-common.ts'
import { PairingProofAudience } from '../../../farm-protocol/src/pairing-proof.ts'

/**
 * Trusted config-v1 capability issuer key, fetched only from the enrolled farm
 * origin over HTTPS (`GET /api/configuration-authority/issuer`). The public
 * endpoint takes no query, credential or Bearer header and answers exactly the
 * metadata DTO below; trust comes from TLS to the pinned origin plus an exact
 * origin match, never from the response alone. Neither the browser nor a
 * signalling frame can supply or replace it.
 */
const IssuerKid = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)
export const ConfigurationIssuerMetadata = z.strictObject({
  protocol: z.literal(CONFIGURATION_PROTOCOL),
  issuerKid: IssuerKid,
  origin: z.string().min(1).max(2048),
  audience: PairingProofAudience,
  publicKeyJwk: z.strictObject({
    kty: z.literal('OKP'),
    crv: z.literal('Ed25519'),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
})

export interface TrustedConfigurationIssuer {
  readonly kid: string
  readonly origin: string
  readonly audience: string
  readonly key: CryptoKey
}

export type IssuerFetch = (url: string, init: RequestInit) => Promise<Response>

export interface IssuerSourceOptions {
  farmOrigin: string
  fetch?: IssuerFetch
  timeoutMs?: number
  /** Minimum interval between refreshes triggered by an unknown kid. */
  refreshIntervalMs?: number
  clock?: () => number
}

const MAX_BYTES = 4096

async function readBounded(response: Response): Promise<unknown> {
  if (
    response.status !== 200 ||
    !/^application\/json(?:\s*;|\s*$)/i.test(
      response.headers.get('content-type') ?? '',
    ) ||
    !response.body
  )
    throw new Error('Issuer metadata unavailable')
  const reader = response.body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_BYTES) throw new Error('Issuer metadata too large')
      chunks.push(value)
    }
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: MAX_BYTES, maxDepth: 3, maxValues: 16, maxStringChars: 2048 },
    )
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

/** Validates metadata against the locally pinned farm origin and imports the key. */
export async function trustedIssuerFromMetadata(
  input: unknown,
  farmOrigin: string,
): Promise<TrustedConfigurationIssuer> {
  const metadata = ConfigurationIssuerMetadata.parse(input)
  if (metadata.origin !== farmOrigin)
    throw new Error('Issuer metadata origin mismatch')
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...metadata.publicKeyJwk },
    { name: 'Ed25519' },
    false,
    ['verify'],
  )
  if (key.type !== 'public' || key.algorithm.name !== 'Ed25519')
    throw new Error('Issuer key must be Ed25519')
  return Object.freeze({
    kid: metadata.issuerKid,
    origin: metadata.origin,
    audience: metadata.audience,
    key,
  })
}

/**
 * Cached issuer source. A capability with an unknown kid triggers at most one
 * rate-limited refresh (key rotation); failure keeps configuration closed.
 */
export function createConfigurationIssuerSource(options: IssuerSourceOptions) {
  const farmOrigin = new URL(options.farmOrigin)
  if (
    farmOrigin.protocol !== 'https:' ||
    farmOrigin.origin !== options.farmOrigin
  )
    throw new Error('Issuer source requires the enrolled HTTPS farm origin')
  const endpoint = farmOrigin.origin + '/api/configuration-authority/issuer'
  const transport = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 5000
  const interval = options.refreshIntervalMs ?? 30_000
  const clock = options.clock ?? Date.now
  let current: TrustedConfigurationIssuer | null = null
  let lastAttempt = Number.NEGATIVE_INFINITY
  let inflight: Promise<TrustedConfigurationIssuer | null> | null = null

  async function load(): Promise<TrustedConfigurationIssuer | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await transport(endpoint, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller.signal,
        headers: { accept: 'application/json' },
      })
      current = await trustedIssuerFromMetadata(
        await readBounded(response),
        farmOrigin.origin,
      )
      return current
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  function refresh(): Promise<TrustedConfigurationIssuer | null> {
    if (inflight) return inflight
    lastAttempt = clock()
    inflight = load().finally(() => {
      inflight = null
    })
    return inflight
  }

  return Object.freeze({
    /** Issuer for `kid`, refreshing once (rate limited) for rotation. */
    async forKid(kid: string): Promise<TrustedConfigurationIssuer | null> {
      if (current?.kid === kid) return current
      if (clock() - lastAttempt < interval) return null
      const loaded = await refresh()
      return loaded?.kid === kid ? loaded : null
    },
    current: () => current,
    refresh,
  })
}
export type ConfigurationIssuerSource = ReturnType<
  typeof createConfigurationIssuerSource
>

/** Fixed issuer source for synthetic tests and pinned local operation. */
export function fixedConfigurationIssuer(
  issuer: TrustedConfigurationIssuer,
): ConfigurationIssuerSource {
  return Object.freeze({
    forKid: async (kid: string) => (kid === issuer.kid ? issuer : null),
    current: () => issuer,
    refresh: async () => issuer,
  })
}
