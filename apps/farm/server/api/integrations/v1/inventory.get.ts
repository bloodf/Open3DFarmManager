import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from '../../../utils/integration-auth-http.ts'
import type { IntegrationPrincipal } from '../../../utils/integration-auth.ts'

export default defineEventHandler((event) => {
  const headers = event.res.headers
  const query = new URL(event.req.url).searchParams
  const limits = query.getAll('limit')
  const limit = limits[0]
  if (
    query.has('cursor') ||
    limits.length > 1 ||
    (limit !== undefined &&
      (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100))
  )
    return integrationProblem('invalid-request', headers)

  const principal = event.context.integrationAuth as IntegrationPrincipal
  if (
    !principal.grants.some(
      (grant) =>
        grant.printerAssignmentId === null &&
        grant.scopes.includes('inventory:read'),
    )
  )
    return integrationProblem('not-found', headers)

  // Spoolman snapshots currently live on the Connector. The API issues no
  // cursor until it has a server-side source of inventory snapshots.
  return { data: [], nextCursor: null }
})
