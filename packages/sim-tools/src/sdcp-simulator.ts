import { createSocket } from 'node:dgram'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'

const require = createRequire(
  new URL('../../connector/package.json', import.meta.url),
)
const { WebSocketServer } = require('ws') as typeof import('ws')

type Attributes = { MainboardID: string; MachineName: string }
type Fixture = {
  Id: string
  Data: Attributes | { Attributes: Attributes }
  fixtureStatus: Record<string, unknown>
}
type Fault = 'denied' | 'disconnect' | 'timeout' | 'malformed' | 'wrong-board'

export async function startSdcpSimulator(fixture: Fixture, fault?: Fault) {
  const { Id, Data, fixtureStatus } = fixture
  const attrs = 'Attributes' in Data ? Data.Attributes : Data
  const board = attrs.MainboardID
  const udp = createSocket('udp4')
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/websocket',
  })
  const commands: number[] = []
  const close = async () => {
    for (const peer of server.clients) peer.terminate()
    await Promise.all([
      new Promise<void>((resolve) => udp.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ])
  }
  udp.on('message', (message, sender) => {
    if (message.toString() === 'M99999') {
      udp.send(JSON.stringify({ Id, Data }), sender.port, sender.address)
    }
  })
  server.on('connection', (peer) => {
    peer.on('message', (message) => {
      const packet = JSON.parse(message.toString())
      const { Cmd, RequestID, MainboardID, From, TimeStamp } = packet.Data
      const fdm = attrs.MachineName === 'Centauri Carbon'
      commands.push(Cmd)
      if (fault === 'timeout') return
      if (fault === 'disconnect') return peer.close()
      if (fault === 'malformed') return peer.send('{')
      const denied =
        fault === 'denied' ||
        (Cmd !== 0 && Cmd !== 320) ||
        packet.Id !== (fdm ? board : Id) ||
        packet.Topic !== `sdcp/request/${board}` ||
        MainboardID !== board ||
        !/^[a-f0-9]{16}$/.test(RequestID) ||
        From !== (fdm ? 1 : 0) ||
        !Number.isInteger(TimeStamp) ||
        Math.abs(Date.now() - TimeStamp * (fdm ? 1 : 1000)) > 5000
      if (!denied && Cmd === 0) {
        peer.send(
          JSON.stringify({
            Topic: `sdcp/status/${board}`,
            MainboardID: fault === 'wrong-board' ? 'ffff' : board,
            Status: fixtureStatus,
          }),
        )
      }
      peer.send(
        JSON.stringify({
          Topic: `sdcp/response/${board}`,
          Data: {
            Cmd,
            RequestID,
            MainboardID: board,
            Data: denied
              ? { Ack: 1 }
              : Cmd === 320
                ? { Ack: 0, HistoryData: ['fixture-task'] }
                : { Ack: 0 },
          },
        }),
      )
    })
  })
  try {
    await Promise.all([
      once(udp, 'listening'),
      once(server, 'listening'),
      udp.bind(0, '127.0.0.1'),
    ])
    return {
      udpPort: udp.address().port,
      wsPort: (server.address() as AddressInfo).port,
      commands,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
