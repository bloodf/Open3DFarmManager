import { connect, type TLSSocket } from 'node:tls'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

export interface BambuUploadOptions {
  host: string
  serial: string
  accessCode: string
  trust: { caPem?: string; pinSha256?: string }
  filePath: string
  name: string
  signal: AbortSignal
  port?: number
  timeoutMs?: number
}

export async function uploadBambuFile(
  options: BambuUploadOptions,
): Promise<void> {
  const { host, accessCode, trust, signal } = options
  if (
    !host ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.serial) ||
    !accessCode ||
    /[\r\n]/.test(accessCode) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_. -]{0,254}$/.test(options.name) ||
    (trust.pinSha256 !== undefined &&
      !/^[a-fA-F0-9]{64}$/.test(trust.pinSha256))
  )
    throw new Error('Invalid Bambu upload options')
  signal.throwIfAborted()
  const sockets = new Set<TLSSocket>()
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Bambu upload aborted'))
  const timer = setTimeout(
    () => controller.abort(new Error('Bambu upload timeout')),
    options.timeoutMs ?? 30000,
  )
  signal.addEventListener('abort', abort, { once: true })
  async function socket(port: number): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const connectionOptions = {
        host,
        port,
        ...(trust.caPem === undefined ? {} : { ca: trust.caPem }),
        minVersion: 'TLSv1.2' as const,
        rejectUnauthorized: !trust.pinSha256,
        signal: controller.signal,
      }
      const s = connect(connectionOptions)
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
    await command(`STOR ${options.name}`, [125, 150])
    await pipeline(createReadStream(options.filePath), data, {
      signal: controller.signal,
    })
    await reply([226])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    for (const s of sockets) s.destroy()
  }
}
