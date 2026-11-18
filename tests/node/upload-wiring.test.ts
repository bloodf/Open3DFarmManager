import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  X509Certificate,
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
import { fixture as ftpsFixture } from '../fixtures/bambu-ftps/server.ts'

type Native = typeof import('node-datachannel')
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
const fixtureRoot = tmpdir()
const nonce = () => randomBytes(32).toString('base64url')

async function connect(
  t: test.TestContext,
  target: FileUploadTarget,
  actions: ('pause' | 'start_print')[] = ['start_print'],
  admit = true,
) {
  const dir = await mkdtemp(join(fixtureRoot, 'upload-wiring-'))
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
  const mapping = registry.provision({
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
    driver: {
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
    onProofsReady(value) {
      assert.equal(
        relay.openPeer({
          ...value,
          sendPhase: (frame) => connector.sendPhase(frame),
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
  // The binding allows at most 30,000 ms. Separate clock reads can cross a
  // millisecond boundary under load and make both peers reject the binding.
  const bindingIssuedAt = Date.now()
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
    issued_at: bindingIssuedAt,
    expires_at: bindingIssuedAt + 30000,
    offer_sha256: await controlSdpHash(offer),
    answer_sha256: await controlSdpHash(answer),
    browser_dtls: controlDtlsFingerprint(answer),
    connector_dtls: controlDtlsFingerprint(offer),
  }
  bindingReady.resolve(binding)
  const phase = await Promise.race([
    challenge.promise,
    browser.closed.then(() => {
      throw Error('Browser closed before admission challenge')
    }),
    connector.closed.then(() => {
      throw Error('Connector closed before admission challenge')
    }),
  ])
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
    invalidateAuthority() {
      fresh = false
    },
  }
}

for (const backend of ['moonraker', 'bambu'] as const) {
  test(
    `real loopback control peer forwards ${backend} upload and removes staging`,
    { timeout: 15000 },
    async (t) => {
      let target: FileUploadTarget
      let received = Buffer.alloc(0)
      let bytes: () => Buffer
      if (backend === 'moonraker') {
        const server = createServer((req, res) => {
          assert.equal(req.method, 'POST')
          assert.equal(req.url, '/server/files/upload')
          assert.equal(req.headers['x-api-key'], 'fixture-secret')
          req.on('data', (b) => {
            received = Buffer.concat([received, b])
          })
          req.on('end', () => res.end('{}'))
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
        target = {
          backend,
          origin: `http://127.0.0.1:${address.port}`,
          apiKey: 'fixture-secret',
        }
        bytes = () => received
      } else {
        const server = await ftpsFixture()
        t.after(() => server.close())
        target = {
          backend,
          host: '127.0.0.1',
          port: server.port,
          serial: 'TEST',
          accessCode: 'secret',
          trust: {
            pinSha256: createHash('sha256')
              .update(new X509Certificate(server.cert).raw)
              .digest('hex'),
          },
        }
        bytes = server.bytes
      }
      const f = await connect(t, target)
      assert.deepEqual(
        await f.browser.sendFile(f.fileOffer, new Blob([f.bytes])),
        { type: 'result', transfer_id: f.fileOffer.transfer_id, ok: true },
      )
      if (backend === 'bambu') assert.deepEqual(bytes(), f.bytes)
      else {
        assert.ok(bytes().includes(f.bytes))
        assert.match(bytes().toString(), /filename="fixture.gcode"/)
        assert.match(bytes().toString(), /name="root"\r\n\r\ngcodes/)
      }
      assert.deepEqual(await readdir(f.staging), [])
    },
  )
}

for (const scenario of [
  'unadmitted',
  'stale-authority',
  'wrong-printer',
  'missing-action',
  'retired-mapping',
  'revoked',
  'integrity',
  'backend-failure',
] as const) {
  test(
    `upload refuses ${scenario} without retaining staged files`,
    { timeout: 15000 },
    async (t) => {
      let requests = 0
      const server = createServer((req, res) => {
        requests++
        req.resume()
        req.on('end', () => res.writeHead(401).end())
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
        {
          backend: 'moonraker',
          origin: `http://127.0.0.1:${address.port}`,
          apiKey: 'fixture-secret',
        },
        scenario === 'missing-action' ? ['pause'] : ['start_print'],
        scenario !== 'unadmitted',
      )
      if (scenario === 'stale-authority') f.invalidateAuthority()
      if (scenario === 'wrong-printer') f.fileOffer.printer_key = 'foreign'
      if (scenario === 'retired-mapping') f.registry.retire(f.mapping)
      if (scenario === 'revoked') f.relay.closePeer(f.transportId)
      if (scenario === 'integrity') f.fileOffer.sha256 = '0'.repeat(64)
      const result = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
      assert.deepEqual(result, {
        type: 'result',
        transfer_id: f.fileOffer.transfer_id,
        ok: false,
        reason: scenario === 'integrity' ? 'invalid-transfer' : 'unauthorized',
      })
      assert.equal(requests, scenario === 'backend-failure' ? 1 : 0)
      assert.equal(JSON.stringify(result).includes('fixture-secret'), false)
      assert.deepEqual(
        await readdir(f.staging).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return []
          throw error
        }),
        [],
      )
    },
  )
}

test(
  'ending the control session aborts an in-flight forward and removes staging',
  { timeout: 15000 },
  async (t) => {
    const arrived = deferred<void>()
    const server = createServer((req) => {
      req.resume()
      req.on('end', () => arrived.resolve())
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
    const f = await connect(t, {
      backend: 'moonraker',
      origin: `http://127.0.0.1:${address.port}`,
    })
    const upload = f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
    const rejected = assert.rejects(upload, /File transfer closed/)
    await arrived.promise
    assert.equal((await readdir(f.staging)).length, 1)
    f.connector.close('fixture-ended')
    await Promise.all([f.connector.closed, rejected])
    assert.deepEqual(await readdir(f.staging), [])
    assert.equal(f.relay.admittedHandle(f.transportId), undefined)
  },
)

test(
  'operator cancellation removes an accepted staged transfer before forwarding',
  { timeout: 15000 },
  async (t) => {
    let requests = 0
    const server = createServer((req, res) => {
      requests++
      req.resume()
      res.end()
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
    const f = await connect(t, {
      backend: 'moonraker',
      origin: `http://127.0.0.1:${address.port}`,
    })
    const read = deferred<void>()
    const entered = deferred<void>()
    class HeldBlob extends Blob {
      override async arrayBuffer() {
        entered.resolve()
        await read.promise
        return super.arrayBuffer()
      }
    }
    class HeldFile extends Blob {
      override slice(start?: number, end?: number) {
        return new HeldBlob([super.slice(start, end)])
      }
    }
    const controller = new AbortController()
    const upload = f.browser.sendFile(
      f.fileOffer,
      new HeldFile([f.bytes]),
      controller.signal,
    )
    const rejected = assert.rejects(upload, /File transfer aborted/)
    await entered.promise
    assert.equal((await readdir(f.staging)).length, 1)
    controller.abort()
    read.resolve()
    await rejected
    await waitFor(async () => (await readdir(f.staging)).length === 0)
    assert.equal(requests, 0)
    assert.deepEqual(await readdir(f.staging), [])
  },
)
