import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { browserBundle } from './browser-bundle.ts'
import { chromium, type Browser, type Page } from '@playwright/test'
import { z } from '../../packages/farm-protocol/node_modules/zod/index.js'
import { BrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  ControlSessionBinding,
  controlSdpHash,
  controlDtlsFingerprint,
  controlBindingHash,
  decodeControlProof,
  verifyControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  PauseChannelFrame,
  MAX_PAUSE_CHANNEL_WIRE_BYTES,
  encodePauseChannelFrame,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import {
  encodePauseCapability,
  signPauseCapability,
  MAX_PAUSE_CAPABILITY_WIRE_BYTES,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import type { PausePhaseMessage } from '../../packages/connector/src/webrtc/pause-control-session.ts'

export const pauseControlRtcScenarios = [
  'valid',
  'wrong-assignment',
  'wrong-proof',
  'deadline',
  'oversize',
] as const
export type PauseControlRtcScenario = (typeof pauseControlRtcScenarios)[number]
const Snapshot = z.object({
  diagnostics: z.object({
    proofsReady: z.boolean(),
    sentProofs: z.number().int(),
    receivedProofs: z.number().int(),
    terminal: z.boolean(),
    commandsEnabled: z.literal(false),
    pending: z.number().int(),
    retainedBytes: z.number().int(),
    certificateMatched: z.boolean(),
    closeCount: z.number().int(),
    cleanupFailures: z.number().int(),
  }),
  ready: z
    .object({
      binding: ControlSessionBinding,
      deadlineMonoMs: z.number(),
      browserProofWire: z.string().max(8192),
      connectorProofWire: z.string().max(8192),
    })
    .optional(),
  phases: z.array(PauseChannelFrame).max(2),
  terminals: z.number().int(),
  settled: z.boolean(),
  reason: z.string().optional(),
})
type Snapshot = z.infer<typeof Snapshot>
async function bounded<T>(
  work: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error(label + ' deadline')), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
/** Private fixture IPC boundary; no transport or authority acceptance. */
export function parsePauseFixtureResponse(bytes: Uint8Array): unknown {
  if (
    bytes.byteLength > 65536 ||
    bytes.byteLength < 2 ||
    bytes[bytes.byteLength - 1] !== 10 ||
    bytes.subarray(0, -1).includes(10)
  )
    throw Error('Invalid fixture IPC record')
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)),
  )
  if (value && typeof value === 'object' && 'error' in value)
    throw Error('Child command rejected')
  return value
}
class ConnectorChild {
  readonly child: ChildProcessWithoutNullStreams
  readonly closed: Promise<void>
  #pending:
    { resolve(value: unknown): void; reject(error: Error): void } | undefined
  #carry = Buffer.alloc(0)
  #stderr = 0
  #closed = false
  constructor() {
    this.child = spawn(
      process.execPath,
      [new URL('./pause-control-rtc-child.ts', import.meta.url).pathname],
      { stdio: 'pipe' },
    )
    const child = this.child
    this.closed = new Promise((resolve) =>
      child.once('close', (code, signal) => {
        this.#closed = true
        this.fail(Error('Connector child closed'))
        console.info(
          JSON.stringify({
            event: 'pause-child-close',
            pid: child.pid,
            code,
            signal,
            stdoutDrained: child.stdout.readableEnded,
            stderrDrained: child.stderr.readableEnded,
          }),
        )
        resolve()
      }),
    )
    child.once('exit', (code, signal) => {
      this.fail(Error('Connector child exit'))
      console.info(
        JSON.stringify({
          event: 'pause-child-exit',
          pid: child.pid,
          code,
          signal,
        }),
      )
    })
    child.on('error', (error) => this.fail(error))
    child.stdin.on('error', (error) => this.fail(error))
    child.stdout.on('error', (error) => this.fail(error))
    child.stderr.on('error', (error) => this.fail(error))
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.length
      if (this.#stderr > 65536) {
        this.fail(Error('Child stderr bound'))
        child.kill('SIGTERM')
      }
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.#carry.length + chunk.length > 65536) {
        this.fail(Error('Child stdout bound'))
        child.kill('SIGTERM')
        return
      }
      this.#carry = Buffer.concat([this.#carry, chunk])
      const end = this.#carry.indexOf(10)
      if (end < 0) return
      const pending = this.#pending
      this.#pending = undefined
      if (!pending || end !== this.#carry.length - 1) {
        pending?.reject(Error('Unsolicited child output'))
        child.kill('SIGTERM')
        return
      }
      const record = this.#carry
      this.#carry = Buffer.alloc(0)
      try {
        pending.resolve(parsePauseFixtureResponse(record))
      } catch {
        pending.reject(Error('Invalid child response'))
      }
    })
  }
  private fail(error: Error) {
    const pending = this.#pending
    this.#pending = undefined
    pending?.reject(error)
  }
  async request(input: unknown) {
    if (
      this.#pending ||
      this.#closed ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      throw Error('Child request lifecycle')
    const wire = JSON.stringify(input) + '\n'
    if (Buffer.byteLength(wire) > 65536) throw Error('Child request byte limit')
    try {
      return await bounded(
        new Promise<unknown>((resolve, reject) => {
          this.#pending = { resolve, reject }
          this.child.stdin.write(wire, (error) => {
            if (error) this.fail(error)
          })
        }),
        9000,
        'Child IPC',
      )
    } finally {
      this.#pending = undefined
    }
  }
  async stop() {
    if (!this.#closed) {
      this.child.stdin.end()
      try {
        await bounded(this.closed, 3000, 'Child graceful close')
      } catch {
        this.child.kill('SIGKILL')
        await bounded(this.closed, 1000, 'Child killed close')
      }
    }
    assert.equal(this.#carry.length, 0)
    assert.equal(this.child.stdout.readableEnded, true)
    assert.equal(this.child.stderr.readableEnded, true)
    assert.equal(
      this.child.exitCode,
      0,
      'Child must exit normally; forced cleanup is not acceptance',
    )
  }
}
type BrowserCommand =
  | { kind: 'initialize' | 'snapshot' | 'close' }
  | { kind: 'create'; expected: unknown; wrongProof: boolean }
  | { kind: 'answer'; sdp: string }
  | { kind: 'admit'; binding: unknown }
  | { kind: 'send'; message: PausePhaseMessage }
async function browserCall(page: Page, input: BrowserCommand) {
  return bounded(
    page.evaluate(async (value) => {
      const path = '/fixture.js'
      const fixture: typeof import('./pause-control-rtc-browser.ts') =
        await import(path)
      switch (value.kind) {
        case 'initialize':
          return fixture.initialize()
        case 'snapshot':
          return fixture.snapshot()
        case 'close':
          return fixture.close()
        case 'create':
          return fixture.create(value.expected, value.wrongProof)
        case 'answer':
          return fixture.answer(value.sdp)
        case 'admit':
          return fixture.admit(value.binding)
        case 'send':
          return fixture.send(value.message)
      }
    }, input),
    9000,
    'Browser fixture',
  )
}
async function observe(
  read: () => Promise<unknown>,
  predicate: (value: Snapshot) => boolean,
  label: string,
  ms = 9000,
) {
  const deadline = performance.now() + ms
  while (performance.now() < deadline) {
    const value = Snapshot.parse(await read())
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw Error(label + ' observation deadline')
}
export function assertPauseFixtureClosed(input: unknown) {
  const value = Snapshot.parse(input)
  assert.equal(value.diagnostics.terminal, true)
  assert.equal(value.diagnostics.closeCount, 1)
  assert.equal(value.diagnostics.cleanupFailures, 0)
  assert.equal(value.diagnostics.pending, 0)
  assert.equal(value.diagnostics.retainedBytes, 0)
  assert.equal(value.diagnostics.commandsEnabled, false)
  assert.equal(value.terminals, 1)
  assert.equal(value.settled, true)
}

/** Real transport, SYNTHETIC trusted signalling and issuer. Never SQL/WSS or dispatch authority. */
export async function runPauseControlRtc(
  scenario: PauseControlRtcScenario,
): Promise<void> {
  const bundleText = await browserBundle(
    new URL('./pause-control-rtc-browser.ts', import.meta.url).pathname,
  )
  assert.ok(Buffer.byteLength(bundleText) <= 1024 * 1024)
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405)
      response.end()
      return
    }
    if (request.url === '/fixture.js') {
      response.writeHead(200, {
        'Content-Type': 'text/javascript',
        'Cache-Control': 'no-store',
      })
      response.end(bundleText)
      return
    }
    if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end(
        '<!doctype html><html lang="pt-BR"><title>Fixture RTC de pausa</title><body>Transporte sintético, sem comandos.</body></html>',
      )
      return
    }
    response.writeHead(404)
    response.end()
  })
  server.requestTimeout = 2000
  server.headersTimeout = 2000
  server.maxConnections = 4
  let browser: Browser | undefined,
    page: Page | undefined,
    child: ConnectorChild | undefined
  let primary: unknown
  const cleanupErrors: unknown[] = []
  try {
    server.listen(0, '127.0.0.1')
    await bounded(once(server, 'listening'), 2000, 'Fixture listen')
    const address = server.address()
    if (!address || typeof address === 'string')
      throw Error('Missing fixture port')
    browser = await chromium.launch({ headless: true, timeout: 5000 })
    page = await bounded(browser.newPage(), 3000, 'Browser page')
    page.setDefaultTimeout(9000)
    await page.goto('http://127.0.0.1:' + address.port, { timeout: 5000 })
    child = new ConnectorChild()
    console.info(
      JSON.stringify({
        event: 'pause-fixture-resources',
        scenario,
        driver: process.version,
        chromium: browser.version(),
        childPid: child.child.pid,
        port: address.port,
        authority: 'synthetic-signalling-and-issuer-only',
      }),
    )
    const web = page,
      native = child
    await bounded(
      (async () => {
        const hello = z
          .object({
            spki: z.string(),
            fingerprint: z.string(),
            runtime: z.string(),
            native: z.string(),
            pid: z.number().int(),
          })
          .parse(await native.request({ kind: 'hello' }))
        console.info(
          JSON.stringify({
            event: 'pause-native-version',
            runtime: hello.runtime,
            native: hello.native,
            pid: hello.pid,
          }),
        )
        const browserIdentity = z
          .object({ publicKey: BrowserDevicePublicKey, thumbprint: z.string() })
          .parse(await browserCall(web, { kind: 'initialize' }))
        const expected = {
          transportId: randomUUID(),
          farmId: randomUUID(),
          agentId: randomUUID(),
          assignmentId: randomUUID(),
          accountId: 'synthetic-control-transport-account',
          keyId: randomUUID(),
          origin: 'https://farm.example',
          audience: 'pause-transport-fixture',
        }
        const constructorStarted = performance.now()
        await browserCall(web, {
          kind: 'create',
          expected:
            scenario === 'wrong-assignment'
              ? { ...expected, assignmentId: randomUUID() }
              : expected,
          wrongProof: scenario === 'wrong-proof',
        })
        const { sdp: offer } = z
          .object({ sdp: z.string().max(7000) })
          .parse(await native.request({ kind: 'offer', expected }))
        const answer = z
          .string()
          .max(7000)
          .parse(await browserCall(web, { kind: 'answer', sdp: offer }))
        await native.request({ kind: 'answer', sdp: answer })
        const digest = () => randomBytes(32).toString('base64url'),
          now = Date.now()
        const binding = ControlSessionBinding.parse({
          v: 1,
          purpose: 'pause-rtc',
          transport_id: expected.transportId,
          farm_id: expected.farmId,
          agent_id: expected.agentId,
          assignment_id: expected.assignmentId,
          account_id: expected.accountId,
          key_id: expected.keyId,
          origin: expected.origin,
          audience: expected.audience,
          browser_public_key: browserIdentity.publicKey,
          browser_thumbprint: browserIdentity.thumbprint,
          connector_public_key_spki: hello.spki,
          connector_fingerprint: hello.fingerprint,
          credential_jti: randomUUID(),
          browser_nonce: digest(),
          connector_nonce: digest(),
          issued_at: now,
          expires_at: now + 30000,
          offer_sha256: await controlSdpHash(offer),
          answer_sha256: await controlSdpHash(answer),
          browser_dtls: controlDtlsFingerprint(answer),
          connector_dtls: controlDtlsFingerprint(offer),
        })
        const readNative = () => native.request({ kind: 'snapshot' })
        const readBrowser = () => browserCall(web, { kind: 'snapshot' })
        if (scenario !== 'deadline') {
          await native.request({ kind: 'admit', binding })
          await browserCall(web, { kind: 'admit', binding })
        }
        if (scenario === 'valid' || scenario === 'oversize') {
          const connector = await observe(
            readNative,
            (s) => s.diagnostics.proofsReady,
            'Connector ready',
          )
          const browserReady = await observe(
            readBrowser,
            (s) => s.diagnostics.proofsReady,
            'Browser ready',
          )
          for (const state of [connector, browserReady]) {
            assert.equal(state.diagnostics.certificateMatched, true)
            assert.equal(state.diagnostics.sentProofs, 1)
            assert.equal(state.diagnostics.receivedProofs, 1)
            assert.equal(state.diagnostics.commandsEnabled, false)
            assert.ok(state.ready)
            assert.deepEqual(state.ready.binding, binding)
          }
          assert.ok(connector.ready && browserReady.ready)
          assert.equal(
            connector.ready.browserProofWire,
            browserReady.ready.browserProofWire,
          )
          assert.equal(
            connector.ready.connectorProofWire,
            browserReady.ready.connectorProofWire,
          )
          for (const [role, wire] of [
            ['browser', connector.ready.browserProofWire],
            ['connector', connector.ready.connectorProofWire],
          ] as const) {
            const proof = decodeControlProof(wire)
            assert.equal(proof.role, role)
            assert.deepEqual(proof.binding, binding)
            assert.equal(
              await verifyControlSessionProof(binding, role, proof.signature),
              true,
            )
          }
          const issued = Date.now()
          const nonce = PauseChannelFrame.parse({
            v: 1,
            t: 'control.admission-nonce',
            transport_id: binding.transport_id,
            seq: 2,
            admission_nonce: digest(),
            issued_at: issued,
            expires_at: issued + 8000,
          })
          assert.equal(
            z
              .object({ sent: z.boolean() })
              .parse(await native.request({ kind: 'nonce', frame: nonce }))
              .sent,
            true,
          )
          const received = await observe(
            readBrowser,
            (s) => s.phases.length === 1,
            'Nonce phase',
          )
          assert.deepEqual(received.phases, [nonce])
          assert.equal(nonce.t, 'control.admission-nonce')
          if (nonce.t !== 'control.admission-nonce')
            throw Error('Fixture nonce invariant')
          if (scenario === 'oversize') {
            assert.equal(
              await browserCall(web, {
                kind: 'send',
                message: {
                  t: 'control.capability',
                  wire: 'x'.repeat(MAX_PAUSE_CAPABILITY_WIRE_BYTES + 1),
                },
              }),
              false,
            )
            const rejected = await observe(
              readBrowser,
              (s) => s.diagnostics.terminal,
              'Oversize rejection',
            )
            assert.equal(rejected.reason, 'invalid-send')
            assert.deepEqual(Snapshot.parse(await readNative()).phases, [])
          } else {
            const issuer = await crypto.subtle.generateKey(
              { name: 'Ed25519' },
              false,
              ['sign', 'verify'],
            )
            const wire = encodePauseCapability(
              await signPauseCapability(
                {
                  v: 1,
                  purpose: 'pause-authority',
                  capability_id: randomUUID(),
                  kid: 'synthetic-transport',
                  issuer: 'synthetic-transport-issuer',
                  audience: binding.audience,
                  origin: binding.origin,
                  issued_at: issued,
                  expires_at: Math.min(issued + 8000, binding.expires_at),
                  account_id: binding.account_id,
                  role: 'owner',
                  farm_id: binding.farm_id,
                  agent_id: binding.agent_id,
                  key_id: binding.key_id,
                  assignment_id: binding.assignment_id,
                  transport_id: binding.transport_id,
                  browser_public_key: binding.browser_public_key,
                  browser_thumbprint: binding.browser_thumbprint,
                  connector_fingerprint: binding.connector_fingerprint,
                  credential_jti: binding.credential_jti,
                  printer_key: 'synthetic-transport-printer',
                  control_binding_sha256: await controlBindingHash(binding),
                  admission_nonce: nonce.admission_nonce,
                  actions: ['pause'],
                },
                issuer.privateKey,
              ),
            )
            assert.ok(
              Buffer.byteLength(wire) <= MAX_PAUSE_CAPABILITY_WIRE_BYTES,
            )
            const frame = PauseChannelFrame.parse({
              v: 1,
              t: 'control.capability',
              transport_id: binding.transport_id,
              seq: 2,
              wire,
            })
            assert.ok(
              Buffer.byteLength(encodePauseChannelFrame(frame)) <=
                MAX_PAUSE_CHANNEL_WIRE_BYTES,
            )
            assert.equal(
              await browserCall(web, {
                kind: 'send',
                message: { t: 'control.capability', wire },
              }),
              true,
            )
            const received = await observe(
              readNative,
              (s) => s.phases.length === 1,
              'Capability phase',
            )
            assert.deepEqual(received.phases, [frame])
            assert.equal(received.diagnostics.commandsEnabled, false)
          }
        } else {
          const rejected = await observe(
            readBrowser,
            (s) => s.diagnostics.terminal,
            'Browser explicit rejection',
          )
          if (scenario === 'wrong-assignment')
            assert.equal(rejected.reason, 'binding-rejected')
          if (scenario === 'wrong-proof')
            assert.equal(rejected.reason, 'local-proof')
          if (scenario === 'deadline') {
            assert.equal(rejected.reason, 'auth-deadline')
            const expired = await observe(
              readNative,
              (s) => s.diagnostics.terminal,
              'Connector auth deadline',
            )
            assert.ok(
              performance.now() - constructorStarted >= 7800,
              'Original constructor auth deadline must not fire early',
            )
            assert.ok(
              expired.reason === 'auth-deadline' ||
                expired.reason === 'transport-closed',
              'Remote may close after the earlier browser deadline',
            )
            assert.equal(expired.diagnostics.sentProofs, 0)
            assert.equal(rejected.diagnostics.sentProofs, 0)
            await native.request({ kind: 'admit', binding })
            await browserCall(web, { kind: 'admit', binding })
            assert.equal(
              Snapshot.parse(await readNative()).diagnostics.proofsReady,
              false,
            )
          }
          assert.equal(rejected.diagnostics.proofsReady, false)
          assert.deepEqual(rejected.phases, [])
          const remote = Snapshot.parse(await readNative())
          assert.deepEqual(remote.phases, [])
          assert.equal(remote.diagnostics.proofsReady, false)
        }
        const nativeClosed = Snapshot.parse(
          await native.request({ kind: 'close' }),
        )
        const webClosed = Snapshot.parse(
          await browserCall(web, { kind: 'close' }),
        )
        assertPauseFixtureClosed(nativeClosed)
        assertPauseFixtureClosed(webClosed)
        console.info(
          JSON.stringify({
            event: 'pause-transport-result',
            scenario,
            native: nativeClosed.diagnostics,
            browser: webClosed.diagnostics,
            nativeReason: nativeClosed.reason,
            browserReason: webClosed.reason,
            commandsExecuted: 0,
          }),
        )
      })(),
      20000,
      'Control interaction',
    )
  } catch (error) {
    primary = error
    // Nonsecret endpoint evidence; a failed read remains unknown, never success.
    for (const [endpoint, read] of [
      ['native', () => child?.request({ kind: 'snapshot' })],
      [
        'browser',
        () =>
          page && !page.isClosed()
            ? browserCall(page, { kind: 'snapshot' })
            : undefined,
      ],
    ] as const) {
      try {
        const snapshot = Snapshot.parse(
          await bounded(Promise.resolve(read()), 500, 'Failure census'),
        )
        console.info(
          JSON.stringify({
            event: 'pause-failure-census',
            scenario,
            endpoint,
            diagnostics: snapshot.diagnostics,
            reason: snapshot.reason,
          }),
        )
      } catch {
        console.info(
          JSON.stringify({
            event: 'pause-failure-census',
            scenario,
            endpoint,
            observation: 'unavailable',
          }),
        )
      }
    }
  } finally {
    // Every independent disposal is attempted even if another rejects.
    if (page && !page.isClosed()) {
      try {
        await browserCall(page, { kind: 'close' })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (child) {
      try {
        await child.stop()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (browser) {
      try {
        await bounded(browser.close(), 3000, 'Chromium cleanup')
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    try {
      server.closeAllConnections()
      if (server.listening)
        await bounded(
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
          1000,
          'HTTP cleanup',
        )
    } catch (error) {
      cleanupErrors.push(error)
    }
  }
  if (primary || cleanupErrors.length)
    throw new AggregateError(
      [...(primary ? [primary] : []), ...cleanupErrors],
      'Pause transport fixture failed',
    )
  console.info(
    JSON.stringify({
      event: 'pause-transport-cleanup',
      scenario,
      childClosed: true,
      browserClosed: true,
      serverClosed: true,
    }),
  )
}
