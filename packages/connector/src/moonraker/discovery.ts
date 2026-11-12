import { z } from 'zod'
import { parseBoundedJson } from '@open3dfarmmanager/farm-protocol'
import { MoonrakerClientError, type MoonrakerLimits } from './client.ts'
import {
  parseIdentifyResult,
  parseServerInfoResult,
  parseToolStatus,
  parseWebcamsResult,
  selectToolObjects,
  type MoonrakerIdentity,
  type MoonrakerServerInfo,
  type MoonrakerToolStatus,
  type MoonrakerWebcam,
} from './discovery-parse.ts'

process.env.WS_NO_BUFFER_UTIL = '1'
process.env.WS_NO_UTF_8_VALIDATE = '1'
const { default: WebSocket } = await import('ws')

const Reply = z.strictObject({
  jsonrpc: z.literal('2.0'),
  id: z.number().int().positive(),
  result: z.unknown(),
})
const Failure = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  error: z.unknown(),
})

export type MoonrakerDiscovery = Readonly<{
  identity: MoonrakerIdentity
  server: MoonrakerServerInfo
  tools: MoonrakerToolStatus
  webcams: readonly MoonrakerWebcam[]
}>

/**
 * One-shot read-only discovery: identify, server.info, tool objects, webcams.
 * Sequential requests, one outstanding at a time, each bounded by requestTimeoutMs.
 * Any malformed reply rejects with invalid-response; webcam failure is non-fatal.
 */
export async function discoverMoonraker(input: {
  origin: string
  limits: MoonrakerLimits
  signal: AbortSignal
  client: { name: string; version: string; url: string }
}): Promise<MoonrakerDiscovery> {
  const url = new URL('/websocket', input.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url, {
    maxPayload: input.limits.maxMessageBytes,
    maxFragments: 128,
    maxBufferedChunks: 128,
    perMessageDeflate: false,
    followRedirects: false,
    handshakeTimeout: input.limits.connectTimeoutMs,
    skipUTF8Validation: false,
  })
  let fail: (error: MoonrakerClientError) => void = () => {}
  const dead = new Promise<never>((_, reject) => (fail = reject))
  dead.catch(() => {})
  const onAbort = () => fail(new MoonrakerClientError('offline'))
  input.signal.addEventListener('abort', onAbort, { once: true })
  socket.on('error', () => fail(new MoonrakerClientError('offline')))
  socket.on('close', () => fail(new MoonrakerClientError('offline')))
  const opened = new Promise<void>((resolve) => socket.once('open', resolve))
  let nextId = 0

  function rpc(method: string, params?: object): Promise<unknown> {
    const id = ++nextId
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => done(() => reject(new MoonrakerClientError('stale'))),
        input.limits.requestTimeoutMs,
      )
      function done(settle: () => void) {
        clearTimeout(timer)
        socket.off('message', onMessage)
        settle()
      }
      function onMessage(data: import('ws').RawData, isBinary: boolean) {
        let value: unknown
        try {
          if (isBinary || !Buffer.isBuffer(data)) throw new Error('frame')
          value = parseBoundedJson(data.toString('utf8'), {
            maxBytes: input.limits.maxMessageBytes,
            maxDepth: 16,
            maxValues: 8192,
            maxStringChars: 16384,
          })
        } catch {
          return done(() =>
            reject(new MoonrakerClientError('invalid-response')),
          )
        }
        // Notifications (no id) may interleave; ignore them.
        if (value && typeof value === 'object' && !('id' in value)) return
        const failure = Failure.safeParse(value)
        if (failure.success && failure.data.id === id)
          return done(() => reject(new RemoteError()))
        const reply = Reply.safeParse(value)
        if (!reply.success || reply.data.id !== id)
          return done(() =>
            reject(new MoonrakerClientError('invalid-response')),
          )
        done(() => resolve(reply.data.result))
      }
      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  function parse<T>(fn: (value: unknown) => T, value: unknown): T {
    try {
      return fn(value)
    } catch {
      throw new MoonrakerClientError('invalid-response')
    }
  }
  async function run(): Promise<MoonrakerDiscovery> {
    await opened
    const identity = parse(
      parseIdentifyResult,
      await rpc('server.connection.identify', {
        client_name: input.client.name,
        version: input.client.version,
        type: 'agent',
        url: input.client.url,
      }),
    )
    const server = parse(parseServerInfoResult, await rpc('server.info'))
    const list = await rpc('printer.objects.list')
    const names = parse(selectToolObjects, list)
    const query = (await rpc('printer.objects.query', {
      objects: Object.fromEntries([
        ['toolhead', ['extruder']],
        ...names.map((name) => [name, ['temperature', 'target']]),
      ]),
    })) as { status?: unknown } | null
    const tools = parse(parseToolStatus, query?.status)
    let webcams: readonly MoonrakerWebcam[] = []
    try {
      const result = await rpc('server.webcams.list')
      webcams = parse((r) => parseWebcamsResult(r, input.origin), result)
    } catch (error) {
      // Webcam support is optional; a remote error means none configured.
      if (!(error instanceof RemoteError)) throw error
    }
    return { identity, server, tools, webcams }
  }

  try {
    if (input.signal.aborted) throw new MoonrakerClientError('offline')
    const work = run()
    work.catch(() => {})
    return await Promise.race([dead, work])
  } catch (error) {
    if (error instanceof RemoteError)
      throw new MoonrakerClientError('invalid-response')
    throw error
  } finally {
    input.signal.removeEventListener('abort', onAbort)
    socket.terminate()
  }
}

class RemoteError extends Error {}
