import { createHash } from 'node:crypto'
import type { IntegrationScope } from '../services/integration-apps.ts'
import {
  uuidPattern,
  type IntegrationAuth,
  type IntegrationPrincipal,
} from './integration-auth.ts'
import { IntegrationLimits } from './integration-auth-limits.ts'
import {
  takeIntegrationRequestLimit,
  type IntegrationRateLimitConfig,
} from './integration-rate-limit.ts'

export const integrationBase = '/api/integrations/v1'
const realm = 'realm="openfarm-integrations"'
const noStore = { 'cache-control': 'no-store' }
const tokenLimits = new IntegrationLimits()
const resourceLimits = new IntegrationLimits()

export function oauthError(error: string, status = 400, headers?: HeadersInit) {
  return Response.json(
    { error },
    {
      status,
      headers: {
        ...noStore,
        ...(status === 401 ? { 'www-authenticate': 'Basic ' + realm } : {}),
        ...headers,
      },
    },
  )
}

export class PayloadTooLarge extends Error {}

export async function readText(request: Request, max: number) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let result = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return result + decoder.decode()
      size += chunk.value.length
      if (size > max) throw new PayloadTooLarge()
      result += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    void reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

function decodeFormComponent(value: string) {
  return decodeURIComponent(value.replaceAll('+', ' '))
}

function parseBasic(authorization: string) {
  const encoded = /^Basic ([A-Za-z0-9+/]{1,2048}={0,2})$/i.exec(
    authorization,
  )?.[1]
  if (!encoded) return []
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) return []
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const separator = decoded.indexOf(':')
  if (separator < 0) return []
  return [
    decodeFormComponent(decoded.slice(0, separator)),
    decodeFormComponent(decoded.slice(separator + 1)),
  ]
}

export async function integrationTokenRequest(
  request: Request,
  runtime: () => IntegrationAuth,
  rateLimits = tokenLimits,
) {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/x-www-form-urlencoded' ||
    request.headers.has('content-encoding')
  )
    return oauthError('invalid_request')

  let form: URLSearchParams
  try {
    const raw = await readText(request, 4096)
    decodeFormComponent(raw)
    form = new URLSearchParams(raw)
  } catch {
    return oauthError('invalid_request')
  }
  const seen = new Set<string>()
  for (const name of form.keys()) {
    if (seen.has(name)) return oauthError('invalid_request')
    seen.add(name)
  }
  const grantType = form.get('grant_type')
  if (!grantType) return oauthError('invalid_request')
  if (grantType !== 'client_credentials')
    return oauthError('unsupported_grant_type')
  const scope = form.get('scope')
  if (
    scope !== null &&
    (scope.length > 512 ||
      !/^[!-~]+(?: [!-~]+)*$/.test(scope) ||
      /["\\]/.test(scope))
  )
    return oauthError('invalid_scope')

  const authorization = request.headers.get('authorization')
  if (
    authorization !== null &&
    (form.has('client_id') || form.has('client_secret'))
  )
    return oauthError('invalid_request')

  let credentials: (string | null)[]
  try {
    credentials =
      authorization === null
        ? [form.get('client_id'), form.get('client_secret')]
        : parseBasic(authorization)
  } catch {
    return oauthError('invalid_client', 401)
  }
  const [id, secret] = credentials
  if (!id || id.length > 128 || !secret || secret.length > 256)
    return oauthError('invalid_client', 401)

  try {
    const auth = runtime()
    const credential = await auth.store.findActiveCredential(id)
    const rateKey = credential
      ? 'token:' + createHash('sha256').update(id).digest('base64url')
      : 'source:' +
        createHash('sha256')
          .update(
            request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
              'unknown-source',
          )
          .digest('base64url')
    const rate = rateLimits.take(rateKey, 30)
    if (!rate.allowed)
      return oauthError('rate_limited', 429, {
        'retry-after': String(rate.retry),
      })
    const issued = await auth.issue(id, secret, scope?.split(' '))
    if (issued === 'invalid_client') return oauthError(issued, 401)
    if (issued === 'invalid_scope') return oauthError(issued)
    return Response.json(issued, {
      headers: { ...noStore, pragma: 'no-cache' },
    })
  } catch {
    return oauthError('temporarily_unavailable', 503)
  }
}

const problems = {
  'invalid-token': [401, 'Token de acesso inválido.'],
  'insufficient-scope': [403, 'Escopo insuficiente.'],
  'not-found': [404, 'Recurso não encontrado.'],
  'invalid-request': [400, 'Solicitação inválida.'],
  'payload-too-large': [413, 'Solicitação muito grande.'],
  'unsupported-media-type': [415, 'Formato de solicitação não aceito.'],
  'unsafe-target': [422, 'Destino do webhook não permitido.'],
  'webhook-limit-reached': [409, 'Limite de assinaturas de webhook atingido.'],
  'validation-failed': [422, 'Solicitação não aceita.'],
  unsupported: [422, 'Ação não suportada por esta impressora.'],
  'idempotency-key-reused': [
    409,
    'Chave de idempotência já usada com outra solicitação.',
  ],
  'method-not-allowed': [405, 'Método não permitido.'],
  'rate-limited': [429, 'Limite de solicitações atingido.'],
  'connector-unavailable': [503, 'Conector indisponível.'],
  'connector-timeout': [504, 'O conector não respondeu a tempo.'],
  'service-unavailable': [503, 'Serviço temporariamente indisponível.'],
} as const

export function integrationProblem(
  code: keyof typeof problems,
  headers?: HeadersInit,
) {
  const [status, title] = problems[code]
  const responseHeaders = new Headers(headers)
  responseHeaders.set('content-type', 'application/problem+json')
  responseHeaders.set('cache-control', 'no-store')
  return Response.json(
    { type: 'https://openfarm.dev/problems/' + code, title, status, code },
    {
      status,
      headers: responseHeaders,
    },
  )
}

interface RoutePolicy {
  method: string
  path: RegExp
  scopes: readonly IntegrationScope[]
}

const policies: RoutePolicy[] = [
  {
    method: 'POST',
    path: /^\/(intents|grants\/(redeem|receipt))$/,
    scopes: [],
  },
  {
    method: 'GET',
    path: /^\/printers(?:\/status|\/[^/]+\/status)?$/,
    scopes: ['printers:read'],
  },
  { method: 'GET', path: /^\/printers\/[^/]+\/files$/, scopes: ['files:read'] },
  {
    method: 'GET',
    path: /^\/printers\/[^/]+\/macros$/,
    scopes: ['control:extended'],
  },
  { method: 'POST', path: /^\/printers\/[^/]+\/jobs$/, scopes: ['jobs:start'] },
  {
    method: 'POST',
    path: /^\/printers\/[^/]+\/actions$/,
    scopes: ['control:basic', 'control:extended'],
  },
  { method: 'GET', path: /^\/inventory$/, scopes: ['inventory:read'] },
  { method: 'GET', path: /^\/library$/, scopes: ['library:read'] },
  { method: 'POST', path: /^\/library$/, scopes: ['library:write'] },
  {
    method: 'GET',
    path: /^\/library\/settings$/,
    scopes: ['library:read'],
  },
  {
    method: 'PATCH',
    path: /^\/library\/settings$/,
    scopes: ['library:write'],
  },
  { method: 'GET', path: /^\/library\/[^/]+$/, scopes: ['library:read'] },
  {
    method: 'GET',
    path: /^\/jobs\/[^/]+\/(eligibility|plate)$/,
    scopes: ['jobs:read', 'jobs:start'],
  },
  {
    method: 'POST',
    path: /^\/jobs\/[^/]+\/actions$/,
    scopes: ['control:basic', 'plates:confirm'],
  },
  { method: 'GET', path: /^\/jobs$/, scopes: ['jobs:read'] },
  {
    method: 'GET',
    path: /^\/jobs\/[^/]+$/,
    scopes: ['jobs:read', 'jobs:start'],
  },
  {
    method: 'GET',
    path: /^\/actions\/[^/]+$/,
    scopes: ['control:basic', 'control:extended', 'plates:confirm'],
  },
  { method: 'GET', path: /^\/webhooks$/, scopes: ['events:subscribe'] },
  {
    method: 'POST',
    path: /^\/webhooks(?:\/[^/]+\/test)?$/,
    scopes: ['events:subscribe'],
  },
  {
    method: 'DELETE',
    path: /^\/webhooks\/[^/]+$/,
    scopes: ['events:subscribe'],
  },
]

export function integrationPath(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, '')
  return pathname === integrationBase ||
    pathname.startsWith(integrationBase + '/')
    ? pathname.slice(integrationBase.length)
    : null
}

export function integrationPolicy(path: string, method: string) {
  return policies.find(
    (policy) => policy.method === method && policy.path.test(path),
  )
}

/** True when the body asks to replay a library version. Malformed JSON is left to the handler. */
async function libraryReplayBody(request: Request) {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase()
  if (mediaType !== 'application/json') return false
  try {
    const body: unknown = JSON.parse(await readText(request.clone(), 16 * 1024))
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false
    const keys = Object.keys(body)
    return (
      keys.includes('libraryVersionId') || keys.includes('library_version_id')
    )
  } catch {
    return false
  }
}

async function readActionScope(request: Request) {
  const mediaType = request.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase()
  if (
    mediaType !== 'application/json' ||
    request.headers.has('content-encoding')
  )
    return 'unsupported-media-type'
  let action: unknown
  try {
    action = (
      JSON.parse(await readText(request.clone(), 64 * 1024)) as {
        action?: unknown
      } | null
    )?.action
  } catch (error) {
    return error instanceof PayloadTooLarge
      ? 'payload-too-large'
      : 'invalid-request'
  }
  if (typeof action !== 'string') return 'invalid-request'
  return ['pause', 'resume', 'cancel'].includes(action)
    ? 'control:basic'
    : 'control:extended'
}

/** Use on resolved rows as well as filters, including each row of a list.
 * Supply the action's exact scope when the operation has alternative scopes.
 */
export function integrationGrantFor(
  principal: IntegrationPrincipal,
  scope: IntegrationScope,
  farmId: string,
  printerId: string | null,
) {
  const covering = principal.grants.filter(
    (grant) =>
      grant.scopes.includes(scope) &&
      grant.farmId === farmId &&
      (grant.printerAssignmentId === null ||
        grant.printerAssignmentId === printerId),
  )
  // Overlapping grants must preserve the ability to use a grant without approval.
  return covering.find((grant) => !grant.requiresApproval) ?? covering[0]
}

export async function authorizeIntegrationRequest(
  request: Request,
  path: string,
  runtime: () => IntegrationAuth,
  rateLimits = resourceLimits,
  rateLimitConfig: IntegrationRateLimitConfig = {},
): Promise<
  | Response
  | { principal: IntegrationPrincipal; headers: Record<string, string> }
> {
  const authorization = request.headers.get('authorization')
  const token = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/i.exec(
    authorization ?? '',
  )?.[1]
  const invalid = () =>
    integrationProblem('invalid-token', {
      'www-authenticate':
        'Bearer ' +
        realm +
        (authorization === null ? '' : ', error="invalid_token"'),
    })
  if (!token) return invalid()
  let headers: Record<string, string> | undefined
  try {
    const auth = runtime()
    const principal = await auth.verify(token)
    if (!principal) return invalid()
    const method = request.method === 'HEAD' ? 'GET' : request.method
    const rate = takeIntegrationRequestLimit(
      rateLimits,
      principal.appId,
      method,
      rateLimitConfig,
    )
    headers = rate.headers
    if (!rate.allowed)
      return integrationProblem('rate-limited', {
        ...headers,
      })
    const policy = integrationPolicy(path, method)
    if (!policy) {
      const allowed = policies
        .filter((entry) => entry.path.test(path))
        .map((entry) => entry.method)
      if (allowed.includes('GET')) allowed.push('HEAD')
      return allowed.length
        ? integrationProblem('method-not-allowed', {
            ...headers,
            allow: allowed.join(', '),
          })
        : integrationProblem('not-found', headers)
    }
    let scopes = policy.scopes.filter((scope) =>
      principal.scopes.includes(scope),
    )
    if (policy.scopes.length && !scopes.length)
      return integrationProblem('insufficient-scope', headers)
    if (method === 'POST' && /^\/printers\/[^/]+\/jobs$/.test(path)) {
      const replay = await libraryReplayBody(request)
      if (replay && !principal.scopes.includes('jobs:write'))
        return integrationProblem('insufficient-scope', headers)
      if (replay) scopes = [...scopes, 'jobs:write']
    }
    if (method === 'POST' && /^\/printers\/[^/]+\/actions$/.test(path)) {
      const scope = await readActionScope(request)
      if (
        scope === 'invalid-request' ||
        scope === 'unsupported-media-type' ||
        scope === 'payload-too-large'
      )
        return integrationProblem(scope, headers)
      if (!scopes.includes(scope))
        return integrationProblem('insufficient-scope', headers)
      scopes = [scope]
    }

    const url = new URL(request.url)
    const farms = [
      '/printers',
      '/printers/status',
      '/inventory',
      '/jobs',
      '/library',
      '/library/settings',
    ].includes(path)
      ? url.searchParams.getAll('farmId')
      : []
    const printers =
      path === '/jobs' ? url.searchParams.getAll('printerId') : []
    if (farms.length > 1 || printers.length > 1)
      return integrationProblem('invalid-request', headers)
    const [farmFilter] = farms
    const [printerFilter] = printers
    const pathPrinter = /^\/printers\/([^/]+)\//.exec(path)?.[1]
    const printerId = (pathPrinter ?? printerFilter)?.toLowerCase()
    const farmId = farmFilter?.toLowerCase()
    if (
      (farmId !== undefined && !uuidPattern.test(farmId)) ||
      (printerId !== undefined && !uuidPattern.test(printerId))
    )
      return integrationProblem('not-found', headers)

    const printerFarm = printerId
      ? await auth.store.activePrinterFarm(printerId)
      : null
    if (printerId && (!printerFarm || (farmId && printerFarm !== farmId)))
      return integrationProblem('not-found', headers)
    const targetFarm = printerFarm ?? farmId
    const grants = principal.grants
      .filter((grant) => !targetFarm || grant.farmId === targetFarm)
      .filter(
        (grant) =>
          printerId === undefined ||
          grant.printerAssignmentId === null ||
          grant.printerAssignmentId === printerId,
      )
      .filter(
        (grant) => path !== '/inventory' || grant.printerAssignmentId === null,
      )
      .map((grant) => ({
        ...grant,
        scopes: grant.scopes.filter((scope) => scopes.includes(scope)),
      }))
      .filter((grant) => grant.scopes.length)
    if ((targetFarm || printerId) && !grants.length)
      return integrationProblem('not-found', headers)

    return { principal: { ...principal, scopes, grants }, headers }
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}
