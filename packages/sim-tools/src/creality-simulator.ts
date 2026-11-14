import { createRequire } from 'node:module'
const { WebSocketServer } = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)('ws') as typeof import('../../connector/node_modules/ws/index.js')

export async function createCrealitySimulator(frame: object = { state: 0 }) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  const received: string[] = []
  server.on('connection', (socket) => {
    socket.on('message', (data) => received.push(data.toString()))
    socket.send(JSON.stringify(frame))
  })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing address')
  return {
    port: address.port,
    received,
    disconnect() {
      for (const socket of server.clients) socket.terminate()
    },
    async close() {
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
