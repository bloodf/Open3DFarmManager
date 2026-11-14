import { connect, type TLSSocket } from 'node:tls'
import { createHash } from 'node:crypto'
import type { BambuUploadOptions } from './ftps.ts'

export type BambuListOptions = Omit<BambuUploadOptions, 'filePath' | 'name'>
export interface BambuFile {
  name: string
  size: number
  modifiedAt: string
}

export async function listBambuFiles(
  options: BambuListOptions,
): Promise<BambuFile[]> {
  const { host, accessCode, trust, signal } = options
  if (
    !host ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.serial) ||
    !accessCode ||
    /[\r\n]/.test(accessCode) ||
    (trust.pinSha256 !== undefined &&
      !/^[a-fA-F0-9]{64}$/.test(trust.pinSha256))
  )
    throw new Error('Invalid Bambu listing options')
  signal.throwIfAborted()
  const sockets = new Set<TLSSocket>()
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Bambu listing aborted'))
  const timer = setTimeout(
    () => controller.abort(new Error('Bambu listing timeout')),
    options.timeoutMs ?? 30000,
  )
  signal.addEventListener('abort', abort, { once: true })
  async function socket(port: number): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const s = connect({
        host,
        port,
        ca: trust.caPem,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: !trust.pinSha256,
        signal: controller.signal,
      })
      sockets.add(s)
      s.on('error', () => reject(new Error('Bambu FTPS connection failed')))
      s.once('secureConnect', () => {
        if (
          trust.pinSha256 &&
          createHash('sha256')
            .update(s.getPeerCertificate().raw)
            .digest('hex') !== trust.pinSha256.toLowerCase()
        ) {
          s.destroy()
          reject(new Error('TLS pin mismatch'))
        } else resolve(s)
      })
    })
  }
  try {
    const control = await socket(options.port ?? 990)
    let buffer = ''
    const replies: number[] = []
    let wake: (() => void) | undefined
    let closed = false
    control.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) {
        control.destroy()
        return
      }
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (/^\d{3} /.test(line)) replies.push(Number(line.slice(0, 3)))
      }
      wake?.()
    })
    control.on('close', () => {
      closed = true
      wake?.()
    })
    async function reply(expected: number[]) {
      while (!replies.length) {
        if (closed || controller.signal.aborted)
          throw new Error('Bambu FTPS connection closed')
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      if (!expected.includes(replies.shift()!))
        throw new Error('Bambu FTPS request rejected')
    }
    async function command(value: string, expected = [200]) {
      control.write(value + '\r\n')
      await reply(expected)
    }
    await reply([220])
    await command('USER bblp', [331])
    await command(`PASS ${accessCode}`, [230])
    await command('TYPE I')
    await command('PBSZ 0')
    await command('PROT P')
    let passive = ''
    const capture = (chunk: Buffer) => {
      passive += chunk.toString()
    }
    control.on('data', capture)
    await command('PASV', [227])
    control.off('data', capture)
    const match = /\((\d+,\d+,\d+,\d+),(\d+),(\d+)\)/.exec(passive)
    if (!match) throw new Error('Invalid FTPS passive response')
    const port = Number(match[2]) * 256 + Number(match[3])
    if (!port || Number(match[2]) > 255 || Number(match[3]) > 255)
      throw new Error('Invalid FTPS passive port')
    // Always connect to the bound host, never an address supplied by the peer.
    const data = await socket(port)
    const chunks: Buffer[] = []
    let bytes = 0
    data.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024)
        controller.abort(new Error('Listing too large'))
      else chunks.push(chunk)
    })
    const ended = new Promise<void>((resolve, reject) => {
      data.once('end', resolve)
      data.once('error', reject)
      data.once('close', () => {
        if (!data.readableEnded) reject(new Error('Listing connection closed'))
      })
    })
    await command('MLSD', [125, 150])
    await ended
    await reply([226])
    return parseBambuListing(Buffer.concat(chunks).toString('utf8'))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    for (const s of sockets) s.destroy()
  }
}

export function parseBambuListing(listing: string): BambuFile[] {
  const files: BambuFile[] = []
  for (const line of listing.split(/\r?\n/)) {
    const match = /^((?:[^;\s]+=[^;]*;)+) (.+)$/.exec(line)
    if (!match) continue
    const facts = new Map(
      match[1]
        .split(';')
        .filter(Boolean)
        .map((fact) => {
          const pos = fact.indexOf('=')
          return [fact.slice(0, pos).toLowerCase(), fact.slice(pos + 1)]
        }),
    )
    const name = match[2]
    const size = facts.get('size')
    const date = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?$/.exec(
      facts.get('modify') ?? '',
    )
    if (
      facts.get('type')?.toLowerCase() !== 'file' ||
      !/\.(3mf|gcode)$/i.test(name) ||
      /[\/\\\x00-\x1f\x7f]/.test(name) ||
      !size ||
      !/^\d+$/.test(size) ||
      !Number.isSafeInteger(Number(size)) ||
      !date
    )
      continue
    const iso = `${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}.000Z`
    const time = new Date(iso)
    if (!Number.isFinite(time.getTime()) || time.toISOString() !== iso) continue
    files.push({ name, size: Number(size), modifiedAt: iso })
  }
  return files
    .sort(
      (a, b) =>
        b.modifiedAt.localeCompare(a.modifiedAt) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, 200)
}
