import { checkMutationOrigin } from '../utils/auth/boundary.ts'
import type {
  ApprovalProblem,
  IntegrationApprovalService,
} from './integration-approval.ts'

/**
 * The farm page's approval endpoints. Authentication, the origin check and the
 * rate limit are injected so a route cannot forget them; every answer is
 * `no-store` and carries only operator-facing fields.
 */
export interface ApprovalHttpDeps {
  /** The trusted deployment origin that mutations must come from. */
  origin: string
  /** Throws when there is no valid session. */
  authenticate(): Promise<{ accountId: string }>
  /** Throws when the account is over its limit. */
  limit?(key: string): Promise<void>
  service: IntegrationApprovalService
}

const MAX_BODY_BYTES = 1024
const HEADERS = {
  'cache-control': 'no-store',
  'content-type': 'application/json; charset=utf-8',
} as const

const PROBLEMS: Record<ApprovalProblem, { status: number; message: string }> = {
  'validation-failed': { status: 400, message: 'Decisão inválida.' },
  forbidden: {
    status: 403,
    message: 'Seu papel nesta farm não permite aprovar ou rejeitar.',
  },
  'not-found': { status: 404, message: 'Solicitação não encontrada.' },
  conflict: { status: 409, message: 'Esta solicitação já foi decidida.' },
  expired: {
    status: 410,
    message: 'O prazo de aprovação desta solicitação expirou.',
  },
  'authority-lost': {
    status: 409,
    message:
      'O aplicativo ou a concessão não está mais ativo; a solicitação foi rejeitada.',
  },
  'service-unavailable': {
    status: 503,
    message: 'Entrega de comandos indisponível. Tente novamente mais tarde.',
  },
}

const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: HEADERS })
const problem = (code: ApprovalProblem) =>
  respond(PROBLEMS[code].status, {
    code,
    message: PROBLEMS[code].message,
  })

async function readDecision(request: Request): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    request.headers.has('content-encoding')
  )
    return undefined
  const reader = request.body?.getReader()
  if (!reader) return undefined
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > MAX_BODY_BYTES) return undefined
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return undefined
    const keys = Object.keys(body)
    return keys.length === 1 && keys[0] === 'decision'
      ? (body as { decision: unknown }).decision
      : undefined
  } catch {
    return undefined
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Cancellation is best-effort; releasing the lock is unconditional.
    } finally {
      reader.releaseLock()
    }
  }
}

/** `GET .../integrations/approvals`: the held items an operator can decide. */
export async function listApprovalsRequest(
  deps: ApprovalHttpDeps,
  farmId: string,
) {
  const { accountId } = await deps.authenticate()
  const result = await deps.service.list(accountId, farmId)
  if (!result.ok) return problem('forbidden')
  return respond(200, { items: result.items })
}

/** `POST .../integrations/approvals/{id}/decision` with `{ "decision": "approve" | "reject" }`. */
export async function decideApprovalRequest(
  request: Request,
  deps: ApprovalHttpDeps,
  farmId: string,
  id: string,
) {
  if (!checkMutationOrigin(request.headers.get('origin'), deps.origin).ok)
    return respond(403, {
      code: 'forbidden-origin',
      message: 'Origem da solicitação não permitida.',
    })
  const { accountId } = await deps.authenticate()
  await deps.limit?.(`approval:${accountId}`)
  const decision = await readDecision(request)
  const result = await deps.service.decide(accountId, farmId, id, decision)
  if (!result.ok) return problem(result.problem)
  return respond(200, result.result)
}
