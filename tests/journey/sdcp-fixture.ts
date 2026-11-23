import dgram from 'node:dgram'
import { WebSocketServer } from 'ws'

export async function startSdcpFixture() {
  const udp = dgram.createSocket('udp4')
  const ws = new WebSocketServer({
    host: '127.0.0.1',
    port: 3030,
    path: '/websocket',
  })
  let online = true
  let layer = 25
  const status = () => ({
    MainboardID: 'journey01',
    Topic: 'sdcp/status/journey01',
    Status: {
      CurrentStatus: [1],
      PrintInfo: {
        Status: 1,
        ErrorNumber: 0,
        CurrentLayer: layer,
        TotalLayer: 100,
      },
    },
  })
  udp.on('message', (data, peer) => {
    if (online && data.toString() === 'M99999')
      udp.send(
        JSON.stringify({
          Id: 'fixture',
          Data: {
            Name: 'Journey',
            MachineName: 'Saturn 4 Ultra',
            MainboardIP: '127.0.0.1',
            MainboardID: 'journey01',
            ProtocolVersion: 'V3.0.0',
            FirmwareVersion: 'V1.0.0',
          },
        }),
        peer.port,
        peer.address,
      )
  })
  ws.on('connection', (client) =>
    client.on('message', () => {
      if (online) client.send(JSON.stringify(status()))
    }),
  )
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      udp.once('error', reject)
      udp.bind(3000, '127.0.0.1', resolve)
    }),
    new Promise<void>((resolve, reject) => {
      ws.once('error', reject)
      ws.once('listening', resolve)
    }),
  ])
  return {
    setOnline(value: boolean) {
      online = value
      if (!value) for (const client of ws.clients) client.terminate()
    },
    setProgress(value: number) {
      layer = value
    },
    async close() {
      for (const client of ws.clients) client.terminate()
      await Promise.all([
        new Promise<void>((resolve) => udp.close(() => resolve())),
        new Promise<void>((resolve) => ws.close(() => resolve())),
      ])
    },
  }
}
