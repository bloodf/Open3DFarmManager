import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { provisionKobraLinkPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'

// Synthetic authority and in-memory bridge only; no physical printer.
type Action = ExtendedControlAction
type Args = Record<string, unknown>
const LIMITS = {
  maxMessageBytes: 4096,
  connectTimeoutMs: 2000,
  requestTimeoutMs: 2000,
  staleAfterMs: 2000,
  reconnectMinMs: 100,
  reconnectMaxMs: 100,
}
let lastMono = 0
const monotonicNow = () =>
  (lastMono = Math.max(performance.now(), lastMono + 0.001))

async function commandFixture(action: Action, args: Args) {
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
    purpose:
      action === 'pause'
        ? ('printer-pause' as const)
        : ('printer-control' as const),
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action,
    args,
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(action: Action, args: Args) {
  const { pair, publicKey, command } = await commandFixture(action, args)
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
    actions: ExtendedControlAction.options.filter(
      (granted) => granted !== 'run_macro',
    ),
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

import { createControlFixture } from '../fixtures/kobralink-integration/control.ts'
for (const [action, args, path] of [
  ['set_temperature', { heater: 'extruder', target_c: 200 }, 'temperature'],
  ['set_fan', { fan: 'part', percent: 40 }, 'fan'],
  ['set_light', { on: true }, 'light'],
  ['set_speed', { level: 'sport' }, 'speed'],
  ['home', { axes: ['x'] }, 'axis'],
  ['start_print', { file: 'test.gcode' }, 'printer-files/print'],
  ['set_temperature', { heater: 'extruder', target_c: 301 }, null],
  ['set_temperature', { heater: 'chamber', target_c: 40 }, null],
  ['set_speed', { level: 'ludicrous' }, null],
  ['emergency_stop', {}, null],
  ['firmware_restart', {}, null],
] as const) {
  test(`KobraLink ${action} reaches the fixture through signed dispatch`, async (t) => {
    const f = await authorityFixture(action, args)
    const directory = mkdtempSync(join(tmpdir(), 'kobralink-wire-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const remote = createControlFixture()
    if (action === 'home' || action === 'start_print')
      remote.state.printState = 'standby'
    const origin = 'http://127.0.0.1:7100'
    const local = {
      backend: 'kobralink',
      version: 2,
      bridgeInstance: 'fixture',
      origin,
      deviceId: remote.state.deviceId,
      id: remote.state.id,
      printerKey: f.capability.printer_key,
      revision: 1,
      credentialFile: join(directory, 'credential'),
    }
    writeFileSync(
      local.credentialFile,
      JSON.stringify({
        ...local,
        backend: undefined,
        credentialFile: undefined,
        version: 1,
        name: 'Connector',
        email: 'c@example.test',
        password: 'synthetic-password',
      }),
      { mode: 0o600 },
    )
    const printerBinding = provisionKobraLinkPrinter(
      {
        assignment_id: f.binding.assignment_id,
        farm_id: f.binding.farm_id,
        agent_id: f.binding.agent_id,
        printer_key: f.capability.printer_key,
      },
      local,
    )
    const journal = openCommandJournal({ directory, clock: Date.now })
    t.after(() => closeCommandJournal(journal))
    let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
    const driver = createPauseDriverRouter({
      allowedOrigins: [origin],
      limits: LIMITS,
      clock: { monotonicNow },
      kobraLinkFetch: remote.fetch,
      observe: (binding, observation) =>
        dispatcher?.observe(binding, observation) ?? false,
    })
    t.after(() => driver.closeAttempt(printerBinding))
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
      driver,
      resultTimeoutMs: 5000,
    })
    const active = dispatcher

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
      { ...f.capability, issued_at: admittedAt, admission_nonce: nonce },
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
    t.after(() => active.close())
    assert.deepEqual(driver.controls(printerBinding), [
      'pause',
      'resume',
      'cancel',
      'set_temperature',
      'set_fan',
      'set_light',
      'set_speed',
      'home',
      'start_print',
    ])
    const result = await active.dispatch({
      wire: encodeCommandV2(signed),
      capability: accepted.handle,
      printerBinding,
    })
    if (path === null) {
      assert.notEqual(result.kind, 'applied')
      assert.equal(remote.extended.length, 0)
      return
    }
    // The fixture acknowledges the write but reports no action-specific effect.
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(result.reason, 'state-unconfirmed')
    assert.equal(remote.extended.length, 1)
    assert.equal(remote.extended[0]?.path, `/api/v1/printers/printer-1/${path}`)
  })
}
