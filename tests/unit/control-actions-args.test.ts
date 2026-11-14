import assert from 'node:assert/strict'
import { describe, it, expect, vi, type TestContext } from 'vitest'
import {
  ControlArguments,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { controlWithinLimits } from '../../packages/connector/src/runtime/control-limits.ts'
const cases = [
  ['pause', {}],
  ['resume', {}],
  ['cancel', {}],
  ['emergency_stop', {}],
  ['firmware_restart', {}],
  ['set_temperature', { heater: 'extruder', target_c: 200 }],
  ['set_fan', { fan: 'part', percent: 100 }],
  ['home', { axes: ['x', 'z'] }],
  ['set_light', { on: true }],
  ['set_speed', { level: 'sport' }],
  ['start_print', { file: 'part.gcode' }],
] as const
describe('extended control arguments', () => {
  for (const [action, args] of cases)
    it(action, () => {
      expect(ControlArguments.safeParse({ action, args }).success).toBe(true)
      expect(
        ControlArguments.safeParse({ action, args: { ...args, unknown: true } })
          .success,
      ).toBe(false)
    })
  it('rejects invalid values', () => {
    for (const [action, args] of [
      ['set_temperature', { heater: 'bed', target_c: -1 }],
      ['set_fan', { fan: 'part', percent: 101 }],
      ['home', { axes: [] }],
      ['home', { axes: ['x', 'x'] }],
      ['set_light', { on: 1 }],
      ['set_speed', { level: 'fast' }],
      ['start_print', { file: '../part' }],
      ['start_print', { file: 'a/b' }],
      ['start_print', { file: 'a\\b' }],
    ])
      expect(ControlArguments.safeParse({ action, args }).success).toBe(false)
  })
  it('enforces connector limits and overrides', () => {
    for (const [heater, max] of [
      ['extruder', 300],
      ['bed', 120],
      ['chamber', 65],
    ] as const) {
      expect(
        controlWithinLimits('set_temperature', { heater, target_c: max }),
      ).toBe(true)
      expect(
        controlWithinLimits('set_temperature', { heater, target_c: max + 1 }),
      ).toBe(false)
    }
    expect(
      controlWithinLimits(
        'set_temperature',
        { heater: 'bed', target_c: 90 },
        { extruder: 250, bed: 80, chamber: 50 },
      ),
    ).toBe(false)
  })
  it('allows only control roles', () => {
    for (const role of ['owner', 'admin', 'operator'])
      expect(controlRoleAllowed(role)).toBe(true)
    for (const role of ['viewer', 'guest', ''])
      expect(controlRoleAllowed(role)).toBe(false)
  })
})

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'

let monotonic = 0
const monotonicNow = () => (monotonic += 0.001)
async function commandFixture(action: 'resume' | 'cancel' | 'set_temperature') {
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
    action,
    args: action === 'set_temperature' ? { heater: 'bed', target_c: 121 } : {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(
  action: 'resume' | 'cancel' | 'set_temperature',
) {
  const { pair, publicKey, command } = await commandFixture(action)
  const now = command.issued_at
  const { validateBrowserDevicePublicKey } =
    await import('../../packages/farm-protocol/src/browser-device-proof.ts')
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
    actions: ['pause', 'resume', 'cancel', 'set_temperature'],
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
    publicKey,
    command,
    issuer,
    connector,
    binding,
    capability,
    challenge,
  }
}

async function fixture(
  t: TestContext,
  action: 'resume' | 'cancel' | 'set_temperature',
  supported = true,
  mode: Parameters<typeof pauseFixture>[0] = {},
  allowedActions: ('pause' | 'resume' | 'cancel' | 'set_temperature')[] = [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
  ],
) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.onTestFinished(async () => {
    const errors: unknown[] = []
    for (const dispose of cleanup.reverse()) {
      try {
        await dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length)
      throw new AggregateError(errors, 'Fixture cleanup failed')
  })
  const f = await authorityFixture(action)
  const directory = mkdtempSync(join(tmpdir(), 'control-actions-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  const remote = await pauseFixture({
    initialState: action === 'resume' ? 'paused' : 'printing',
    ...mode,
  })
  cleanup.push(async () => {
    await remote.close()
    assert.equal(remote.counts().sockets, 0)
  })
  const registry = createPrinterBindingRegistry({
    allowedOrigins: [remote.origin],
  })
  const printerBinding = registry.provision({
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
    moonraker_origin: remote.origin,
  })
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const router = createPauseDriverRouter({
    allowedOrigins: [remote.origin],
    limits: {
      maxMessageBytes: 4096,
      connectTimeoutMs: 500,
      requestTimeoutMs: 500,
      staleAfterMs: 2000,
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    },
    clock: { monotonicNow },
    observe: (binding, observation) =>
      dispatcher?.observe(binding, observation) ?? false,
  })
  const driver = {
    ...router,
    prepare: vi.fn(router.prepare),
    pauseOnce: vi.fn(router.pauseOnce),
  }
  cleanup.push(() => driver.closeAttempt(printerBinding))
  dispatcher = createPauseDispatcher({
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
    driver: supported ? driver : { ...driver, controls: () => ['pause'] },
    resultTimeoutMs: 1500,
  })
  const active = dispatcher
  cleanup.push(() => active.close())
  const controls =
    await import('../../packages/farm-protocol/src/control-session-binding.ts')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const admission = active.beginAdmission({
    binding: f.binding,
    printerBinding,
    peer: active.createPeer(1).peer,
  })
  const nonce = admission.challenge.admissionNonce
  const admittedAt = Date.now()
  const capability = await caps.signPauseCapability(
    {
      ...f.capability,
      actions: allowedActions,
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
  const accepted = await active.admit(admission.token, {
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
  return {
    f,
    directory,
    journal,
    remote,
    driver,
    dispatcher: active,
    input,
    signed,
  }
}

for (const [heater, target_c] of [
  ['extruder', 301],
  ['bed', 121],
  ['chamber', 66],
] as const)
  it(`rejects ${heater} above its local limit before calling the driver`, async (t) => {
    const f = await fixture(t, 'set_temperature')
    const { sig, ...unsigned } = f.signed
    const signed = await signCommandV2(
      { ...unsigned, args: { heater, target_c } },
      f.f.pair.privateKey,
    )
    expect(
      await f.dispatcher.dispatch({
        ...f.input,
        wire: encodeCommandV2(signed),
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'invalid-command',
    })
    expect(f.driver.prepare).not.toHaveBeenCalled()
    expect(f.driver.pauseOnce).not.toHaveBeenCalled()
    expect(f.remote.requests).toEqual([])
  })
it('returns typed unsupported-action before driver preparation', async (t) => {
  const f = await fixture(t, 'resume', false)
  expect(await f.dispatcher.dispatch(f.input)).toEqual({
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  expect(f.driver.prepare).not.toHaveBeenCalled()
  expect(f.driver.pauseOnce).not.toHaveBeenCalled()
  expect(f.remote.requests).toEqual([])
})
