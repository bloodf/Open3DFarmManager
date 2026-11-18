import { defineEventHandler } from 'nuxt/server'
import {
  authorizeIntegrationRequest,
  integrationPath,
} from '../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../utils/integration-auth-runtime.ts'

export default defineEventHandler(async (event) => {
  const path = integrationPath(new URL(event.req.url))
  if (path === null || path === '/openapi.json' || path === '/oauth/token')
    return

  const result = await authorizeIntegrationRequest(
    event.req,
    path,
    integrationAuthRuntime,
  )
  if (result instanceof Response) return result
  for (const [name, value] of Object.entries(result.headers))
    event.res.headers.set(name, value)
  event.context.integrationAuth = result.principal
})
