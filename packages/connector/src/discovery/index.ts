import dgram from 'node:dgram'
import { isIPv4 } from 'node:net'

export type Printer = {
  vendor: 'bambu' | 'moonraker'
  host: string
  port?: number
  serial?: string
  model?: string
  name?: string
}

const service = '_moonraker._tcp.local'
const clean = (value: string | undefined) =>
  value && value.length <= 128 && /^[\x20-\x7e]+$/.test(value)
    ? value
    : undefined

export function parseBambu(packet: Buffer): Printer | undefined {
  if (packet.length > 8192 || packet.length === 0) return
  const lines = packet.toString('utf8').split(/\r?\n/)
  if (!/^NOTIFY \* HTTP\/1\.1$/i.test(lines.shift() ?? '')) return
  const headers = new Map<string, string>()
  for (const line of lines) {
    if (!line) break
    const colon = line.indexOf(':')
    if (colon < 1 || line.length > 1024) return
    const key = line.slice(0, colon).trim().toLowerCase()
    if (headers.has(key)) return
    headers.set(key, line.slice(colon + 1).trim())
  }
  try {
    const location = new URL(headers.get('location') ?? '')
    if (!isIPv4(location.hostname)) return
    const usn = headers
      .get('usn')
      ?.split('::')[0]
      ?.replace(/^uuid:/i, '')
    const serial = clean(usn)
    const model = clean(headers.get('devmodel.bambu.com'))
    const name = clean(headers.get('devname.bambu.com'))
    return {
      vendor: 'bambu',
      host: location.hostname,
      ...(serial && { serial }),
      ...(model && { model }),
      ...(name && { name }),
    }
  } catch {
    return
  }
}

export function encodeQuery(): Buffer {
  const labels = service
    .split('.')
    .map((label) =>
      Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]),
    )
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    ...labels,
    Buffer.from([0, 0, 12, 0, 1]),
  ])
}

type RecordData = { name: string; type: number; value: string; port?: number }
function readName(buf: Buffer, start: number): { name: string; next: number } {
  let pos = start,
    next = -1,
    length = 0
  const labels: string[] = [],
    seen = new Set<number>()
  while (true) {
    if (pos >= buf.length || seen.has(pos)) throw Error('invalid DNS name')
    seen.add(pos)
    const n = buf[pos++]!
    if ((n & 0xc0) === 0xc0) {
      if (pos >= buf.length) throw Error('truncated pointer')
      const target = ((n & 0x3f) << 8) | buf[pos++]!
      if (next < 0) next = pos
      pos = target
    } else if (n === 0) {
      return {
        name: labels.join('.').toLowerCase(),
        next: next < 0 ? pos : next,
      }
    } else {
      if (n > 63 || pos + n > buf.length || (length += n + 1) > 255)
        throw Error('invalid label')
      labels.push(buf.subarray(pos, pos + n).toString('utf8'))
      pos += n
    }
  }
}

export function decodeDns(buf: Buffer): RecordData[] {
  if (buf.length < 12 || buf.length > 9000) return []
  try {
    const questions = buf.readUInt16BE(4)
    const count =
      buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10)
    if (questions + count > 512) return []
    let pos = 12
    for (let i = 0; i < questions; i++) {
      pos = readName(buf, pos).next + 4
      if (pos > buf.length) throw Error('question')
    }
    const records: RecordData[] = []
    for (let i = 0; i < count; i++) {
      const owner = readName(buf, pos)
      pos = owner.next
      if (pos + 10 > buf.length) throw Error('record')
      const type = buf.readUInt16BE(pos),
        size = buf.readUInt16BE(pos + 8)
      pos += 10
      const end = pos + size
      if (end > buf.length) throw Error('data')
      if (type === 12) {
        const target = readName(buf, pos)
        if (target.next > end) throw Error('ptr')
        records.push({ name: owner.name, type, value: target.name })
      } else if (type === 33 && size >= 7) {
        const target = readName(buf, pos + 6)
        if (target.next > end) throw Error('srv')
        records.push({
          name: owner.name,
          type,
          value: target.name,
          port: buf.readUInt16BE(pos + 4),
        })
      } else if (type === 1 && size === 4) {
        records.push({
          name: owner.name,
          type,
          value: [...buf.subarray(pos, end)].join('.'),
        })
      } else if (type === 16) {
        let p = pos
        while (p < end) {
          const n = buf[p++]!
          if (p + n > end) throw Error('txt')
          records.push({
            name: owner.name,
            type,
            value: buf.subarray(p, p + n).toString('utf8'),
          })
          p += n
        }
      }
      pos = end
    }
    return records
  } catch {
    return []
  }
}

export function moonrakerPrinters(records: RecordData[]): Printer[] {
  const result: Printer[] = []
  for (const ptr of records.filter(
    (r) => r.type === 12 && r.name === service,
  )) {
    for (const srv of records.filter(
      (r) => r.type === 33 && r.name === ptr.value && r.port,
    )) {
      for (const a of records.filter(
        (r) => r.type === 1 && r.name === srv.value && isIPv4(r.value),
      )) {
        const name = clean(
          ptr.value.endsWith('.' + service)
            ? ptr.value.slice(0, -service.length - 1)
            : undefined,
        )
        result.push({
          vendor: 'moonraker',
          host: a.value,
          ...(srv.port !== undefined && { port: srv.port }),
          ...(name && { name }),
        })
      }
    }
  }
  return result
}

type Options = {
  timeout?: number
  bindAddress?: string
  bambuPorts?: number[]
  mdnsPort?: number
  queryAddress?: string
  queryPort?: number
  createSocket?: () => dgram.Socket
}
export async function discoverPrinters(
  options: Options = {},
): Promise<Printer[]> {
  const timeout = options.timeout ?? 3000
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60000)
    throw Error('invalid timeout')
  const sockets: dgram.Socket[] = [],
    records: RecordData[] = [],
    printers: Printer[] = []
  const factory =
    options.createSocket ??
    (() => dgram.createSocket({ type: 'udp4', reuseAddr: true }))
  const bind = (port: number, mdns: boolean) =>
    new Promise<void>((resolve, reject) => {
      const socket = factory()
      sockets.push(socket)
      socket.on('error', reject)
      socket.on('message', (packet) => {
        if (mdns) {
          if (records.length < 2048)
            records.push(...decodeDns(packet).slice(0, 2048 - records.length))
        } else {
          const printer = parseBambu(packet)
          if (printer && printers.length < 2048) printers.push(printer)
        }
      })
      socket.bind(port, options.bindAddress ?? '0.0.0.0', () => {
        if (mdns) {
          if (!options.queryAddress) {
            try {
              socket.addMembership('224.0.0.251')
            } catch (error) {
              reject(error)
              return
            }
          }
          socket.send(
            encodeQuery(),
            options.queryPort ?? 5353,
            options.queryAddress ?? '224.0.0.251',
            (error) => (error ? reject(error) : resolve()),
          )
        } else resolve()
      })
    })
  try {
    await Promise.all([
      ...(options.bambuPorts ?? [2021, 1990]).map((port) => bind(port, false)),
      bind(options.mdnsPort ?? 5353, true),
    ])
    await new Promise((resolve) => setTimeout(resolve, timeout))
    const unique = new Map<string, Printer>()
    for (const printer of [...printers, ...moonrakerPrinters(records)])
      unique.set(
        `${printer.vendor}:${printer.serial ?? printer.host}:${printer.port ?? ''}`,
        printer,
      )
    return [...unique.values()]
  } finally {
    for (const socket of sockets) {
      try {
        socket.close()
      } catch {}
    }
  }
}
