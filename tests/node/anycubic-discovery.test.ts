import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import dgram from 'node:dgram'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'

test('discovers LAN Anycubic via mDNS and info', async () => {
  const server = http.createServer((_req, res) =>
    res.end(
      JSON.stringify({
        ctrlType: 'lan',
        token: 'token',
        ctrlInfoUrl: '/ctrl',
        modelId: 'K3',
        cn: 'serial',
        modelName: 'Kobra 3',
        deviceType: 'fdm',
      }),
    ),
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw Error('no address')
  const udp = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
  const label = (s: string) =>
    Buffer.concat([
      ...s
        .split('.')
        .map((x) => Buffer.concat([Buffer.from([x.length]), Buffer.from(x)])),
      Buffer.from([0]),
    ])
  const name = label('_services._dns-sd._udp.local')
  const target = label('_test._tcp.local')
  const header = Buffer.alloc(10)
  header.writeUInt16BE(12)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(target.length, 8)
  const packet = Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
    name,
    header,
    target,
  ])
  udp.on('message', (_msg, peer) => udp.send(packet, peer.port, peer.address))
  try {
    const found = await discoverPrinters({
      timeout: 100,
      bambuPorts: [],
      mdnsPort: 0,
      bindAddress: '127.0.0.1',
      queryAddress: '127.0.0.1',
      queryPort: udp.address().port,
      anycubicPort: addr.port,
    })
    assert.deepEqual(
      found.find((p) => p.vendor === 'anycubic'),
      {
        vendor: 'anycubic',
        host: '127.0.0.1',
        port: addr.port,
        serial: 'serial',
        model: 'K3',
        name: 'Kobra 3',
      },
    )
  } finally {
    udp.close()
    server.close()
  }
})
