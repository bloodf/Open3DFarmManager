import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'

export async function startFlashforgeSimulator(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: Buffer,
  ) => void,
  discoveryPid = 36,
) {
  const host = '127.0.0.1'
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      handler(req, res, Buffer.concat(chunks))
    } catch (error) {
      res.destroy(error instanceof Error ? error : undefined)
    }
  })
  const udp = createSocket('udp4')
  udp.on('message', (_data, sender) => {
    const packet = Buffer.alloc(280)
    packet.writeUInt16BE(0x2b71, 0x86)
    packet.writeUInt16BE(discoveryPid, 0x88)
    packet.writeUInt16BE(8898, 0x8e)
    packet.write('FIXTURE-SERIAL', 0x92)
    udp.send(packet, sender.port, sender.address)
  })
  await Promise.all([
    once(server.listen(0, host), 'listening'),
    once(udp.bind(0, host), 'listening'),
  ])
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing simulator address')
  return {
    host,
    port: address.port,
    discoveryPort: udp.address().port,
    async close() {
      await Promise.all([
        new Promise<void>((resolve) => udp.close(resolve)),
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
          server.closeAllConnections()
        }),
      ])
    },
  }
}
