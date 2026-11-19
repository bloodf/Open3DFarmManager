import { defineEventHandler } from 'nuxt/server'
import { activeConnectorLibraryRelay } from '../../../../utils/library/connector-relay.ts'

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })

/** The Connector asks for its next library operation (long poll). */
export default defineEventHandler(async (event) => {
  const hub = activeConnectorLibraryRelay()
  if (!hub) return json(503, { error: 'Biblioteca indisponível.' })
  let polled
  try {
    polled = await hub.poll(event.req.headers, event.req.signal)
  } catch {
    return json(503, { error: 'Biblioteca indisponível.' })
  }
  if (!polled) return json(403, { error: 'Acesso negado.' })
  if (!polled.op)
    return new Response(null, {
      status: 204,
      headers: { 'cache-control': 'no-store' },
    })
  return json(200, { op: polled.op })
})
