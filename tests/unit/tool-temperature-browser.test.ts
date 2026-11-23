import assert from 'node:assert/strict'
import { it, expect, vi, type TestContext } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPauseDispatcher,
  type ControlObservation,
  type PreparedPauseDriver,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'

let monotonic = 10_000
const monotonicNow = () => (monotonic += 0.001)
async function authorityFixture() {
  const now = Date.now()
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  const { kty, crv, x, y } = await crypto.subtle.exportKey(
    'jwk',
    pair.publicKey,
  )
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
  const { publicKey } = await validateBrowserDevicePublicKey({ kty, crv, x, y })
  const command = {
    v: 2 as const,
    purpose: 'printer-control' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'set_tool_temperature',
    args: { tool: 1, target_c: 200 },
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  const { thumbprint } = await validateBrowserDevicePublicKey(publicKey)
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const connector = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = Buffer.from(
    await crypto.subtle.exportKey('spki', connector.publicKey),
  )
  const { createHash } = await import('node:crypto')
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: command.transport_id,
    farm_id: command.farm_id,
    agent_id: command.agent_id,
    account_id: command.account_id,
    key_id: command.key_id,
    assignment_id: command.assignment_id,
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
  const { controlBindingHash } =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const bindingHash = await controlBindingHash(binding),
    admissionNonce = digest()
  const capability = {
    v: 1 as const,
    purpose: 'pause-authority' as const,
    capability_id: command.capability_id,
    kid: 'issuer-1',
    issuer: 'farm:issuer',
    audience: binding.audience,
    origin: binding.origin,
    issued_at: now,
    expires_at: now + 30000,
    account_id: command.account_id,
    role: 'operator' as const,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    key_id: binding.key_id,
    assignment_id: binding.assignment_id,
    transport_id: binding.transport_id,
    browser_public_key: publicKey,
    browser_thumbprint: thumbprint,
    connector_fingerprint: binding.connector_fingerprint,
    credential_jti: binding.credential_jti,
    printer_key: 'é"\\'.repeat(32),
    control_binding_sha256: bindingHash,
    admission_nonce: admissionNonce,
    actions: ['set_tool_temperature'] as const,
  }
  const challenge = {
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
    issued_at: now,
    expires_at: now + 8000,
  }
  return {
    pair,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

type FixtureOptions = {
  state?: ControlObservation['printState']
  heaters?: ControlObservation['toolHeaters']
  stale?: boolean
  removeAtSend?: boolean
  loseConfirmation?: boolean
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const f = await authorityFixture()
  const directory = mkdtempSync(join(tmpdir(), 'tool-temperature-browser-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  const origin = 'http://127.0.0.1:7125'
  const registry = createPrinterBindingRegistry({ allowedOrigins: [origin] })
  const printerBinding = registry.provision({
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
    moonraker_origin: origin,
  })
  const observation = (sequence: number): ControlObservation => {
    const now = monotonicNow()
    return {
      assignmentId: f.binding.assignment_id,
      printerKey: f.capability.printer_key,
      connectionGeneration: 1,
      sequence,
      ready: true,
      printState: options.state ?? 'idle',
      readyObservedMono: options.stale ? 0 : now,
      printStateObservedMono: options.stale ? 0 : now,
      receivedMono: now,
    }
  }
  const sent = vi.fn()
  const execute = vi.fn<NonNullable<PreparedPauseDriver['execute']>>(
    async (action, args, { beforeSend }) => {
      if (options.removeAtSend)
        dispatcher.observe(printerBinding, observation(2))
      if (!beforeSend()) return { acknowledged: false }
      sent(action, args)
      return { acknowledged: true }
    },
  )
  const driver: PreparedPauseDriver = {
    controls: () => ['set_tool_temperature'],
    async prepare() {
      dispatcher.observe(printerBinding, {
        ...observation(1),
        toolHeaters:
          'heaters' in options ? options.heaters : [{ tool: 1, maxC: 250 }],
      })
      return { connectionGeneration: 1 }
    },
    execute,
    async pauseOnce() {
      throw new Error('Unexpected lifecycle dispatch')
    },
    async waitForPaused() {
      if (options.loseConfirmation) return null
      const after = observation(3)
      return {
        ...after,
        effect: {
          kind: 'tool-temperature',
          tool: 1,
          target_c: 200,
          observedMono: after.receivedMono,
        },
      }
    },
    async closeAttempt() {},
  }
  const dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        {
          issuer: f.capability.issuer,
          kid: f.capability.kid,
          publicKey: f.issuer.publicKey,
        },
      ],
    },
    clock: { wallNow: () => Date.now(), monotonicNow },
    journal,
    driver,
    resultTimeoutMs: 1500,
  })
  t.onTestFinished(async () => {
    dispatcher.close()
    await dispatcher.settled
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  const controls =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const admission = dispatcher.beginAdmission({
    binding: f.binding,
    printerBinding,
    peer: dispatcher.createPeer(1).peer,
  })
  const nonce = admission.challenge.admissionNonce
  const admittedAt = Date.now()
  const capability = await caps.signPauseCapability(
    {
      ...f.capability,
      actions: ['set_tool_temperature'],
      issued_at: admittedAt,
      admission_nonce: nonce,
    },
    f.issuer.privateKey,
  )
  const proof = await caps.signPauseAdmissionProof(
    {
      ...f.challenge,
      issued_at: admittedAt,
      expires_at: admittedAt + 8000,
      admission_nonce: nonce,
    },
    f.pair.privateKey,
  )
  const accepted = await dispatcher.admit(admission.token, {
    capabilityWire: caps.encodePauseCapability(capability),
    admissionProofWire: caps.encodePauseAdmissionProof(proof),
    browserProofWire: controls.encodeControlProof({
      v: 1,
      role: 'browser',
      binding: f.binding,
      signature: await controls.signControlSessionProof(
        f.binding,
        'browser',
        f.pair.privateKey,
      ),
    }),
    connectorProofWire: controls.encodeControlProof({
      v: 1,
      role: 'connector',
      binding: f.binding,
      signature: await controls.signControlSessionProof(
        f.binding,
        'connector',
        f.connector.privateKey,
      ),
    }),
  })
  assert.ok(accepted.ok, accepted.ok ? 'admitted' : accepted.reason)
  const commandAt = Date.now()
  const signed = await signCommandV2(
    { ...f.command, issued_at: commandAt, expires_at: commandAt + 5000 },
    f.pair.privateKey,
  )
  const input = {
    wire: encodeCommandV2(signed),
    capability: accepted.handle,
    printerBinding,
  }
  return { dispatcher, input, sent, execute }
}

for (const state of [
  'printing',
  'paused',
  'error',
  'unknown',
  'cancelled',
] as const)
  it(`browser refuses ${state} state before sending`, async (t) => {
    const f = await fixture(t, { state })
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
      kind: 'not-sent',
      code: 'tool-printer-not-idle',
    })
    expect(f.execute).not.toHaveBeenCalled()
  })

for (const [options, code] of [
  [{ heaters: [{ tool: 2, maxC: 250 }] }, 'tool-heater-not-advertised'],
  [{ heaters: [{ tool: 1, maxC: 199 }] }, 'tool-temperature-above-maximum'],
  [{ stale: true }, 'tool-state-stale'],
] satisfies [FixtureOptions, string][])
  it(`browser refuses before execution with ${code}`, async (t) => {
    const f = await fixture(t, options)
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
      kind: 'not-sent',
      code,
    })
    expect(f.execute).not.toHaveBeenCalled()
  })

it('browser delivers and confirms one typed command for an idle advertised tool', async (t) => {
  const f = await fixture(t)
  expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
    kind: 'applied',
  })
  expect(f.sent).toHaveBeenCalledExactlyOnceWith('set_tool_temperature', {
    tool: 1,
    target_c: 200,
  })
})

it('browser refuses a heater withdrawn at the send boundary', async (t) => {
  const f = await fixture(t, { removeAtSend: true })
  expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
    kind: 'not-sent',
    code: 'tool-heater-not-advertised',
  })
  expect(f.execute).toHaveBeenCalledOnce()
  expect(f.sent).not.toHaveBeenCalled()
})

it('browser never replays a write with an uncertain outcome', async (t) => {
  const f = await fixture(t, { loseConfirmation: true })
  expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
    kind: 'outcome-unknown',
  })
  expect(await f.dispatcher.dispatch(f.input)).toMatchObject({
    reason: 'replay',
  })
  expect(f.sent).toHaveBeenCalledOnce()
})
