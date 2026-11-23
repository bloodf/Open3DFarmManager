import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'

export async function startPrusaSimulator(reply: RequestListener) {
  const server = createServer(reply)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
