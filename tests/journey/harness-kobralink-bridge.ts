// Loopback stand-in for the KobraLink bridge HTTP API the Connector uses:
// sign-in cookie, GET /api/v1/printers/:id, the print lifecycle and extended
// control routes, the G-code library and "print a library file". The real
// bridge is an external GPL service and never runs here; this synthetic
// device keeps one printer whose live state the journey scripts and whose
// accepted commands it records. Nothing here reaches a physical actuator.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'

export type KobraBridgeState = Readonly<{
  printState: 'printing' | 'paused' | 'complete' | 'error' | 'standby'
  kobraState?: 'finished' | 'failed' | 'canceled'
  progress: number
  filename?: string
  printDurationSec?: number
}>

export type KobraBridgeIdentity = Readonly<{
  id: string
  deviceId: string
  name: string
  email: string
  password: string
}>

/** One write the bridge accepted, in arrival order. */
export type KobraBridgeCommand = Readonly<{ path: string; body: unknown }>

export type KobraBridgeLibraryFile = Readonly<{
  id: string
  filename: string
  sizeBytes: number
  content: string
}>

export type KobraBridgeSimulator = Readonly<{
  origin: string
  /** Replaces the scripted live state (progress is a 0..1 fraction). */
  setState(state: KobraBridgeState): void
  readonly state: KobraBridgeState
  /** Sign-ins and printer reads the Connector made, for assertions. */
  readonly observed: { signIns: number; reads: number }
  /** Every accepted write (`print/pause`, `temperature`, `print`, ...). */
  readonly commands: readonly KobraBridgeCommand[]
  /** Bounded tail of `METHOD path status`, for failure reports. */
  readonly requests: readonly string[]
  /** Files uploaded to the bridge library. */
  readonly library: readonly KobraBridgeLibraryFile[]
  close(): Promise<void>
}>

const COOKIE = 'better-auth.session_token=journey-session'
const MAX_BODY = 4 * 1024 * 1024
const EXTENDED = /^(temperature|fan|light|speed|axis)$/

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        request.destroy()
        reject(new Error('Body too large'))
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

export async function startKobraBridgeSimulator(
  identity: KobraBridgeIdentity,
  initial: KobraBridgeState = {
    printState: 'printing',
    progress: 0.25,
    filename: 'journey.gcode',
  },
): Promise<KobraBridgeSimulator> {
  let state = initial
  const observed = { signIns: 0, reads: 0 }
  const commands: KobraBridgeCommand[] = []
  const library: KobraBridgeLibraryFile[] = []
  const requests: string[] = []
  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string | string[]> = {},
  ) => {
    const payload = JSON.stringify(body)
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    })
    response.end(payload)
  }
  const accepted = (response: ServerResponse) => response.writeHead(204).end()
  const json = async (request: IncomingMessage): Promise<unknown> => {
    const body = await readBody(request)
    return body.length ? JSON.parse(body.toString('utf8')) : undefined
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    const { method } = request
    if (method === 'GET' && url.pathname === '/api/v1/setup/status') {
      send(response, 200, { needsSetup: false })
      return
    }
    if (method === 'POST' && url.pathname === '/api/auth/sign-in/email') {
      const body = (await json(request)) as {
        email?: unknown
        password?: unknown
      }
      if (
        body?.email !== identity.email ||
        body.password !== identity.password
      ) {
        send(response, 401, { message: 'invalid credentials' })
        return
      }
      observed.signIns++
      send(response, 200, { ok: true }, { 'set-cookie': `${COOKIE}; Path=/` })
      return
    }
    const base = `/api/v1/printers/${identity.id}`
    if (url.pathname !== base && !url.pathname.startsWith(base + '/')) {
      send(response, 404, {})
      return
    }
    if (request.headers.cookie !== COOKIE) {
      send(response, 401, {})
      return
    }
    const route = url.pathname.slice(base.length + 1)
    if (method === 'GET' && route === '') {
      observed.reads++
      send(response, 200, {
        id: identity.id,
        deviceId: identity.deviceId,
        name: identity.name,
        live: {
          connected: true,
          // The bridge refreshes this on every device report, also after a
          // print has ended.
          updatedAt: Date.now(),
          firmwareVersion: '1.0.0-synthetic',
          printState: state.printState,
          ...(state.kobraState ? { kobraState: state.kobraState } : {}),
          progress: state.progress,
          ...(state.filename ? { filename: state.filename } : {}),
          ...(state.printDurationSec === undefined
            ? {}
            : { printDurationSec: state.printDurationSec }),
        },
      })
      return
    }
    if (method === 'GET' && route === 'files') {
      send(
        response,
        200,
        library.map(({ id, filename, sizeBytes }) => ({
          id,
          filename,
          sizeBytes,
        })),
      )
      return
    }
    if (method === 'GET' && route === 'printer-files') {
      send(response, 200, [])
      return
    }
    if (method === 'POST' && route === 'files') {
      const form = await new Request('http://bridge.invalid/', {
        method: 'POST',
        headers: { 'content-type': request.headers['content-type'] ?? '' },
        body: new Uint8Array(await readBody(request)),
      }).formData()
      const file = form.get('file')
      if (!(file instanceof File) || form.get('print') !== 'false') {
        send(response, 400, {})
        return
      }
      const entry = {
        id: `journey-file-${library.length + 1}`,
        filename: file.name,
        sizeBytes: file.size,
        content: await file.text(),
      }
      library.push(entry)
      commands.push({ path: 'files', body: { filename: file.name } })
      send(response, 200, { id: entry.id })
      return
    }
    if (method === 'POST' && route === 'print') {
      const body = (await json(request)) as { fileId?: unknown }
      const file = library.find((entry) => entry.id === body?.fileId)
      if (!file) {
        send(response, 404, {})
        return
      }
      commands.push({ path: route, body })
      state = { printState: 'printing', progress: 0, filename: file.filename }
      send(response, 200, {})
      return
    }
    const lifecycle = /^print\/(pause|resume|cancel)$/.exec(route)?.[1]
    if (method === 'POST' && lifecycle) {
      await readBody(request)
      commands.push({ path: route, body: undefined })
      state =
        lifecycle === 'pause'
          ? { ...state, printState: 'paused' }
          : lifecycle === 'resume'
            ? { ...state, printState: 'printing' }
            : { ...state, printState: 'standby', kobraState: 'canceled' }
      accepted(response)
      return
    }
    if (method === 'POST' && EXTENDED.test(route)) {
      commands.push({ path: route, body: await json(request) })
      accepted(response)
      return
    }
    send(response, 404, {})
  }

  const server: Server = createServer((request, response) => {
    response.once('finish', () => {
      const line = `${request.method} ${request.url} ${response.statusCode}`
      // Successful telemetry polls would drown everything else.
      if (/^GET \/api\/v1\/printers\/[^/]+ 200$/.test(line)) return
      requests.push(line)
      if (requests.length > 64) requests.shift()
    })
    handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, {})
      else response.destroy()
    })
  })
  server.headersTimeout = 2000
  server.requestTimeout = 5000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Bridge simulator listener missing')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setState(next) {
      state = next
    },
    get state() {
      return state
    },
    observed,
    commands,
    requests,
    library,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
