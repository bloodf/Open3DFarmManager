// This simulator's responses are made up from docs/protocols/creality-discovery.md.
export function crealityDiscoveryResponse(): Buffer {
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
  return Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0]),
    name('_services._dns-sd._udp.local'),
    header,
    target,
  ])
}
