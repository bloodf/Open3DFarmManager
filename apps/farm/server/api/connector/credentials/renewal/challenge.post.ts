import { defineEventHandler } from 'nuxt/server'
import { connectorRenewalHandler } from '../../../../utils/connector-renewal/runtime.ts'
export default defineEventHandler(async (event) => {
  event.res.headers.set('Cache-Control', 'no-store')
  const handler = await connectorRenewalHandler()
  const response = await handler(event)
  event.res.status = response.status
  return response.body
})
