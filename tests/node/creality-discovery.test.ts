import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import http from 'node:http'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'

const name = (value: string) =>
  Buffer.concat([
    ...value
      .split('.')
      .map((part) =>
        Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
      ),
    Buffer.from([0]),
  ])
const target = name('_creality._tcp.local')
const header = Buffer.alloc(10)
header.writeUInt16BE(12)
header.writeUInt16BE(1, 2)
header.writeUInt16BE(target.length, 8)
const response = Buffer.concat([
  Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
  name('_services._dns-sd._udp.local'),
  header,
  target,
])

test('discovers and deduplicates a Creality printer over loopback', async () => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/info')
    res.end(JSON.stringify({ model: 'K1', mac: 'AA:BB' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const udp = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
  udp.on('message', (_packet, peer) => {
    udp.send(response, peer.port, peer.address)
    udp.send(response, peer.port, peer.address)
  })
  try {
    const printers = await discoverPrinters({
      timeout: 100,
      bindAddress: '127.0.0.1',
      bambuPorts: [],
      mdnsPort: 0,
      queryAddress: '127.0.0.1',
      queryPort: udp.address().port,
      crealityPorts: { https: port, http: port },
    })
    assert.deepEqual(printers, [
      { vendor: 'creality', host: '127.0.0.1', model: 'K1', serial: 'AA:BB' },
    ])
  } finally {
    udp.close()
    server.close()
  }
})
