import dgram from 'node:dgram'
import { WebSocketServer } from 'ws'

/** Loopback-only SDCP v3 test double; never connects to a printer. */
export async function startSdcpSimulator() {
  const udp = dgram.createSocket('udp4')
  const ws = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/websocket',
  })
  await Promise.all([
    new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve)),
    new Promise<void>((resolve) => ws.once('listening', resolve)),
  ])
  const requests: unknown[] = []
  let response: unknown
  ws.on('connection', (client) =>
    client.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString())
        requests.push(message)
        if (message.Data?.Cmd === 0 && response !== undefined)
          client.send(JSON.stringify(response))
      } catch {}
    }),
  )
  const discovery = {
    Id: 'fixture',
    Data: {
      Name: 'Test',
      MachineName: 'Saturn 4 Ultra',
      MainboardIP: '127.0.0.1',
      MainboardID: 'fixture01',
      ProtocolVersion: 'V3.0.0',
      FirmwareVersion: 'V1.0.0',
    },
  }
  udp.on('message', (message, peer) => {
    if (message.toString() === 'M99999')
      udp.send(JSON.stringify(discovery), peer.port, peer.address)
  })
  return {
    discoveryPort: udp.address().port,
    websocketPort: (ws.address() as { port: number }).port,
    discovery,
    requests,
    setStatus(value: unknown) {
      response = value
    },
    publish(message: unknown) {
      for (const client of ws.clients) client.send(JSON.stringify(message))
    },
    connected: () => ws.clients.size,
    async close() {
      for (const client of ws.clients) client.terminate()
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => ws.close(() => resolve())),
      ])
    },
  }
}
