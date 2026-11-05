import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ConnectorIdentity } from '../../packages/connector/src/identity/store.ts'
import {
  PauseControlSession,
  type PauseDataFrame,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'
import {
  ControlSessionBinding,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  decodePauseChannelFrame,
  encodePauseChannelFrame,
} from '../../packages/farm-protocol/src/pause-channel.ts'
import {
  encodePauseAdmissionProof,
  encodePauseCapability,
  signPauseAdmissionProof,
  signPauseCapability,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import {
  decodeCommandV2,
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import { PauseBrowserPeer } from '../../apps/farm/app/utils/webrtc/pause-control-peer.ts'
import { PauseBrowserSignallingClient } from '../../apps/farm/app/utils/webrtc/pause-signalling-client.ts'
import { PauseConnectorSignallingClient } from '../../packages/connector/src/cloud/pause-signalling-client.ts'

const ORIGIN = 'https://farm.example'
const AUDIENCE = 'pause-fixture'
const ACCOUNT = 'fixture-account'

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Genuine crypto material: real P-256 device key, real Ed25519 issuer and Connector identity. */
async function fixture() {
  const browserKeys = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuerKeys = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    false,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', browserKeys.publicKey)
  const browser = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const identity = new ConnectorIdentity(
    generateKeyPairSync('ed25519').privateKey,
  )
  const now = Date.now()
  const binding = ControlSessionBinding.parse({
    v: 1,
    purpose: 'pause-rtc',
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: ACCOUNT,
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    browser_public_key: browser.publicKey,
    browser_thumbprint: browser.thumbprint,
    connector_public_key_spki: identity.publicKeySpki,
    connector_fingerprint: identity.fingerprint,
    credential_jti: randomUUID(),
    origin: ORIGIN,
    audience: AUDIENCE,
    browser_nonce: randomBytes(32).toString('base64url'),
    connector_nonce: randomBytes(32).toString('base64url'),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: randomBytes(32).toString('base64url'),
    answer_sha256: randomBytes(32).toString('base64url'),
    browser_dtls: 'AA:'.repeat(31) + 'AA',
    connector_dtls: 'BB:'.repeat(31) + 'BB',
  })
  const expected = {
    transportId: binding.transport_id,
    farmId: binding.farm_id,
    agentId: binding.agent_id,
    assignmentId: binding.assignment_id,
    accountId: binding.account_id,
    keyId: binding.key_id,
    origin: binding.origin,
    audience: binding.audience,
  }
  const admissionNonce = randomBytes(32).toString('base64url')
  const controlBindingSha256 = randomBytes(32).toString('base64url')
  const capability = await signPauseCapability(
    {
      v: 1,
      purpose: 'pause-authority',
      capability_id: randomUUID(),
      kid: 'fixture-key',
      issuer: AUDIENCE,
      audience: AUDIENCE,
      origin: ORIGIN,
      issued_at: now,
      expires_at: now + 30000,
      account_id: ACCOUNT,
      role: 'owner',
      farm_id: binding.farm_id,
      agent_id: binding.agent_id,
      key_id: binding.key_id,
      assignment_id: binding.assignment_id,
      transport_id: binding.transport_id,
      browser_public_key: browser.publicKey,
      browser_thumbprint: browser.thumbprint,
      connector_fingerprint: identity.fingerprint,
      credential_jti: randomUUID(),
      printer_key: 'fixture-printer',
      control_binding_sha256: controlBindingSha256,
      admission_nonce: admissionNonce,
      actions: ['pause'],
    },
    issuerKeys.privateKey,
  )
  const admissionProof = await signPauseAdmissionProof(
    {
      v: 1,
      purpose: 'pause-admission',
      challenge_id: randomUUID(),
      farm_id: binding.farm_id,
      agent_id: binding.agent_id,
      key_id: binding.key_id,
      assignment_id: binding.assignment_id,
      transport_id: binding.transport_id,
      account_id: ACCOUNT,
      browser_thumbprint: browser.thumbprint,
      origin: ORIGIN,
      audience: AUDIENCE,
      control_binding_sha256: controlBindingSha256,
      admission_nonce: admissionNonce,
      issued_at: now,
      expires_at: now + 8000,
    },
    browserKeys.privateKey,
  )
  return {
    browserKeys,
    identity,
    binding,
    expected,
    admissionNonce,
    capabilityWire: encodePauseCapability(capability),
    admissionWire: encodePauseAdmissionProof(admissionProof),
  }
}

async function buildCommand(f: Fixture) {
  const now = Date.now()
  const signed = await signCommandV2(
    {
      v: 2,
      purpose: 'printer-pause',
      cmd_id: randomUUID(),
      farm_id: f.binding.farm_id,
      agent_id: f.binding.agent_id,
      account_id: f.binding.account_id,
      key_id: f.binding.key_id,
      transport_id: f.binding.transport_id,
      capability_id: randomUUID(),
      assignment_id: f.binding.assignment_id,
      action: 'pause',
      args: {},
      issued_at: now,
      expires_at: now + 5000,
      nonce: randomBytes(16).toString('base64url'),
    },
    f.browserKeys.privateKey,
  )
  return { cmdId: signed.cmd_id, wire: encodeCommandV2(signed) }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('Test deadline')), 2000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

type PairOptions = {
  connectorOnData?: (frame: Readonly<PauseDataFrame>) => void
  browserOnData?: (frame: Readonly<PauseDataFrame>) => void
  lifetimeDeadline?: number
}

/** Two genuine sessions wired through the real admission sequence. */
async function pair(f: Fixture, options: PairOptions = {}) {
  const connectorFrames: string[] = []
  const browserFrames: string[] = []
  const admitted = deferred<void>()
  let browser: PauseControlSession
  const connector = new PauseControlSession({
    role: 'connector',
    identity: f.identity,
    expected: f.expected,
    ...(options.lifetimeDeadline !== undefined
      ? { lifetimeDeadline: options.lifetimeDeadline }
      : {}),
    send: (wire) => {
      connectorFrames.push(wire)
      browser.receive(wire)
    },
    onProofsReady: () => {
      const now = Date.now()
      connector.sendPhase({
        t: 'control.admission-nonce',
        admission_nonce: f.admissionNonce,
        issued_at: now,
        expires_at: now + 5000,
      })
    },
    onPhase: (frame) => {
      if (frame.t === 'control.admission-proof') admitted.resolve()
    },
    ...(options.connectorOnData ? { onData: options.connectorOnData } : {}),
  })
  browser = new PauseControlSession({
    role: 'browser',
    privateKey: f.browserKeys.privateKey,
    expected: f.expected,
    ...(options.lifetimeDeadline !== undefined
      ? { lifetimeDeadline: options.lifetimeDeadline }
      : {}),
    send: (wire) => {
      browserFrames.push(wire)
      connector.receive(wire)
    },
    onPhase: (frame) => {
      if (frame.t !== 'control.admission-nonce') return
      browser.sendPhase({ t: 'control.capability', wire: f.capabilityWire })
      browser.sendPhase({ t: 'control.admission-proof', wire: f.admissionWire })
    },
    ...(options.browserOnData ? { onData: options.browserOnData } : {}),
  })
  await Promise.all([
    browser.activate(f.binding),
    connector.activate(f.binding),
  ])
  await bounded(admitted.promise)
  return { connector, browser, connectorFrames, browserFrames }
}

function frameTypes(wires: string[]): string[] {
  return wires.map((wire) => decodePauseChannelFrame(wire).t)
}

test(
  'a genuine command reaches the connector and the matching result returns to the browser',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const commands: PauseDataFrame[] = []
    const results: PauseDataFrame[] = []
    const commandArrived = deferred<void>()
    const resultArrived = deferred<void>()
    const p = await pair(f, {
      connectorOnData: (frame) => {
        commands.push(frame)
        commandArrived.resolve()
      },
      browserOnData: (frame) => {
        results.push(frame)
        resultArrived.resolve()
      },
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(commandArrived.promise)
      assert.equal(commands.length, 1)
      assert.equal(commands[0]!.t, 'control.command')
      assert.equal(
        decodeCommandV2((commands[0] as { wire: string }).wire).cmd_id,
        command.cmdId,
      )
      assert.equal(
        p.connector.sendResult({
          t: 'control.result',
          command_id: command.cmdId,
          outcome: 'applied',
        }),
        true,
      )
      await bounded(resultArrived.promise)
      assert.equal(results.length, 1)
      assert.equal(results[0]!.t, 'control.result')
      assert.equal(
        (results[0] as { command_id: string }).command_id,
        command.cmdId,
      )
      assert.equal((results[0] as { outcome: string }).outcome, 'applied')
      // The data frames share the original frame sequence budget.
      assert.deepEqual(frameTypes(p.browserFrames), [
        'control.proof',
        'control.proofs-ready',
        'control.capability',
        'control.admission-proof',
        'control.command',
      ])
      assert.deepEqual(frameTypes(p.connectorFrames), [
        'control.proof',
        'control.proofs-ready',
        'control.admission-nonce',
        'control.result',
      ])
      assert.deepEqual(
        p.browserFrames.map((w) => decodePauseChannelFrame(w).seq),
        [0, 1, 2, 3, 4],
      )
      assert.deepEqual(
        p.connectorFrames.map((w) => decodePauseChannelFrame(w).seq),
        [0, 1, 2, 3],
      )
      assert.equal(p.connector.diagnostics().commandsEnabled, false)
      assert.equal(p.browser.diagnostics().commandsEnabled, false)
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'the data channel stays disabled without a trusted handler',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = await pair(f)
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(p.connector.closed)
      assert.equal(p.connector.diagnostics().terminal, true)
      assert.equal(p.connector.diagnostics().commandsEnabled, false)
      assert.equal(
        frameTypes(p.connectorFrames).includes('control.result'),
        false,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'direction lock refuses a command for the connector and a result for the browser',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = await pair(f, {
      connectorOnData: () => {},
      browserOnData: () => {},
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.connector.sendCommand({ t: 'control.command', wire: command.wire }),
        false,
      )
      assert.equal(p.connector.diagnostics().terminal, true)
      assert.equal(
        p.browser.sendResult({
          t: 'control.result',
          command_id: command.cmdId,
          outcome: 'rejected',
        }),
        false,
      )
      assert.equal(p.browser.diagnostics().terminal, true)
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'a browser that receives a command and a connector that receives a result both fail closed',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const command = await buildCommand(f)
    const browserProof = {
      v: 1 as const,
      role: 'browser' as const,
      binding: f.binding,
      signature: await signControlSessionProof(
        f.binding,
        'browser',
        f.browserKeys.privateKey,
      ),
    }
    const connectorProof = await f.identity.signControlSessionProof({
      binding: f.binding,
      expectedAgentId: f.expected.agentId,
    })
    for (const side of ['browser', 'connector'] as const) {
      const peer =
        side === 'browser'
          ? new PauseControlSession({
              role: 'browser',
              privateKey: f.browserKeys.privateKey,
              expected: f.expected,
              send: () => {},
            })
          : new PauseControlSession({
              role: 'connector',
              identity: f.identity,
              expected: f.expected,
              send: () => {},
            })
      try {
        peer.receive(
          encodePauseChannelFrame({
            v: 1,
            t: 'control.proof',
            transport_id: f.binding.transport_id,
            seq: 0,
            wire: encodeControlProof(
              side === 'browser' ? connectorProof : browserProof,
            ),
          }),
        )
        peer.receive(
          encodePauseChannelFrame({
            v: 1,
            t: 'control.proofs-ready',
            transport_id: f.binding.transport_id,
            seq: 1,
          }),
        )
        peer.receive(
          encodePauseChannelFrame({
            v: 1,
            t: side === 'browser' ? 'control.command' : 'control.result',
            transport_id: f.binding.transport_id,
            seq: 2,
            ...(side === 'browser'
              ? { wire: command.wire }
              : { command_id: command.cmdId, outcome: 'applied' }),
          }),
        )
        await peer.activate(f.binding)
        await bounded(peer.closed)
        assert.equal(peer.diagnostics().terminal, true)
        assert.equal(peer.diagnostics().commandsEnabled, false)
      } finally {
        peer.close()
        await bounded(peer.closed)
      }
    }
  },
)

test(
  'one command and one result per control peer',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const commands: PauseDataFrame[] = []
    const p = await pair(f, {
      connectorOnData: (frame) => {
        commands.push(frame)
      },
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(
        new Promise<void>((resolve) => {
          const check = () =>
            commands.length ? resolve() : setTimeout(check, 5)
          check()
        }),
      )
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        false,
      )
      assert.equal(p.browser.diagnostics().terminal, true)
      assert.equal(
        frameTypes(p.browserFrames).filter((t) => t === 'control.command')
          .length,
        1,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'a command before the admission sequence is refused',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const connectorProof = await f.identity.signControlSessionProof({
      binding: f.binding,
      expectedAgentId: f.expected.agentId,
    })
    const peer = new PauseControlSession({
      role: 'browser',
      privateKey: f.browserKeys.privateKey,
      expected: f.expected,
      send: () => {},
    })
    try {
      // Mutual proofs only: the admission sequence never ran.
      peer.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.proof',
          transport_id: f.binding.transport_id,
          seq: 0,
          wire: encodeControlProof(connectorProof),
        }),
      )
      peer.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.proofs-ready',
          transport_id: f.binding.transport_id,
          seq: 1,
        }),
      )
      await peer.activate(f.binding)
      await bounded(
        new Promise<void>((resolve) => {
          const check = () =>
            peer.diagnostics().proofsReady ? resolve() : setTimeout(check, 5)
          check()
        }),
      )
      const command = await buildCommand(f)
      assert.equal(
        peer.sendCommand({ t: 'control.command', wire: command.wire }),
        false,
      )
      assert.equal(peer.diagnostics().terminal, true)
    } finally {
      peer.close()
      await bounded(peer.closed)
    }
  },
)

test(
  'a result that arrives before its command fails closed',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const results: PauseDataFrame[] = []
    const p = await pair(f, {
      browserOnData: (frame) => {
        results.push(frame)
      },
    })
    try {
      const command = await buildCommand(f)
      p.browser.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.result',
          transport_id: f.binding.transport_id,
          seq: 3,
          command_id: command.cmdId,
          outcome: 'applied',
        }),
      )
      await bounded(p.browser.closed)
      assert.equal(p.browser.diagnostics().terminal, true)
      assert.equal(results.length, 0)
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'a mismatched command id is refused in both directions',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const command = await buildCommand(f)
    const p = await pair(f, {
      connectorOnData: () => {},
      browserOnData: () => {},
    })
    try {
      assert.equal(
        p.connector.sendResult({
          t: 'control.result',
          command_id: randomUUID(),
          outcome: 'rejected',
        }),
        false,
      )
      assert.equal(p.connector.diagnostics().terminal, true)
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
    const second = await pair(f, {
      connectorOnData: () => {},
      browserOnData: () => {},
    })
    try {
      assert.equal(
        second.browser.sendCommand({
          t: 'control.command',
          wire: command.wire,
        }),
        true,
      )
      second.browser.receive(
        encodePauseChannelFrame({
          v: 1,
          t: 'control.result',
          transport_id: f.binding.transport_id,
          seq: 3,
          command_id: randomUUID(),
          outcome: 'applied',
        }),
      )
      await bounded(second.browser.closed)
      assert.equal(second.browser.diagnostics().terminal, true)
    } finally {
      second.browser.close()
      second.connector.close()
      await bounded(
        Promise.all([second.browser.closed, second.connector.closed]),
      )
    }
  },
)

test(
  'a throwing handler closes the peer without emitting a result',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = await pair(f, {
      connectorOnData: () => {
        throw Error('handler failure')
      },
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(p.connector.closed)
      assert.equal(p.connector.diagnostics().terminal, true)
      assert.equal(
        frameTypes(p.connectorFrames).includes('control.result'),
        false,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'a handler that returns a promise fails closed',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = await pair(f, {
      connectorOnData: (() => Promise.resolve()) as unknown as () => void,
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(p.connector.closed)
      assert.equal(p.connector.diagnostics().terminal, true)
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'reentrant delivery cannot open a second result',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const attempts: boolean[] = []
    let connector: PauseControlSession | undefined
    const p = await pair(f, {
      connectorOnData: (frame) => {
        const id = decodeCommandV2((frame as { wire: string }).wire).cmd_id
        attempts.push(
          connector!.sendResult({
            t: 'control.result',
            command_id: id,
            outcome: 'applied',
          }),
        )
        attempts.push(
          connector!.sendResult({
            t: 'control.result',
            command_id: id,
            outcome: 'applied',
          }),
        )
      },
      browserOnData: () => {},
    })
    connector = p.connector
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(p.connector.closed)
      assert.deepEqual(attempts, [true, false])
      assert.equal(
        frameTypes(p.connectorFrames).filter((t) => t === 'control.result')
          .length,
        1,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'a malformed command wire is refused and never answered',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const p = await pair(f, {
      connectorOnData: () => {},
      browserOnData: () => {},
    })
    try {
      assert.equal(
        p.browser.sendCommand({
          t: 'control.command',
          wire: 'not-a-command',
        }),
        false,
      )
      assert.equal(p.browser.diagnostics().terminal, true)
      assert.equal(
        frameTypes(p.connectorFrames).includes('control.result'),
        false,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

test(
  'the session lifetime is not extended by command traffic',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const lifetimeDeadline = performance.now() + 400
    const p = await pair(f, {
      connectorOnData: () => {},
      browserOnData: () => {},
      lifetimeDeadline,
    })
    try {
      const command = await buildCommand(f)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        true,
      )
      await bounded(p.browser.closed)
      assert.equal(p.browser.diagnostics().terminal, true)
      assert.equal(
        p.browser.sendCommand({ t: 'control.command', wire: command.wire }),
        false,
      )
    } finally {
      p.browser.close()
      p.connector.close()
      await bounded(Promise.all([p.browser.closed, p.connector.closed]))
    }
  },
)

/** Minimal stand-in for the browser WebRTC API. No native, browser or network use. */
class FakePeerConnection {
  iceGatheringState = 'complete'
  connectionState = 'new'
  localDescription: { type: string; sdp: string } | null = null
  remoteDescription: { type: string; sdp: string } | null = null
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((value: { track: { stop(): void } }) => void) | null = null
  ondatachannel: ((value: { channel: RTCDataChannel }) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  async setRemoteDescription() {}
  async createAnswer() {
    return { type: 'answer', sdp: '' }
  }
  async setLocalDescription() {}
  close() {}
}
function installFake() {
  const original = Object.getOwnPropertyDescriptor(
    globalThis,
    'RTCPeerConnection',
  )
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    writable: true,
    value: FakePeerConnection,
  })
  return () => {
    if (original)
      Object.defineProperty(globalThis, 'RTCPeerConnection', original)
    else Reflect.deleteProperty(globalThis, 'RTCPeerConnection')
  }
}

test(
  'the browser peer keeps the bounded command inert until the control session is ready',
  { timeout: 5000 },
  async () => {
    const restore = installFake()
    const f = await fixture()
    let delivered = 0
    const peer = new PauseBrowserPeer({
      privateKey: f.browserKeys.privateKey,
      expected: {
        transportId: f.expected.transportId,
        farmId: f.expected.farmId,
        agentId: f.expected.agentId,
        assignmentId: f.expected.assignmentId,
        accountId: f.expected.accountId,
        keyId: f.expected.keyId,
        origin: f.expected.origin,
        audience: f.expected.audience,
      },
      expectedBinding: new Promise(() => {}),
      onData: () => {
        delivered++
      },
    })
    try {
      assert.equal(typeof PauseBrowserPeer.prototype.sendCommand, 'function')
      assert.equal(
        peer.sendCommand({ t: 'control.command', wire: 'not-a-command' }),
        false,
      )
      assert.equal(peer.diagnostics().terminal, false)
      assert.equal(peer.diagnostics().commandsEnabled, false)
      assert.equal(delivered, 0)
    } finally {
      peer.close()
      await bounded(peer.closed)
      restore()
    }
  },
)

test(
  'both signalling wrappers expose a directional command API that stays inert by default',
  { timeout: 5000 },
  async () => {
    const f = await fixture()
    const jwk = await crypto.subtle.exportKey('jwk', f.browserKeys.publicKey)
    const browser = new PauseBrowserSignallingClient(
      {
        farmId: f.expected.farmId,
        agentId: f.expected.agentId,
        assignmentId: f.expected.assignmentId,
        keyId: f.expected.keyId,
        accountId: f.expected.accountId,
        origin: f.expected.origin,
        audience: f.expected.audience,
        publicKey: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
        privateKey: f.browserKeys.privateKey,
      },
      {},
    )
    const connector = new PauseConnectorSignallingClient(
      {
        url: 'wss://farm.example/api/signalling/pause-connector',
        origin: f.expected.origin,
        audience: f.expected.audience,
        credentialAudience: f.expected.audience,
        agentId: f.expected.agentId,
        farmId: f.expected.farmId,
        assignmentId: f.expected.assignmentId,
        jti: randomUUID(),
        token: 'fixture-token',
        identity: f.identity,
      },
      {},
    )
    try {
      assert.equal(
        browser.sendCommand({ t: 'control.command', wire: 'not-a-command' }),
        false,
      )
      assert.equal(
        connector.sendResult({
          t: 'control.result',
          command_id: randomUUID(),
          outcome: 'rejected',
        }),
        false,
      )
      assert.equal(browser.diagnostics().commandsEnabled, false)
      assert.equal(connector.diagnostics().commandsEnabled, false)
    } finally {
      browser.close()
      connector.close()
    }
  },
)
