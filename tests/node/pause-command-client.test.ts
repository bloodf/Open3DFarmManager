import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import {
  createPauseCommandClient,
  type PauseCommandIssuer,
} from '../../apps/farm/app/utils/webrtc/pause-command-client.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import {
  decodeCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type {
  PauseCommandMessage,
  PausePhaseMessage,
} from '../../packages/connector/src/webrtc/pause-control-session.ts'

const digest = () => randomBytes(32).toString('base64url')

/**
 * Waits without a timer, so the wait also works while the fake timers of a
 * test are enabled.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * Synthetic browser enrollment with a real nonextractable P-256 key and a
 * local issuer double. No server, no network, no browser and no RTC.
 */
async function clientFixture(
  t: test.TestContext,
  options: {
    holdIssuer?: boolean
    challengeGate?: Promise<void>
    onChallenge?: () => void
  } = {},
) {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', browser.publicKey)
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty: jwk.kty,
    crv: jwk.crv,
    x: jwk.x,
    y: jwk.y,
  })
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const now = Date.now()
  const transportId = randomUUID()
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: transportId,
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    assignment_id: randomUUID(),
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_public_key_spki: spki.toString('base64url'),
    connector_fingerprint:
      'SHA256:' + createHash('sha256').update(spki).digest('base64url'),
    credential_jti: randomUUID(),
    origin: 'https://farm.example',
    audience: 'open3dfarmmanager:pause',
    browser_nonce: digest(),
    connector_nonce: digest(),
    issued_at: now,
    expires_at: now + 30000,
    offer_sha256: digest(),
    answer_sha256: digest(),
    browser_dtls: Array(32).fill('AA').join(':'),
    connector_dtls: Array(32).fill('BB').join(':'),
  }
  const browserProofWire = encodeControlProof({
    v: 1,
    role: 'browser',
    binding,
    signature: await signControlSessionProof(
      binding,
      'browser',
      browser.privateKey,
    ),
  })
  const connectorProofWire = encodeControlProof({
    v: 1,
    role: 'connector',
    binding,
    signature: await signControlSessionProof(
      binding,
      'connector',
      connector.privateKey,
    ),
  })
  const bindingHash = await controlBindingHash(binding)
  const phases: PausePhaseMessage[] = []
  const commands: PauseCommandMessage[] = []
  const outcomes: string[] = []
  let refuseCommand = false
  let refusePhase = false
  let throwCommand = false
  let thenableCommand = false
  let reentrantAbort: (() => void) | undefined
  let throwObserver = false
  const nonce = digest()
  const client = createPauseCommandClient({
    privateKey: browser.privateKey,
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    onOutcome: (outcome) => {
      outcomes.push(outcome)
      if (throwObserver) throw new Error('Observer fault')
    },
    transport: {
      sendPhase: (message) => {
        if (refusePhase) return false
        phases.push(message)
        return true
      },
      sendCommand: (message) => {
        if (reentrantAbort) {
          const abort = reentrantAbort
          reentrantAbort = undefined
          // The frame is already on its way when the session is aborted.
          commands.push(message)
          abort()
          return true
        }
        if (throwCommand) throw new Error('Transport fault')
        if (thenableCommand) return Promise.resolve(true) as unknown as boolean
        if (refuseCommand) return false
        commands.push(message)
        return true
      },
    },
    issuer: {
      async challenge({ admissionNonce, signal }) {
        options.onChallenge?.()
        if (options.challengeGate) await options.challengeGate
        if (options.holdIssuer) {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              {
                once: true,
              },
            )
          })
        }
        return {
          v: 1 as const,
          purpose: 'pause-admission' as const,
          challenge_id: randomUUID(),
          farm_id: binding.farm_id,
          agent_id: binding.agent_id,
          key_id: binding.key_id,
          assignment_id: binding.assignment_id,
          transport_id: binding.transport_id,
          account_id: binding.account_id,
          browser_thumbprint: thumbprint,
          origin: binding.origin,
          audience: binding.audience,
          control_binding_sha256: bindingHash,
          admission_nonce: admissionNonce,
          issued_at: Date.now(),
          expires_at: Date.now() + 8000,
        }
      },
      async capability() {
        const issuedAt = Date.now()
        return signPauseCapability(
          {
            v: 1,
            purpose: 'pause-authority',
            capability_id: randomUUID(),
            kid: 'issuer-1',
            issuer: 'farm:issuer',
            audience: binding.audience,
            origin: binding.origin,
            issued_at: issuedAt,
            expires_at: Math.min(issuedAt + 30000, binding.expires_at),
            account_id: binding.account_id,
            role: 'operator',
            farm_id: binding.farm_id,
            agent_id: binding.agent_id,
            key_id: binding.key_id,
            assignment_id: binding.assignment_id,
            transport_id: binding.transport_id,
            browser_public_key: publicKey,
            browser_thumbprint: thumbprint,
            connector_fingerprint: binding.connector_fingerprint,
            credential_jti: binding.credential_jti,
            printer_key: 'printer-key',
            control_binding_sha256: bindingHash,
            admission_nonce: nonce,
            actions: ['pause'],
          },
          issuer.privateKey,
        )
      },
    },
  })
  t.after(() => client.abort())
  return {
    binding,
    client,
    phases,
    commands,
    outcomes,
    browserProofWire,
    connectorProofWire,
    issuer,
    setRefuseCommand(value: boolean) {
      refuseCommand = value
    },
    setRefusePhase(value: boolean) {
      refusePhase = value
    },
    setThrowCommand(value: boolean) {
      throwCommand = value
    },
    setThenableCommand(value: boolean) {
      thenableCommand = value
    },
    setThrowObserver(value: boolean) {
      throwObserver = value
    },
    abortOnCommand(abort: () => void) {
      reentrantAbort = abort
    },
    proofsReady() {
      client.proofsReady({
        binding,
        deadlineMonoMs: performance.now() + 30000,
        browserProofWire,
        connectorProofWire,
      })
    },
    nonceFrame() {
      return {
        v: 1 as const,
        transport_id: transportId,
        seq: 1,
        t: 'control.admission-nonce' as const,
        admission_nonce: nonce,
        issued_at: Date.now(),
        expires_at: Date.now() + 8000,
      }
    },
    resultFrame(commandId: string, outcome: 'applied' | 'rejected') {
      return {
        v: 1 as const,
        transport_id: transportId,
        seq: 4,
        t: 'control.result' as const,
        command_id: commandId,
        outcome,
      }
    },
  }
}

test('the admission nonce starts the admission and sends both phases in order', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  assert.deepEqual(
    f.phases.map((phase) => phase.t),
    ['control.capability', 'control.admission-proof'],
  )
  assert.equal(f.client.state.aborted, false)
  f.client.abort()
})

test('pause signs one command from the issued capability and settles with the result', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  assert.equal(f.commands.length, 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  assert.equal(command.transport_id, f.binding.transport_id)
  assert.equal(command.assignment_id, f.binding.assignment_id)
  assert.equal(command.farm_id, f.binding.farm_id)
  assert.equal(command.agent_id, f.binding.agent_id)
  assert.equal(command.account_id, f.binding.account_id)
  assert.equal(command.key_id, f.binding.key_id)
  assert.equal(command.action, 'pause')
  assert.ok(command.expires_at > command.issued_at)
  assert.ok(command.expires_at - command.issued_at <= 5000)
  assert.equal(f.client.state.commandSent, true)
  f.client.data(f.resultFrame(command.cmd_id, 'applied'))
  assert.equal(await outcome, 'applied')
  assert.deepEqual(f.outcomes, ['applied'])
})

test('a result with another command id never settles the command', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  f.client.data(f.resultFrame(randomUUID(), 'applied'))
  assert.deepEqual(f.outcomes, [])
  f.client.data(f.resultFrame(command.cmd_id, 'rejected'))
  assert.equal(await outcome, 'rejected')
})

test('a second pause is rejected and never sends a second command', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const first = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  assert.equal(await f.client.pause(), 'rejected')
  assert.equal(f.commands.length, 1)
  f.client.data(f.resultFrame(command.cmd_id, 'applied'))
  assert.equal(await first, 'applied')
})

test('two concurrent pauses keep one command and settle every caller', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  // Both callers arrive before any await of the first one.
  const first = f.client.pause()
  const second = f.client.pause()
  assert.equal(await second, 'rejected')
  await waitFor(() => f.commands.length === 1)
  assert.equal(f.commands.length, 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  f.client.data(f.resultFrame(command.cmd_id, 'applied'))
  assert.equal(await first, 'applied')
  assert.deepEqual(f.outcomes, ['applied'])
})

test('a refused command settles as unknown, never as a clean rejection', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.setRefuseCommand(true)
  // The transport refused the hand over. The frame may have left the
  // transport, so the outcome is unknown and never a clean rejection.
  assert.equal(await f.client.pause(), 'outcome-unknown')
  assert.equal(f.commands.length, 0)
})

test('a throwing transport callback settles as unknown', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.setThrowCommand(true)
  assert.equal(await f.client.pause(), 'outcome-unknown')
})

test('a thenable transport callback settles as unknown', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.setThenableCommand(true)
  assert.equal(await f.client.pause(), 'outcome-unknown')
})

test('a reentrant abort inside the send settles the caller as unknown', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.abortOnCommand(() => f.client.abort())
  const outcome = f.client.pause()
  assert.equal(await outcome, 'outcome-unknown')
  assert.equal(f.client.state.aborted, true)
  assert.equal(f.client.state.commandSent, true)
})

test('a throwing outcome observer never breaks the settlement', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.setThrowObserver(true)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  f.client.data(f.resultFrame(command.cmd_id, 'applied'))
  assert.equal(await outcome, 'applied')
})

test('aborting before the command keeps the send sealed', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  f.client.abort()
  assert.equal(await f.client.pause(), 'rejected')
  assert.equal(f.commands.length, 0)
  assert.equal(f.client.state.aborted, true)
})

test('aborting after the command keeps the unknown outcome and never resends', async (t) => {
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  f.client.abort()
  assert.equal(await outcome, 'outcome-unknown')
  assert.equal(f.commands.length, 1)
  assert.equal(await f.client.pause(), 'rejected')
})

test('a dropped result settles as unknown at the command bound', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  // The result never arrives. The bound ends the wait with an unknown outcome.
  t.mock.timers.tick(5001)
  assert.equal(await outcome, 'outcome-unknown')
  assert.deepEqual(f.outcomes, ['outcome-unknown'])
})

test('the admission ends at its own deadline and never reaches the transport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await clientFixture(t, { holdIssuer: true })
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  const outcome = f.client.pause()
  t.mock.timers.tick(8001)
  assert.equal(await outcome, 'rejected')
  assert.equal(f.phases.length, 0)
  assert.equal(f.commands.length, 0)
})

test('the session ends at its own deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = await clientFixture(t)
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  await waitFor(() => f.client.state.admitted)
  const outcome = f.client.pause()
  await waitFor(() => f.commands.length === 1)
  t.mock.timers.tick(30001)
  assert.equal(await outcome, 'outcome-unknown')
  assert.equal(f.client.state.aborted, true)
})

test('an issuer that answers after the close never reaches the transport', async (t) => {
  const f = await clientFixture(t, { holdIssuer: true })
  f.proofsReady()
  f.client.phase(f.nonceFrame())
  const outcome = f.client.pause()
  f.client.abort()
  assert.equal(await outcome, 'rejected')
  assert.equal(f.phases.length, 0)
  assert.equal(f.commands.length, 0)
  assert.equal(f.client.state.aborted, true)
})

test('a client without a transport never sends a phase', async (t) => {
  const browser = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const issuer: PauseCommandIssuer = {
    challenge: async () => {
      throw new Error('Issuer must not be reached')
    },
    capability: async () => {
      throw new Error('Issuer must not be reached')
    },
  }
  const client = createPauseCommandClient({
    privateKey: browser.privateKey,
    issuer,
  })
  client.phase({
    v: 1,
    transport_id: randomUUID(),
    seq: 1,
    t: 'control.admission-nonce',
    admission_nonce: digest(),
    issued_at: Date.now(),
    expires_at: Date.now() + 8000,
  })
  await waitFor(() => !client.state.pending)
  assert.equal(client.state.admitted, false)
  assert.equal(await client.pause(), 'rejected')
  client.abort()
})

test('an issuer that answers outside the control scope never reaches the transport', async (t) => {
  const f = await clientFixture(t)
  const foreign = createPauseCommandClient({
    privateKey: (
      await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify'],
      )
    ).privateKey,
    issuer: {
      async challenge({ admissionNonce }) {
        return {
          v: 1 as const,
          purpose: 'pause-admission' as const,
          challenge_id: randomUUID(),
          farm_id: randomUUID(),
          agent_id: f.binding.agent_id,
          key_id: f.binding.key_id,
          assignment_id: f.binding.assignment_id,
          transport_id: f.binding.transport_id,
          account_id: f.binding.account_id,
          browser_thumbprint: f.binding.browser_thumbprint,
          origin: f.binding.origin,
          audience: f.binding.audience,
          control_binding_sha256: digest(),
          admission_nonce: admissionNonce,
          issued_at: Date.now(),
          expires_at: Date.now() + 8000,
        }
      },
      async capability() {
        throw new Error('Issuer must not be reached')
      },
    },
  })
  foreign.proofsReady({
    binding: f.binding,
    deadlineMonoMs: performance.now() + 30000,
    browserProofWire: f.browserProofWire,
    connectorProofWire: f.connectorProofWire,
  })
  t.after(() => foreign.abort())
  foreign.phase(f.nonceFrame())
  await waitFor(() => !foreign.state.pending)
  assert.equal(foreign.state.admitted, false)
  assert.equal(await foreign.pause(), 'rejected')
})

test(
  'a rejection before command reservation settles without a later session abort',
  { timeout: 2000 },
  async (t) => {
    const f = await clientFixture(t)
    assert.equal(await f.client.pause(), 'rejected')
    let settled = false
    void f.client.settled.then(() => {
      settled = true
    })
    await waitFor(() => settled, 100)
    assert.equal(f.commands.length, 0)
  },
)

test(
  'an issuer ignoring admission abort cannot publish late phases',
  { timeout: 3000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = false
    const f = await clientFixture(t, {
      challengeGate: gate,
      onChallenge: () => {
        entered = true
      },
    })
    try {
      f.proofsReady()
      f.client.phase(f.nonceFrame())
      await waitFor(() => entered)
      t.mock.timers.tick(8001)
      release()
      await waitFor(() => !f.client.state.pending)
      assert.equal(f.phases.length, 0)
      assert.equal(f.client.state.admitted, false)
      await f.client.settled
    } finally {
      release()
    }
  },
)
