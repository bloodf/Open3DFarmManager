import { defineEventHandler } from 'nuxt/server'
import { readIntegrationDispatch } from '../../../../../utils/integration-jobs-dispatch.ts'
import type { IntegrationPrincipal } from '../../../../../utils/integration-auth.ts'

export default defineEventHandler((event) =>
  readIntegrationDispatch({
    request: event.req,
    headers: event.res.headers,
    principal: event.context.integrationAuth as IntegrationPrincipal,
    jobId: event.context.params?.id ?? '',
    view: 'eligibility',
  }),
)
