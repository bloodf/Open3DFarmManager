import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  url: URL
  port: number
  stop: () => Promise<void>
}

// Minimal node:http stand-in for the former Bun.serve test fixtures.
// The handler speaks standard Fetch API; the returned server exposes the
// same `url`/`stop(true)` surface the tests used under Bun.
export function serveTestServer(
  handler: (request: Request) => Response | Promise<Response>,
): TestServer {
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
              method: req.method,
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
  server.listen(0, '127.0.0.1')
  const { port } = server.address() as AddressInfo
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
