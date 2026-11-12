import { z } from 'zod'
import {
  MoonrakerClientError,
  validateMoonrakerInput,
  type MoonrakerLimits,
} from './client.ts'
import { Reply, decodeMoonrakerFrame } from './frame.ts'
import { createMoonrakerSocket } from './socket.ts'
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

const Failure = z.looseObject({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  error: z.unknown(),
})
const REQUESTS = 5

export type MoonrakerDiscovery = Readonly<{
  identity: MoonrakerIdentity
  server: MoonrakerServerInfo
  tools: MoonrakerToolStatus
  webcams: readonly MoonrakerWebcam[]
}>

class RemoteError extends Error {}

// Reuses validateMoonrakerInput so discovery enforces the same origin and limit rules.
function checkedOrigin(origin: string, limits: MoonrakerLimits): string {
  return validateMoonrakerInput({
    assignment: { printerKey: 'discovery', origin },
    allowedOrigins: [origin],
    limits,
  }).origin
}

/**
 * One-shot read-only discovery: identify, server.info, tool objects, webcams.
 * Sequential requests, one outstanding at a time, each bounded by requestTimeoutMs,
 * all bounded by an overall deadline. Rejects `not-ready` (without querying Klipper
 * objects) when Klippy is not ready; `invalid-response` on any malformed reply.
 * A remote error on server.webcams.list means no webcams and is non-fatal.
 *
 * `webcamOrigin` is the host serving the camera paths (Mainsail/Fluidd frontend,
 * typically port 80), which differs from the Moonraker origin. Without it webcam
 * URLs stay null and only the raw relative paths are returned.
 * Note: identify registers a visible client connection on Moonraker; it changes no printer state.
 */
export async function discoverMoonraker(input: {
  origin: string
  webcamOrigin?: string
  limits: MoonrakerLimits
  signal: AbortSignal
  client: { name: string; version: string; url: string }
}): Promise<MoonrakerDiscovery> {
  const origin = checkedOrigin(input.origin, input.limits)
  const webcamOrigin = input.webcamOrigin
    ? checkedOrigin(input.webcamOrigin, input.limits)
    : null
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(
      input.limits.connectTimeoutMs + REQUESTS * input.limits.requestTimeoutMs,
    ),
  ])
  const socket = createMoonrakerSocket(origin, input.limits)
  let fail: (error: MoonrakerClientError) => void = () => {}
  const dead = new Promise<never>((_, reject) => (fail = reject))
  dead.catch(() => {})
  const onAbort = () => fail(new MoonrakerClientError('offline'))
  const onSocketEnd = () => fail(new MoonrakerClientError('offline'))
  // ws protocol violations (oversized or over-fragmented frames) are invalid responses.
  const onSocketError = (cause: Error) =>
    fail(
      new MoonrakerClientError(
        'code' in cause &&
          typeof cause.code === 'string' &&
          cause.code.startsWith('WS_ERR_')
          ? 'invalid-response'
          : 'offline',
      ),
    )
  signal.addEventListener('abort', onAbort, { once: true })
  socket.on('error', onSocketError)
  socket.on('close', onSocketEnd)
  const opened = new Promise<void>((resolve) => socket.once('open', resolve))
  let nextId = 0
  let cancelInFlight: () => void = () => {}

  function rpc(method: string, params?: object): Promise<unknown> {
    const id = ++nextId
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => done(() => reject(new MoonrakerClientError('stale'))),
        input.limits.requestTimeoutMs,
      )
      function done(settle: () => void) {
        cancelInFlight()
        settle()
      }
      cancelInFlight = () => {
        clearTimeout(timer)
        socket.off('message', onMessage)
        cancelInFlight = () => {}
      }
      function onMessage(data: import('ws').RawData, isBinary: boolean) {
        let value: unknown
        try {
          value = decodeMoonrakerFrame(
            data,
            isBinary,
            input.limits.maxMessageBytes,
          )
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
    // Klipper objects answer 503 while Klippy is down; do not ask for them.
    if (!server.ready) throw new MoonrakerClientError('not-ready')
    const names = parse(selectToolObjects, await rpc('printer.objects.list'))
    const query = (await rpc('printer.objects.query', {
      objects: Object.fromEntries([
        ['toolhead', ['extruder']],
        ...names.map((name) => [name, ['temperature', 'target']]),
      ]),
    })) as { status?: unknown } | null
    const tools = parse(parseToolStatus, query?.status)
    let webcams: readonly MoonrakerWebcam[] = []
    try {
      webcams = parse(
        (r) => parseWebcamsResult(r, webcamOrigin),
        await rpc('server.webcams.list'),
      )
    } catch (error) {
      if (!(error instanceof RemoteError)) throw error
    }
    return { identity, server, tools, webcams }
  }

  try {
    if (signal.aborted) throw new MoonrakerClientError('offline')
    const work = run()
    work.catch(() => {})
    return await Promise.race([dead, work])
  } catch (error) {
    if (error instanceof RemoteError)
      throw new MoonrakerClientError('invalid-response')
    throw error
  } finally {
    cancelInFlight()
    signal.removeEventListener('abort', onAbort)
    socket.off('error', onSocketError)
    socket.off('close', onSocketEnd)
    socket.on('error', () => {}) // terminate() during handshake emits an error
    socket.terminate()
  }
}
