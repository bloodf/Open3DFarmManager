/**
 * One HALOT LAN WebSocket. Wire facts and their sources are in
 * docs/protocols/halot.md. No reply carries a request id, so one request is in
 * flight at a time and any timeout or malformed frame closes the socket.
 */
import { WebSocket } from 'ws'
import { z } from 'zod'
import { halotTokens } from './token.ts'

/** The only version reply any source records. */
export const HALOT_PROTOCOL_VERSION = '1'

const MAX_FRAME_BYTES = 64 * 1024

// Values are strings on the wire; a number is accepted too. An empty or
// malformed optional field is dropped rather than failing the reading.
const Count = z
  .union([z.number(), z.string().regex(/^\d{1,9}$/)])
  .transform(Number)
  .pipe(z.number().int().min(0).max(999_999_999))
  .optional()
  .catch(undefined)

const StatusReply = z.object({
  cmd: z.literal('GET_PRINT_STATUS'),
  printStatus: z.string().min(1).max(64),
  filename: z.string().max(255).optional().catch(undefined),
  curSliceLayer: Count,
  sliceLayerCount: Count,
  printRemainTime: Count,
})
export type HalotStatusReply = z.infer<typeof StatusReply>

export class HalotTokenError extends Error {
  constructor() {
    super('HALOT refused the token: check the network password')
  }
}

export type HalotWriteCommand = 'PRINT_PAUSE' | 'PRINT_STOP'

export type HalotSession = {
  readStatus(): Promise<HalotStatusReply>
  /**
   * Sends one print command and awaits nothing: its reply proves no effect.
   * `guard` runs on the same stack as the send; false sends nothing.
   * Returns whether the frame left this process.
   */
  write(command: HalotWriteCommand, guard: () => boolean): boolean
  close(): void
}

export async function openHalotSession(input: {
  host: string
  port: number
  password: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<HalotSession> {
  const timeoutMs = input.timeoutMs ?? 5000
  const tokens = halotTokens(input.password)
  let token = tokens[0]!
  /** True once a status reply was accepted with `token`. */
  let authenticated = false
  input.signal?.throwIfAborted()
  const socket = new WebSocket(`ws://${input.host}:${input.port}`, {
    handshakeTimeout: timeoutMs,
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
  })
  type Pending = {
    matches(frame: Record<string, unknown>): boolean
    resolve(frame: Record<string, unknown>): void
    reject(error: Error): void
  }
  let pending: Pending | undefined
  let closed = false

  function close(reason = 'HALOT connection closed') {
    if (closed) return
    closed = true
    input.signal?.removeEventListener('abort', abort)
    socket.terminate()
    pending?.reject(Error(reason))
    pending = undefined
  }
  const abort = () => close('HALOT session aborted')
  input.signal?.addEventListener('abort', abort, { once: true })

  socket.on('close', () => close())
  socket.on('error', () => close('HALOT connection failed'))
  socket.on('message', (data, isBinary) => {
    // Binary frames carry file data only, which is never requested.
    if (isBinary) return
    let frame: unknown
    try {
      frame = JSON.parse(String(data))
    } catch {
      return close('Malformed HALOT frame')
    }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame))
      return close('Malformed HALOT frame')
    // Command acknowledgments and unrequested reports match nothing.
    const record = frame as Record<string, unknown>
    if (!pending?.matches(record)) return
    const { resolve } = pending
    pending = undefined
    resolve(record)
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('close', () => reject(Error('HALOT connection failed')))
  })

  function request(
    message: Record<string, string>,
    matches: Pending['matches'],
  ) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (closed) return reject(Error('HALOT connection closed'))
      if (pending) return reject(Error('HALOT request already in flight'))
      const timer = setTimeout(() => close('HALOT reply timed out'), timeoutMs)
      pending = {
        matches,
        resolve(frame) {
          clearTimeout(timer)
          resolve(frame)
        },
        reject(error) {
          clearTimeout(timer)
          reject(error)
        },
      }
      socket.send(JSON.stringify(message))
    })
  }

  async function ask(value: string) {
    const frame = await request(
      { cmd: 'GET_PRINT_STATUS', token: value },
      (reply) => reply.cmd === 'GET_PRINT_STATUS',
    )
    const parsed = StatusReply.safeParse(frame)
    if (!parsed.success) {
      close('Malformed HALOT status')
      throw Error('Malformed HALOT status')
    }
    return parsed.data
  }

  async function readStatus() {
    for (const candidate of authenticated ? [token] : tokens) {
      const reply = await ask(candidate)
      if (reply.printStatus === 'TOKEN_ERROR') continue
      token = candidate
      authenticated = true
      return reply
    }
    close('HALOT refused the token')
    throw new HalotTokenError()
  }

  try {
    // Asked first, so no password-derived value goes to anything else.
    const reply = await request(
      { cmd: 'VERSION_CHECK' },
      (frame) => 'version' in frame,
    )
    if (reply.version !== HALOT_PROTOCOL_VERSION)
      throw Error('Unsupported HALOT protocol version')
  } catch (error) {
    close()
    throw error
  }

  return {
    readStatus,
    write(command, guard) {
      // Only an accepted token may carry a command.
      if (closed || !authenticated || socket.readyState !== WebSocket.OPEN)
        return false
      if (!guard()) return false
      socket.send(JSON.stringify({ cmd: command, token }))
      return true
    },
    close: () => close(),
  }
}
