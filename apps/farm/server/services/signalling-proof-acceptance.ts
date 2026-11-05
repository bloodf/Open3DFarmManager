import { CredentialProofCompletion } from '../../../../packages/farm-protocol/src/credential-proof.ts'
import type {
  PostgresConnectorCredentialAcceptance,
  CredentialAcceptanceDecision,
} from '../storage/postgres-connector-credential-acceptance.ts'
const denied = {
  ok: false,
  reason: 'denied',
} satisfies CredentialAcceptanceDecision
function wait(
  milliseconds: number,
  signal: AbortSignal,
  timers: { after(ms: number, callback: () => void): () => void },
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    let cancel = () => {}
    const finish = (ready: boolean) => {
      cancel()
      signal.removeEventListener('abort', aborted)
      resolve(ready)
    }
    const aborted = () => finish(false)
    signal.addEventListener('abort', aborted, { once: true })
    try {
      cancel = timers.after(milliseconds, () => finish(true))
      if (signal.aborted) finish(false)
    } catch (error) {
      signal.removeEventListener('abort', aborted)
      reject(error)
    }
  })
}
/** 0014 throttles completion too. Retry only a definite busy result, with the
 * exact immutable proof, at most twice, inside the original server-owned deadline.
 * Storage uncertainty, expiry or abort never reissues a challenge or retries a commit. */
export async function acceptSignallingProof(input: {
  credentials: Pick<PostgresConnectorCredentialAcceptance, 'accept'>
  request: unknown
  clock: { monotonic(): number }
  timers: { after(ms: number, callback: () => void): () => void }
  deadline: number
  signal: AbortSignal
}): Promise<CredentialAcceptanceDecision> {
  const parsed = CredentialProofCompletion.safeParse(input.request)
  if (!parsed.success || parsed.data.challenge.purpose !== 'signalling')
    return denied
  Object.freeze(parsed.data.challenge)
  Object.freeze(parsed.data)
  let last = input.clock.monotonic()
  const current = () => {
    const now = input.clock.monotonic()
    const valid =
      !input.signal.aborted &&
      Number.isFinite(now) &&
      now >= last &&
      Number.isFinite(input.deadline) &&
      now < input.deadline
    last = now
    return valid
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current()) return denied
      const result = await input.credentials.accept(parsed.data)
      if (!current()) return denied
      if (result.ok || result.reason !== 'busy') return result
      if (
        attempt === 2 ||
        !Number.isSafeInteger(result.retryAfterMs) ||
        result.retryAfterMs < 1 ||
        result.retryAfterMs >= input.deadline - last
      )
        return denied
      if (!(await wait(result.retryAfterMs, input.signal, input.timers)))
        return denied
    }
    return denied
  } catch {
    return { ok: false, reason: 'storage-unavailable' }
  }
}
