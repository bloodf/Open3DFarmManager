// Loopback stand-in for the KobraLink bridge HTTP API the Connector polls
// (sign-in cookie, then GET /api/v1/printers/:id). The real bridge is an
// external GPL service and never runs here; this synthetic device keeps one
// printer whose live state the journey scripts. No actuator endpoints exist.
import { createServer, type Server } from 'node:http'

export type KobraBridgeState = Readonly<{
  printState: 'printing' | 'complete' | 'error' | 'standby'
  kobraState?: 'finished' | 'failed'
  progress: number
}>

export type KobraBridgeIdentity = Readonly<{
  id: string
  deviceId: string
  name: string
  email: string
  password: string
}>

export type KobraBridgeSimulator = Readonly<{
  origin: string
  /** Replaces the scripted live state (progress is a 0..1 fraction). */
  setState(state: KobraBridgeState): void
  readonly state: KobraBridgeState
  /** Sign-ins and printer reads the Connector made, for assertions. */
  readonly observed: { signIns: number; reads: number }
  close(): Promise<void>
}>

const COOKIE = 'better-auth.session_token=journey-session'

export async function startKobraBridgeSimulator(
  identity: KobraBridgeIdentity,
  initial: KobraBridgeState = { printState: 'printing', progress: 0.25 },
): Promise<KobraBridgeSimulator> {
  let state = initial
  const observed = { signIns: 0, reads: 0 }
  const send = (
    response: import('node:http').ServerResponse,
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
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://bridge.invalid')
    if (request.method === 'GET' && url.pathname === '/api/v1/setup/status') {
      send(response, 200, { needsSetup: false })
      return
    }
    if (
      request.method === 'POST' &&
      url.pathname === '/api/auth/sign-in/email'
    ) {
      const chunks: Buffer[] = []
      let size = 0
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 4096) request.destroy()
        else chunks.push(chunk)
      })
      request.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            email?: unknown
            password?: unknown
          }
          if (
            body.email !== identity.email ||
            body.password !== identity.password
          ) {
            send(response, 401, { message: 'invalid credentials' })
            return
          }
          observed.signIns++
          send(
            response,
            200,
            { ok: true },
            { 'set-cookie': `${COOKIE}; Path=/` },
          )
        } catch {
          send(response, 400, {})
        }
      })
      return
    }
    if (
      request.method === 'GET' &&
      url.pathname === `/api/v1/printers/${identity.id}`
    ) {
      if (request.headers.cookie !== COOKIE) {
        send(response, 401, {})
        return
      }
      observed.reads++
      send(response, 200, {
        id: identity.id,
        deviceId: identity.deviceId,
        name: identity.name,
        live: {
          connected: true,
          updatedAt: Date.now(),
          firmwareVersion: '1.0.0-synthetic',
          printState: state.printState,
          ...(state.kobraState ? { kobraState: state.kobraState } : {}),
          progress: state.progress,
        },
      })
      return
    }
    send(response, 404, {})
  })
  server.headersTimeout = 2000
  server.requestTimeout = 2000
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
