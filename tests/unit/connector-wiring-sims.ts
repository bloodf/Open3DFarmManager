import { createServer, type IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOrCreateIdentity } from '../../packages/connector/src/identity/store.ts'
import { serveWsTestServer, type WsTestSocket } from './ws-serve.ts'

/**
 * Loopback Moonraker simulator: one printer, read-only telemetry answers,
 * and an explicit `finish()` that reports the running job complete. Every
 * request is recorded so tests can prove nothing was commanded.
 */
export async function moonrakerSimulator(input: {
  /** Extra status objects reported on subscribe (e.g. U1 tool objects). */
  status?: Record<string, unknown>
  objects?: readonly string[]
  /** `GET /server/spoolman/spool_id`: a spool id, null, or 404 (absent). */
  spoolId: number | null | 'absent'
}) {
  const methods: string[] = []
  const subscribed: Record<string, unknown>[] = []
  const sockets = new Set<WsTestSocket>()
  let eventtime = 1
  const server = await serveWsTestServer({
    async http(request) {
      const path = new URL(request.url).pathname
      if (path === '/server/spoolman/spool_id')
        return input.spoolId === 'absent'
          ? new Response('', { status: 404 })
          : Response.json({ result: { spool_id: input.spoolId } })
      if (path === '/server/info')
        return Response.json({
          result: { klippy_connected: true, klippy_state: 'ready' },
        })
      return new Response('', { status: 404 })
    },
    upgrade: () => true,
    onOpen: (socket) => sockets.add(socket),
    onClose: (socket) => sockets.delete(socket),
    onMessage(socket, message) {
      const call = JSON.parse(message)
      methods.push(call.method)
      const reply = (result: unknown) =>
        socket.send(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }))
      if (call.method === 'server.connection.identify')
        return reply({ connection_id: 1 })
      if (call.method === 'printer.objects.list')
        return reply({ objects: input.objects ?? [] })
      if (
        call.method === 'printer.objects.subscribe' ||
        call.method === 'printer.objects.query'
      ) {
        if (call.method === 'printer.objects.subscribe')
          subscribed.push(call.params.objects)
        return reply({
          eventtime: ++eventtime,
          status: {
            webhooks: { state: 'ready' },
            print_stats: {
              state: 'printing',
              filename: 'part.gcode',
              filament_used: 10,
            },
            virtual_sdcard: { progress: 0.5 },
            ...input.status,
          },
        })
      }
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: call.id,
          error: { code: -32601, message: 'Method not found' },
        }),
      )
    },
  })
  return {
    origin: `http://127.0.0.1:${server.port}`,
    methods,
    subscribed,
    connected: () => sockets.size > 0 && subscribed.length > 0,
    /** Reports the watched job complete with this measured length. */
    finish(millimetres: number) {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'notify_status_update',
            params: [
              {
                print_stats: { state: 'complete', filament_used: millimetres },
                virtual_sdcard: { progress: 1 },
              },
              ++eventtime,
            ],
          }),
        )
    },
    stop: () => server.stop(),
  }
}

/**
 * Loopback Spoolman simulator. Records every `PUT /api/v1/spool/:id/use`.
 * `lose` drops the connection without an answer: the debit may or may not
 * have been applied.
 */
export async function spoolmanSimulator(input: { lose?: boolean } = {}) {
  const uses: { spoolId: number; body: unknown }[] = []
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const match = /^\/api\/v1\/spool\/(\d+)\/use$/.exec(request.url ?? '')
      if (request.method === 'PUT' && match) {
        uses.push({
          spoolId: Number(match[1]),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        })
        if (input.lose) {
          request.socket.destroy()
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: Number(match[1]) }))
        return
      }
      response.writeHead(404)
      response.end()
    })
  })
  server.on('upgrade', (_request, socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Spoolman address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    uses,
    async stop() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * Writes a complete local agent setup (identity, approved credential and
 * runtime config) in a fresh directory. Telemetry points at a closed
 * loopback port; there is no signalling unless `extra` adds it.
 */
export function agentSetup(input: {
  collection: (ids: { agent: string; farm: string }) => object
  extra?: (ids: { agent: string; farm: string; assignment: string }) => object
  assignmentExtra?: object
}) {
  const directory = mkdtempSync(join(tmpdir(), 'connector-wiring-'))
  const identity = loadOrCreateIdentity(directory)
  const agent = randomUUID(),
    farm = randomUUID(),
    assignment = randomUUID()
  const origin = 'https://127.0.0.1:1'
  const configPath = join(directory, 'config.json')
  const credentialPath = join(directory, 'credential.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      collection: input.collection({ agent, farm }),
      assignments: [
        {
          assignment_id: assignment,
          agent_id: agent,
          farm_id: farm,
          printer_key: 'printer',
          ...input.assignmentExtra,
        },
      ],
      telemetry: {
        endpoint: origin + '/api/connector/telemetry',
        audience: 'fixture',
      },
      ...input.extra?.({ agent, farm, assignment }),
    }),
    { mode: 0o600 },
  )
  writeFileSync(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: identity.fingerprint,
      approval: {
        status: 'approved',
        agent_id: agent,
        farm_id: farm,
        device_token:
          'e30.' +
          Buffer.from(JSON.stringify({ jti: randomUUID() })).toString(
            'base64url',
          ) +
          '.AA',
        expires_at: Date.now() + 60_000,
      },
    }),
    { mode: 0o600 },
  )
  return {
    directory,
    configPath,
    credentialPath,
    ids: { agent, farm, assignment },
    journal(): {
      status: string
      reason: string | null
      spoolId: number | null
      tool: string
    }[] {
      try {
        return JSON.parse(
          readFileSync(join(directory, 'filament-runs.json'), 'utf8'),
        ).entries
      } catch {
        return []
      }
    },
    remove: () => rmSync(directory, { recursive: true, force: true }),
  }
}

export async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 15_000,
) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw Error(`Timed out waiting: ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
