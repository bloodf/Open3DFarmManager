import { defineEventHandler } from 'nuxt/server'
import { activeConnectorLibraryRelay } from '../../../../utils/library/connector-relay.ts'

/** The Connector reports its library quota and usage. */
export default defineEventHandler(async (event) => {
  const hub = activeConnectorLibraryRelay()
  if (!hub) return new Response(null, { status: 503 })
  const res = await hub.storage(event.req.headers, event.req.body)
  return new Response(null, {
    status: res.status,
    headers: { 'cache-control': 'no-store' },
  })
})
