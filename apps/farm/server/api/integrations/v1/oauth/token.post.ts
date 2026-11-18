import { defineEventHandler } from 'nuxt/server'
import { integrationTokenRequest } from '../../../../utils/integration-auth-http.ts'
import { integrationAuthRuntime } from '../../../../utils/integration-auth-runtime.ts'

export default defineEventHandler((event) =>
  integrationTokenRequest(event.req, integrationAuthRuntime),
)
