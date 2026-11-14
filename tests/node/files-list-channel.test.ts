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
import type { FileListTarget } from '../../packages/connector/src/runtime/file-list.ts'
import {
  FileListRequest,
  FileListResponse,
} from '../../packages/farm-protocol/src/file-list.ts'

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
  target: FileListTarget,
  actions: ('pause' | 'start_print')[] = ['start_print'],
  admit = true,
) {
  const dir = await mkdtemp(join(tmpdir(), 'files-list-channel-'))
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
      targetFor: () => undefined,
    },
    fileList: {
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
    invalidateAuthority() {
      fresh = false
    },
  }
}

function moonTarget(
  request: (method: string, params: object) => Promise<unknown>,
): FileListTarget {
  return { backend: 'moonraker', client: { request } }
}

test(
  'loopback lists 200 Moonraker files and permits repeated requests before upload',
  { timeout: 15000 },
  async (t) => {
    const f = await connect(
      t,
      moonTarget(async (method) =>
        method === 'server.files.list'
          ? Array.from({ length: 250 }, (_, i) => ({
              path: `${i}.gcode`,
              size: i,
              modified: i,
            }))
          : { estimated_time: 42 },
      ),
    )
    for (let i = 0; i < 2; i++) {
      const result = await f.browser.listFiles('printer')
      assert.equal(result.ok, true)
      if (!result.ok) throw Error('Expected list')
      assert.equal(result.files.length, 200)
      assert.deepEqual(result.files[0], {
        name: '249.gcode',
        size: 249,
        modified: 249,
        estimatedTime: 42,
      })
      assert.deepEqual(result.files[199], {
        name: '50.gcode',
        size: 50,
        modified: 50,
        estimatedTime: 42,
      })
    }
    const upload = await f.browser.sendFile(f.fileOffer, new Blob([f.bytes]))
    assert.equal(upload.ok, false)
    if (!upload.ok) assert.equal(upload.reason, 'offline')
  },
)

for (const scenario of [
  'unadmitted',
  'wrong-printer',
  'missing-action',
  'stale-authority',
  'retired-mapping',
  'revoked',
] as const) {
  test(
    `loopback denies ${scenario} without querying backend`,
    { timeout: 15000 },
    async (t) => {
      let calls = 0
      const f = await connect(
        t,
        moonTarget(async () => {
          calls++
          return []
        }),
        scenario === 'missing-action' ? ['pause'] : ['start_print'],
        scenario !== 'unadmitted',
      )
      if (scenario === 'stale-authority') f.invalidateAuthority()
      if (scenario === 'retired-mapping') f.registry.retire(f.mapping)
      if (scenario === 'revoked') f.relay.closePeer(f.transportId)
      const result = await f.browser.listFiles(
        scenario === 'wrong-printer' ? 'foreign' : 'printer',
      )
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.reason, 'unauthorized')
      assert.equal(calls, 0)
    },
  )
}

test(
  'loopback suppresses files when authority expires during listing',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred<void>()
    const release = deferred<unknown>()
    const f = await connect(
      t,
      moonTarget(async () => {
        entered.resolve()
        return release.promise
      }),
    )
    const listing = f.browser.listFiles('printer')
    await entered.promise
    f.invalidateAuthority()
    release.resolve([{ path: 'private.gcode', size: 1, modified: 1 }])
    const result = await listing
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'unauthorized')
    assert.equal(JSON.stringify(result).includes('private.gcode'), false)
  },
)

test(
  'loopback returns empty lists and redacts backend failures',
  { timeout: 15000 },
  async (t) => {
    let fail = false
    const f = await connect(
      t,
      moonTarget(async () => {
        if (fail) throw Error('fixture-secret')
        return []
      }),
    )
    const empty = await f.browser.listFiles('printer')
    assert.equal(empty.ok, true)
    if (empty.ok) assert.deepEqual(empty.files, [])
    fail = true
    const result = await f.browser.listFiles('printer')
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'offline')
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false)
  },
)

test('protocol rejects remote targets, traversal, oversized lists and unknown fields', () => {
  assert.equal(
    FileListRequest.safeParse({
      type: 'files.list',
      request_id: 'a',
      printer_key: 'printer',
      origin: 'http://foreign',
    }).success,
    false,
  )
  const result = {
    type: 'files.list.result',
    request_id: 'a',
    printer_key: 'printer',
    ok: true,
  }
  assert.equal(
    FileListResponse.safeParse({
      ...result,
      files: [{ name: '../secret.gcode', size: 1, modified: 1 }],
    }).success,
    false,
  )
  assert.equal(
    FileListResponse.safeParse({
      ...result,
      files: Array.from({ length: 201 }, () => ({
        name: 'a.gcode',
        size: 1,
        modified: 1,
      })),
    }).success,
    false,
  )
})

async function bambuListingFixture(t: test.TestContext) {
  const { createServer } = await import('node:tls')
  const { readFileSync } = await import('node:fs')
  const cert = readFileSync(
    new URL('../fixtures/bambu-ftps/cert.pem', import.meta.url),
  )
  const key = readFileSync(
    new URL('../fixtures/bambu-ftps/key.pem', import.meta.url),
  )
  const sockets = new Set<import('node:tls').TLSSocket>()
  const track = (socket: import('node:tls').TLSSocket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
  }
  let data: import('node:tls').TLSSocket | undefined
  const passive = createServer({ cert, key }, (socket) => {
    track(socket)
    data = socket
  })
  await new Promise<void>((resolve) => passive.listen(0, '127.0.0.1', resolve))
  const address = passive.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const server = createServer({ cert, key }, (socket) => {
    track(socket)
    socket.write('220 ready\r\n')
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString()
      let end: number
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (line.startsWith('USER ')) socket.write('331 password\r\n')
        else if (line.startsWith('PASS ')) socket.write('230 ok\r\n')
        else if (line === 'PASV')
          socket.write(
            `227 passive (127,0,0,1,${address.port >> 8},${address.port & 255})\r\n`,
          )
        else if (line === 'MLSD') {
          socket.write('150 listing\r\n')
          const send = (stream: import('node:tls').TLSSocket) => {
            stream.end(
              'type=file;size=42;modify=20261114010203; sample.3mf\r\n',
            )
            socket.write('226 done\r\n')
          }
          if (data) send(data)
          else passive.once('secureConnection', send)
        } else socket.write('200 ok\r\n')
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const control = server.address()
  if (!control || typeof control === 'string') throw new Error('No port')

  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all(
      [server, passive].map(
        (s) => new Promise<void>((resolve) => s.close(() => resolve())),
      ),
    )
  })
  return {
    backend: 'bambu' as const,
    host: '127.0.0.1',
    port: control.port,
    serial: 'TEST',
    accessCode: 'secret',
    trust: {
      pinSha256: createHash('sha256')
        .update(new X509Certificate(cert).raw)
        .digest('hex'),
    },
  }
}

test(
  'loopback lists Bambu files through protected FTPS with a bounded public DTO',
  { timeout: 15000 },
  async (t) => {
    const target = await bambuListingFixture(t)
    const f = await connect(t, target)
    const result = await f.browser.listFiles('printer')
    assert.equal(result.ok, true)
    if (result.ok)
      assert.deepEqual(result.files, [
        {
          name: 'sample.3mf',
          size: 42,
          modified: Date.parse('2026-11-14T01:02:03.000Z') / 1000,
        },
      ])
    assert.equal(JSON.stringify(result).includes('secret'), false)
  },
)

test(
  'closing the peer settles a hung list and rejects concurrent requests',
  { timeout: 15000 },
  async (t) => {
    const entered = deferred<void>()
    const held = deferred<unknown>()
    const f = await connect(
      t,
      moonTarget(async () => {
        entered.resolve()
        return held.promise
      }),
    )
    const listing = f.browser.listFiles('printer')
    const rejected = assert.rejects(listing, /File list closed/)
    await entered.promise
    await assert.rejects(
      f.browser.listFiles('printer'),
      /File list unavailable/,
    )
    await assert.rejects(
      f.browser.sendFile(f.fileOffer, new Blob([f.bytes])),
      /File transfer unavailable/,
    )
    f.connector.close()
    await Promise.all([rejected, f.connector.closed])
    held.resolve([])
  },
)
