import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandAction,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPauseDispatcher,
  type ControlObservation,
} from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  createPrinterBindingRegistry,
  provisionBambuPrinter,
  provisionReadonlyPrinter,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import type { ControlLimits } from '../../packages/connector/src/runtime/control-limits.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'

// Loopback fixtures only: the Moonraker fixture and the Bambu simulator. The
// authority, capability and command are synthetic, exactly as in
// control-actions.test.ts; nothing here reaches a physical printer.
type Action = ExtendedControlAction
type Args = Record<string, unknown>
const SECRET = 'synthetic-access-do-not-log'
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
    role: 'admin' as const,
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
    actions: [...ExtendedControlAction.options],
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

type Backend =
  | { kind: 'moonraker'; mode?: Parameters<typeof pauseFixture>[0] }
  | {
      kind: 'bambu'
      model?: string
      control?: boolean
      initialState?: 'RUNNING' | 'PAUSE' | 'IDLE'
    }

async function world(
  t: test.TestContext,
  backend: Backend,
  action: Action,
  args: Args = {},
  options: { controlLimits?: ControlLimits; detect?: boolean } = {},
) {
  const cleanup: Array<() => unknown | Promise<unknown>> = []
  t.after(async () => {
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
  const f = await authorityFixture(action, args)
  const directory = mkdtempSync(join(tmpdir(), 'control-drivers-extended-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  const scope = {
    assignment_id: f.binding.assignment_id,
    farm_id: f.binding.farm_id,
    agent_id: f.binding.agent_id,
    printer_key: f.capability.printer_key,
  }
  let printerBinding: PrinterBinding
  let moonraker: Awaited<ReturnType<typeof pauseFixture>> | undefined
  let bambu: Awaited<ReturnType<typeof startBambuSimulator>> | undefined
  if (backend.kind === 'moonraker') {
    const remote = await pauseFixture({
      initialState: action === 'resume' ? 'paused' : 'printing',
      ...backend.mode,
    })
    moonraker = remote
    cleanup.push(() => remote.close())
    printerBinding = createPrinterBindingRegistry({
      allowedOrigins: [remote.origin],
    }).provision({ ...scope, moonraker_origin: remote.origin })
  } else {
    const remote = await startBambuSimulator({
      initialTargetTemperature: 215,
      initialState:
        backend.initialState ?? (action === 'resume' ? 'PAUSE' : 'RUNNING'),
    })
    bambu = remote
    cleanup.push(() => remote.close())
    writeFileSync(
      join(directory, 'credentials'),
      JSON.stringify({ accessCode: SECRET }),
      { mode: 0o600 },
    )
    writeFileSync(join(directory, 'ca'), remote.syntheticTrust)
    printerBinding = provisionBambuPrinter(scope, {
      printerKey: scope.printer_key,
      serial: 'SYNTHETIC',
      host: remote.host,
      port: remote.port,
      allowedEndpoints: [{ host: remote.host, port: remote.port }],
      credentialFile: join(directory, 'credentials'),
      caFile: join(directory, 'ca'),
      control: backend.control ?? true,
    })
  }
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  let latest: ControlObservation | undefined
  const model = backend.kind === 'bambu' ? backend.model : undefined
  const driver = createPauseDriverRouter({
    allowedOrigins: moonraker ? [moonraker.origin] : [],
    limits: LIMITS,
    clock: { monotonicNow },
    ...(options.controlLimits ? { controlLimits: options.controlLimits } : {}),
    bambuModel: (binding) => (binding === printerBinding ? model : undefined),
    observe: (binding, observation) => {
      if (observation) latest = observation
      return dispatcher?.observe(binding, observation) ?? false
    },
  })
  cleanup.push(() => driver.closeAttempt(printerBinding))
  // Local support detection happens at provisioning, before any command.
  if (moonraker && options.detect !== false) await driver.detect(printerBinding)
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
    ...(options.controlLimits ? { controlLimits: options.controlLimits } : {}),
    resultTimeoutMs: 5000,
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
  return {
    journal,
    moonraker,
    bambu,
    driver,
    dispatcher: active,
    printerBinding,
    signed,
    dispatch: () =>
      active.dispatch({
        wire: encodeCommandV2(signed),
        capability: accepted.handle,
        printerBinding,
      }),
  }
}

for (const [action, args, script] of [
  ['run_macro', { name: 'CLEAN' }, 'CLEAN'],
  ['load_filament', {}, 'LOAD_FILAMENT'],
  ['unload_filament', {}, 'UNLOAD_FILAMENT'],
] as const) {
  test(`signed Moonraker ${action}`, async (t) => {
    const f = await world(
      t,
      {
        kind: 'moonraker',
        mode: {
          objects: [
            'gcode_macro CLEAN',
            'gcode_macro LOAD_FILAMENT',
            'gcode_macro UNLOAD_FILAMENT',
            'gcode_macro _PRIVATE',
          ],
        },
      },
      action,
      args,
    )
    assert.ok(f.driver.macros, 'router exposes macro discovery')
    assert.deepEqual(f.driver.macros(f.printerBinding), ['CLEAN'])
    const result = await f.dispatch()
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(result.reason, 'state-unconfirmed')
    assert.deepEqual(f.moonraker?.gcodeScripts, [script])
  })
}
for (const action of ['load_filament', 'unload_filament'] as const) {
  test(`signed Bambu ${action}`, async (t) => {
    const f = await world(
      t,
      { kind: 'bambu', model: 'X1C', initialState: 'IDLE' },
      action,
      action === 'load_filament' ? { tray: 15 } : {},
    )
    const result = await f.dispatch()
    assert.equal(result.kind, 'outcome-unknown')
    assert.equal(result.reason, 'state-unconfirmed')
    assert.deepEqual(f.bambu?.extendedState.ams, {
      tray_now: action === 'load_filament' ? '15' : '255',
    })
  })
}

test('Moonraker refuses an unadvertised macro without sending G-code', async (t) => {
  const f = await world(
    t,
    { kind: 'moonraker', mode: { objects: ['gcode_macro CLEAN'] } },
    'run_macro',
    { name: 'OTHER' },
  )
  assert.equal((await f.dispatch()).kind, 'rejected')
  assert.deepEqual(f.moonraker?.gcodeScripts, [])
})
test('Moonraker filament requires the corresponding macro', async (t) => {
  const f = await world(
    t,
    { kind: 'moonraker', mode: { objects: ['gcode_macro CLEAN'] } },
    'load_filament',
  )
  assert.deepEqual(await f.dispatch(), {
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  assert.deepEqual(f.moonraker?.gcodeScripts, [])
})
