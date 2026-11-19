import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { execFileSync } from 'node:child_process'
import {
  decodeDns,
  discoverPrinters,
  encodeQuery,
  moonrakerPrinters,
  parseBambu,
} from '../../packages/connector/src/discovery/index.ts'
import { main } from '../../scripts/discover-printers.ts'

const fixture = Buffer.from(
  'NOTIFY * HTTP/1.1\r\nLocation: http://192.168.1.42:2021/\r\nUSN: uuid:ABC123\r\nDevModel.bambu.com: BL-P001\r\nDevName.bambu.com: Oficina\r\nDevConnect.bambu.com: lan\r\nDevBind.bambu.com: free\r\n\r\n',
)
const name = (s: string) =>
  Buffer.concat([
    ...s
      .split('.')
      .map((part) =>
        Buffer.concat([Buffer.from([part.length]), Buffer.from(part)]),
      ),
    Buffer.from([0]),
  ])
const record = (owner: string, type: number, data: Buffer) => {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type)
  header.writeUInt16BE(1, 2)
  header.writeUInt16BE(data.length, 8)
  return Buffer.concat([name(owner), header, data])
}
const service = '_moonraker._tcp.local'
const instance = `printer.${service}`
const srv = Buffer.concat([
  Buffer.from([0, 0, 0, 0, 0x1b, 0xd1]),
  name('printer.local'),
])
const response = Buffer.concat([
  Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 4, 0, 0, 0, 0]),
  record(service, 12, name(instance)),
  record(instance, 33, srv),
  record(instance, 16, Buffer.from([3, 120, 61, 49])),
  record('printer.local', 1, Buffer.from([127, 0, 0, 1])),
])

test('Bambu SSDP validates input', () => {
  assert.deepEqual(parseBambu(fixture), {
    vendor: 'bambu',
    host: '192.168.1.42',
    serial: 'ABC123',
    model: 'BL-P001',
    name: 'Oficina',
  })
  assert.equal(parseBambu(Buffer.alloc(8193)), undefined)
  assert.equal(
    parseBambu(
      Buffer.from('NOTIFY * HTTP/1.1\r\nLocation: http://example.com\r\n\r\n'),
    ),
    undefined,
  )
  assert.equal(parseBambu(Buffer.from('bad')), undefined)
})
test('DNS query and responses, including compression loops', () => {
  assert.deepEqual(decodeDns(encodeQuery()), [])
  assert.deepEqual(moonrakerPrinters(decodeDns(response)), [
    { vendor: 'moonraker', host: '127.0.0.1', port: 7121, name: 'printer' },
  ])
  assert.deepEqual(
    decodeDns(
      Buffer.from([
        0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 0x0c, 0, 12, 0, 1,
      ]),
    ),
    [],
  )
})
test('discovers both protocols over loopback', async () => {
  const responder = dgram.createSocket('udp4')
  await new Promise<void>((resolve) => responder.bind(0, '127.0.0.1', resolve))
  const address = responder.address()
  responder.on('message', (_msg, peer) =>
    responder.send(response, peer.port, peer.address),
  )
  const port = address.port
  const found = discoverPrinters({
    timeout: 150,
    bindAddress: '127.0.0.1',
    bambuPorts: [port + 1],
    mdnsPort: 0,
    queryAddress: '127.0.0.1',
    queryPort: port,
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  responder.send(fixture, port + 1, '127.0.0.1')
  try {
    assert.deepEqual((await found).map((p) => p.vendor).sort(), [
      'bambu',
      'moonraker',
    ])
  } finally {
    responder.close()
  }
})
test('CLI help and JSON', async (t) => {
  assert.match(
    execFileSync(process.execPath, ['scripts/discover-printers.ts', '--help'], {
      encoding: 'utf8',
    }),
    /--timeout/,
  )
  // Real discovery binds 0.0.0.0 and sends LAN multicast; inject an in-process
  // mock so the JSON path is exercised without leaving the process.
  const requested: unknown[] = []
  const written: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: string) => {
    written.push(chunk)
    return true
  })
  const status = await main(['--timeout', '30'], async (options) => {
    requested.push(options)
    return [{ vendor: 'moonraker', host: '127.0.0.1', port: 7125 }]
  })
  t.mock.restoreAll()
  assert.equal(status, 0)
  assert.deepEqual(requested, [{ timeout: 30 }])
  assert.ok(Array.isArray(JSON.parse(written.join(''))))
  assert.equal(
    await main(['--timeout', 'abc'], () => {
      throw Error('discovery must not run for rejected arguments')
    }),
    2,
  )
})
