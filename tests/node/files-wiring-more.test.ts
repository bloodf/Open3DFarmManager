import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { PauseConnectorPeer } from '../../packages/connector/src/webrtc/pause-control-peer.ts'
import { PauseBrowserPeer } from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { createPauseCommandRelay } from '../../packages/connector/src/control/pause-command-relay.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import {
  controlBindingHash,
  controlDtlsFingerprint,
  controlSdpHash,
  type ControlSessionBinding,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  signPauseCapability,
  encodePauseCapability,
  signPauseAdmissionProof,
  encodePauseAdmissionProof,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import type { PausePhaseFrame } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import type { FileUploadTarget } from '../../packages/connector/src/runtime/file-upload.ts'
import type { FileListTarget } from '../../packages/connector/src/runtime/file-list.ts'
import { createKobraLinkFilesTarget } from '../../packages/connector/src/kobralink/runtime.ts'
import { createKobraLinkClient } from '../../packages/connector/src/kobralink/client.ts'
import { createFilesFixture } from '../fixtures/kobralink-integration/files.ts'
import { createFilesSession } from '../../apps/farm/app/utils/files-view-session.ts'
import { buildCrealityCommand } from '../../packages/connector/src/creality/commands.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  provisionCrealityPrinter,
  provisionAnycubicPrinter,
  provisionKobraLinkPrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createCrealitySimulator } from '../../packages/sim-tools/src/creality-simulator.ts'
import { startAnycubicSimulator } from '../fixtures/anycubic-files.ts'
import { writeFile } from 'node:fs/promises'
import type { KobraLinkFetch } from '../../packages/connector/src/kobralink/client.ts'

type Native =
  typeof import('../../packages/connector/node_modules/node-datachannel')
const native: Native = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('node-datachannel')
type Channel = ReturnType<
  InstanceType<Native['PeerConnection']>['createDataChannel']
>

// Browser API adapter over real loopback SCTP/DTLS. All application peers are production classes.
class LoopbackBrowser {
  peer = new native.PeerConnection('upload-browser', {
    iceServers: [],
    bindAddress: '127.0.0.1',
    enableIceTcp: false,
  })
  onconnectionstatechange: (() => void) | null = null
  ondatachannel: ((event: { channel: object }) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  ontrack = null
  iceGatheringState = 'new'
  connectionState = 'new'
  gathering = deferred<void>()
  constructor() {
    this.peer.onGatheringStateChange((state) => {
      if (state === 'complete') {
        this.iceGatheringState = 'complete'
        this.gathering.resolve()
        this.onicegatheringstatechange?.()
      }
    })
    this.peer.onStateChange((state) => {
      this.connectionState = state
      this.onconnectionstatechange?.()
    })
    this.peer.onDataChannel((channel) => {
      this.ondatachannel?.({ channel: this.wrap(channel) })
    })
  }
  wrap(channel: Channel) {
    const wrapped = {
      label: channel.getLabel(),
      protocol: '',
      ordered: true,
      maxPacketLifeTime: null,
      maxRetransmits: null,
      get readyState() {
        return channel.isOpen() ? 'open' : 'closed'
      },
      get bufferedAmount() {
        return channel.bufferedAmount()
      },
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onopen: null as (() => void) | null,
      onclose: null as (() => void) | null,
      onerror: null as (() => void) | null,
      send(wire: string | ArrayBuffer) {
        assert.equal(
          typeof wire === 'string'
            ? channel.sendMessage(wire)
            : channel.sendMessageBinary(Buffer.from(wire)),
          true,
        )
      },
      close() {
        channel.close()
      },
    }
    channel.onMessage((data) => wrapped.onmessage?.({ data }))
    channel.onOpen(() => wrapped.onopen?.())
    channel.onClosed(() => wrapped.onclose?.())
    channel.onError(() => wrapped.onerror?.())
    return wrapped
  }
  get localDescription() {
    return this.peer.localDescription()
  }
  get remoteDescription() {
    return this.peer.remoteDescription()
  }
  async setRemoteDescription(value: { sdp: string; type: 'offer' }) {
    this.peer.setRemoteDescription(value.sdp, value.type)
  }
  async createAnswer() {
    await this.gathering.promise
    return this.peer.localDescription()
  }
  async setLocalDescription() {}
  async getStats() {
    const fingerprint = this.peer.remoteFingerprint()
    return new Map([
      [
        'transport',
        {
          type: 'transport',
          dtlsState: 'connected',
          remoteCertificateId: 'cert',
        },
      ],
      [
        'cert',
        {
          type: 'certificate',
          fingerprintAlgorithm: fingerprint.algorithm,
          fingerprint: fingerprint.value,
        },
      ],
    ])
  }
  close() {
    this.peer.close()
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function waitFor(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 5000
  while (!(await check())) {
    if (Date.now() > end) throw Error('Fixture deadline')
    await new Promise((r) => setTimeout(r, 5))
  }
}
const nonce = () => randomBytes(32).toString('base64url')

async function connect(
  t: test.TestContext,
  target: FileUploadTarget,
  listTarget: FileListTarget,
  actions: ('pause' | 'start_print')[] = ['start_print'],
  admit = true,
  control?: {
    binding(scope: {
      assignment_id: string
      farm_id: string
      agent_id: string
      printer_key: string
    }): PrinterBinding
    fetch?: KobraLinkFetch
  },
) {
  const dir = await mkdtemp(join(tmpdir(), 'files-wiring-more-'))
  const staging = join(dir, 'staging')
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  const publicKey = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const expected = {
    transportId: randomUUID(),
    farmId: randomUUID(),
    agentId: randomUUID(),
    assignmentId: randomUUID(),
    accountId: 'upload-operator',
    keyId: randomUUID(),
    origin: 'https://farm.example',
    audience: 'upload-fixture',
  }
  const registry = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1'],
  })
  const scope = {
    assignment_id: expected.assignmentId,
    farm_id: expected.farmId,
    agent_id: expected.agentId,
    printer_key: 'printer',
  }
  const mapping = control
    ? control.binding(scope)
    : registry.provision({
        assignment_id: expected.assignmentId,
        farm_id: expected.farmId,
        agent_id: expected.agentId,
        printer_key: 'printer',
        moonraker_origin: 'http://127.0.0.1',
      })
  const journal = openCommandJournal({
    directory: join(dir, 'journal'),
    clock: Date.now,
  })
  const outcome =
    deferred<
      import('../../packages/connector/src/webrtc/pause-control-session.ts').PauseCommandOutcome
    >()
  const driver = control
    ? createPauseDriverRouter({
        allowedOrigins: ['http://127.0.0.1:7100'],
        limits: {
          maxMessageBytes: 65536,
          connectTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          staleAfterMs: 5000,
          reconnectMinMs: 100,
          reconnectMaxMs: 1000,
        },
        clock: { monotonicNow: () => performance.now() },
        observe: (binding, value) => relay.observe(binding, value),
        ...(control.fetch ? { kobraLinkFetch: control.fetch } : {}),
      })
    : undefined
  let fresh = true
  const relay = createPauseCommandRelay({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'upload-1', publicKey: issuer.publicKey },
      ],
      freshness: { freshAt: () => fresh },
    },
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
    journal,
    driver: driver ?? {
      async prepare() {
        throw Error('No printer commands allowed')
      },
      async closeAttempt() {},
      async pauseOnce() {
        throw Error('No printer commands allowed')
      },
      async waitForPaused() {
        throw Error('No printer commands allowed')
      },
    },
    bindingFor: () => mapping,
  })
  const bindingReady = deferred<ControlSessionBinding>()
  const challenge =
    deferred<Extract<PausePhaseFrame, { t: 'control.admission-nonce' }>>()
  let connector: PauseConnectorPeer
  connector = new PauseConnectorPeer({
    identity,
    expected,
    expectedBinding: bindingReady.promise,
    getAdmittedHandle: (id) => relay.admittedHandle(id),
    fileTransfer: {
      directory: staging,
      targetFor: (key) => (key === 'printer' ? target : undefined),
    },
    fileList: {
      targetFor: (key) => (key === 'printer' ? listTarget : undefined),
    },
    onProofsReady(value) {
      assert.equal(
        relay.openPeer({
          ...value,
          sendPhase: (frame) => connector.sendPhase(frame),
          sendResult: (result) => connector.sendResult(result),
        }),
        true,
      )
    },
    onPhase(frame) {
      if (frame.t === 'control.capability')
        void relay.admitPeer({
          transportId: expected.transportId,
          capabilityWire: frame.wire,
        })
      if (frame.t === 'control.admission-proof')
        void relay.admitPeer({
          transportId: expected.transportId,
          admissionProofWire: frame.wire,
        })
    },
    onData(frame) {
      if (frame.t === 'control.command')
        void relay.commandPeer({
          transportId: expected.transportId,
          wire: frame.wire,
        })
    },
    onTerminal() {
      relay.closePeer(expected.transportId)
    },
  })
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'RTCPeerConnection',
  )
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: LoopbackBrowser,
  })
  const browser = new PauseBrowserPeer({
    privateKey: keys.privateKey,
    expected,
    expectedBinding: bindingReady.promise,
    onData(frame) {
      if (frame.t === 'control.result') outcome.resolve(frame.outcome)
    },
    onPhase(frame) {
      if (frame.t === 'control.admission-nonce') challenge.resolve(frame)
    },
  })
  t.after(async () => {
    browser.close()
    connector.close()
    relay.close()
    await Promise.all([browser.closed, connector.closed, relay.settled])
    closeCommandJournal(journal)
    if (original)
      Object.defineProperty(globalThis, 'RTCPeerConnection', original)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
    await rm(dir, { recursive: true })
  })
  const offer = await connector.offer()
  const answer = await browser.answer(offer)
  connector.answer(answer)
  const binding: ControlSessionBinding = {
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
    browser_public_key: publicKey.publicKey,
    browser_thumbprint: publicKey.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    browser_nonce: nonce(),
    connector_nonce: nonce(),
    issued_at: Date.now(),
    expires_at: Date.now() + 30000,
    offer_sha256: await controlSdpHash(offer),
    answer_sha256: await controlSdpHash(answer),
    browser_dtls: controlDtlsFingerprint(answer),
    connector_dtls: controlDtlsFingerprint(offer),
  }
  bindingReady.resolve(binding)
  const phase = await challenge.promise
  const issuedAt = Date.now()
  const common = {
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    account_id: binding.account_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_thumbprint: binding.browser_thumbprint,
    origin: binding.origin,
    audience: binding.audience,
    control_binding_sha256: await controlBindingHash(binding),
    admission_nonce: phase.admission_nonce,
    issued_at: issuedAt,
  }
  const capability = await signPauseCapability(
    {
      ...common,
      v: 1,
      purpose: 'pause-authority',
      capability_id: randomUUID(),
      kid: 'upload-1',
      issuer: 'farm:issuer',
      expires_at: binding.expires_at,
      role: 'operator',
      browser_public_key: publicKey.publicKey,
      connector_fingerprint: binding.connector_fingerprint,
      credential_jti: binding.credential_jti,
      printer_key: 'printer',
      actions,
    },
    issuer.privateKey,
  )
  const proof = await signPauseAdmissionProof(
    {
      ...common,
      v: 1,
      purpose: 'pause-admission',
      challenge_id: randomUUID(),
      expires_at: issuedAt + 8000,
    },
    keys.privateKey,
  )
  if (admit) {
    assert.equal(
      browser.sendPhase({
        t: 'control.capability',
        wire: encodePauseCapability(capability),
      }),
      true,
    )
    assert.equal(
      browser.sendPhase({
        t: 'control.admission-proof',
        wire: encodePauseAdmissionProof(proof),
      }),
      true,
    )
    await waitFor(() => !!relay.admittedHandle(expected.transportId))
  }
  const bytes = Buffer.from('G28\n' + '; fixture only\n'.repeat(3000))
  const fileOffer = {
    type: 'offer',
    transfer_id: 'fixture-upload',
    name: 'fixture.gcode',
    printer_key: 'printer',
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
  return {
    browser,
    connector,
    relay,
    registry,
    mapping,
    staging,
    bytes,
    fileOffer,
    transportId: expected.transportId,
    async start(file: string) {
      const now = Date.now()
      const command = await signCommandV2(
        {
          v: 2,
          purpose: 'printer-control',
          cmd_id: randomUUID(),
          farm_id: binding.farm_id,
          agent_id: binding.agent_id,
          account_id: binding.account_id,
          key_id: binding.key_id,
          transport_id: binding.transport_id,
          capability_id: capability.capability_id,
          assignment_id: binding.assignment_id,
          action: 'start_print',
          args: { file },
          issued_at: now,
          expires_at: now + 5000,
          nonce: randomBytes(16).toString('base64url'),
        },
        keys.privateKey,
      )
      assert.equal(
        browser.sendCommand({
          t: 'control.command',
          wire: encodeCommandV2(command),
        }),
        true,
      )
      return outcome.promise
    },
    invalidateAuthority() {
      fresh = false
    },
  }
}

// Public wire sources are cited by creality/files.ts and anycubic/files.ts.
// KobraLink fixtures follow NatHacks/Kobralink 5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1.
function kobraTarget(fixture: ReturnType<typeof createFilesFixture>) {
  return {
    backend: 'kobralink' as const,
    binding: { id: 'printer-1', deviceId: 'synthetic-device' },
    async client(signal: AbortSignal) {
      const origin = 'http://127.0.0.1:7100'
      const client = createKobraLinkClient({
        origin,
        allowedOrigins: [origin],
        signal,
        fetch: fixture.fetch,
      })
      await client.authenticate({
        ownership: 'fresh_owned',
        mode: 'signin',
        name: 'Connector',
        email: 'c@example.test',
        password: 'synthetic-password',
      })
      return client
    },
  }
}

test(
  'real file channel uploads Creality multipart, cleans staging and reports unsupported listing',
  { timeout: 15000 },
  async (t) => {
    let received = Buffer.alloc(0)
    const server = createServer((req, res) => {
      assert.equal(req.method, 'POST')
      assert.equal(req.url, '/upload/fixture.gcode')
      req.on('data', (b) => {
        received = Buffer.concat([received, b])
      })
      req.on('end', () => res.writeHead(201).end())
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    t.after(
      () =>
        new Promise<void>((r) => {
          server.closeAllConnections()
          server.close(() => r())
        }),
    )
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const f = await connect(
      t,
      { backend: 'creality', origin: `http://127.0.0.1:${address.port}` },
      { backend: 'creality' },
    )
    const list = await f.browser.listFiles('printer')
    assert.equal(list.ok, false)
    if (!list.ok) assert.equal(list.reason, 'unsupported')
    const upload = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
    assert.equal(upload.ok, true)
    assert.ok(received.includes(f.bytes))
    assert.match(received.toString(), /name="file"; filename="fixture.gcode"/)
    assert.deepEqual(await readdir(f.staging), [])
    assert.deepEqual(
      buildCrealityCommand('start_print', { file: f.fileOffer.name }),
      {
        method: 'set',
        params: {
          opGcodeFile: 'printprt:/usr/data/printer_data/gcodes/fixture.gcode',
        },
      },
    )
  },
)

test(
  'Anycubic undocumented upload and listing return unsupported through real channel without staging',
  { timeout: 15000 },
  async (t) => {
    const f = await connect(t, { backend: 'anycubic' }, { backend: 'anycubic' })
    const list = await f.browser.listFiles('printer')
    assert.equal(list.ok, false)
    if (!list.ok) assert.equal(list.reason, 'unsupported')
    const upload = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
    assert.equal(upload.ok, false)
    if (!upload.ok) assert.equal(upload.reason, 'unsupported')
    await assert.rejects(readdir(f.staging), { code: 'ENOENT' })
  },
)

test(
  'KobraLink library upload and listing cross the real file channel without treating library files as printer-local',
  { timeout: 15000 },
  async (t) => {
    const fixture = createFilesFixture()
    fixture.state.printState = 'standby'
    const target = kobraTarget(fixture)
    const f = await connect(t, target, target)
    const result = await f.browser.listFiles('printer')
    assert.equal(result.ok, true)
    if (!result.ok) throw Error('Expected library list')
    assert.deepEqual(result.files, [
      {
        name: 'part.gcode',
        size: 4,
        modified: 0,
        printRef: 'kobralink-library:file-1',
      },
    ])
    const uploaded = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
    assert.equal(uploaded.ok, true)
    if (uploaded.ok) assert.equal(uploaded.library, true)
    assert.deepEqual(fixture.uploads, [
      { name: 'fixture.gcode', content: f.bytes.toString(), print: 'false' },
    ])
    assert.deepEqual(fixture.starts, [])
    assert.deepEqual(await readdir(f.staging), [])
  },
)

for (const backend of ['creality', 'anycubic', 'kobralink'] as const) {
  test(
    `${backend} file channel retains admission and printer isolation`,
    { timeout: 15000 },
    async (t) => {
      const fixture = createFilesFixture()
      const target =
        backend === 'kobralink'
          ? kobraTarget(fixture)
          : backend === 'creality'
            ? { backend, origin: 'http://127.0.0.1:1' }
            : { backend }
      const f = await connect(
        t,
        target,
        backend === 'kobralink'
          ? (target as ReturnType<typeof kobraTarget>)
          : { backend },
        ['pause'],
      )
      const foreign = await f.browser.listFiles('foreign')
      assert.equal(foreign.ok, false)
      if (!foreign.ok) assert.equal(foreign.reason, 'unauthorized')
      const list = await f.browser.listFiles('printer')
      assert.equal(list.ok, false)
      if (!list.ok) assert.equal(list.reason, 'unauthorized')
      const upload = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
      assert.equal(upload.ok, false)
      if (!upload.ok) assert.equal(upload.reason, 'unauthorized')
      assert.deepEqual(fixture.uploads, [])
    },
  )
}

test('files session renders unsupported and never invents a local file after a bridge upload', async () => {
  const states: unknown[] = []
  const files: unknown[] = []
  const session = createFilesSession({
    available: () => true,
    changed: (s) => states.push(s),
    files: (f) => files.push(f),
    connect: async () => ({
      listFiles: async () => ({
        type: 'files.list.result',
        request_id: 'x',
        printer_key: 'printer',
        ok: false,
        reason: 'unsupported',
      }),
      sendFile: async () => ({
        type: 'result',
        transfer_id: 'x',
        ok: true,
        library: true,
      }),
      issueControlCommand: async () => 'not-sent',
      close() {},
      async dispose() {},
    }),
  })
  await session.list('printer')
  assert.deepEqual(states.at(-1), {
    kind: 'error',
    message: 'Listagem não suportada pela biblioteca desta impressora.',
  })
  await session.upload('printer', new File(['G28\n'], 'part.gcode'))
  assert.deepEqual(files.at(-1), [])
  assert.match(JSON.stringify(states.at(-1)), /biblioteca da ponte/)
})

for (const backend of ['creality', 'anycubic', 'kobralink'] as const) {
  test(
    `${backend} starts a print once through the signed real control channel`,
    { timeout: 15000 },
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), 'files-start-'))
      t.after(() => rm(dir, { recursive: true }))
      let control: NonNullable<Parameters<typeof connect>[5]>
      let check: () => void
      let filename = 'part.gcode'
      if (backend === 'creality') {
        const sim = await createCrealitySimulator({ state: 0 })
        t.after(() => sim.close())
        control = {
          binding: (scope) =>
            provisionCrealityPrinter(scope, {
              printerKey: 'printer',
              host: '127.0.0.1',
              port: sim.port,
            }),
        }
        check = () =>
          assert.deepEqual(sim.requests, [
            {
              method: 'set',
              params: {
                opGcodeFile:
                  'printprt:/usr/data/printer_data/gcodes/part.gcode',
              },
            },
          ])
      } else if (backend === 'anycubic') {
        const sim = await startAnycubicSimulator({
          serial: '20024/SYNTHETIC',
          initialState: 'IDLE',
        })
        t.after(() => sim.close())
        await writeFile(
          join(dir, 'password'),
          JSON.stringify('synthetic-password'),
          { mode: 0o600 },
        )
        await writeFile(join(dir, 'ca'), sim.syntheticTrust)
        control = {
          binding: (scope) =>
            provisionAnycubicPrinter(scope, {
              printerKey: 'printer',
              host: '127.0.0.1',
              port: sim.port,
              modelId: '20024',
              deviceId: 'SYNTHETIC',
              username: 'synthetic',
              passwordFile: join(dir, 'password'),
              caFile: join(dir, 'ca'),
            }),
        }
        check = () => {
          assert.equal(sim.requests.length, 1)
          assert.deepEqual(sim.requests[0], {
            type: 'print',
            action: 'start',
            timestamp: (sim.requests[0] as { timestamp: number }).timestamp,
            msgid: (sim.requests[0] as { msgid: string }).msgid,
            data: { taskid: '-1', filename: 'part.gcode', filetype: 1 },
          })
        }
      } else {
        const fixture = createFilesFixture()
        fixture.state.printState = 'standby'
        const binding = {
          backend: 'kobralink',
          version: 2,
          bridgeInstance: 'fixture',
          origin: 'http://127.0.0.1:7100',
          deviceId: 'synthetic-device',
          id: 'printer-1',
          printerKey: 'printer',
          revision: 1,
          credentialFile: join(dir, 'credential'),
        } as const
        await writeFile(
          binding.credentialFile,
          JSON.stringify({
            ...binding,
            backend: undefined,
            version: 1,
            credentialFile: undefined,
            name: 'Connector',
            email: 'c@example.test',
            password: 'synthetic-password',
          }),
          { mode: 0o600 },
        )
        control = {
          binding: (scope) => provisionKobraLinkPrinter(scope, binding),
          fetch: fixture.fetch,
        }
        filename = 'kobralink-library:file-1'
        check = () => {
          assert.deepEqual(fixture.starts, [
            { fileId: 'file-1', excludedObjects: [] },
          ])
          assert.deepEqual(fixture.extended, [])
        }
      }
      const f = await connect(
        t,
        { backend: 'anycubic' },
        { backend: 'anycubic' },
        ['start_print'],
        true,
        control,
      )
      // The fresh state read after the send confirms an extended command.
      assert.equal(await f.start(filename), 'applied')
      check()
    },
  )
}

test(
  'page session uses the KobraLink library print reference after listing over real WebRTC',
  { timeout: 15000 },
  async (t) => {
    const fixture = createFilesFixture()
    fixture.state.printState = 'standby'
    const dir = await mkdtemp(join(tmpdir(), 'files-page-'))
    t.after(() => rm(dir, { recursive: true }))
    const binding = {
      backend: 'kobralink',
      version: 2,
      bridgeInstance: 'fixture',
      origin: 'http://127.0.0.1:7100',
      deviceId: 'synthetic-device',
      id: 'printer-1',
      printerKey: 'printer',
      revision: 1,
      credentialFile: join(dir, 'credential'),
    } as const
    await writeFile(
      binding.credentialFile,
      JSON.stringify({
        version: 1,
        bridgeInstance: binding.bridgeInstance,
        origin: binding.origin,
        deviceId: binding.deviceId,
        id: binding.id,
        printerKey: binding.printerKey,
        revision: 1,
        name: 'Connector',
        email: 'c@example.test',
        password: 'synthetic-password',
      }),
      { mode: 0o600 },
    )
    const target = createKobraLinkFilesTarget({
      binding,
      allowedOrigins: [binding.origin],
      fetch: fixture.fetch,
    })
    const states: unknown[] = []
    const session = createFilesSession({
      available: () => true,
      changed: (s) => states.push(s),
      files: () => {},
      connect: async () => {
        const f = await connect(t, target, target, ['start_print'], true, {
          binding: (scope) => provisionKobraLinkPrinter(scope, binding),
          fetch: fixture.fetch,
        })
        return {
          listFiles: (key) => f.browser.listFiles(key),
          sendFile: (...args) => f.browser.sendFile(...args),
          issueControlCommand: (_action, args) => {
            assert.ok(args && typeof args.file === 'string')
            return f.start(args.file)
          },
          close() {
            f.browser.close()
            f.connector.close()
          },
          async dispose() {
            await Promise.all([f.browser.closed, f.connector.closed])
          },
        }
      },
    })
    await session.list('printer')
    await session.start('part.gcode')
    assert.deepEqual(fixture.starts, [
      { fileId: 'file-1', excludedObjects: [] },
    ])
    assert.match(
      JSON.stringify(states.at(-1)),
      /Impressão iniciada\. O Connector confirmou o comando\./,
    )
  },
)

for (const backend of ['creality', 'kobralink'] as const) {
  test(
    `${backend} rejects unsupported 3mf uploads before staging or backend access`,
    { timeout: 15000 },
    async (t) => {
      const fixture = createFilesFixture()
      const target =
        backend === 'kobralink'
          ? kobraTarget(fixture)
          : { backend, origin: 'http://127.0.0.1:1' }
      const f = await connect(t, target, { backend: 'anycubic' })
      const result = await f.browser.sendFile(
        { ...f.fileOffer, name: 'part.3mf' },
        new Blob([f.bytes]),
      )
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'unsupported')
      assert.deepEqual(fixture.uploads, [])
      await assert.rejects(readdir(f.staging), { code: 'ENOENT' })
    },
  )
}

test(
  'KobraLink duplicate library names cannot silently select a different file ID',
  { timeout: 15000 },
  async (t) => {
    const fixture = createFilesFixture()
    const target = kobraTarget({
      ...fixture,
      fetch: async (url, init) =>
        new URL(url).pathname.endsWith('/files') && init.method === 'GET'
          ? Response.json([
              { id: 'one', filename: 'same.gcode', sizeBytes: 4 },
              { id: 'two', filename: 'same.gcode', sizeBytes: 8 },
            ])
          : fixture.fetch(url, init),
    })
    const f = await connect(t, target, target)
    const result = await f.browser.listFiles('printer')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'offline')
    assert.deepEqual(fixture.starts, [])
  },
)
