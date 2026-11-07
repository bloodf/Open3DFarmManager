import { z } from 'zod'
import { parseBoundedJson } from '../../../../../packages/farm-protocol/src/json.ts'
import { MAX_CONTROL_PROOF_WIRE_BYTES } from '../../../../../packages/farm-protocol/src/control-session-binding.ts'
import {
  MAX_PAUSE_ADMISSION_WIRE_BYTES,
  PauseAdmissionChallenge,
  SignedPauseCapabilityV1,
} from '../../../../../packages/farm-protocol/src/pause-capability.ts'
import type { PauseCommandIssuer } from './pause-command-client.ts'

/**
 * Production browser HTTP adapter of the pause command issuer.
 *
 * It speaks the two maintained same-origin pause authority routes and nothing
 * else: no discovery, no alternate URL, no fallback route, no custom
 * authorization header and no automatic retry. Every authority decision stays
 * with the Connector and the issuer service. This adapter only delivers the
 * maintained request shapes and returns the validated challenge or capability.
 */

/** The only maintained pause authority routes of the browser application. */
const CHALLENGES_PATH = '/api/pause-authority/challenges'
const CAPABILITIES_PATH = '/api/pause-authority/capabilities'

/** One non renewable deadline per request, armed before the fetch starts. */
const REQUEST_TIMEOUT_MS = 2_000
/** Upper bound of a maintained pause authority response body. */
const MAX_RESPONSE_BYTES = 16_384
// Allows one-byte fragmentation while bounding empty-chunk work as well.
const MAX_RESPONSE_CHUNKS = MAX_RESPONSE_BYTES
/** Maintained outer body limits of the two maintained routes. */
const CHALLENGE_REQUEST_LIMIT_BYTES = 102_400
const CAPABILITY_REQUEST_LIMIT_BYTES = 51_200

const RESPONSE_JSON_LIMITS = Object.freeze({
  maxBytes: MAX_RESPONSE_BYTES,
  maxDepth: 6,
  maxValues: 128,
  maxStringChars: 8_192,
})

/** The maintained request shapes of the two routes. Nothing else is sent. */
const ChallengeRequest = z.strictObject({
  browserProofWire: boundedWire(MAX_CONTROL_PROOF_WIRE_BYTES),
  connectorProofWire: boundedWire(MAX_CONTROL_PROOF_WIRE_BYTES),
  admissionNonce: PauseAdmissionChallenge.shape.admission_nonce,
})
const CapabilityRequest = z.strictObject({
  admissionProofWire: boundedWire(MAX_PAUSE_ADMISSION_WIRE_BYTES),
})

function boundedWire(limit: number) {
  return z
    .string()
    .max(limit)
    .refine((wire) => new TextEncoder().encode(wire).byteLength <= limit)
}

/** The maintained response envelopes. Unknown fields are rejected. */
const ChallengeEnvelope = z.strictObject({ challenge: PauseAdmissionChallenge })
const CapabilityEnvelope = z.strictObject({
  capability: SignedPauseCapabilityV1,
})

const ABORTED_MESSAGE = 'Pause issuer request was cancelled.'
const TIMEOUT_MESSAGE =
  'Pause issuer request timed out. The issuance state is unknown.'
const REQUEST_MESSAGE = 'Pause issuer request failed.'

export type PauseCommandIssuerFailure =
  'aborted' | 'timeout' | 'origin' | 'request' | 'response' | 'status'

/** Every failure of this adapter is closed and carries its reason. */
export class PauseCommandIssuerError extends Error {
  readonly reason: PauseCommandIssuerFailure
  constructor(reason: PauseCommandIssuerFailure, message: string) {
    super(message)
    this.name = 'PauseCommandIssuerError'
    this.reason = reason
  }
}

export type PauseCommandIssuerOptions = Readonly<{
  /** Injected transport for deterministic tests. It defaults to the page fetch. */
  fetch?: typeof globalThis.fetch
  /** Injected current origin for deterministic tests. */
  currentOrigin?: string
}>

type IssuerFetch = (input: string, init: RequestInit) => Promise<Response>

function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as AbortSignal
  return (
    typeof candidate.aborted === 'boolean' &&
    typeof candidate.addEventListener === 'function'
  )
}

/** The origin of the current page, when the runtime exposes one. */
function pageOrigin(): string | undefined {
  const scope = globalThis as unknown as { location?: { origin?: unknown } }
  const origin = scope.location?.origin
  return typeof origin === 'string' && origin.length > 0 ? origin : undefined
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => {})
  } catch {
    // An already cancelled or errored stream needs no further disposal.
  }
}

/** Releases a response body without reading it. Best effort by design. */
function disposeResponse(response: Response): void {
  try {
    if (!response.body) return
    const reader = response.body.getReader()
    cancelReader(reader)
    try {
      reader.releaseLock()
    } catch {
      // The lock is already released.
    }
  } catch {
    // Disposal never changes the reported failure.
  }
}

function encodeBody(value: unknown, limitBytes: number): string {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (typeof json !== 'string')
    throw new PauseCommandIssuerError(
      'request',
      'Pause issuer request is not serializable.',
    )
  if (new TextEncoder().encode(json).byteLength > limitBytes)
    throw new PauseCommandIssuerError(
      'request',
      'Pause issuer request exceeds the maintained body limit.',
    )
  return json
}

/**
 * The production adapter of the pause command issuer.
 *
 * The factory is inert: it performs no request, creates no key and touches no
 * session. Every network activity starts with an explicit challenge or
 * capability call.
 */
export function createPauseCommandIssuer(
  options: PauseCommandIssuerOptions = {},
): PauseCommandIssuer {
  /** The current origin must be the origin of the page itself. */
  function resolveOrigin(): string {
    const current = pageOrigin()
    const candidate = options.currentOrigin ?? current
    if (typeof candidate !== 'string' || candidate.length === 0)
      throw new PauseCommandIssuerError(
        'origin',
        'Pause issuer origin is unavailable.',
      )
    let url: URL
    try {
      url = new URL(candidate)
    } catch {
      throw new PauseCommandIssuerError(
        'origin',
        'Pause issuer origin is not an absolute URL.',
      )
    }
    if (url.protocol !== 'https:' || url.origin !== candidate)
      throw new PauseCommandIssuerError(
        'origin',
        'Pause issuer origin must be the current plain HTTPS origin.',
      )
    if (current !== undefined && current !== candidate)
      throw new PauseCommandIssuerError(
        'origin',
        'Pause issuer origin is not the current page origin.',
      )
    return candidate
  }

  /** The maintained route of the current origin, and nothing else. */
  function destination(origin: string, path: string): string {
    const url = new URL(path, origin)
    if (
      url.origin !== origin ||
      url.pathname !== path ||
      url.search !== '' ||
      url.hash !== ''
    )
      throw new PauseCommandIssuerError(
        'origin',
        'Pause issuer destination is not a maintained route.',
      )
    return url.href
  }

  function transport(): IssuerFetch {
    const injected = options.fetch
    if (injected !== undefined) {
      if (typeof injected !== 'function')
        throw new PauseCommandIssuerError(
          'request',
          'Pause issuer transport is not callable.',
        )
      return (input, init) => injected(input, init)
    }
    if (typeof globalThis.fetch !== 'function')
      throw new PauseCommandIssuerError(
        'request',
        'Pause issuer transport is unavailable.',
      )
    // The call keeps the global object as its receiver, as the platform
    // requires of the page fetch.
    return (input, init) => globalThis.fetch(input, init)
  }

  async function post<T>(input: {
    path: string
    body: unknown
    limitBytes: number
    signal: AbortSignal
    parse: (value: unknown) => T
  }): Promise<T> {
    const caller = input.signal
    if (!isAbortSignal(caller))
      throw new PauseCommandIssuerError(
        'aborted',
        'Pause issuer requires a caller abort signal.',
      )
    if (caller.aborted)
      throw new PauseCommandIssuerError('aborted', ABORTED_MESSAGE)
    const origin = resolveOrigin()
    const url = destination(origin, input.path)
    const body = encodeBody(input.body, input.limitBytes)

    const controller = new AbortController()
    const combined = AbortSignal.any([caller, controller.signal])
    const deadline = performance.now() + REQUEST_TIMEOUT_MS
    let failure: 'timeout' | 'aborted' | undefined
    /** True once the adapter stopped waiting for this request. */
    let abandoned = false

    let interruptAbort = () => {}
    const interrupt = new Promise<never>((_, reject) => {
      const fail = () => {
        failure ??= 'aborted'
        reject(
          new PauseCommandIssuerError(
            failure,
            failure === 'timeout' ? TIMEOUT_MESSAGE : ABORTED_MESSAGE,
          ),
        )
      }
      combined.addEventListener('abort', fail, { once: true })
      interruptAbort = fail
    })
    // The race below consumes the rejection. This keeps an unused rejection
    // from being reported as an unhandled one.
    void interrupt.catch(() => {})

    // The single deadline of this request. It is never renewed.
    const timer = setTimeout(() => {
      failure ??= 'timeout'
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    const guard = (): void => {
      if (caller.aborted) failure ??= 'aborted'
      if (performance.now() >= deadline) failure ??= 'timeout'
      if (failure)
        throw new PauseCommandIssuerError(
          failure,
          failure === 'timeout' ? TIMEOUT_MESSAGE : ABORTED_MESSAGE,
        )
    }
    const classify = (error: unknown): PauseCommandIssuerError => {
      if (error instanceof PauseCommandIssuerError) return error
      if (failure === 'timeout')
        return new PauseCommandIssuerError('timeout', TIMEOUT_MESSAGE)
      if (failure === 'aborted' || caller.aborted)
        return new PauseCommandIssuerError('aborted', ABORTED_MESSAGE)
      return new PauseCommandIssuerError('request', REQUEST_MESSAGE)
    }

    let response: Response | undefined
    try {
      let pending: Promise<Response>
      try {
        pending = transport()(url, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body,
          signal: combined,
        })
      } catch (error) {
        abandoned = true
        throw classify(error)
      }
      void pending.catch(() => {})
      // A response that arrives after the adapter gave up is disposed, never
      // delivered and never interpreted.
      void pending.then(
        (late) => {
          if (abandoned) void disposeResponse(late)
        },
        () => {},
      )
      try {
        response = await Promise.race([pending, interrupt])
      } catch (error) {
        abandoned = true
        throw classify(error)
      }

      guard()
      if (response.redirected || response.type === 'opaque')
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response was redirected or is opaque.',
        )
      if (response.status !== 200)
        throw new PauseCommandIssuerError(
          'status',
          `Pause issuer rejected the request with status ${response.status}.`,
        )
      if (!response.body)
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response has no body.',
        )
      const text = await readBody(response.body, guard, combined)
      let parsed: unknown
      try {
        parsed = parseBoundedJson(text, RESPONSE_JSON_LIMITS)
      } catch {
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response is not bounded JSON.',
        )
      }
      try {
        return input.parse(parsed)
      } catch {
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response does not match the maintained envelope.',
        )
      }
    } catch (error) {
      abandoned = true
      if (response) disposeResponse(response)
      throw classify(error)
    } finally {
      clearTimeout(timer)
      combined.removeEventListener('abort', interruptAbort)
    }
  }

  return Object.freeze({
    async challenge(input): Promise<PauseAdmissionChallenge> {
      const parsed = ChallengeRequest.safeParse({
        browserProofWire: input.browserProofWire,
        connectorProofWire: input.connectorProofWire,
        admissionNonce: input.admissionNonce,
      })
      if (!parsed.success)
        throw new PauseCommandIssuerError(
          'request',
          'Pause issuer challenge request is outside the maintained shape.',
        )
      return await post({
        path: CHALLENGES_PATH,
        body: parsed.data,
        limitBytes: CHALLENGE_REQUEST_LIMIT_BYTES,
        signal: input.signal,
        parse: (value) => ChallengeEnvelope.parse(value).challenge,
      })
    },
    async capability(input): Promise<SignedPauseCapabilityV1> {
      const parsed = CapabilityRequest.safeParse({
        admissionProofWire: input.admissionProofWire,
      })
      if (!parsed.success)
        throw new PauseCommandIssuerError(
          'request',
          'Pause issuer capability request is outside the maintained shape.',
        )
      return await post({
        path: CAPABILITIES_PATH,
        body: parsed.data,
        limitBytes: CAPABILITY_REQUEST_LIMIT_BYTES,
        signal: input.signal,
        parse: (value) => CapabilityEnvelope.parse(value).capability,
      })
    },
  })
}

/**
 * Reads the bounded response body. The byte limit is enforced on the raw
 * stream, the encoding is strict and every read is followed by a check of the
 * caller signal and of the single deadline.
 */
async function readBody(
  body: ReadableStream<Uint8Array>,
  guard: () => void,
  signal: AbortSignal,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = ''
  let bytes = 0
  let chunks = 0
  // Cancelling a ReadableStream closes pending reads immediately, even when
  // its underlying cancellation promise never settles. Never await that promise.
  const abort = () => cancelReader(reader)
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    for (;;) {
      guard()
      const chunk = await reader.read()
      guard()
      if (chunk.done) break
      if (++chunks > MAX_RESPONSE_CHUNKS)
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response exceeds the chunk limit.',
        )
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES)
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response exceeds the maintained size limit.',
        )
      try {
        text += decoder.decode(chunk.value, { stream: true })
      } catch {
        throw new PauseCommandIssuerError(
          'response',
          'Pause issuer response is not valid UTF-8.',
        )
      }
      guard()
    }
    try {
      text += decoder.decode()
    } catch {
      throw new PauseCommandIssuerError(
        'response',
        'Pause issuer response is not valid UTF-8.',
      )
    }
    guard()
    return text
  } catch (error) {
    cancelReader(reader)
    throw error
  } finally {
    signal.removeEventListener('abort', abort)
    try {
      reader.releaseLock()
    } catch {
      // The lock is already released.
    }
  }
}
