import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { projectVersion } from '@open3dfarmmanager/shared'
import {
  PAIRING_TTL_MS,
  acceptPairingStart,
  formatPairingCode,
  parsePairingResponse,
} from '../../../farm-protocol/src/pairing.ts'
import { PairingProofChallenge } from '../../../farm-protocol/src/pairing-proof.ts'
import { CredentialFile } from '../config/credential.ts'
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
  const length = response.headers.get('content-length')
  if (length !== null && !(Number(length) <= MAX_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Pairing response exceeds size limit')
  }
  return {
    status: response.status,
    async text() {
      const reader = response.body?.getReader()
      if (!reader) return ''
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error('Pairing response exceeds size limit')
        }
        chunks.push(chunk.value)
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      )
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
  if (response.status !== 200)
    // Release the connection; text() is size-capped and cancels the stream past the cap.
    await response.text().catch(() => {})
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

/** Retries transient failures with doubling, capped backoff, never past the deadline. */
async function postRetrying(
  input: PairInput,
  path: string,
  body: object,
  deadline: number,
): Promise<unknown> {
  const sleep = input.sleep ?? defaultSleep
  const now = input.now ?? Date.now
  for (let failures = 0; ; failures++) {
    try {
      return await post(input, path, body)
    } catch (error) {
      const wait = Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS)
      if (
        !(error instanceof TransientError) ||
        failures + 1 >= MAX_TRANSIENT_FAILURES ||
        now() + wait >= deadline
      )
        throw error
      await sleep(wait, input.signal)
      if (input.signal.aborted) throw new Error('Pairing cancelled')
    }
  }
}

/** The proof lives at most 60 s; claim without a current proof is always denied. */
export class PairingProofExpired extends Error {
  constructor() {
    super('Pairing proof expired before approval')
  }
}

/**
 * Checked before any network call so a token is never consumed server-side only
 * to fail locally: final path absent, parent private to us, temp file reserved.
 */
function reserveCredential(path: string) {
  try {
    lstatSync(path)
    throw new Error('Credential file already exists')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const directory = dirname(path)
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o022) !== 0 || stat.uid !== process.getuid?.()))
  )
    throw new Error(
      'Credential directory must be owned and not writable by others',
    )
  const tmp = join(
    directory,
    `.credential-${randomBytes(8).toString('hex')}.tmp`,
  )
  const fd = openSync(
    tmp,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  )
  try {
    // Hardlink support is required at commit; fail now, before the single-use approval.
    linkSync(tmp, tmp + '.probe')
    unlinkSync(tmp + '.probe')
  } catch (error) {
    closeSync(fd)
    for (const name of [tmp, tmp + '.probe']) {
      try {
        unlinkSync(name)
      } catch {}
    }
    throw error
  }
  let open = true
  const close = () => {
    if (open) closeSync(fd)
    open = false
  }
  return {
    /** Atomic and never replaces: link fails with EEXIST; tmp is removed (nlink 1). */
    commit(text: string) {
      const bytes = Buffer.from(text)
      for (let written = 0; written < bytes.length;)
        written += writeSync(fd, bytes, written)
      fsyncSync(fd)
      close()
      linkSync(tmp, path)
      // The credential exists now: cleanup and durability are best effort. A leftover
      // temp file is retried by abort(); nothing here may report a false failure.
      try {
        unlinkSync(tmp)
      } catch {}
      if (process.platform !== 'win32')
        try {
          const dirFd = openSync(directory, 'r')
          try {
            fsyncSync(dirFd)
          } finally {
            closeSync(dirFd)
          }
        } catch {}
    },
    /** Always safe to call: removes the temp file only; a linked credential is kept. */
    abort() {
      close()
      try {
        unlinkSync(tmp)
      } catch {}
    },
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
  const reservation = reserveCredential(input.credentialPath)
  try {
    const start = acceptPairingStart(
      await postRetrying(
        input,
        'start',
        {
          public_key_spki: identity.publicKeySpki,
          platform: process.platform,
          version: projectVersion,
        },
        now() + PAIRING_TTL_MS,
      ),
      identity.fingerprint,
      now(),
    )
    const challenge = PairingProofChallenge.parse(
      await postRetrying(
        input,
        'challenge',
        { device_code: start.device_code },
        start.expires_at,
      ),
    )
    const deadline = Math.min(start.expires_at, challenge.expires_at)
    const signature = identity.signPairingProof({
      challenge,
      expectedOrigin: input.serverOrigin,
      expectedAudience: input.audience,
      now: now(),
    })
    await postRetrying(
      input,
      'proof',
      { device_code: start.device_code, challenge, signature },
      deadline,
    )
    input.onCode({
      userCode: formatPairingCode(start.user_code),
      fingerprint: identity.fingerprint,
    })
    let waitMs = start.poll_interval_s * 1000
    for (;;) {
      await sleep(Math.min(waitMs, Math.max(deadline - now(), 0)), input.signal)
      if (input.signal.aborted) throw new Error('Pairing cancelled')
      if (now() >= deadline) throw new PairingProofExpired()
      const poll = parsePairingResponse(
        JSON.stringify(
          await postRetrying(
            input,
            'claim',
            { device_code: start.device_code },
            deadline,
          ),
        ),
      )
      if (poll.status === 'approved') {
        if (poll.agent_id !== challenge.agent_id)
          throw new Error('Pairing agent mismatch')
        reservation.commit(
          JSON.stringify({
            version: 1,
            expected_fingerprint: identity.fingerprint,
            approval: poll,
          }) + '\n',
        )
        return { expiresAt: poll.expires_at }
      }
      if (poll.status === 'denied') throw new Error('Pairing denied')
      if (poll.status === 'expired') throw new Error('Pairing expired')
      waitMs = Math.max(poll.retry_after_s, start.poll_interval_s) * 1000
    }
  } finally {
    reservation.abort()
  }
}

/** Local metadata only. The device token never leaves the parsed file. */
export function readCredentialStatus(
  path: string,
  fingerprint: string,
  now: number,
) {
  try {
    const { approval, expected_fingerprint } = CredentialFile.parse(
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
