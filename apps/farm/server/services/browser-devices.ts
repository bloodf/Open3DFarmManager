import { createError, type RequestEvent } from 'nuxt/server'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import {
  BROWSER_DEVICE_HTTP_LIMITS,
  BrowserDeviceHttpChallengeRequest,
  BrowserDeviceHttpProofRequest,
  BrowserDeviceHttpDecisionRequest,
  BrowserDeviceHttpListRequest,
  BrowserDeviceHttpListResponse,
  BrowserDeviceHttpChallengeResponse,
  BrowserDeviceHttpMutationResponse,
} from '../../../../packages/farm-protocol/src/browser-device-http.ts'
import {
  authResponse,
  authenticatedSession,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'
import type {
  PostgresBrowserDeviceRegistry,
  BrowserDeviceRegistryFailure,
} from '../storage/postgres-browser-device-registry.ts'

export type BrowserDeviceOperation =
  | 'list'
  | 'challenges'
  | 'recovery-challenges'
  | 'proofs'
  | 'approve'
  | 'revoke'
export interface BrowserDeviceHttpRuntime {
  auth: AuthRuntime
  registry: Pick<
    PostgresBrowserDeviceRegistry,
    'list' | 'issueChallenge' | 'completeProof' | 'approve' | 'revoke'
  >
  admission: { active: number }
}
type Event = Pick<RequestEvent, 'req' | 'res'>
const messages = {
  400: 'Solicitação de dispositivo inválida.',
  401: 'Entre na sua conta para continuar.',
  403: 'Acesso ao dispositivo não permitido.',
  405: 'Método não permitido.',
  408: 'Tempo de envio esgotado.',
  413: 'Solicitação muito grande.',
  415: 'Envie os dados em JSON sem compactação.',
  429: 'Limite de tentativas atingido. Aguarde 15 minutos.',
  503: 'Serviço de dispositivos indisponível. Tente novamente.',
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
function registryFailure(result: BrowserDeviceRegistryFailure): never {
  switch (result.reason) {
    case 'invalid-input':
      return failure(400)
    case 'denied':
      return failure(403)
    case 'storage-unavailable':
      return failure(503)
    case 'capacity':
      throw createError({
        status: 409,
        message:
          'Limite de cadastro atingido: são três desafios por chave ao longo da vida e 24 horas para aprovar um cadastro pendente. Não repita a operação automaticamente.',
      })
  }
  return failure(503)
}
/** Finite UTF-8 JSON reader; callers retain admission until cancellation/cleanup. */
export async function readBrowserDeviceBody(
  request: Request,
): Promise<unknown> {
  if (!validContentType(request)) return failure(415)
  const reader = request.body?.getReader()
  if (!reader) return failure(400)
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(createError({ status: 408, message: messages[408] }))
        void reader.cancel().catch(() => {})
      }, 5000)
    })
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 4096 || chunks.length >= 4096) return failure(413)
      chunks.push(chunk.value)
    }
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: 4096, maxDepth: 4, maxValues: 32, maxStringChars: 1024 },
    )
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 408)
      return failure(408)
    if (error instanceof Error && 'status' in error && error.status === 413)
      return failure(413)
    return failure(400)
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
function listQuery(request: Request): unknown {
  const query = new URL(request.url).searchParams
  if (query.toString().length > 512) return failure(400)
  for (const key of query.keys())
    if (
      !['farm_id', 'limit', 'after'].includes(key) ||
      query.getAll(key).length !== 1
    )
      return failure(400)
  const limit = query.get('limit')
  if (limit !== null && !/^[1-9][0-9]?$/.test(limit)) return failure(400)
  return {
    farm_id: query.get('farm_id'),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(query.has('after') ? { after: query.get('after') } : {}),
  }
}
function metadata(
  device: Awaited<
    ReturnType<PostgresBrowserDeviceRegistry['completeProof']>
  > & { ok: true },
) {
  return BrowserDeviceHttpMutationResponse.parse({
    device: {
      keyId: device.device.key_id,
      accountId: device.device.account_id,
      thumbprint: device.device.thumbprint,
      status: device.device.status,
      proofAt: device.device.proof_at,
    },
    limits: BROWSER_DEVICE_HTTP_LIMITS,
  })
}
/** No injected authentication shortcut: tests and runtime use the maintained sealed cookie + DB session helpers. */
export async function browserDeviceRequest(
  event: Event,
  runtime: BrowserDeviceHttpRuntime,
  operation: BrowserDeviceOperation,
) {
  authResponse(event)
  if (runtime.admission.active >= 16) return failure(503)
  runtime.admission.active++
  try {
    if (event.req.method !== (operation === 'list' ? 'GET' : 'POST'))
      return failure(405)
    if (operation !== 'list') {
      if (new URL(event.req.url).searchParams.size !== 0) return failure(400)
      if (
        !checkMutationOrigin(
          event.req.headers.get('origin'),
          runtime.auth.origin,
        ).ok
      )
        return failure(403)
      if (!validContentType(event.req)) return failure(415)
    }
    await authenticatedSession(event, runtime.auth)
    const id = await sealedSessionRecordId(event, runtime.auth)
    let allowed: boolean
    try {
      allowed = await runtime.auth.credentials.consumeLimit(
        's',
        `browser-devices:v1:${operation}:${id}`,
      )
    } catch {
      return failure(503)
    }
    if (!allowed) return failure(429)
    const input = {
      sessionRecordId: id,
      policy: { idleTimeoutMs: runtime.auth.idleTimeoutMs },
    }
    if (operation === 'list') {
      const parsed = BrowserDeviceHttpListRequest.safeParse(
        listQuery(event.req),
      )
      if (!parsed.success) return failure(400)
      const result = await runtime.registry.list({
        ...input,
        request: parsed.data,
      })
      if (!result.ok) return registryFailure(result)
      const { ok, ...response } = result
      return BrowserDeviceHttpListResponse.parse(response)
    }
    const body = await readBrowserDeviceBody(event.req)
    if (operation === 'challenges' || operation === 'recovery-challenges') {
      const parsed = BrowserDeviceHttpChallengeRequest.safeParse(body)
      if (!parsed.success) return failure(400)
      const result = await runtime.registry.issueChallenge({
        ...input,
        request: {
          ...parsed.data,
          purpose: operation === 'challenges' ? 'enroll' : 'recover',
        },
      })
      if (!result.ok) return registryFailure(result)
      return BrowserDeviceHttpChallengeResponse.parse({
        challenge: result.challenge,
        limits: BROWSER_DEVICE_HTTP_LIMITS,
      })
    }
    if (operation === 'proofs') {
      const parsed = BrowserDeviceHttpProofRequest.safeParse(body)
      if (!parsed.success) return failure(400)
      const result = await runtime.registry.completeProof({
        ...input,
        request: parsed.data,
      })
      if (!result.ok) return registryFailure(result)
      return metadata(result)
    }
    const parsed = BrowserDeviceHttpDecisionRequest.safeParse(body)
    if (!parsed.success) return failure(400)
    const result = await runtime.registry[operation]({
      ...input,
      request: parsed.data,
    })
    if (!result.ok) return registryFailure(result)
    return metadata(result)
  } catch (error) {
    // Only fixed boundary messages cross HTTP; never database errors or session identifiers.
    if (error instanceof Error && 'status' in error) {
      const status = error.status
      if (status === 409)
        throw createError({
          status: 409,
          message:
            'Limite de cadastro atingido: são três desafios por chave ao longo da vida e 24 horas para aprovar um cadastro pendente. Não repita a operação automaticamente.',
        })
      if (
        status === 400 ||
        status === 401 ||
        status === 403 ||
        status === 405 ||
        status === 408 ||
        status === 413 ||
        status === 415 ||
        status === 429 ||
        status === 503
      )
        return failure(status)
    }
    return failure(503)
  } finally {
    runtime.admission.active--
  }
}
