// Loopback-only fixtures for scripts/test-connector-outage-recovery.ts.
// Nothing here contacts a physical printer, a shared server or a non-loopback address.
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, request } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = (path: string) =>
  fileURLToPath(new URL('../../' + path, import.meta.url))

/** Errors raised inside event handlers; scenarios assert this stays empty. */
export const handlerErrors: string[] = []
function guarded(label: string, run: () => void) {
  try {
    run()
  } catch (error) {
    handlerErrors.push(
      label + ': ' + (error instanceof Error ? error.message : String(error)),
    )
  }
}

/** Aborted by SIGINT/SIGTERM/uncaught errors so waits unwind into cleanup. */
export const interruption = new AbortController()

export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
) {
  const deadline = performance.now() + timeoutMs
  while (!(await predicate())) {
    if (interruption.signal.aborted) throw new Error('Interrupted: ' + label)
    if (performance.now() > deadline) throw new Error('Timed out: ' + label)
    await new Promise((resolveWait) => setTimeout(resolveWait, 50))
  }
}

/** Synthetic Moonraker: subscribe baseline plus explicit notify_status_update pushes. */
export async function startFakeMoonraker(port: number) {
  const {
    WebSocketServer,
  }: typeof import('../../packages/connector/node_modules/@types/ws') =
    createRequire(
      new URL('../../packages/connector/package.json', import.meta.url),
    )('ws')
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4096 })
  let eventtime = 1
  let state: 'printing' | 'paused' = 'printing'
  let progress = 0
  let subscriptions = 0
  const server = createHttpServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/server/info') {
      res.writeHead(404).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        result: { klippy_connected: true, klippy_state: 'ready' },
      }),
    )
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/websocket') {
      socket.destroy()
      return
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.on('message', (data) =>
        guarded('moonraker message', () => {
          const message: unknown = JSON.parse(data.toString())
          if (!message || typeof message !== 'object' || !('id' in message))
            return
          subscriptions++
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                eventtime,
                status: {
                  webhooks: { state: 'ready' },
                  print_stats: { state },
                  virtual_sdcard: { progress },
                },
              },
            }),
          )
        }),
      )
    })
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  function broadcast(delta: object) {
    eventtime++
    const text = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notify_status_update',
      params: [delta, eventtime],
    })
    for (const socket of sockets.clients) socket.send(text)
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    get progress() {
      return progress
    },
    get subscriptions() {
      return subscriptions
    },
    get clients() {
      return sockets.clients.size
    },
    push(next: number) {
      progress = next
      broadcast({ virtual_sdcard: { progress } })
    },
    setState(next: 'printing' | 'paused') {
      state = next
      broadcast({ print_stats: { state } })
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate()
      await new Promise<void>((done) => sockets.close(() => done()))
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export type ProxyEntry = {
  at: number
  route: 'challenge' | 'commit' | 'other'
  outcome: number | 'reset' | 'upstream-down' | 'held'
  eventIds?: string[]
}

/** TLS front for the built app. Records every attempt and can inject faults. */
export async function startFaultProxy(input: {
  port: number
  appPort: number
  cert: Buffer
  key: Buffer
}) {
  const log: ProxyEntry[] = []
  let mode: 'pass' | 'reset' = 'pass'
  let hold:
    ((held: { eventIds: string[]; release: () => void }) => void) | undefined
  const server = createHttpsServer(
    { cert: input.cert, key: input.key },
    (req, res) => {
      const route =
        req.url === '/api/connector/telemetry'
          ? 'commit'
          : req.url === '/api/connector/telemetry/challenge'
            ? 'challenge'
            : 'other'
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 70000) req.destroy()
        else chunks.push(chunk)
      })
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const entry: ProxyEntry = { at: performance.now(), route, outcome: 0 }
        if (route === 'commit')
          guarded('commit body', () => {
            entry.eventIds = (
              JSON.parse(body.toString()) as { eventId: string }[]
            ).map((record) => record.eventId)
          })
        log.push(entry)
        if (mode === 'reset') {
          entry.outcome = 'reset'
          req.socket.destroy()
          return
        }
        const upstream = request(
          {
            host: '127.0.0.1',
            port: input.appPort,
            method: req.method,
            path: req.url,
            headers: { ...req.headers, host: `127.0.0.1:${input.appPort}` },
          },
          (response) => {
            const parts: Buffer[] = []
            response.on('data', (chunk: Buffer) => parts.push(chunk))
            response.on('end', () => {
              entry.outcome = response.statusCode ?? 502
              if (route === 'commit' && entry.outcome === 200 && hold) {
                const notify = hold
                hold = undefined
                entry.outcome = 'held'
                notify({
                  eventIds: entry.eventIds ?? [],
                  release: () => res.destroy(),
                })
                return
              }
              res.writeHead(response.statusCode ?? 502, response.headers)
              res.end(Buffer.concat(parts))
            })
          },
        )
        upstream.on('error', () => {
          entry.outcome = 'upstream-down'
          res.destroy()
        })
        upstream.end(body)
      })
    },
  )
  server.listen(input.port, '127.0.0.1')
  await once(server, 'listening')
  return {
    origin: `https://127.0.0.1:${input.port}`,
    log,
    setMode(next: 'pass' | 'reset') {
      mode = next
    },
    /** Withholds the next successful commit response from the Connector. */
    holdNextCommit() {
      return new Promise<{ eventIds: string[]; release: () => void }>(
        (resolveHold) => {
          hold = resolveHold
        },
      )
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

async function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    exited,
    new Promise<void>((done) => {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        done()
      }, 5000)
    }),
  ])
  clearTimeout(timer)
  if (child.exitCode === null && child.signalCode === null) await exited
}

/** Built Nuxt server process (database gate + telemetry runtime). */
export function startFarmApp(input: {
  env: Record<string, string>
  logPath: string
  onPid: (pid: number) => void
}) {
  const child = spawn(
    process.execPath,
    [repo('apps/farm/.output/server/index.mjs')],
    { env: input.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (child.pid) input.onPid(child.pid)
  let bytes = 0
  const write = (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes < 1024 * 1024) appendFileSync(input.logPath, chunk)
  }
  child.stdout?.on('data', write)
  child.stderr?.on('data', write)
  const exited = once(child, 'exit').then(([code]) => code as number | null)
  return {
    child,
    exited,
    get running() {
      return child.exitCode === null && child.signalCode === null
    },
    stop: () => stopChild(child, 'SIGTERM'),
  }
}

export type Diagnostic = { kind: string } & Record<string, unknown>

/** Real Connector CLI process (`run`), diagnostics parsed from stdout. */
export function startConnector(input: {
  args: string[]
  env: Record<string, string>
  logPath: string
  onPid: (pid: number) => void
}) {
  const child = spawn(
    process.execPath,
    [repo('packages/connector/src/cli.ts'), 'run', ...input.args],
    { env: input.env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (child.pid) input.onPid(child.pid)
  const diagnostics: Diagnostic[] = []
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      appendFileSync(input.logPath, line + '\n')
      guarded('connector diagnostic', () =>
        diagnostics.push(JSON.parse(line) as Diagnostic),
      )
    }
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    appendFileSync(input.logPath, chunk)
    if (stderr.length < 16384) stderr += chunk.toString('utf8')
  })
  const exited = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((done) => child.once('exit', (code, signal) => done({ code, signal })))
  return {
    child,
    diagnostics,
    exited,
    get stderr() {
      return stderr
    },
    get running() {
      return child.exitCode === null && child.signalCode === null
    },
    count(kind: string, filter: (d: Diagnostic) => boolean = () => true) {
      return diagnostics.filter((d) => d.kind === kind && filter(d)).length
    },
    stop: () => stopChild(child, 'SIGTERM'),
    async kill() {
      child.kill('SIGKILL')
      await exited
    },
  }
}
