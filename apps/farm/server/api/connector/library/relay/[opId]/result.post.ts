import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { activeConnectorLibraryRelay } from '../../../../../utils/library/connector-relay.ts'

/** The Connector reports an operation's outcome (JSON) or the bytes of a read. */
export default defineEventHandler(async (event) => {
  const hub = activeConnectorLibraryRelay()
  if (!hub) return new Response(null, { status: 503 })
  const res = await hub.result(
    event.req.headers,
    getRouterParam(event, 'opId') ?? '',
    event.req.headers.get('content-type') ?? '',
    event.req.body,
  )
  return new Response(null, {
    status: res.status,
    headers: { 'cache-control': 'no-store' },
  })
})
