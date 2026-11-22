import { createServer } from 'node:http'
import { once } from 'node:events'

export async function startFormlabsSimulator(reply: unknown) {
  let fault:
    'denial' | 'disconnect' | 'timeout' | 'malformed' | 'redirect' | undefined
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const route = `${request.method} ${request.url}`
    requests.push(route)
    if (
      (route !== 'GET /v1/device/list/' || body) &&
      (route !== 'POST /v1/device/discover/' ||
        body !== '{"timeout_seconds":2}')
    ) {
      response.writeHead(400).end()
      return
    }

    switch (fault) {
      case 'denial':
        response.writeHead(403).end()
        return
      case 'disconnect':
        response.destroy()
        return
      case 'timeout':
        response.writeHead(200).flushHeaders()
        response.write('{')
        return
      case 'malformed':
        response.end('{')
        return
      case 'redirect':
        response.writeHead(307, { location: '/v1/device/list/' }).end()
        return
      default:
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify(reply))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing simulator address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    setFault(next: typeof fault) {
      fault = next
    },
    setReply(next: unknown) {
      reply = next
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
