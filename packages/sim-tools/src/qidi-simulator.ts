import { createServer } from 'node:http'
import { once } from 'node:events'

/** Moonraker HTTP simulator. Its ephemeral listener is loopback-only. */
export async function startQidiSimulator(fixtures: {
  info: unknown
  state: unknown
  history: unknown
  snapshot: Uint8Array
}) {
  let fault: 'disconnect' | 'timeout' | 'malformed' | undefined
  const requests: string[] = []
  const uploads: string[] = []
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (
      request.headers['x-api-key'] !== 'fixture-key' &&
      request.headers.authorization !== 'Bearer fixture-token'
    ) {
      response.writeHead(401).end()
      return
    }
    switch (fault) {
      case 'disconnect':
        request.socket.destroy()
        return
      case 'timeout':
        return
      case 'malformed':
        response.writeHead(200, { 'content-type': 'application/json' }).end('{')
        return
    }
    if (request.method === 'POST' && request.url === '/server/files/upload') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk)
      uploads.push(Buffer.concat(chunks).toString())
      response
        .writeHead(201, { 'content-type': 'application/json' })
        .end(JSON.stringify({ result: { print_started: false } }))
      return
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end()
      return
    }
    if (request.url === '/webcam/?action=snapshot') {
      response
        .writeHead(200, { 'content-type': 'image/jpeg' })
        .end(fixtures.snapshot)
      return
    }
    const payloads: Record<string, unknown> = {
      '/server/info': fixtures.info,
      '/printer/objects/query?webhooks&print_stats&virtual_sdcard&extruder&heater_bed&fan':
        fixtures.state,
      '/server/history/list?limit=50&order=desc': fixtures.history,
    }
    const path = request.url ?? ''
    const payload = Object.hasOwn(payloads, path) ? payloads[path] : undefined
    if (payload === undefined) {
      response.writeHead(404).end()
      return
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify(payload))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    uploads,
    setFault(value: typeof fault) {
      fault = value
    },
    close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      server.closeAllConnections()
      return closed
    },
  }
}
