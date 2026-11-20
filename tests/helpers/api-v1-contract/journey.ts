import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  signApiEnvelope,
} from '../../../packages/farm-protocol/src/api-envelope.ts'
import {
  decodeSignallingServerFrame,
  encodeSignallingServerFrame,
} from '../../../packages/farm-protocol/src/signalling-socket.ts'
import { createOfflineAuthority } from '../../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../../packages/connector/src/control/printer-binding.ts'
import {
  receiveApiCommand,
  type ApiPrinterObservation,
} from '../../../packages/connector/src/runtime/api-command.ts'
import { apiBase, call } from './router.ts'
import { ids, type freshWorld } from './world.ts'

export async function openJourney(
  world: ReturnType<typeof freshWorld>,
  onCleanup: (cleanup: () => void | Promise<void>) => void,
) {
  async function listen(server: Server, host = '127.0.0.1') {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    onCleanup(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    const address = server.address()
    assert(address && typeof address !== 'string')
    return `${host}:${address.port}`
  }

  const file = 'G28\n'
  const fixture = new URL('../../fixtures/bambu-ftps/', import.meta.url)
  const [cert, key] = await Promise.all([
    readFile(new URL('cert.pem', fixture)),
    readFile(new URL('key.pem', fixture)),
  ])
  const source = await listen(
    createHttpsServer({ cert, key }, (_req, res) => res.end(file)),
    'localhost',
  )
  const executed: string[] = []
  const uploaded: string[] = []
  const states = [
    { action: 'start_print', from: 'idle', to: 'printing' },
    { action: 'pause', from: 'printing', to: 'paused' },
    { action: 'cancel', from: 'paused', to: 'idle' },
  ] as const
  const printer = {
    ready: true,
    printState: 'idle',
  } satisfies ApiPrinterObservation
  const printerOrigin =
    'http://' +
    (await listen(
      createServer(async (req, res) => {
        const body = await text(req)
        if (req.method === 'POST' && req.url === '/server/files/upload') {
          uploaded.push(body)
          res.end()
          return
        }
        const next = states[executed.length]
        if (
          req.method !== 'POST' ||
          !next ||
          req.url !== '/printer/' + next.action ||
          printer.printState !== next.from ||
          (next.action === 'start_print' &&
            (body !== '{"file":"journey.gcode"}' ||
              !uploaded[0]?.includes(file)))
        ) {
          res.writeHead(409).end()
          return
        }
        executed.push(next.action)
        printer.printState = next.to
        res.end()
      }),
    ))

  const directory = await mkdtemp(join(tmpdir(), 'openfarm-204-journal-'))
  onCleanup(() => rm(directory, { recursive: true, force: true }))
  const clock = { wallNow: Date.now, monotonicNow: () => performance.now() }
  const journal = openCommandJournal({ directory, clock: clock.wallNow })
  onCleanup(() => closeCommandJournal(journal))
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const bindings = createPrinterBindingRegistry({
    allowedOrigins: [printerOrigin],
  })
  const binding = bindings.provision({
    assignment_id: ids.printerA1,
    farm_id: ids.farmA,
    agent_id: ids.agentA,
    printer_key: 'printer-a1',
    moonraker_origin: printerOrigin,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall: clock.wallNow(), mono: clock.monotonicNow() }, 1)
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  const inboxOrigin =
    'http://' +
    (await listen(
      createServer(async (req, res) => {
        try {
          assert.equal(req.method, 'POST')
          const frame = decodeSignallingServerFrame(await text(req))
          assert.equal(frame.t, 'connector.api-command')
          const outcome = await receiveApiCommand(
            {
              farmId: ids.farmA,
              agentId: ids.agentA,
              clock,
              journal,
              keys: {
                issuer: (issuer, kid) =>
                  issuer === API_ENVELOPE_ISSUER && kid === 'journey'
                    ? keys.publicKey
                    : undefined,
              },
              printer: (id) => (id === ids.printerA1 ? binding : undefined),
              observe: (target) => (target === binding ? printer : null),
              jobFiles: {
                directory,
                ca: cert,
                targetFor: () => ({
                  backend: 'moonraker',
                  origin: printerOrigin,
                }),
              },
              driver: {
                async prepare() {
                  return { connectionGeneration: 1 }
                },
                controls: () => ['start_print', 'pause', 'cancel'],
                macros: () => [],
                async execute(action, args, input) {
                  if (!input.beforeSend()) return { acknowledged: false }
                  const reply = await fetch(
                    printerOrigin + '/printer/' + action,
                    {
                      method: 'POST',
                      body: JSON.stringify(args),
                      signal: input.signal,
                    },
                  )
                  return { acknowledged: reply.ok }
                },
              },
            },
            frame,
            {
              signal: AbortSignal.timeout(5000),
              freshness: authority.freshness,
              report: (wire) =>
                reports.push(decodeApiEnvelopeResultFrame(wire)),
            },
          )
          res.end(JSON.stringify(outcome))
        } catch {
          res.writeHead(500).end()
        }
      }),
    ))

  const apiOrigin =
    'http://' +
    (await listen(
      createServer(async (req, res) => {
        try {
          assert(req.url?.startsWith(apiBase + '/'))
          const input = {
            method: req.method ?? '',
            path: req.url.slice(apiBase.length),
            headers: Object.fromEntries(
              new Headers(
                req.rawHeaders.flatMap((name, index, entries) =>
                  index % 2 === 0 ? [[name, entries[index + 1] ?? '']] : [],
                ),
              ),
            ),
            body: await text(req),
          }
          const result = await call(input)
          res
            .writeHead(result.status, Object.fromEntries(result.headers))
            .end(result.text)
        } catch {
          res.writeHead(500).end()
        }
      }),
    ))

  world.envelopes.deliver = async (cmdId) => {
    const record = await world.envelopes.get(cmdId)
    assert(record)
    const command = world.envelopes.commands.get(record.cmdId)
    assert(command)
    const envelope = await signApiEnvelope(
      {
        v: 1,
        purpose: 'api-envelope',
        issuer: API_ENVELOPE_ISSUER,
        kid: 'journey',
        app_id: record.appId,
        grant_id: record.grantId,
        farm_id: record.farmId,
        agent_id: record.agentId,
        assignment_id: record.printerAssignmentId,
        resource_id: record.resourceId,
        cmd_id: record.cmdId,
        nonce: record.nonce,
        issued_at: record.issuedAt,
        expires_at: record.expiresAt,
        ...command,
      },
      keys.privateKey,
    )
    const reply = await fetch(inboxOrigin, {
      method: 'POST',
      body: encodeSignallingServerFrame({
        v: 1,
        t: 'connector.api-command',
        scope: record.requiredScope,
        confirmed_at: Date.now(),
        wire: encodeApiEnvelopeFrame({
          v: 1,
          t: 'api-envelope.command',
          envelope,
        }),
      }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(await reply.json(), { kind: 'completed' })
    return 'sent'
  }

  return {
    apiOrigin,
    job: {
      fileUrl: `https://${source}/journey.gcode`,
      sha256: createHash('sha256').update(file).digest('hex'),
      sizeBytes: Buffer.byteLength(file),
      displayName: 'journey.gcode',
    },
    executed,
    uploaded,
    printer,
    reports,
  }
}
