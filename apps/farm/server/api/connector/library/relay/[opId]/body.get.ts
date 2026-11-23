import { Readable } from 'node:stream'
import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { activeConnectorLibraryRelay } from '../../../../../utils/library/connector-relay.ts'

/** The Connector pulls the bytes of an upload it was handed; once only. */
export default defineEventHandler(async (event) => {
  const hub = activeConnectorLibraryRelay()
  if (!hub) return new Response(null, { status: 503 })
  const res = await hub.body(
    event.req.headers,
    getRouterParam(event, 'opId') ?? '',
  )
  if (res.status !== 200)
    return new Response(null, {
      status: res.status,
      headers: { 'cache-control': 'no-store' },
    })
  return new Response(Readable.toWeb(res.stream) as ReadableStream, {
    status: 200,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/octet-stream',
    },
  })
})
