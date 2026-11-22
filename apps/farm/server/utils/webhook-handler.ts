import { defineEventHandler } from 'nuxt/server'
import { integrationProblem } from './integration-auth-http.ts'
import type { IntegrationPrincipal } from './integration-auth.ts'
import { integrationAuthPool } from './integration-auth-runtime.ts'
import { webhookRequest } from '../services/webhook-http.ts'
import { PostgresWebhooks } from '../storage/webhook-postgres.ts'
import { useRuntimeConfig } from 'nuxt/server'
import { credentialKeyring } from './sealed-credential-key.ts'

export const webhookHandler = defineEventHandler(async (event) => {
  const headers = event.res.headers
  const principal = event.context.integrationAuth as IntegrationPrincipal
  try {
    return await webhookRequest(
      event.req,
      principal,
      new PostgresWebhooks(
        integrationAuthPool(),
        credentialKeyring(useRuntimeConfig().auth ?? {}),
      ),
      headers,
      event.context.params?.webhookId,
    )
  } catch {
    return integrationProblem('service-unavailable', headers)
  }
})
