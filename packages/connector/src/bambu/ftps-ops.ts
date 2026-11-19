import { connect, type TLSSocket } from 'node:tls'
import { createHash } from 'node:crypto'
import { parseBambuListing, type BambuFile } from './files.ts'
import type { BambuListOptions } from './files.ts'

/** SD-card folders the detail page may touch. Nothing else is addressable. */
export type BambuSdFolder = 'root' | 'timelapse'
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const MAX_LISTING_BYTES = 4 * 1024 * 1024
const SD_NAME = /^[A-Za-z0-9_][A-Za-z0-9_. -]{0,254}$/

export type BambuFtpsOperation =
  | { op: 'list'; folder: BambuSdFolder }
  | { op: 'delete'; folder: BambuSdFolder; name: string }
  | { op: 'download'; folder: BambuSdFolder; name: string; maxBytes?: number }

export type BambuFtpsResult =
  | { op: 'list'; files: BambuFile[] }
  | { op: 'delete' }
  | { op: 'download'; data: Buffer }

const listed: Record<BambuSdFolder, RegExp> = {
  root: /\.(3mf|gcode)$/i,
  timelapse: /\.(mp4|avi|jpg)$/i,
}
const dir = (folder: BambuSdFolder) => (folder === 'root' ? '' : '/timelapse')

/**
 * One FTPS exchange on the Bambu SD card: implicit TLS on the bound host,
 * `bblp` and the access code, pinned or CA-trusted certificate, a single
 * passive data connection to the bound host (never to an address the peer
 * names). Names are plain file names inside one allow-listed folder. A failed
 * exchange is reported to the caller; it is never retried here.
 */
export async function bambuFtps(
  options: BambuListOptions,
  operation: BambuFtpsOperation,
): Promise<BambuFtpsResult> {
  const { host, accessCode, trust, signal } = options
  if (
    !host ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(options.serial) ||
    !accessCode ||
    /[\r\n]/.test(accessCode) ||
    (trust.pinSha256 !== undefined &&
      !/^[a-fA-F0-9]{64}$/.test(trust.pinSha256)) ||
    (operation.op !== 'list' && !SD_NAME.test(operation.name)) ||
    (operation.op === 'delete' &&
      !listed[operation.folder].test(operation.name))
  )
    throw new Error('Invalid Bambu FTPS request')
  signal.throwIfAborted()
  const sockets = new Set<TLSSocket>()
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Bambu FTPS aborted'))
  const timer = setTimeout(
    () => controller.abort(new Error('Bambu FTPS timeout')),
    options.timeoutMs ?? 30000,
  )
  signal.addEventListener('abort', abort, { once: true })
  const open = (port: number) =>
    new Promise<TLSSocket>((resolve, reject) => {
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
  try {
    const control = await open(options.port ?? 990)
    let buffer = ''
    const replies: { code: number; text: string }[] = []
    let wake: (() => void) | undefined
    let closed = false
    control.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > 65536) return void control.destroy()
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (/^\d{3} /.test(line))
          replies.push({ code: Number(line.slice(0, 3)), text: line })
      }
      wake?.()
    })
    control.on('close', () => {
      closed = true
      wake?.()
    })
    const reply = async (expected: number[]) => {
      while (!replies.length) {
        if (closed || controller.signal.aborted)
          throw new Error('Bambu FTPS connection closed')
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      const next = replies.shift()!
      if (!expected.includes(next.code))
        throw new Error('Bambu FTPS request rejected')
      return next.text
    }
    const command = async (value: string, expected = [200]) => {
      control.write(value + '\r\n')
      return reply(expected)
    }
    await reply([220])
    await command('USER bblp', [331])
    await command(`PASS ${accessCode}`, [230])
    await command('TYPE I')
    await command('PBSZ 0')
    await command('PROT P')
    if (operation.op === 'delete') {
      await command(`DELE ${dir(operation.folder)}/${operation.name}`, [250])
      return { op: 'delete' }
    }
    const passive = await command('PASV', [227])
    const match = /\((\d+,\d+,\d+,\d+),(\d+),(\d+)\)/.exec(passive)
    if (!match || Number(match[2]) > 255 || Number(match[3]) > 255)
      throw new Error('Invalid FTPS passive response')
    const port = Number(match[2]) * 256 + Number(match[3])
    if (!port) throw new Error('Invalid FTPS passive port')
    const data = await open(port)
    const limit =
      operation.op === 'download'
        ? (operation.maxBytes ?? MAX_DOWNLOAD_BYTES)
        : MAX_LISTING_BYTES
    const chunks: Buffer[] = []
    let bytes = 0
    data.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > limit) controller.abort(new Error('Bambu FTPS too large'))
      else chunks.push(chunk)
    })
    const ended = new Promise<void>((resolve, reject) => {
      data.once('end', resolve)
      data.once('error', reject)
      data.once('close', () => {
        if (!data.readableEnded) reject(new Error('Data connection closed'))
      })
    })
    // A failure before `await ended` must not leave an unhandled rejection.
    ended.catch(() => {})
    await command(
      operation.op === 'list'
        ? `MLSD${dir(operation.folder) && ` ${dir(operation.folder)}`}`
        : `RETR ${dir(operation.folder)}/${operation.name}`,
      [125, 150],
    )
    await ended
    await reply([226])
    const body = Buffer.concat(chunks)
    return operation.op === 'list'
      ? {
          op: 'list',
          files: parseBambuListing(
            body.toString('utf8'),
            listed[operation.folder],
          ),
        }
      : { op: 'download', data: body }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    for (const s of sockets) s.destroy()
  }
}
