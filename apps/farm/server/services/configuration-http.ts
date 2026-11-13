import { createError, type RequestEvent } from 'nuxt/server'
import { z } from 'zod'
import { parseBoundedJson } from '../../../../packages/farm-protocol/src/json.ts'
import { BrowserDeviceUuid } from '../../../../packages/farm-protocol/src/browser-device-proof.ts'
import { MAX_CONFIGURATION_PROOF_WIRE_BYTES } from '../../../../packages/farm-protocol/src/configuration-common.ts'
import {
  ConfigurationAdmissionChallenge,
  SignedConfigurationCapabilityV1,
  encodeConfigurationCapability,
} from '../../../../packages/farm-protocol/src/configuration-capability.ts'
import {
  authResponse,
  authenticatedSession,
  sealedSessionRecordId,
} from './authenticated-session.ts'
import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import type { AuthRuntime } from '../utils/auth/runtime.ts'
import type { ConfigurationFailure } from './configuration-authority-contract.ts'
import {
  ConfigurationCapabilityRequest,
  ConfigurationChallengeRequest,
  type ConfigurationAuthorityService,
} from './configuration-authority.ts'
import type { ConfigurationRegistrationService } from './configuration-receipt-registration.ts'

export interface ConfigurationHttpRuntime {
  readonly auth: AuthRuntime
  readonly authority: ConfigurationAuthorityService
  readonly registration: ConfigurationRegistrationService
}
export type ConfigurationHttpOperation =
  'challenges' | 'capabilities' | 'receipts' | 'bootstrap'
type Event = Pick<RequestEvent, 'req' | 'res'>

const ReceiptRequest = z.strictObject({
  keyId: BrowserDeviceUuid,
  receiptWire: z.string().min(1).max(MAX_CONFIGURATION_PROOF_WIRE_BYTES),
})
const limits = { challenges: 51200, capabilities: 25600, receipts: 25600 }
const messages = {
  400: 'Solicitação de configuração inválida.',
  401: 'Entre na sua conta para continuar.',
  403: 'Configuração de impressoras não permitida.',
  405: 'Método não permitido.',
  408: 'Tempo de envio esgotado.',
  409: 'O recibo de configuração conflita com um registro existente.',
  413: 'Solicitação muito grande.',
  415: 'Envie os dados em JSON sem compactação.',
  429: 'Limite de tentativas atingido. Aguarde antes de tentar novamente.',
  503: 'Configuração de impressoras indisponível. Não repita automaticamente.',
}
type Status = keyof typeof messages
function failure(status: Status): never {
  throw createError({ status, message: messages[status] })
}
function serviceFailure(result: ConfigurationFailure): never {
  switch (result.reason) {
    case 'invalid-input':
      return failure(400)
    case 'denied':
      return failure(403)
    case 'conflict':
      return failure(409)
    case 'capacity':
    case 'storage-unavailable':
      return failure(503)
  }
}
function known(error: unknown): error is Error & { status: Status } {
  return (
    error instanceof Error &&
    'status' in error &&
    typeof error.status === 'number' &&
    Object.hasOwn(messages, error.status)
  )
}

/** Bounded, uncompressed, strictly UTF-8 JSON read with a five second deadline. */
export async function readConfigurationBody(
  request: Request,
  limit: number,
): Promise<unknown> {
  if (
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(
      request.headers.get('content-type') ?? '',
    ) ||
    request.headers.has('content-encoding')
  )
    return failure(415)
  const length = request.headers.get('content-length')
  if (length !== null && !/^(0|[1-9][0-9]{0,8})$/.test(length))
    return failure(400)
  if (length !== null && Number(length) > limit) return failure(413)
  const reader = request.body?.getReader()
  if (!reader) return failure(400)
  const chunks: Uint8Array[] = []
  let size = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(createError({ status: 408, message: messages[408] })),
        5000,
      )
    })
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout])
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit || chunks.length >= 1024) return failure(413)
      chunks.push(chunk.value)
    }
    if (length !== null && Number(length) !== size) return failure(400)
    return parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
      { maxBytes: limit, maxDepth: 2, maxValues: 12, maxStringChars: 20000 },
    )
  } catch (error) {
    if (known(error)) throw error
    return failure(400)
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

let activeRequests = 0
/**
 * Shared boundary of every config-v1 HTTP route: exact origin for mutations,
 * the sealed own-login session, a per-session rate limit and bounded input.
 * The session ID handed to the services comes only from cookie unsealing.
 */
async function boundary<T>(
  event: Event,
  runtime: ConfigurationHttpRuntime,
  operation: ConfigurationHttpOperation,
  action: (sessionRecordId: string) => Promise<T>,
): Promise<T> {
  authResponse(event)
  event.res.headers.set('Referrer-Policy', 'no-referrer')
  if (activeRequests >= 8) return failure(503)
  activeRequests++
  try {
    const mutation = operation !== 'bootstrap'
    if (event.req.method !== (mutation ? 'POST' : 'GET')) return failure(405)
    if (mutation && new URL(event.req.url).searchParams.size !== 0)
      return failure(400)
    if (
      mutation &&
      !checkMutationOrigin(event.req.headers.get('origin'), runtime.auth.origin)
        .ok
    )
      return failure(403)
    await authenticatedSession(event, runtime.auth)
    const id = await sealedSessionRecordId(event, runtime.auth)
    if (
      !(await runtime.auth.credentials.consumeLimit(
        's',
        `configuration:v1:${operation}:${id}`,
      ))
    )
      return failure(429)
    return await action(id)
  } catch (error) {
    if (known(error)) throw error
    // A failed response is not evidence that nothing was committed.
    return failure(503)
  } finally {
    activeRequests--
  }
}

/** POST /api/configuration-authority/{challenges,capabilities} */
export function configurationAuthorityRequest(
  event: Event,
  runtime: ConfigurationHttpRuntime,
  operation: 'challenges' | 'capabilities',
): Promise<
  | { challenge: ConfigurationAdmissionChallenge }
  | { capability: SignedConfigurationCapabilityV1 }
> {
  return boundary(event, runtime, operation, async (sessionRecordId) => {
    const body = await readConfigurationBody(event.req, limits[operation])
    if (operation === 'challenges') {
      const parsed = ConfigurationChallengeRequest.safeParse(body)
      if (!parsed.success) return failure(400)
      const result = await runtime.authority.issueChallenge({
        sessionRecordId,
        request: parsed.data,
      })
      if (!result.ok) return serviceFailure(result)
      return {
        challenge: ConfigurationAdmissionChallenge.parse(result.challenge),
      }
    }
    const parsed = ConfigurationCapabilityRequest.safeParse(body)
    if (!parsed.success) return failure(400)
    const result = await runtime.authority.issueCapability({
      sessionRecordId,
      request: parsed.data,
    })
    if (!result.ok) return serviceFailure(result)
    const capability = SignedConfigurationCapabilityV1.parse(result.capability)
    encodeConfigurationCapability(capability)
    return { capability }
  })
}

/** POST /api/farms/:farmId/configuration-receipts */
export function configurationReceiptRequest(
  event: Event,
  runtime: ConfigurationHttpRuntime,
  target: { farmId: string },
) {
  return boundary(event, runtime, 'receipts', async (sessionRecordId) => {
    if (!BrowserDeviceUuid.safeParse(target.farmId).success) return failure(400)
    const parsed = ReceiptRequest.safeParse(
      await readConfigurationBody(event.req, limits.receipts),
    )
    if (!parsed.success) return failure(400)
    const result = await runtime.registration.register({
      sessionRecordId,
      farmId: target.farmId,
      request: parsed.data,
    })
    if (!result.ok) return serviceFailure(result)
    return {
      assignmentId: result.assignmentId,
      receiptSha256: result.receiptSha256,
      status: result.status,
      replayed: result.replayed,
    }
  })
}

/** GET /api/farms/:farmId/connectors/:agentId/configuration?keyId=<uuid> */
export function configurationBootstrapRequest(
  event: Event,
  runtime: ConfigurationHttpRuntime,
  target: { farmId: string; agentId: string },
) {
  return boundary(event, runtime, 'bootstrap', async (sessionRecordId) => {
    const query = new URL(event.req.url).searchParams
    const scope = z
      .strictObject({
        farmId: BrowserDeviceUuid,
        agentId: BrowserDeviceUuid,
        keyId: BrowserDeviceUuid,
      })
      .safeParse({ ...target, keyId: query.get('keyId') })
    if (
      !scope.success ||
      query.size !== 1 ||
      query.getAll('keyId').length !== 1
    )
      return failure(400)
    const result = await runtime.registration.bootstrap({
      sessionRecordId,
      ...scope.data,
    })
    if (!result.ok) return serviceFailure(result)
    const { ok: _ok, ...metadata } = result
    return { ...metadata, issuerKid: runtime.authority.issuerKid }
  })
}
