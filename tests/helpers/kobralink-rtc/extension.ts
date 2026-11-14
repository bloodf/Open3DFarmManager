import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runConfigurationConnector } from '../../../packages/connector/src/runtime/configuration-command.ts'
import { configurationConnectorSocket } from '../../../packages/connector/src/webrtc/configuration-signalling.ts'
import type { PairingPollResponse } from '../../../packages/farm-protocol/src/pairing.ts'
import { leasePhase, type Lease } from './qualification.ts'

/** Production constant mirrored for timing decisions only; never overridden. */
export const MIN_CONTEXT_MS = 5000

const ALLOWED_T = new Set([
  'config.connector-begin',
  'config.connector-challenge',
  'config.connector-proof',
  'config.connector-ready',
  'config.advertise',
  'config.retry',
  'config.context-request',
  'config.binding',
  'config.context-closed',
  'rtc.offer',
  'rtc.answer',
  'rtc.ice',
  'rtc.close',
])

type Approved = Extract<PairingPollResponse, { status: 'approved' }>

/** Private files the real `configure` command reads. Removed by the runner. */
export async function writeConnectorFiles(input: {
  root: string
  origin: string
  audience: string
  farmId: string
  fingerprint: string
  claim: Approved
  kobraPort: number
}) {
  const credentialPath = join(input.root, 'credential.json')
  const provisioningPath = join(input.root, 'provisioning.json')
  await writeFile(
    credentialPath,
    JSON.stringify({
      version: 1,
      expected_fingerprint: input.fingerprint,
      approval: input.claim,
    }),
    { mode: 0o600, flag: 'wx' },
  )
  await writeFile(
    provisioningPath,
    JSON.stringify({
      version: 1,
      mode: 'configuration-provisioning',
      farm_id: input.farmId,
      agent_id: input.claim.agent_id,
      farmOrigin: input.origin,
      credentialAudience: input.audience,
      stateDirectory: join(input.root, 'state'),
      runtimeConfigPath: join(input.root, 'runtime.json'),
      printerNetworks: ['172.30.78.0/24'],
      managedBridge: {
        origin: `http://127.0.0.1:${input.kobraPort}`,
        ownership: 'connector-owned-fresh',
      },
      runtimeTemplate: {
        telemetry: {
          endpoint: input.origin + '/api/connector/telemetry',
          audience: input.audience,
        },
        signalling: {
          endpoint:
            input.origin.replace('https:', 'wss:') +
            '/api/signalling/connector',
          origin: input.origin,
          audience: input.audience,
        },
        rtc: { bindAddress: '127.0.0.1' },
      },
      rtc: { bindAddress: '127.0.0.1' },
    }),
    { mode: 0o600, flag: 'wx' },
  )
  return { credentialPath, provisioningPath }
}

export type TransportEntry = Readonly<{
  target: 'bridge' | 'farm'
  method: string
  path: string
  status: number | null
}>

/**
 * Hosts the real native Connector `configure` runtime in this process and
 * observes it: diagnostics, allowlisted signalling frame kinds, the inbox
 * lease the server actually granted, and its outbound HTTP. It can be stopped
 * and started again on the same durable state, like a service restart.
 */
export function createConnectorHost(input: {
  root: string
  origin: string
  provisioningPath: string
  credentialPath: string
  dataDirectory: string
  t0: number
}) {
  const events: Readonly<Record<string, unknown>>[] = []
  const transport: TransportEntry[] = []
  const frames: { atMs: number; dir: 'out' | 'in'; t: string }[] = []
  const now = () => Math.round(performance.now() - input.t0)
  let lease: Lease | null = null
  let renewals = 0
  let controller: AbortController | undefined
  let done: Promise<void> | undefined
  let failure: unknown
  const boundary = (entry: Readonly<Record<string, unknown>>) =>
    appendFile(
      join(input.root, 'boundary.jsonl'),
      JSON.stringify({ atMs: now(), ...entry }) + '\n',
      { mode: 0o600 },
    ).catch(() => {})
  const frameKind = (raw: unknown): string => {
    try {
      if (typeof raw !== 'string') return 'non-string'
      const parsed: unknown = JSON.parse(raw)
      const t =
        parsed && typeof parsed === 'object' && 't' in parsed
          ? parsed.t
          : undefined
      return typeof t === 'string' && ALLOWED_T.has(t) ? t : 'other'
    } catch {
      return 'invalid'
    }
  }
  /** Only the two lease timestamps are read from the ready frame. */
  const observeLease = (raw: unknown) => {
    try {
      if (typeof raw !== 'string') return
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed &&
        typeof parsed === 'object' &&
        't' in parsed &&
        parsed.t === 'config.connector-ready' &&
        'issued_at' in parsed &&
        'expires_at' in parsed &&
        typeof parsed.issued_at === 'number' &&
        typeof parsed.expires_at === 'number'
      ) {
        lease = { issuedAt: parsed.issued_at, expiresAt: parsed.expires_at }
        renewals++
        void boundary({
          side: 'connector-lease',
          renewal: renewals,
          leaseMs: parsed.expires_at - parsed.issued_at,
        })
      }
    } catch {
      /* Observation only. */
    }
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (resource, init) => {
    const value = resource instanceof Request ? resource.url : String(resource)
    const url = new URL(value)
    const target = url.origin === input.origin ? 'farm' : 'bridge'
    const path = url.pathname.replace(
      /^(\/api\/v1\/printers\/)[A-Za-z0-9_-]+/,
      '$1:id',
    )
    const method = init?.method ?? 'GET'
    const started = performance.now()
    const note = (status: number | null, error?: string) => {
      if (transport.length < 4096)
        transport.push({ target, method, path, status })
      return appendFile(
        join(input.root, 'transport.jsonl'),
        JSON.stringify({
          atMs: now(),
          target,
          path,
          method,
          ...(status === null ? { error } : { status }),
          ms: Math.round(performance.now() - started),
        }) + '\n',
        { mode: 0o600 },
      ).catch(() => {})
    }
    try {
      const response = await originalFetch(resource, init)
      await note(response.status)
      return response
    } catch (error) {
      await note(null, error instanceof Error ? error.name : 'unknown')
      throw error
    }
  }

  function start() {
    if (controller) throw new Error('Connector already running')
    const current = new AbortController()
    controller = current
    events.push({ kind: 'harness', state: 'connector-start' })
    done = runConfigurationConnector({
      provisioningPath: input.provisioningPath,
      dataDirectory: input.dataDirectory,
      credentialPath: input.credentialPath,
      signal: current.signal,
      async socket() {
        const inner = await configurationConnectorSocket(input.origin)
        await boundary({ side: 'connector-ws', state: 'created' })
        return {
          send(wire) {
            if (frames.length < 8192)
              frames.push({ atMs: now(), dir: 'out', t: frameKind(wire) })
            void boundary({
              side: 'connector-ws-out',
              t: frameKind(wire),
              bytes: Buffer.byteLength(wire),
            })
            inner.send(wire)
          },
          close() {
            lease = null
            void boundary({ side: 'connector-ws', state: 'close-call' })
            inner.close()
          },
          bind(handlers) {
            inner.bind({
              message(raw) {
                if (frames.length < 8192)
                  frames.push({ atMs: now(), dir: 'in', t: frameKind(raw) })
                void boundary({
                  side: 'connector-ws-in',
                  t: frameKind(raw),
                  bytes: typeof raw === 'string' ? Buffer.byteLength(raw) : 0,
                })
                observeLease(raw)
                handlers.message(raw)
              },
              close() {
                lease = null
                void boundary({ side: 'connector-ws', state: 'closed' })
                handlers.close()
              },
            })
          },
        }
      },
      onDiagnostic(event) {
        if (events.length < 8192) events.push(event)
        void appendFile(
          join(input.root, 'connector.jsonl'),
          JSON.stringify({ atMs: now(), ...event }) + '\n',
          { mode: 0o600 },
        ).catch(() => {})
      },
    }).catch((error: unknown) => {
      failure = error
    })
  }
  async function stop() {
    const current = controller
    controller = undefined
    lease = null
    if (!current) return
    current.abort()
    await done
    events.push({ kind: 'harness', state: 'connector-stop' })
  }
  const pause = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms))

  return {
    events,
    transport,
    frames,
    start,
    stop,
    async restart() {
      await stop()
      start()
    },
    running: () => controller !== undefined,
    failure: () => failure,
    renewals: () => renewals,
    lease: () => lease,
    phase: () => leasePhase(lease, Date.now(), MIN_CONTEXT_MS),
    /**
     * `fresh`: at least 7 s of inbox lease remain, so a `config.begin` sent now
     * is admissible with margin. `near-rotation`: 1.5-3.5 s remain, less than
     * the production MIN_CONTEXT_MS, while the inbox is still live.
     */
    async waitLease(kind: 'fresh' | 'near-rotation', timeoutMs = 45_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const current = lease
        if (current) {
          const remaining = current.expiresAt - Date.now()
          if (kind === 'fresh' && remaining >= 7000) return remaining
          if (
            kind === 'near-rotation' &&
            remaining >= 1500 &&
            remaining <= 3500
          )
            return remaining
        }
        await pause(40)
      }
      throw new Error(`Connector lease phase ${kind} not reached`)
    },
    async waitRenewals(count: number, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs
      while (renewals < count) {
        if (Date.now() >= deadline)
          throw new Error('Connector inbox renewal not observed')
        await pause(100)
      }
      return renewals
    },
    async waitEvent(
      match: (event: Readonly<Record<string, unknown>>) => boolean,
      from: number,
      timeoutMs = 30_000,
    ) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (events.slice(from).some(match)) return true
        await pause(100)
      }
      return false
    },
    count: (match: (event: Readonly<Record<string, unknown>>) => boolean) =>
      events.filter(match).length,
    bridgeCalls(method: string, pattern: RegExp) {
      return transport.filter(
        (entry) =>
          entry.target === 'bridge' &&
          entry.method === method &&
          pattern.test(entry.path) &&
          entry.status !== null &&
          entry.status < 400,
      ).length
    },
    async dispose() {
      await stop()
      globalThis.fetch = originalFetch
    },
  }
}
export type ConnectorHost = ReturnType<typeof createConnectorHost>
