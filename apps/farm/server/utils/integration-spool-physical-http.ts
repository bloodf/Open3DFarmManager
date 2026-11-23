import type { RequestEvent } from 'nuxt/server'
import type { ZodType } from 'zod'
import {
  integrationProblem,
  PayloadTooLarge,
  readText,
} from './integration-auth-http.ts'
import { uuidPattern, type IntegrationPrincipal } from './integration-auth.ts'

export function physicalSpoolAccess(
  event: RequestEvent,
  principal: IntegrationPrincipal,
  scope: 'inventory:read' | 'inventory:write',
  grantedFarms: string[],
) {
  const query = new URL(event.req.url).searchParams
  const fields = [...query.keys()]
  const farmId = query.get('farmId')?.toLowerCase()
  if (fields.length !== 1 || !farmId || !uuidPattern.test(farmId))
    return integrationProblem('invalid-request', event.res.headers)
  if (!grantedFarms.includes(farmId))
    return integrationProblem('not-found', event.res.headers)
  const grantIds = principal.grants
    .filter(
      (grant) =>
        grant.farmId === farmId &&
        grant.printerAssignmentId === null &&
        grant.scopes.includes(scope),
    )
    .map((grant) => grant.id)
  return grantIds.length
    ? { appId: principal.appId, farmId, scope, grantIds }
    : integrationProblem('not-found', event.res.headers)
}

export async function physicalSpoolBody<T>(
  event: RequestEvent,
  schema: ZodType<T>,
) {
  const { req, res } = event
  if (
    req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
      'application/json' ||
    req.headers.has('content-encoding')
  )
    return integrationProblem('unsupported-media-type', res.headers)
  try {
    const body = schema.safeParse(JSON.parse(await readText(req, 8192)))
    if (body.success) return body.data
  } catch (error) {
    if (error instanceof PayloadTooLarge)
      return integrationProblem('payload-too-large', res.headers)
  }
  return integrationProblem('invalid-request', res.headers)
}
