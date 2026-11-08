import { defineEventHandler } from 'nuxt/server'
import { credentialRenewalHttpRuntime } from '../../../../services/credential-renewal-http-runtime.ts'
export default defineEventHandler(async (event) => {
  event.res.headers.set('Cache-Control', 'no-store')
  const handler = credentialRenewalHttpRuntime()
  if (!handler) {
    event.res.status = 503
    return { error: 'Renovação indisponível.' }
  }
  const response = await handler(event)
  event.res.status = response.status
  return response.body
})
