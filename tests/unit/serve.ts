import { createServer, type Server } from 'node:http'
import { once } from 'node:events'

export interface TestServer {
  url: URL
  port: number
  stop: () => Promise<void>
}

// HTTP fixture with a Fetch API handler and explicit connection cleanup.
export async function serveTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<TestServer> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      void (async () => {
        try {
          const headers = new Headers()
          for (const [name, value] of Object.entries(req.headers)) {
            if (Array.isArray(value))
              for (const item of value) headers.append(name, item)
            else if (value !== undefined) headers.set(name, value)
          }
          const hasBody = !['GET', 'HEAD'].includes(req.method ?? '')
          const request = new Request(
            `http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`,
            {
              method: req.method ?? 'GET',
              headers,
              ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
            },
          )
          const response = await handler(request)
          res.writeHead(
            response.status,
            Object.fromEntries(response.headers.entries()),
          )
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (error) {
          res.writeHead(500)
          res.end()
          console.error(error)
        }
      })()
    })
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  } catch (error) {
    server.closeAllConnections()
    server.close()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw Error('Missing fixture port')
  }
  const { port } = address
  return {
    url: new URL(`http://127.0.0.1:${port}`),
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
