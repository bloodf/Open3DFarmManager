import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import {
  decodeControlProof,
  MAX_CONTROL_PROOF_WIRE_BYTES,
} from '../../../../packages/farm-protocol/src/control-session-binding.ts'
import {
  decodePauseAdmissionProof,
  MAX_PAUSE_ADMISSION_WIRE_BYTES,
  PauseAdmissionChallenge,
  pauseAdmissionPayload,
  SignedPauseCapabilityV1,
  encodePauseCapability,
} from '../../../../packages/farm-protocol/src/pause-capability.ts'
import {
  authResponse,
  authenticatedSession,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'
import type {
  createPauseAuthorityService,
  PauseAuthorityServiceFailure,
} from './pause-authority.ts'

export type PauseAuthorityOperation = 'challenges' | 'capabilities'
export interface PauseAuthorityHttpRuntime {
  readonly auth: AuthRuntime
  readonly authority: ReturnType<typeof createPauseAuthorityService>
}
type Event = Pick<RequestEvent, 'req' | 'res'>
const ChallengeRequest = z.strictObject({
  browserProofWire: z.string().max(MAX_CONTROL_PROOF_WIRE_BYTES),
  connectorProofWire: z.string().max(MAX_CONTROL_PROOF_WIRE_BYTES),
  admissionNonce: PauseAdmissionChallenge.shape.admission_nonce,
})
const CapabilityRequest = z.strictObject({
  admissionProofWire: z.string().max(MAX_PAUSE_ADMISSION_WIRE_BYTES),
})
const messages = {
  400: 'Solicitação de autorização inválida.',
  401: 'Entre na sua conta para continuar.',
  403: 'Autorização de pausa não permitida.',
  405: 'Método não permitido.',
  408: 'Tempo de envio esgotado.',
  409: 'Capacidade de autorização esgotada. Não repita automaticamente.',
  413: 'Solicitação muito grande.',
  415: 'Envie os dados em JSON sem compactação.',
  429: 'Limite de tentativas atingido. Aguarde 15 minutos.',
  503: 'Autorização de pausa indisponível. Não repita automaticamente.',
}
function failure(status: keyof typeof messages): never {
  throw createError({ status, message: messages[status] })
}
function validContentType(request: Request): boolean {
  return (
    /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      request.headers.get('content-type') ?? '',
    ) && !request.headers.has('content-encoding')
  )
}
function serviceFailure(result: PauseAuthorityServiceFailure): never {
  switch (result.reason) {
    case 'invalid-input':
      return failure(400)
    case 'denied':
      return failure(403)
    case 'capacity':
      return failure(409)
    case 'rate-limited':
      return failure(429)
    case 'storage-unavailable':
      return failure(503)
  }
}

/** Escaped outer JSON has its own cap; canonical inner proof byte limits stay unchanged. */
export async function readPauseAuthorityBody(
  request: Request,
  operation: PauseAuthorityOperation,
): Promise<unknown> {
  if (!validContentType(request)) return failure(415)
  const monotonicNow = performance.now.bind(performance)
  const started = monotonicNow()
  if (
    !Number.isFinite(started) ||
    started < 0 ||
    started > Number.MAX_SAFE_INTEGER - 5000
  )
    return failure(408)
  let previous = started
  const limit = operation === 'challenges' ? 102400 : 51200
  const length = request.headers.get('content-length')
  if (
    length !== null &&
    (!/^(0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)))
  )
    return failure(400)
  if (length !== null && Number(length) > limit) return failure(413)
  const reader = request.body?.getReader()
  if (!reader) return failure(400)
  const buffer = new Uint8Array(limit)
  let size = 0,
    chunks = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let cancellation: Promise<void> | undefined
  const cancel = () => (cancellation ??= reader.cancel().catch(() => {}))
  const checkDeadline = () => {
    const now = monotonicNow()
    if (!Number.isFinite(now) || now < previous || now - started >= 5000) {
      void cancel()
      return failure(408)
    }
    previous = now
  }
  let rejectDeadline: (reason: unknown) => void = () => {}
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject
  })
  const abort = () => {
    rejectDeadline(createError({ status: 408, message: messages[408] }))
    void cancel()
  }
  try {
    timer = setTimeout(abort, 5000)
    request.signal.addEventListener('abort', abort, { once: true })
    if (request.signal.aborted) abort()
    while (true) {
      checkDeadline()
      const chunk = await Promise.race([reader.read(), deadline])
      checkDeadline()
      if (chunk.done) break
      if (++chunks > 1024 || chunk.value.byteLength > limit - size)
        return failure(413)
      buffer.set(chunk.value, size)
      size += chunk.value.byteLength
    }
    if (request.signal.aborted) return failure(408)
    if (length !== null && Number(length) !== size) return failure(400)
    checkDeadline()
    const parsed = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, size),
      ),
      {
        maxBytes: limit,
        maxDepth: 2,
        maxValues: 8,
        maxStringChars: 8192,
      },
    )
    checkDeadline()
    return parsed
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      (error.status === 408 || error.status === 413)
    )
      return failure(error.status)
    return failure(400)
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', abort)
    // A pending cancellation keeps its HTTP slot, rather than freeing capacity behind live work.
    try {
      await cancel()
      checkDeadline()
    } finally {
      reader.releaseLock()
    }
  }
}
let activeRequests = 0
/** The only session identifier passed to the issuer comes from maintained own-login unsealing. */
export async function pauseAuthorityRequest(
  event: Event,
  runtime: PauseAuthorityHttpRuntime,
  operation: PauseAuthorityOperation,
): Promise<
  | { challenge: PauseAdmissionChallenge }
  | { capability: SignedPauseCapabilityV1 }
> {
  authResponse(event)
  if (activeRequests >= 8) return failure(503)
  activeRequests++
  try {
    if (event.req.method !== 'POST') return failure(405)
    if (new URL(event.req.url).searchParams.size !== 0) return failure(400)
    if (
      !checkMutationOrigin(event.req.headers.get('origin'), runtime.auth.origin)
        .ok
    )
      return failure(403)
    if (!validContentType(event.req)) return failure(415)
    await authenticatedSession(event, runtime.auth)
    const id = await sealedSessionRecordId(event, runtime.auth)
    if (event.req.signal.aborted) return failure(408)
    const allowed = await runtime.auth.credentials.consumeLimit(
      's',
      `pause-authority:v1:${operation}:${id}`,
    )
    if (!allowed) return failure(429)
    const body = await readPauseAuthorityBody(event.req, operation)
    if (event.req.signal.aborted) return failure(408)
    if (operation === 'challenges') {
      const parsed = ChallengeRequest.safeParse(body)
      if (!parsed.success) return failure(400)
      try {
        if (
          decodeControlProof(parsed.data.browserProofWire).role !== 'browser' ||
          decodeControlProof(parsed.data.connectorProofWire).role !==
            'connector'
        )
          return failure(400)
      } catch {
        return failure(400)
      }
      const result = await runtime.authority.issueChallenge({
        sessionRecordId: id,
        request: parsed.data,
      })
      if (!result.ok) return serviceFailure(result)
      const challenge = PauseAdmissionChallenge.parse(result.challenge)
      pauseAdmissionPayload(challenge)
      const response = { challenge }
      if (Buffer.byteLength(JSON.stringify(response)) > 8256)
        return failure(503)
      return response
    }
    const parsed = CapabilityRequest.safeParse(body)
    if (!parsed.success) return failure(400)
    try {
      decodePauseAdmissionProof(parsed.data.admissionProofWire)
    } catch {
      return failure(400)
    }
    const result = await runtime.authority.issueCapability({
      sessionRecordId: id,
      request: parsed.data,
    })
    if (!result.ok) return serviceFailure(result)
    const capability = SignedPauseCapabilityV1.parse(result.capability)
    encodePauseCapability(capability)
    const response = { capability }
    if (Buffer.byteLength(JSON.stringify(response)) > 8256) return failure(503)
    return response
  } catch (error) {
    if (
      error instanceof Error &&
      'status' in error &&
      typeof error.status === 'number' &&
      Object.hasOwn(messages, error.status)
    )
      throw error
    // A failed response is not evidence that issuance failed to commit. No retries or cancellation inference.
    return failure(503)
  } finally {
    activeRequests--
  }
}
