import { createServer } from 'node:http'

/** Loopback-only PreForm host test double. */
export async function startFormlabsSimulator() {
  const requests: string[] = []
  let response: unknown = { count: 0, devices: [] }
  let status = 200
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`)
    if (req.method !== 'GET' || req.url !== '/devices/') {
      res.writeHead(404).end()
      return
    }
    res
      .writeHead(status, { 'content-type': 'application/json' })
      .end(JSON.stringify(response))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    requests,
    setResponse(value: unknown, code = 200) {
      response = value
      status = code
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
