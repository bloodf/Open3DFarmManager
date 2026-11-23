import type { RequestEvent } from 'nuxt/server'
import { integrationProblem } from './integration-auth-http.ts'
import { integrationAuthPool } from './integration-auth-runtime.ts'
import type { IntegrationPrincipal } from './integration-auth.ts'
import { postgresResinReader } from './integration-resin-postgres.ts'
import type { IntegrationResinReader } from './integration-resin.ts'

type Result = { error: 'invalid-request' | 'not-found' } | object

/** Shared handler body for the three resin reads. */
export async function resinResponse(
  event: Pick<RequestEvent, 'req' | 'res' | 'context'>,
  read: (
    principal: IntegrationPrincipal,
    reader: IntegrationResinReader,
    query: URLSearchParams,
  ) => Promise<Result>,
) {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const result = await read(
      principal,
      postgresResinReader(integrationAuthPool()),
      new URL(event.req.url).searchParams,
    )
    if ('error' in result)
      return integrationProblem(result.error as never, headers)
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
}
