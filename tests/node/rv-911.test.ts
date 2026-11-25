import assert from 'node:assert/strict'
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test, type TestContext } from 'node:test'
import { z } from 'zod'
import { PauseBrowserPeer } from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'
import {
  IntegrationDeliveryService,
  type EnvelopeRecord,
  type EnvelopeResult,
} from '../../apps/farm/server/services/integration-delivery.ts'
import { jobView } from '../../apps/farm/server/services/integration-jobs.ts'
import {
  AuthenticatedConnectorSignallingClient,
  connectorSocket,
} from '../../packages/connector/src/cloud/authenticated-signalling-client.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import { createApiCommandRunner } from '../../packages/connector/src/runtime/api-command.ts'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import { PauseConnectorPeer } from '../../packages/connector/src/webrtc/pause-control-peer.ts'
import { PauseControlSession } from '../../packages/connector/src/webrtc/pause-control-session.ts'
import type { SocketPort } from '../../packages/connector/src/webrtc/signalling-client-channel.ts'
import {
  API_ENVELOPE_ISSUER,
  API_REFUSAL_MESSAGE_SUPPORT_HEADER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  encodeApiEnvelopeResultFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  decodePauseChannelFrame,
  encodePauseChannelFrame,
  hasSdpLine,
  REFUSAL_MESSAGE_ANSWER_LINE,
  REFUSAL_MESSAGE_OFFER_LINE,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import { decodeSignallingServerFrame } from '../../packages/farm-protocol/src/signalling-socket.ts'
import { fixture as runtimeFixture } from '../helpers/signalling-runtime-fixture.ts'

const MESSAGE =
  'Para iniciar uma impressão de resina, selecione uma versão validada do arquivo na biblioteca.'
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

// Frozen from before #907: the strict frames older peers still decode with.
const OldControlResult = z.strictObject({
  v: z.literal(1),
  transport_id: z.string(),
  seq: z.number(),
  t: z.literal('control.result'),
  command_id: z.string(),
  outcome: z.enum(['rejected', 'not-sent', 'applied', 'outcome-unknown']),
  code: z.string().optional(),
})
const OldApiResult = z.strictObject({
  v: z.literal(1),
  t: z.literal('api-envelope.result'),
  cmd_id: z.string(),
  outcome: z.string(),
  refusal_code: z.string().optional(),
  detail: z.string().optional(),
  history_entry_id: z.string().optional(),
  at: z.number(),
})

const refusal = (extra: Record<string, unknown> = {}) => ({
  v: 1 as const,
  t: 'api-envelope.result' as const,
  cmd_id: randomUUID(),
  outcome: 'refused' as const,
  refusal_code: 'unsupported' as const,
  detail: 'invalid-command',
  at: 1,
  ...extra,
})

const native = createRequire(
  new URL('../../packages/connector/package.json', import.meta.url),
)('node-datachannel')
// libdatachannel keeps its threads, and the process, alive until told to stop.
after(() => native.cleanup())

/** The browser's RTCPeerConnection, over libdatachannel, up to its answer. */
function installBrowserRtc(t: TestContext) {
  class Browser {
    peer = new native.PeerConnection('rv-911-browser', {
      iceServers: [],
      bindAddress: '127.0.0.1',
    })
    iceGatheringState = 'new'
    connectionState = 'new'
    onicegatheringstatechange: (() => void) | null = null
    gathered: Promise<void>
    constructor() {
      this.gathered = new Promise((resolve) => {
        this.peer.onGatheringStateChange((state: string) => {
          if (state !== 'complete') return
          this.iceGatheringState = 'complete'
          resolve()
          this.onicegatheringstatechange?.()
        })
      })
    }
    get localDescription() {
      return this.peer.localDescription()
    }
    get remoteDescription() {
      return this.peer.remoteDescription()
    }
    async setRemoteDescription(value: { sdp: string; type: string }) {
      this.peer.setRemoteDescription(value.sdp, value.type)
    }
    async createAnswer() {
      await this.gathered
      return this.peer.localDescription()
    }
    async setLocalDescription() {}
    close() {
      this.peer.close()
    }
  }
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'RTCPeerConnection',
  )
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: Browser,
  })
  t.after(() => {
    if (original)
      Object.defineProperty(globalThis, 'RTCPeerConnection', original)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
  })
}

/** Real peers exchange SDP; returns what the Connector puts on the channel. */
async function connectorResult(
  t: TestContext,
  bundle: 'old' | 'new',
  message: string,
) {
  installBrowserRtc(t)
  const expected = {
    transportId: randomUUID(),
    farmId: randomUUID(),
    agentId: randomUUID(),
    assignmentId: randomUUID(),
    accountId: 'operator-fixture',
    keyId: randomUUID(),
    origin: 'https://farm.example',
    audience: 'pause-fixture',
  }
  const keys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const connector = new PauseConnectorPeer({
    identity: new ConnectorIdentity(generateKeyPairSync('ed25519').privateKey),
    expected,
    expectedBinding: new Promise(() => {}),
    onData: () => {},
  })
  const browser = new PauseBrowserPeer({
    privateKey: keys.privateKey,
    expected,
    expectedBinding: new Promise(() => {}),
  })
  t.after(async () => {
    browser.close()
    connector.close()
    await Promise.all([browser.closed, connector.closed])
  })
  const offer = await connector.offer()
  assert.equal(hasSdpLine(offer, REFUSAL_MESSAGE_OFFER_LINE), true)
  const answer = await browser.answer(offer)
  assert.equal(hasSdpLine(answer, REFUSAL_MESSAGE_ANSWER_LINE), true)
  // An older bundle transmits its local description as it is, which here echoes
  // the offer line, as libdatachannel does.
  connector.answer(
    bundle === 'new'
      ? answer
      : answer.replace(`${REFUSAL_MESSAGE_ANSWER_LINE}\r\n`, ''),
  )
  const sent = t.mock.method(
    PauseControlSession.prototype,
    'sendResult',
    () => true,
  )
  const commandId = randomUUID()
  assert.equal(
    connector.sendResult({
      t: 'control.result',
      command_id: commandId,
      outcome: 'not-sent',
      code: 'incompatible',
      message,
    }),
    true,
  )
  const result = sent.mock.calls[0]!.arguments[0]
  return decodePauseChannelFrame(
    encodePauseChannelFrame({
      ...result,
      v: 1,
      transport_id: expected.transportId,
      seq: 0,
    }),
  )
}

test('an old browser schema accepts a new Connector refusal', async (t) => {
  const frame = await connectorResult(t, 'old', MESSAGE)
  const old = OldControlResult.parse(frame)
  assert.equal(old.outcome, 'not-sent')
  assert.equal(old.code, 'incompatible')
})

test('a browser that advertises support receives the message', async (t) => {
  const frame = await connectorResult(t, 'new', MESSAGE)
  assert.equal(frame.t, 'control.result')
  assert.equal(frame.t === 'control.result' && frame.message, MESSAGE)
})

test('an invalid message is left out without losing the result', async (t) => {
  const frame = await connectorResult(t, 'new', 'bad\u0007message')
  assert.equal(frame.t, 'control.result')
  assert.equal('message' in frame, false)
})

/** The shipped inbox client, admitted by a scripted server. */
async function apiReport(
  command: { refusal_message?: true },
  wire: string,
): Promise<string> {
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const scope = {
    url: 'wss://farm.example/api/signalling/connector',
    origin: 'https://farm.example',
    audience: 'farm-test',
    agentId: randomUUID(),
    farmId: randomUUID(),
    jti: randomUUID(),
    token: 'fixture-token',
    identity,
  }
  let handlers: Parameters<SocketPort['bind']>[0] | undefined
  const sent: { t: string; wire?: string }[] = []
  const client = new AuthenticatedConnectorSignallingClient(scope, {
    onApiCommand: (_frame, report) => report(wire),
    socketFactory: () => ({
      isOpen: () => true,
      bufferedBytes: () => 0,
      send: (value, done) => {
        sent.push(JSON.parse(value))
        done()
      },
      bind: (value) => {
        handlers = value
        return () => {}
      },
      close: () => {},
    }),
  })
  const pending = client.start()
  void pending.catch(() => {})
  await tick()
  handlers!.open()
  await tick()
  const push = async (value: unknown) => {
    handlers!.message(JSON.stringify(value))
    await tick()
  }
  const jwk = createPublicKey({
    key: Buffer.from(identity.publicKeySpki, 'base64url'),
    format: 'der',
    type: 'spki',
  }).export({ format: 'jwk' })
  const wall = Date.now()
  const connectionId = randomUUID()
  await push({
    v: 1,
    t: 'connector.inbox-challenge',
    challenge: {
      v: 1,
      agent_id: scope.agentId,
      farm_id: scope.farmId,
      jti: scope.jti,
      connection_id: connectionId,
      public_key_spki: identity.publicKeySpki,
      fingerprint: identity.fingerprint,
      thumbprint: createHash('sha256')
        .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
        .digest('base64url'),
      token_hash: createHash('sha256').update(scope.token).digest('base64url'),
      origin: scope.origin,
      audience: scope.audience,
      purpose: 'signalling',
      generation: 1,
      nonce: randomBytes(32).toString('base64url'),
      issued_at: wall - 1,
      expires_at: wall + 5000,
    },
  })
  await push({
    v: 1,
    t: 'connector.inbox-ready',
    inbox_id: connectionId,
    issued_at: wall - 1,
    expires_at: wall + 4000,
    commands_enabled: false,
  })
  await push({
    v: 1,
    t: 'connector.api-command',
    wire: 'signed-envelope',
    scope: 'control:basic',
    confirmed_at: wall,
    ...command,
  })
  const report = sent.findLast((frame) => frame.t === 'connector.api-result')
  client.close()
  return report!.wire!
}

test('an old server receives a refusal it can decode, detail unchanged', async () => {
  const wire = encodeApiEnvelopeResultFrame(refusal({ message: MESSAGE }))
  const old = OldApiResult.parse(JSON.parse(await apiReport({}, wire)))
  assert.equal(old.refusal_code, 'unsupported')
  assert.equal(old.detail, 'invalid-command')
})

test('a server that marks the command receives message beside detail', async () => {
  const wire = encodeApiEnvelopeResultFrame(refusal({ message: MESSAGE }))
  const frame = decodeApiEnvelopeResultFrame(
    await apiReport({ refusal_message: true }, wire),
  )
  assert.equal(frame.detail, 'invalid-command')
  assert.equal(frame.message, MESSAGE)
})

test('the Connector inbox upgrade advertises refusal message support', async (t) => {
  const saved = {
    WS_NO_BUFFER_UTIL: process.env.WS_NO_BUFFER_UTIL,
    WS_NO_UTF_8_VALIDATE: process.env.WS_NO_UTF_8_VALIDATE,
  }
  process.env.WS_NO_BUFFER_UTIL = process.env.WS_NO_UTF_8_VALIDATE = '1'
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
  })
  let headers: Record<string, string> | undefined
  class FakeSocket {
    readyState = 0
    constructor(
      _url: URL,
      _protocol: string,
      options: { headers?: Record<string, string> },
    ) {
      headers = options.headers
    }
    on() {}
  }
  await connectorSocket(
    'wss://farm.example/api/signalling/connector',
    async () => ({ WebSocket: FakeSocket as never }),
    true,
  )
  assert.equal(headers?.[API_REFUSAL_MESSAGE_SUPPORT_HEADER], '1')
})

for (const advertised of [false, true]) {
  test(`the server marks commands only for a Connector that asked (${advertised})`, async () => {
    const f = await runtimeFixture()
    try {
      f.runtime.bindApiDelivery({
        deliverPending: async () => [],
        recordResult: async () => 'recorded',
      })
      const machine = f.peer(
        'connector',
        advertised ? [API_REFUSAL_MESSAGE_SUPPORT_HEADER, '1'] : [],
      )
      await f.runtime.upgrade(machine.request, 'connector', 'read-only')
      f.runtime.open(machine)
      await f.send(machine, {
        v: 1,
        t: 'connector.begin',
        agent_id: f.agent,
        farm_id: f.farm,
        jti: f.jti,
        token: f.token,
      })
      const challenge = machine.wires.at(-1)
      assert.equal(challenge?.t, 'connector.inbox-challenge')
      await f.send(machine, {
        v: 1,
        t: 'connector.inbox-proof',
        signature: await f.sign(
          (challenge as { challenge: Parameters<typeof f.sign>[0] }).challenge,
        ),
      })
      assert.equal(
        f.runtime.sendToAgentInbox(f.farm, f.agent, 'signed-envelope', {
          scope: 'control:basic',
          confirmedAt: 1,
        }),
        'sent',
      )
      const command = decodeSignallingServerFrame(
        JSON.stringify(machine.wires.at(-1)),
      )
      assert.equal(command.t, 'connector.api-command')
      assert.equal(
        command.t === 'connector.api-command' && command.refusal_message,
        advertised ? true : undefined,
      )
    } finally {
      await f.runtime.close()
    }
  })
}

test('both refusal frames reject control characters and long messages', () => {
  const control = {
    v: 1,
    t: 'control.result',
    transport_id: randomUUID(),
    command_id: randomUUID(),
    seq: 0,
    outcome: 'not-sent',
  }
  for (const bad of ['a\u0000b', 'a\u001bb', 'a\u007fb', '']) {
    assert.throws(() => encodePauseChannelFrame({ ...control, message: bad }))
    assert.throws(() => encodeApiEnvelopeResultFrame(refusal({ message: bad })))
  }
  assert.throws(() =>
    encodePauseChannelFrame({ ...control, message: 'a'.repeat(257) }),
  )
  assert.throws(() =>
    encodeApiEnvelopeResultFrame(refusal({ message: 'a'.repeat(501) })),
  )
  encodePauseChannelFrame({ ...control, message: 'linha 1\nlinha 2' })
})

test('an invalid API message is left out without losing the refusal', async (t) => {
  const ids = {
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    assignment_id: randomUUID(),
  }
  const binding = createPrinterBindingRegistry({
    allowedOrigins: ['http://127.0.0.1:7125'],
  }).provision({
    ...ids,
    printer_key: 'printer',
    moonraker_origin: 'http://127.0.0.1:7125',
  })
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'rv-911-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  t.after(() => {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall: Date.now(), mono: performance.now() }, 1)
  const app = randomUUID()
  const grant = randomUUID()
  const reports: string[] = []
  const runner = createApiCommandRunner({
    farmId: ids.farm_id,
    agentId: ids.agent_id,
    keys: { issuer: () => issuer.publicKey },
    grants: {
      lookup: () => ({
        grant_id: grant,
        app_id: app,
        farm_id: ids.farm_id,
        scopes: ['jobs:write'],
        revoked: false,
      }),
      freshness: authority.freshness,
    },
    journal,
    printer: () => binding,
    observe: () => ({ ready: true, printState: 'idle' }),
    driver: {
      async prepare() {
        throw Error('No printer commands allowed')
      },
      startUnavailableMessage: () => 'firmware V1\u0007',
    },
    report: (wire) => reports.push(wire),
    clock: { wallNow: Date.now, monotonicNow: () => performance.now() },
  })
  const now = Date.now()
  const result = await runner.run(
    encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'test',
          app_id: app,
          grant_id: grant,
          ...ids,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: now,
          expires_at: now + 60000,
          kind: 'action',
          action: {
            action: 'start_library_print',
            args: { sha256: 'a'.repeat(64) },
          },
        },
        issuer.privateKey,
      ),
    }),
  )
  assert.equal(result.kind, 'refused')
  assert.equal(reports.length, 1)
  const frame = decodeApiEnvelopeResultFrame(reports[0])
  assert.equal(frame.detail, 'action not supported by this printer')
  assert.equal(frame.message, undefined)
})

test('the server records detail and message separately', async () => {
  const farmId = randomUUID()
  const agentId = randomUUID()
  const cmdId = randomUUID()
  let record = {
    cmdId,
    farmId,
    agentId,
    appId: randomUUID(),
    printerAssignmentId: randomUUID(),
    kind: 'job',
    resourceId: randomUUID(),
    status: 'sent',
    refusalCode: null,
    resultDetail: null,
    historyEntryId: null,
    updatedAt: 1,
  } as unknown as EnvelopeRecord
  let stored: EnvelopeResult | undefined
  const service = new IntegrationDeliveryService({
    store: {
      get: async () => record,
      transition: async (
        _id: string,
        _from: unknown,
        status: EnvelopeRecord['status'],
        _now: number,
        result: EnvelopeResult,
      ) => {
        stored = result
        record = {
          ...record,
          status,
          refusalCode: result.refusalCode ?? null,
          resultDetail: result.detail ?? null,
          resultMessage: result.message ?? null,
        }
        return record
      },
    },
    audit: { record: async () => {} },
    inbox: {},
  } as never)
  assert.equal(
    await service.recordResult(
      farmId,
      agentId,
      encodeApiEnvelopeResultFrame(
        refusal({ cmd_id: cmdId, message: MESSAGE }),
      ),
    ),
    'recorded',
  )
  assert.equal(stored?.detail, 'invalid-command')
  assert.equal(stored?.message, MESSAGE)
  const view = jobView(
    {
      status: 'submitted',
      createdAt: 1,
      updatedAt: 1,
    } as never,
    record,
  )
  assert.deepEqual(view.refusal, {
    code: 'unsupported',
    detail: 'invalid-command',
    message: MESSAGE,
  })
})
