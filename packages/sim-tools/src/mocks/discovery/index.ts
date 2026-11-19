// SPDX-License-Identifier: MIT
import dgram from 'node:dgram'
import { once } from 'node:events'
import { anycubicDiscoveryMdnsResponse } from '../../anycubic-discovery-sim.ts'
import { crealityDiscoveryResponse } from '../../creality-discovery-sim.ts'

const loopback = '127.0.0.1'
const service = '_moonraker._tcp.local'
const instance = `mock-printer.${service}`
const hostname = 'mock-printer.local'

function dnsName(value: string): Buffer {
  const labels = value
    .split('.')
    .map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
    )
  return Buffer.concat([...labels, Buffer.alloc(1)])
}

function dnsRecord(owner: string, type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(10)
  header.writeUInt16BE(type)
  header.writeUInt16BE(1, 2)
  header.writeUInt32BE(120, 4)
  header.writeUInt16BE(data.length, 8)
  return Buffer.concat([dnsName(owner), header, data])
}

function moonrakerReply(port: number): Buffer {
  const srv = Buffer.alloc(6)
  srv.writeUInt16BE(port, 4)
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0]),
    dnsRecord(service, 12, dnsName(instance)),
    dnsRecord(instance, 33, Buffer.concat([srv, dnsName(hostname)])),
    dnsRecord(hostname, 1, Buffer.from([127, 0, 0, 1])),
  ])
}

const bambuNotify = Buffer.from(
  [
    'NOTIFY * HTTP/1.1',
    'LOCATION: http://127.0.0.1/',
    'NT: urn:bambulab-com:device:3dprinter:1',
    'NTS: ssdp:alive',
    'USN: uuid:synthetic-bambu',
    'DevModel.bambu.com: BL-P001',
    'DevName.bambu.com: Mock Bambu',
    '',
    '',
  ].join('\r\n'),
)

export async function startDiscoveryResponder(moonrakerPort: number) {
  const socket = dgram.createSocket('udp4')
  const mdns = moonrakerReply(moonrakerPort)
  const creality = crealityDiscoveryResponse()
  const anycubic = anycubicDiscoveryMdnsResponse()
  socket.on('message', (packet, peer) => {
    if (peer.address !== loopback) return
    if (packet.includes(dnsName(service))) {
      socket.send(mdns, peer.port, loopback)
    } else if (packet.includes(dnsName('_services._dns-sd._udp.local'))) {
      socket.send(creality, peer.port, loopback)
      socket.send(anycubic, peer.port, loopback)
    }
  })
  const ready = once(socket, 'listening')
  socket.bind(0, loopback)
  try {
    await ready
    return {
      port: socket.address().port,
      notifyBambu: (port: number) => socket.send(bambuNotify, port, loopback),
      close: () => new Promise<void>((resolve) => socket.close(resolve)),
    }
  } catch (error) {
    socket.close()
    throw error
  }
}
