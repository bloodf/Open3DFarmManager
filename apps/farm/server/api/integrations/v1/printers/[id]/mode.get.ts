import { defineEventHandler } from 'nuxt/server'
import { PostgresFleetMode } from '../../../../../storage/fleet-mode-postgres.ts'
import { integrationProblem } from '../../../../../utils/integration-auth-http.ts'
import {
  integrationAuthPool,
  integrationAuthRuntime,
} from '../../../../../utils/integration-auth-runtime.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'
import { readFleetMode } from '../../../../../utils/integration-fleet-mode.ts'

export default defineEventHandler(async (event) => {
  const { headers } = event.res
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    const reader = integrationAuthRuntime().store
    if (!reader.readPrinter)
      return integrationProblem('service-unavailable', headers)
    const result = await readFleetMode(
      principal,
      reader.readPrinter.bind(reader),
      new PostgresFleetMode(integrationAuthPool()),
      event.context.params?.id?.toLowerCase() ?? '',
    )
    if (!result) return integrationProblem('not-found', headers)
    headers.set('cache-control', 'no-store')
    return result
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
