import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import {
  openFarmPauseControl,
  PAUSE_CAPABILITY_MARGIN_MS,
  type FarmPauseControlState,
} from '../../apps/farm/app/utils/webrtc/farm-pause-control.ts'
import { pauseAvailability } from '../../apps/farm/app/utils/farm-pause.ts'
import type { FarmRow } from '../../apps/farm/app/utils/farm-view.ts'
import {
  controlBindingHash,
  encodeControlProof,
  signControlSessionProof,
} from '../../packages/farm-protocol/src/control-session-binding.ts'
import { decodeCommandV2 } from '../../packages/farm-protocol/src/command-v2.ts'
import { signPauseCapability } from '../../packages/farm-protocol/src/pause-capability.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import type { PauseCommandMessage } from '../../packages/connector/src/webrtc/pause-control-session.ts'

const digest = () => randomBytes(32).toString('base64url')
async function waitFor(condition: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Real keys and signatures; issuer and signalling are local doubles. */
async function fixture(
  t: test.TestContext,
  options: { capabilityMs?: number; resolveFails?: boolean } = {},
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
  const nonce = digest()
  const states: FarmPauseControlState[] = []
  const commands: PauseCommandMessage[] = []
  const phases: string[] = []
  let signallingOptions:
    | Parameters<
        NonNullable<
          Parameters<typeof openFarmPauseControl>[0]['createSignalling']
        >
      >[1]
    | undefined
  let signallingScope: Record<string, unknown> | undefined
  let closed = 0
  const control = openFarmPauseControl({
    accountId: binding.account_id,
    farmId: binding.farm_id,
    keyId: binding.key_id,
    agentId: binding.agent_id,
    assignmentId: binding.assignment_id,
    async resolveKey() {
      if (options.resolveFails) throw new Error('Unavailable')
      return {
        publicKey,
        privateKey: browser.privateKey,
        origin: binding.origin,
        audience: binding.audience,
      }
    },
    onState: (state) => states.push(state),
    createSignalling(scope, value) {
      signallingScope = { ...scope }
      signallingOptions = value
      return {
        start: () => Promise.resolve(),
        close: () => {
          closed++
        },
        dispose: () => Promise.resolve(),
        sendPhase: (message) => {
          phases.push(message.t)
          return true
        },
        sendCommand: (message) => {
          commands.push(message)
          return true
        },
      }
    },
    issuer: {
      async challenge({ admissionNonce }) {
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
            expires_at: Math.min(
              issuedAt + (options.capabilityMs ?? 30000),
              binding.expires_at,
            ),
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
  t.after(() => control.dispose())
  async function admit() {
    await waitFor(() => !!signallingOptions)
    signallingOptions!.onProofsReady?.({
      binding,
      deadlineMonoMs: performance.now() + 30000,
      browserProofWire,
      connectorProofWire,
    })
    signallingOptions!.onPhase?.({
      v: 1,
      transport_id: binding.transport_id,
      seq: 1,
      t: 'control.admission-nonce',
      admission_nonce: nonce,
      issued_at: Date.now(),
      expires_at: Date.now() + 8000,
    })
  }
  return {
    binding,
    control,
    states,
    commands,
    phases,
    admit,
    options: () => signallingOptions,
    scope: () => signallingScope,
    closed: () => closed,
    result(commandId: string, outcome: 'applied' | 'rejected') {
      signallingOptions!.onData?.({
        v: 1,
        transport_id: binding.transport_id,
        seq: 4,
        t: 'control.result',
        command_id: commandId,
        outcome,
      })
    },
  }
}

test('confirmation is offered only after admission with a fresh capability and sends exactly one signed pause', async (t) => {
  const f = await fixture(t)
  await f.admit()
  await waitFor(() => f.states.at(-1)?.kind === 'ready')
  assert.deepEqual(f.phases, ['control.capability', 'control.admission-proof'])
  assert.equal(f.scope()?.assignmentId, f.binding.assignment_id)
  assert.equal(f.commands.length, 0)
  const outcome = f.control.pause()
  await waitFor(() => f.commands.length === 1)
  const command = decodeCommandV2(f.commands[0]!.wire)
  assert.equal(command.action, 'pause')
  assert.equal(command.assignment_id, f.binding.assignment_id)
  f.result(command.cmd_id, 'applied')
  assert.equal(await outcome, 'applied')
  assert.deepEqual(
    f.states.map((state) => state.kind),
    ['ready', 'sending', 'settled'],
  )
  assert.deepEqual(f.states.at(-1), { kind: 'settled', outcome: 'applied' })
  // The session is over: a second pause sends nothing.
  assert.equal(await f.control.pause(), undefined)
  assert.equal(f.commands.length, 1)
})

test('a capability without enough remaining validity is never offered', async (t) => {
  const f = await fixture(t, { capabilityMs: PAUSE_CAPABILITY_MARGIN_MS - 500 })
  await f.admit()
  await waitFor(() => f.states.at(-1)?.kind === 'failed')
  assert.deepEqual(f.states.at(-1), { kind: 'failed', reason: 'expired' })
  assert.equal(await f.control.pause(), undefined)
  assert.equal(f.commands.length, 0)
})

test('a transport that ends before confirmation fails closed without a command', async (t) => {
  const f = await fixture(t)
  await f.admit()
  await waitFor(() => f.states.at(-1)?.kind === 'ready')
  f.options()!.onTerminal?.('socket-closed')
  assert.deepEqual(f.states.at(-1), { kind: 'failed', reason: 'closed' })
  assert.equal(await f.control.pause(), undefined)
  assert.equal(f.commands.length, 0)
})

test('an unavailable key or pause metadata opens no transport', async (t) => {
  const f = await fixture(t, { resolveFails: true })
  await waitFor(() => f.states.length === 1)
  assert.deepEqual(f.states, [{ kind: 'failed', reason: 'unavailable' }])
  assert.equal(f.options(), undefined)
})

test('cancel while ready closes the session without a command', async (t) => {
  const f = await fixture(t)
  await f.admit()
  await waitFor(() => f.states.at(-1)?.kind === 'ready')
  f.control.close()
  assert.deepEqual(f.states.at(-1), { kind: 'failed', reason: 'closed' })
  assert.ok(f.closed() >= 1)
  assert.equal(f.commands.length, 0)
})

const live = (overrides: Partial<FarmRow> = {}, age = 1000): FarmRow => ({
  assignment: {
    assignmentId: randomUUID(),
    agentId: randomUUID(),
    printerKey: 'p',
    status: 'active',
    connectorStatus: 'approved',
  } as FarmRow['assignment'],
  connection: 'authenticated',
  localOrigin: null,
  observation: {
    state: {
      state: 'printing',
      progress: 0.5,
      observedAt: 100_000 - age,
    } as NonNullable<FarmRow['observation']>['state'],
    received: { wall: 100_000 - age, mono: 50_000 - age },
    sourceClockComparable: true,
    historical: false,
  },
  ...overrides,
})
const keys = { kind: 'available' as const, choices: [], selected: randomUUID() }
const now = { wall: 100_000, mono: 50_000 }

test('pause availability requires a live printing row, an approved key and enabled control', () => {
  assert.deepEqual(pauseAvailability(live(), keys, true, now), {
    available: true,
  })
  const reason = (
    row: FarmRow,
    k = keys as Parameters<typeof pauseAvailability>[1],
    enabled = true,
  ) => {
    const value = pauseAvailability(row, k, enabled, now)
    return value.available ? '' : value.reason
  }
  assert.match(reason(live(), keys, false), /não está habilitado/)
  assert.match(
    reason(live(), { kind: 'unavailable', reason: 'pending' }),
    /dispositivo aprovado/,
  )
  assert.match(reason(live({ connection: 'closed' })), /ao vivo/)
  const historical = live()
  historical.observation!.historical = true
  assert.match(reason(historical), /ao vivo/)
  assert.match(reason(live({}, 31_000)), /desatualizado/)
  const idle = live()
  idle.observation!.state = { ...idle.observation!.state, state: 'idle' }
  assert.match(reason(idle), /não está imprimindo/)
  const revoked = live()
  revoked.assignment = { ...revoked.assignment, connectorStatus: 'revoked' }
  assert.match(reason(revoked), /não está ativo/)
})
