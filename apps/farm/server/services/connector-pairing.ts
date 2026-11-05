import {
  parseBoundedJson,
  PairingApprovalRequest,
} from '@open3dfarmmanager/farm-protocol'
import { createError, getRequestIP, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { authResponse, sealedSessionRecordId } from './authenticated-session.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import { authRuntime } from '../utils/auth/runtime.ts'
import {
  connectorPairingRuntime,
  pairingConfiguredOrigin,
} from '../utils/connector-pairing/runtime.ts'

type Event = Pick<RequestEvent, 'req' | 'res'>
export type PairingOperation =
  | 'start'
  | 'challenge'
  | 'proof'
  | 'claim'
  | 'approve'
  | 'revoke'
const revokeBody = z.strictObject({
  expected_fingerprint: PairingApprovalRequest.shape.expected_fingerprint,
})
const invalid = () =>
  createError({ status: 400, message: 'Solicitação inválida.' })

export function pairingRequestBoundary(
  request: Request,
  origin: string,
  browser: boolean,
): void {
  if (request.method !== 'POST' || new URL(request.url).search) throw invalid()
  if (browser) {
    if (!checkMutationOrigin(request.headers.get('origin'), origin).ok)
      throw createError({
        status: 403,
        message: 'Origem da solicitação não permitida.',
      })
    // Node's native fetch supplies Sec-Fetch-Mode without browser site metadata.
  } else if (
    request.headers.has('origin') ||
    request.headers.has('cookie') ||
    [...request.headers.keys()].some(
      (name) => name.startsWith('sec-fetch-') && name !== 'sec-fetch-mode',
    )
  ) {
    throw createError({ status: 403, message: 'Solicitação não permitida.' })
  }
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    throw createError({ status: 415, message: 'Envie os dados em JSON.' })
  const length = request.headers.get('content-length')
  if (length !== null && (!/^\d{1,6}$/.test(length) || Number(length) > 4096))
    throw createError({ status: 413, message: 'Solicitação muito grande.' })
}
export async function readPairingBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw invalid()
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          createError({ status: 408, message: 'Tempo de envio esgotado.' }),
        )
        void reader.cancel().catch(() => {})
      }, 5000)
    })
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4096)
        throw createError({ status: 413, message: 'Solicitação muito grande.' })
      chunks.push(chunk.value)
    }
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: 4096, maxDepth: 4, maxValues: 32, maxStringChars: 1024 },
    )
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    throw invalid()
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function failure(reason: string): never {
  if (reason === 'invalid-input') throw invalid()
  if (reason === 'capacity' || reason === 'slow-down')
    throw createError({
      status: 429,
      message: 'Muitas tentativas. Aguarde antes de tentar novamente.',
    })
  if (reason === 'storage-unavailable')
    throw createError({
      status: 503,
      message: 'Pareamento indisponível. Tente novamente.',
    })
  // Missing, stale, mismatched and unauthorized targets have one public response.
  throw createError({
    status: 403,
    message: 'Não foi possível autorizar esta solicitação.',
  })
}
export async function connectorPairing(
  event: Event,
  operation: PairingOperation,
  target?: { farmId: string; agentId: string },
) {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  const origin = pairingConfiguredOrigin()
  const auth = authRuntime()
  if (origin !== auth.origin) return failure('storage-unavailable')
  const browser = operation === 'approve' || operation === 'revoke'
  pairingRequestBoundary(event.req, origin, browser)
  const sessionRecordId = browser
    ? await sealedSessionRecordId(event, auth)
    : undefined
  if (browser && !sessionRecordId) return failure('denied')
  // Durable limits shared by all app instances; never trust proxy-supplied headers.
  // Anonymous traffic cannot spend an authenticated session's recovery budget.
  // consumeLimit hashes keys before persistence; storage still rechecks authority.
  try {
    if (browser) {
      if (
        !(await auth.credentials.consumeLimit(
          's',
          `pairing-browser:${operation}:${sessionRecordId}`,
        ))
      )
        return failure('capacity')
    } else {
      const source =
        getRequestIP(event, { xForwardedFor: false }) ?? 'unknown-source'
      if (
        !(await auth.credentials.consumeLimit('s', 'pairing-global')) ||
        !(await auth.credentials.consumeLimit('s', 'pairing-source:' + source))
      )
        return failure('capacity')
    }
  } catch (error) {
    if (error instanceof Error && 'status' in error) throw error
    return failure('storage-unavailable')
  }
  const body = await readPairingBody(event.req)
  const runtime = await connectorPairingRuntime()
  switch (operation) {
    case 'start': {
      const result = await runtime.pairing.start(body)
      if (!result.ok) return failure(result.reason)
      return result.response
    }
    case 'challenge': {
      const result = await runtime.proof.issue(body)
      if (!result.ok) return failure(result.reason)
      return result.challenge
    }
    case 'proof': {
      const result = await runtime.proof.complete(body)
      if (!result.ok) return failure(result.reason)
      return {
        status: result.status,
        agentId: result.agentId,
        fingerprint: result.fingerprint,
      }
    }
    case 'claim': {
      const result = await runtime.pairing.claim(body, runtime.issuer)
      if (!result.ok) return failure(result.reason)
      const { ok: _, ...response } = result
      return response
    }
    case 'approve': {
      if (!sessionRecordId) return failure('denied')
      const result = await runtime.pairing.decide({
        request: body,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
        decision: 'approve',
      })
      if (!result.ok) return failure(result.reason)
      return { status: result.status }
    }
    case 'revoke': {
      const parsed = revokeBody.safeParse(body)
      if (!sessionRecordId || !target || !parsed.success) throw invalid()
      const result = await runtime.revocation.revoke({
        ...target,
        expectedFingerprint: parsed.data.expected_fingerprint,
        sessionRecordId,
        policy: { idleTimeoutMs: auth.idleTimeoutMs },
      })
      if (!result.ok) return failure(result.reason)
      return {
        status: result.status,
        credential: result.credential,
        revokedAt: result.revokedAt,
      }
    }
  }
}
