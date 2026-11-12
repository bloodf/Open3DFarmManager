import {
  closeSync,
  constants,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { canonicalize } from '../../../farm-protocol/src/canonical.ts'
import { parseBoundedJson } from '../../../farm-protocol/src/json.ts'
import {
  RenewalChallenge,
  RenewalIdentity,
  RenewalIntent,
  RenewalRequest,
} from '../../../farm-protocol/src/credential-renewal.ts'
import { PairingProofOrigin } from '../../../farm-protocol/src/pairing-proof.ts'
import {
  CredentialFile,
  readRuntimeCredential,
  type RuntimeCredential,
} from '../config/credential.ts'
import { credentialLookupId } from '../config/signalling.ts'
import type { ConnectorIdentity } from '../identity/store.ts'

const PATH = '/api/connector/credentials/renewal/'
const MAX_RESPONSE_BYTES = 16 * 1024

export type RenewalStep = 'challenge' | 'complete'
/** Throws on transport failure; a returned status is a classified server answer. */
export type RenewalTransport = (
  step: RenewalStep,
  body: unknown,
  signal: AbortSignal,
) => Promise<{ status: number; body: unknown }>

export type RenewalDiagnostic =
  | { kind: 'credential-renewed'; expiresAt: number }
  | { kind: 'credential-renewal-retry'; reason: string; delayMs: number }
  | { kind: 'credential-renewal-expired' }
  // The successor file is in place but its directory entry may not be durable yet.
  | { kind: 'credential-renewal-directory-sync-failed' }

type Signer = Pick<
  ConnectorIdentity,
  'fingerprint' | 'signRenewalProof' | 'signRenewalIntent'
>

/** Exact-origin JSON POST; no redirects, cookies, caching or unbounded bodies. */
export function createRenewalHttpTransport(options: {
  origin: string
  timeoutMs: number
  allowLoopbackHttpForTests?: boolean
}): RenewalTransport {
  const url = new URL(options.origin)
  if (
    url.origin !== options.origin ||
    !(
      url.protocol === 'https:' ||
      (options.allowLoopbackHttpForTests === true &&
        url.protocol === 'http:' &&
        ['127.0.0.1', '[::1]'].includes(url.hostname))
    ) ||
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 60000
  )
    throw new Error('Invalid renewal transport configuration')
  return async (step, body, callerSignal) => {
    const signal = AbortSignal.any([
      callerSignal,
      AbortSignal.timeout(options.timeoutMs),
    ])
    const response = await fetch(url.origin + PATH + step, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
    })
    if (
      !response.body ||
      !/^application\/json(?:\s*;|\s*$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel().catch(() => {})
      throw new Error('Unexpected renewal response')
    }
    const reader = response.body.getReader()
    try {
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES)
          throw new Error('Renewal response too large')
        chunks.push(value)
      }
      return {
        status: response.status,
        body: parseBoundedJson(
          new TextDecoder('utf-8', { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
          {
            maxBytes: MAX_RESPONSE_BYTES,
            maxDepth: 8,
            maxValues: 256,
            maxStringChars: 8192,
          },
        ),
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}

function claims(token: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
  )
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid successor claims')
  return value as Record<string, unknown>
}

/**
 * Validates the envelope in memory, writes a private temp file, fsyncs it and
 * renames it over the target. Returns false only when the final directory fsync
 * failed: the rename already happened, so the new file is in place.
 */
export function writeCredentialFileAtomically(
  path: string,
  value: CredentialFile,
): boolean {
  const data = JSON.stringify(CredentialFile.parse(value))
  const directory = dirname(path)
  const temp = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  const fd = openSync(
    temp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    try {
      // writeFileSync loops until every byte is written (no short writes).
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch {
      // Temp already renamed or removed; the original credential is untouched.
    }
    throw error
  }
  try {
    const dir = openSync(directory, 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
    return true
  } catch {
    return false
  }
}

class SuccessorMismatch extends Error {}

type Outcome =
  | { kind: 'renewed'; credential: RuntimeCredential; directorySynced: boolean }
  | { kind: 'retry'; reason: string }

/**
 * One renewal attempt for the exact current predecessor. The successor is used
 * only after the server returned it from a committed issue or a readback, and it
 * is persisted atomically before the caller learns about it. Any failure leaves
 * the current credential file and in-memory credential untouched.
 */
export async function renewCredentialOnce(input: {
  credentialPath: string
  credential: RuntimeCredential
  identity: Signer
  transport: RenewalTransport
  origin: string
  audience: string
  signal: AbortSignal
  now: () => number
}): Promise<Outcome> {
  const { credential, identity, transport, signal } = input
  const origin = PairingProofOrigin.parse(input.origin)
  const jti = credentialLookupId(credential.device_token)
  const rootJti = credential.root_jti ?? jti
  const predecessor = RenewalIdentity.parse({
    kind: rootJti === jti ? 'root' : 'successor',
    rootJti,
    jti,
    agentId: credential.agent_id,
  })
  async function exchange(mode: 'issue' | 'readback') {
    let request: RenewalRequest
    if (mode === 'issue')
      request = RenewalRequest.parse({
        mode,
        identity: predecessor,
        farmId: credential.farm_id,
        token: credential.device_token,
      })
    else {
      const intent = RenewalIntent.parse({
        v: 1,
        identity: predecessor,
        farmId: credential.farm_id,
        origin,
        audience: input.audience,
      })
      request = RenewalRequest.parse({
        mode,
        intent,
        identitySignature: identity.signRenewalIntent({
          intent,
          expectedOrigin: origin,
          expectedAudience: input.audience,
        }),
      })
    }
    const first = await transport('challenge', request, signal)
    const firstBody = first.body as { kind?: unknown; reason?: unknown } | null
    if (first.status !== 200)
      return first.status === 503 && firstBody?.reason === 'readback-required'
        ? ({ kind: 'readback-required' } as const)
        : ({ kind: 'retry', reason: 'challenge-' + first.status } as const)
    if (firstBody?.kind !== 'challenge')
      return { kind: 'retry', reason: 'challenge-shape' } as const
    const challenge = RenewalChallenge.parse(
      (first.body as { challenge?: unknown }).challenge,
    )
    const signature = identity.signRenewalProof({
      challenge,
      expectedMode: mode,
      expectedIdentity: predecessor,
      expectedFarmId: credential.farm_id,
      expectedOrigin: origin,
      expectedAudience: input.audience,
      now: input.now(),
    })
    const second = await transport(
      'complete',
      { request, challenge, signature },
      signal,
    )
    const body = second.body as {
      kind?: unknown
      identity?: unknown
      childJti?: unknown
      token?: unknown
      expiresAt?: unknown
    } | null
    if (second.status !== 200 || body?.kind !== 'credential')
      return { kind: 'retry', reason: 'complete-' + second.status } as const
    const reservation = challenge.reservation
    if (
      canonicalize(body.identity) !== canonicalize(predecessor) ||
      body.childJti !== reservation.childJti ||
      body.expiresAt !== reservation.expiresAt * 1000 ||
      typeof body.token !== 'string' ||
      credentialLookupId(body.token) !== reservation.childJti ||
      body.expiresAt <= credential.expires_at
    )
      throw new SuccessorMismatch('Successor does not match the reservation')
    const payload = claims(body.token)
    if (
      payload.sub !== credential.agent_id ||
      payload.farm_id !== credential.farm_id ||
      payload.fingerprint !== identity.fingerprint ||
      payload.iss !== reservation.issuer ||
      payload.aud !== reservation.audience ||
      payload.iat !== reservation.issuedAt ||
      payload.exp !== reservation.expiresAt
    )
      throw new SuccessorMismatch('Successor claims do not match')
    return {
      kind: 'credential',
      token: body.token,
      expiresAt: body.expiresAt,
    } as const
  }
  let result = await exchange('issue')
  // A committed successor whose response was lost (crash, timeout, late
  // delivery) is recovered by readback; the server never issues a second one.
  if (result.kind === 'readback-required') result = await exchange('readback')
  if (result.kind === 'readback-required')
    return { kind: 'retry', reason: 'readback-required' }
  if (result.kind !== 'credential') return result
  if (result.expiresAt <= input.now())
    return { kind: 'retry', reason: 'successor-expired' }
  const directorySynced = writeCredentialFileAtomically(input.credentialPath, {
    version: 1,
    expected_fingerprint: credential.expectedFingerprint,
    approval: {
      status: 'approved',
      agent_id: credential.agent_id,
      farm_id: credential.farm_id,
      device_token: result.token,
      expires_at: result.expiresAt,
    },
    root_jti: rootJti,
  })
  // Reload through the same validator the agent uses at startup.
  return {
    kind: 'renewed',
    directorySynced,
    credential: readRuntimeCredential(
      input.credentialPath,
      credential.expectedFingerprint,
      input.now(),
    ),
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    if (signal.aborted) done()
  })
}

/**
 * Renews after 50-75% of the remaining lifetime, retries with jittered bounded
 * exponential backoff, and stops (fail closed) at the current hard expiry.
 * onRenewed is called only with a persisted, server-confirmed successor.
 */
export async function runCredentialRenewal(input: {
  credentialPath: string
  credential: RuntimeCredential
  identity: Signer
  transport: RenewalTransport
  origin: string
  audience: string
  retryMinMs: number
  retryMaxMs: number
  signal: AbortSignal
  onRenewed: (credential: RuntimeCredential) => void
  onDiagnostic?: (value: RenewalDiagnostic) => void
  now?: () => number
  random?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<void> {
  const now = input.now ?? Date.now
  const random = input.random ?? Math.random
  const sleep = input.sleep ?? wait
  let current = input.credential
  const schedule = () => {
    const t = now()
    return t + Math.floor((current.expires_at - t) * (0.5 + 0.25 * random()))
  }
  let at = schedule()
  let backoff = input.retryMinMs
  while (!input.signal.aborted) {
    const t = now()
    if (t >= current.expires_at) {
      input.onDiagnostic?.({ kind: 'credential-renewal-expired' })
      return
    }
    if (t < at) {
      await sleep(Math.min(at, current.expires_at) - t, input.signal)
      continue
    }
    let outcome: Outcome
    try {
      outcome = await renewCredentialOnce({
        ...input,
        credential: current,
        now,
      })
    } catch (error) {
      outcome = {
        kind: 'retry',
        reason:
          error instanceof SuccessorMismatch ? 'successor-mismatch' : 'failed',
      }
    }
    if (input.signal.aborted) return
    if (outcome.kind === 'renewed') {
      current = outcome.credential
      backoff = input.retryMinMs
      at = schedule()
      if (!outcome.directorySynced)
        input.onDiagnostic?.({
          kind: 'credential-renewal-directory-sync-failed',
        })
      input.onDiagnostic?.({
        kind: 'credential-renewed',
        expiresAt: current.expires_at,
      })
      input.onRenewed(current)
      continue
    }
    const delayMs =
      input.retryMinMs + Math.floor(random() * (backoff - input.retryMinMs + 1))
    backoff = Math.min(input.retryMaxMs, backoff * 2)
    at = now() + delayMs
    input.onDiagnostic?.({
      kind: 'credential-renewal-retry',
      reason: outcome.reason,
      delayMs,
    })
  }
}
