import {
  MAX_API_QUERY_ITEMS,
  MAX_API_QUERY_PAGE,
  apiQueryScopes,
  type ApiQueryKind,
} from '../../../../packages/farm-protocol/src/api-query.ts'
import type { SignallingRuntime } from '../services/signalling-runtime.ts'
import {
  integrationGrantFor,
  integrationProblem,
} from './integration-auth-http.ts'
import {
  uuidPattern,
  type IntegrationAuthStore,
  type IntegrationPrincipal,
} from './integration-auth.ts'

export async function readIntegrationApiQuery(input: {
  request: Request
  headers?: HeadersInit
  principal: IntegrationPrincipal
  printerId: string
  kind: ApiQueryKind
  store: Pick<IntegrationAuthStore, 'readPrinter'>
  inbox?: Pick<SignallingRuntime, 'queryAgentInbox'> | undefined
}): Promise<Response> {
  const { request, headers, principal, kind, store, inbox } = input
  const printerId = input.printerId.toLowerCase()
  const scope = apiQueryScopes[kind]
  if (!principal.scopes.includes(scope))
    return integrationProblem('insufficient-scope', headers)
  if (!uuidPattern.test(printerId))
    return integrationProblem('not-found', headers)

  const params = new URL(request.url).searchParams
  const limits = params.getAll('limit')
  const cursors = params.getAll('cursor')
  const limit = limits[0] === undefined ? 50 : Number(limits[0])
  if (
    limits.length > 1 ||
    cursors.length > 1 ||
    (limits[0] !== undefined && !/^\d+$/.test(limits[0])) ||
    limit < 1 ||
    limit > MAX_API_QUERY_PAGE
  ) {
    return integrationProblem('invalid-request', headers)
  }
  const cursor = cursors[0]
  let offset = 0
  if (cursor !== undefined) {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor))
      return integrationProblem('invalid-request', headers)
    const decoded = Buffer.from(cursor, 'base64url').toString()
    const prefix = `${printerId}:${kind}:`
    offset = Number(decoded.slice(prefix.length))
    if (
      !Number.isInteger(offset) ||
      offset < 1 ||
      offset >= MAX_API_QUERY_ITEMS ||
      cursor !== encodeCursor(printerId, kind, offset)
    ) {
      return integrationProblem('invalid-request', headers)
    }
  }
  if (!store.readPrinter)
    return integrationProblem('service-unavailable', headers)
  const row = await store.readPrinter(printerId)
  if (!row || !integrationGrantFor(principal, scope, row.farmId, row.id))
    return integrationProblem('not-found', headers)
  if (!inbox || !row.agentId)
    return integrationProblem('connector-unavailable', headers)
  const result = await inbox.queryAgentInbox(
    row.farmId,
    row.agentId,
    {
      assignment_id: row.id,
      kind,
      offset,
      limit,
    },
    request.signal,
  )
  if (result.kind === 'error') return integrationProblem(result.error, headers)
  const responseHeaders = new Headers(headers)
  responseHeaders.set('cache-control', 'no-store')
  return Response.json(
    {
      data: result.data,
      nextCursor:
        result.nextOffset === null
          ? null
          : encodeCursor(printerId, kind, result.nextOffset),
    },
    { headers: responseHeaders },
  )
}

function encodeCursor(printerId: string, kind: ApiQueryKind, offset: number) {
  return Buffer.from(`${printerId}:${kind}:${offset}`).toString('base64url')
}
