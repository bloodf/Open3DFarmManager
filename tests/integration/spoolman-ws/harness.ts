// Shared fixture for the Spoolman websocket feed tests (#545).
//
// scripts/test-spoolman-websocket.mjs starts one disposable PostgreSQL
// container, applies the migrations, creates the runtime login role and exports
// its location in the environment. Each test file builds the farm-scoped
// harness from that: the real PostgreSQL storage, the real legacy handler and
// the real websocket feed hooks behind a loopback server. The server is wired
// the way Nitro wires apps/farm/server/routes/spoolman/[...path].ts: one h3
// event handler carries both the HTTP handler and the websocket hooks, and
// crossws's Node adapter serves the upgrade requests.
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import wsAdapter from 'crossws/adapters/node'
import {
  createApp,
  createRouter,
  defineEventHandler,
  getRequestHeader,
  readRawBody,
  setResponseHeader,
  setResponseStatus,
  toNodeListener,
} from 'h3'
import postgres, { type Sql } from 'postgres'
import WebSocket from 'ws'
import { PostgresSpoolLibrary } from '../../../apps/farm/server/storage/postgres-spool-library.ts'
import { classifyLegacyBody } from '../../../apps/farm/server/utils/spool-library/legacy-api/body.ts'
import { handleLegacyRequest } from '../../../apps/farm/server/utils/spool-library/legacy-handler.ts'
import { spoolFeedBus } from '../../../apps/farm/server/utils/spool-library/events.ts'
import { createSpoolFeedHooks } from '../../../apps/farm/server/utils/spool-library/ws-feed.ts'

export interface CallResult {
  status: number
  body: any
  text: string
}

export interface FeedEvent {
  type: string
  resource: string
  date: string
  payload: any
}

/** One open websocket client that records every event it is sent. */
export interface Feed {
  events: FeedEvent[]
  /** Resolves with the first `count` events (rejects after a timeout). */
  next(count?: number): Promise<FeedEvent[]>
  closed: Promise<{ code: number; reason: string }>
  close(): Promise<void>
}

export interface Harness {
  admin: Sql
  /** `host:port` of the loopback server. */
  host: string
  farms: string[]
  /** Legacy credential token of `access` for farm index `farm`. */
  token(farm: number, access: 'read' | 'write'): string
  call(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<CallResult>
  /** Open a feed and wait for the handshake; rejects when it is refused. */
  connect(
    token: string,
    path: string,
    headers?: Record<string, string>,
  ): Promise<Feed>
  /** Handshake status of a feed that must be refused (HTTP status). */
  refused(token: string, path: string): Promise<number>
  /** Let in-flight frames arrive, for asserting that nothing was sent. */
  settle(ms?: number): Promise<void>
  close(): Promise<void>
}

const env = (name: string): string => {
  const value = process.env[name]
  if (!value)
    throw new Error(
      `${name} is not set: run node scripts/test-spoolman-websocket.mjs`,
    )
  return value
}

export async function startHarness(farmCount = 2): Promise<Harness> {
  const port = Number(env('WS_PG_PORT'))
  const connect = (username: string) =>
    postgres({
      host: '127.0.0.1',
      port,
      database: 'fixture',
      username,
      password: env('WS_PG_PASSWORD'),
      ssl: false,
      max: 4,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { search_path: 'pg_catalog' },
    })
  const admin = connect('fixture')
  const runtime = connect(env('WS_PG_ROLE'))
  const clock = Date.UTC(2026, 10, 21, 8, 0, 0)
  const store = new PostgresSpoolLibrary(runtime, () => clock)

  const farms: string[] = []
  const tokens = new Map<string, string>()
  for (let i = 0; i < farmCount; i++) {
    const farm = randomUUID()
    const account = `acc-${farm}`
    const session = `session-${farm}`
    farms.push(farm)
    await admin`INSERT INTO farm.farms (id) VALUES (${farm}::uuid)`
    await admin`INSERT INTO farm.session_accounts (id) VALUES (${account})`
    await admin`INSERT INTO farm.account_sessions (id, account_id, account_version, created_at, last_seen_at, absolute_expires_at) VALUES (${session}, ${account}, 0, ${clock}, ${clock}, ${clock + 86_400_000})`
    await admin`INSERT INTO farm.memberships (farm_id, account_id, role) VALUES (${farm}::uuid, ${account}, 'owner')`
    for (const access of ['read', 'write'] as const) {
      const issued = await store.issueLegacyCredential({
        sessionRecordId: session,
        policy: { idleTimeoutMs: 1e12 },
        farmId: farm,
        label: `${access}-${i}`,
        access,
      })
      if (!issued.ok) throw new Error(`credential: ${issued.reason}`)
      tokens.set(`${i}:${access}`, issued.value.token)
    }
  }

  const handler = defineEventHandler({
    websocket: createSpoolFeedHooks({ storage: async () => store }),
    async handler(event) {
      setResponseHeader(event, 'Cache-Control', 'no-store')
      const url = event.node.req.url ?? '/'
      const at = url.indexOf('?')
      const raw = ['POST', 'PATCH', 'PUT'].includes(event.method)
        ? await readRawBody(event, 'utf8')
        : undefined
      const result = await handleLegacyRequest(store, {
        method: event.method,
        pathname: at === -1 ? url : url.slice(0, at),
        query: new URLSearchParams(at === -1 ? '' : url.slice(at + 1)),
        body: classifyLegacyBody(raw, getRequestHeader(event, 'content-type')),
      })
      setResponseStatus(event, result.status)
      return result.body
    },
  })
  const app = createApp()
  app.use(createRouter().use('/spoolman/**', handler))
  const server: Server = createServer(toNodeListener(app))
  const { handleUpgrade } = wsAdapter(app.websocket)
  server.on('upgrade', handleUpgrade)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = `127.0.0.1:${(server.address() as AddressInfo).port}`
  const open: WebSocket[] = []

  return {
    admin,
    host: address,
    farms,
    token(farm, access) {
      const token = tokens.get(`${farm}:${access}`)
      if (!token) throw new Error('unknown credential')
      return token
    },
    async call(token, method, path, body) {
      const response = await fetch(
        `http://${address}/spoolman/${token}${path}`,
        {
          method,
          headers:
            body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? null : JSON.stringify(body),
        },
      )
      const text = await response.text()
      let parsed: any = text
      try {
        parsed = JSON.parse(text)
      } catch {
        // Not JSON: keep the text.
      }
      return { status: response.status, body: parsed, text }
    },
    connect(token, path, headers = {}) {
      return new Promise<Feed>((resolve, reject) => {
        const socket = new WebSocket(
          `ws://${address}/spoolman/${token}${path}`,
          {
            headers,
          },
        )
        open.push(socket)
        const events: FeedEvent[] = []
        const waiting: (() => void)[] = []
        const closed = new Promise<{ code: number; reason: string }>((done) =>
          socket.on('close', (code, reason) =>
            done({ code, reason: reason.toString() }),
          ),
        )
        socket.on('message', (data) => {
          events.push(JSON.parse(data.toString()) as FeedEvent)
          for (const wake of waiting.splice(0)) wake()
        })
        socket.once('error', reject)
        socket.once('unexpected-response', (_req, res) =>
          reject(new Error(`refused:${res.statusCode}`)),
        )
        socket.once('open', () =>
          resolve({
            events,
            closed,
            async next(count = 1) {
              const deadline = Date.now() + 5000
              while (events.length < count) {
                if (Date.now() > deadline)
                  throw new Error(
                    `timed out with ${events.length}/${count} events`,
                  )
                await new Promise<void>((wake) => {
                  waiting.push(wake)
                  setTimeout(wake, 100)
                })
              }
              return events.slice(0, count)
            },
            async close() {
              if (socket.readyState === WebSocket.CLOSED) return
              socket.close()
              await closed
            },
          }),
        )
      })
    },
    refused(token, path) {
      return new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`ws://${address}/spoolman/${token}${path}`)
        const timeout = setTimeout(() => {
          socket.terminate()
          reject(new Error('websocket handshake timed out'))
        }, 5000)
        socket.once('unexpected-response', (_req, res) => {
          clearTimeout(timeout)
          resolve(res.statusCode ?? 0)
          res.resume()
          socket.terminate()
        })
        socket.once('open', () => {
          clearTimeout(timeout)
          socket.terminate()
          reject(new Error('handshake was accepted'))
        })
        socket.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })
    },
    settle: (ms = 250) => new Promise((done) => setTimeout(done, ms)),
    async close() {
      for (const socket of open) socket.terminate()
      spoolFeedBus.closeAll()
      await new Promise((done) => server.close(done))
      await runtime.end({ timeout: 3 })
      await admin.end({ timeout: 3 })
    },
  }
}
