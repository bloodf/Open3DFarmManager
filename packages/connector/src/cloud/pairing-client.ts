import { closeSync, fsyncSync, openSync, writeSync, constants } from 'node:fs'
import { z } from 'zod'
import { projectVersion } from '@open3dfarmmanager/shared'
import {
  PairingPollResponse,
  PairingStartResponse,
  acceptPairingStart,
  formatPairingCode,
  parsePairingResponse,
} from '../../../farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../../farm-protocol/src/pairing-proof.ts'
import { readPrivateJsonFile } from '../config/local.ts'
import type { ConnectorIdentity } from '../identity/store.ts'

const MAX_RESPONSE_BYTES = 12_288
const REQUEST_TIMEOUT_MS = 10_000
const MAX_TRANSIENT_FAILURES = 5
const MAX_BACKOFF_MS = 30_000

export type PairingFetch = (
  url: string,
  init: {
    method: 'POST'
    headers: Record<string, string>
    body: string
    signal: AbortSignal
  },
) => Promise<{ status: number; text(): Promise<string> }>

export interface PairInput {
  serverOrigin: string
  audience: string
  identity: ConnectorIdentity
  credentialPath: string
  signal: AbortSignal
  fetch?: PairingFetch
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Called once, before any approval wait, so the user can compare in the browser. */
  onCode: (code: { userCode: string; fingerprint: string }) => void
}

class TransientError extends Error {}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
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

const defaultFetch: PairingFetch = async (url, init) => {
  const response = await fetch(url, { ...init, redirect: 'error' })
  return {
    status: response.status,
    async text() {
      const text = await response.text()
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
        throw new Error('Pairing response exceeds size limit')
      return text
    },
  }
}

/** Reads one bounded JSON response. 429/5xx and network faults are retryable. */
async function post(
  input: PairInput,
  path: string,
  body: object,
): Promise<unknown> {
  const send = input.fetch ?? defaultFetch
  let response
  try {
    response = await send(
      `${input.serverOrigin}/api/connector-pairing/${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          input.signal,
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
      },
    )
  } catch {
    if (input.signal.aborted) throw new Error('Pairing cancelled')
    throw new TransientError('Pairing request failed')
  }
  if (response.status === 429 || response.status >= 500)
    throw new TransientError('Pairing server unavailable')
  if (response.status !== 200) throw new Error('Pairing request rejected')
  let text: string
  try {
    text = await response.text()
    return JSON.parse(text)
  } catch {
    throw new Error('Invalid pairing response')
  }
}

/** Retries transient failures with doubling, capped backoff; never retries rejections. */
async function postRetrying(
  input: PairInput,
  path: string,
  body: object,
): Promise<unknown> {
  const sleep = input.sleep ?? defaultSleep
  for (let failures = 0; ; failures++) {
    try {
      return await post(input, path, body)
    } catch (error) {
      if (
        !(error instanceof TransientError) ||
        failures + 1 >= MAX_TRANSIENT_FAILURES
      )
        throw error
      await sleep(Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS), input.signal)
      if (input.signal.aborted) throw new Error('Pairing cancelled')
    }
  }
}

/** Never overwrites: a credential for another pairing must be removed deliberately. */
function writeCredential(
  path: string,
  fingerprint: string,
  approval: PairingPollResponse,
) {
  const text =
    JSON.stringify({
      version: 1,
      expected_fingerprint: fingerprint,
      approval,
    }) + '\n'
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * start -> proof of key possession -> wait for browser approval -> claim.
 * The server requires a verified proof before approval and before delivery, and a
 * proof lives at most 60 seconds, so the user must approve promptly after the code
 * is shown. Resolves with the credential expiry; the token is only written to disk.
 */
export async function pairConnector(
  input: PairInput,
): Promise<{ expiresAt: number }> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? defaultSleep
  const { identity } = input
  const start = acceptPairingStart(
    await postRetrying(input, 'start', {
      public_key_spki: identity.publicKeySpki,
      platform: process.platform,
      version: projectVersion,
    }),
    identity.fingerprint,
    now(),
  )
  const challenge = PairingProofChallenge.parse(
    await postRetrying(input, 'challenge', { device_code: start.device_code }),
  )
  const signature = identity.signPairingProof({
    challenge,
    expectedOrigin: input.serverOrigin,
    expectedAudience: input.audience,
    now: now(),
  })
  await postRetrying(input, 'proof', {
    device_code: start.device_code,
    challenge,
    signature,
  })
  input.onCode({
    userCode: formatPairingCode(start.user_code),
    fingerprint: identity.fingerprint,
  })
  let waitMs = start.poll_interval_s * 1000
  while (now() < start.expires_at) {
    await sleep(waitMs, input.signal)
    if (input.signal.aborted) throw new Error('Pairing cancelled')
    const poll = parsePairingResponse(
      JSON.stringify(
        await postRetrying(input, 'claim', { device_code: start.device_code }),
      ),
    )
    if (poll.status === 'approved') {
      writeCredential(input.credentialPath, identity.fingerprint, poll)
      return { expiresAt: poll.expires_at }
    }
    if (poll.status === 'denied') throw new Error('Pairing denied')
    if (poll.status === 'expired') throw new Error('Pairing expired')
    waitMs = Math.max(poll.retry_after_s, start.poll_interval_s) * 1000
  }
  throw new Error('Pairing timed out')
}

const StoredCredential = z.strictObject({
  version: z.literal(1),
  expected_fingerprint: PairingStartResponse.shape.fingerprint,
  approval: PairingPollResponse,
})

/** Local metadata only. The device token never leaves the parsed file. */
export function readCredentialStatus(
  path: string,
  fingerprint: string,
  now: number,
) {
  try {
    const { approval, expected_fingerprint } = StoredCredential.parse(
      readPrivateJsonFile(path, { maxBytes: 16 * 1024, maxStringChars: 8192 }),
    )
    if (approval.status !== 'approved') return { present: true, valid: false }
    return {
      present: true,
      valid: expected_fingerprint === fingerprint && approval.expires_at > now,
      fingerprintMatches: expected_fingerprint === fingerprint,
      expired: approval.expires_at <= now,
      expiresAt: new Date(approval.expires_at).toISOString(),
      agentId: approval.agent_id,
      farmId: approval.farm_id,
    }
  } catch (error) {
    return {
      present: (error as NodeJS.ErrnoException).code !== 'ENOENT',
      valid: false,
    }
  }
}
