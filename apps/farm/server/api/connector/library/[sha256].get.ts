import { Readable } from 'node:stream'
import { defineEventHandler, getRouterParam } from 'nuxt/server'
import { connectorLibraryDownload } from '../../../utils/library/connector-download.ts'

export default defineEventHandler(async (event) => {
  const handler = connectorLibraryDownload()
  if (!handler)
    return new Response(JSON.stringify({ error: 'Biblioteca indisponível.' }), {
      status: 503,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      },
    })
  const res = await handler(
    getRouterParam(event, 'sha256') ?? '',
    event.req.headers,
  )
  if (res.body instanceof Readable)
    return new Response(Readable.toWeb(res.body) as ReadableStream, {
      status: res.status,
      headers: res.headers,
    })
  return new Response(JSON.stringify(res.body), {
    status: res.status,
    headers: { 'content-type': 'application/json', ...res.headers },
  })
})
