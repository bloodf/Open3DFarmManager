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
const LIFECYCLE = ['pause', 'resume', 'cancel']
const MOONRAKER_ALL = [
  ...LIFECYCLE,
  'emergency_stop',
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
]
const BAMBU_ALL = [
  ...LIFECYCLE,
  'set_temperature',
  'set_fan',
  'home',
  'set_light',
  'set_speed',
  'start_print',
]
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
    /**
     * The dispatcher's own driver sequence on the router: prepare, one guarded
     * execute, then the post-send observation. Used for the extended actions,
     * which the command journal cannot record yet (see the report).
     */
    async execute() {
      const signal = new AbortController().signal
      const { connectionGeneration } = await driver.prepare({
        binding: printerBinding,
        signal,
      })
      let guards = 0
      let after = { connectionGeneration, sequence: 0, sentMono: 0 }
      const request = {
        binding: printerBinding,
        beforeSend() {
          guards++
          after = {
            connectionGeneration,
            sequence: latest?.sequence ?? 0,
            sentMono: monotonicNow(),
          }
          return true
        },
        signal,
      }
      const acknowledgement = await driver.execute(action, args, request)
      const observation = await driver.waitForPaused({
        // The dispatcher passes the signed action through this same cast.
        action: action as 'pause',
        args,
        binding: printerBinding,
        after,
        signal,
      })
      // One attempt carries one command; a second send is refused unsent.
      await assert.rejects(driver.execute(action, args, request))
      assert.equal(guards, 1)
      await driver.closeAttempt(printerBinding)
      return { acknowledgement, observation, after }
    },
  }
}

async function assertExecuted(f: Awaited<ReturnType<typeof world>>) {
  const { acknowledgement, observation, after } = await f.execute()
  assert.deepEqual(acknowledgement, { acknowledged: true })
  assert.ok(observation, 'a state read after the send is reported')
  assert.equal(observation.connectionGeneration, after.connectionGeneration)
  assert.ok(observation.sequence > after.sequence)
  assert.ok(observation.receivedMono > after.sentMono)
  return observation
}
const commands = (f: Awaited<ReturnType<typeof world>>) =>
  (f.moonraker?.requests ?? []).filter(
    (request) => request.method !== 'printer.objects.query',
  )

const moonrakerCases: Array<{
  action: Action
  args: Args
  method: string
  script?: string
}> = [
  { action: 'pause', args: {}, method: 'printer.print.pause' },
  { action: 'resume', args: {}, method: 'printer.print.resume' },
  { action: 'cancel', args: {}, method: 'printer.print.cancel' },
  { action: 'emergency_stop', args: {}, method: 'printer.emergency_stop' },
  {
    action: 'set_temperature',
    args: { heater: 'extruder', target_c: 215 },
    method: 'printer.gcode.script',
    script: 'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=215',
  },
  {
    action: 'set_temperature',
    args: { heater: 'bed', target_c: 60 },
    method: 'printer.gcode.script',
    script: 'SET_HEATER_TEMPERATURE HEATER=heater_bed TARGET=60',
  },
  {
    action: 'set_fan',
    args: { fan: 'part', percent: 100 },
    method: 'printer.gcode.script',
    script: 'M106 S255',
  },
  {
    action: 'set_fan',
    args: { fan: 'aux', percent: 50 },
    method: 'printer.gcode.script',
    script: 'SET_FAN_SPEED FAN=aux SPEED=0.5',
  },
  {
    action: 'home',
    args: { axes: ['x', 'y'] },
    method: 'printer.gcode.script',
    script: 'G28 X Y',
  },
  {
    action: 'set_light',
    args: { on: true },
    method: 'printer.gcode.script',
    script: 'SET_PIN PIN=caselight VALUE=1',
  },
  {
    action: 'set_speed',
    args: { level: 'sport' },
    method: 'printer.gcode.script',
    script: 'M220 S124',
  },
]
for (const c of moonrakerCases) {
  const lifecycle = LIFECYCLE.includes(c.action)
  test(`Moonraker ${c.action} ${JSON.stringify(c.args)} sends exactly one RPC`, async (t) => {
    const f = await world(t, { kind: 'moonraker' }, c.action, c.args)
    assert.ok(f.driver.controls(f.printerBinding).includes(c.action))
    if (lifecycle) {
      assert.deepEqual(await f.dispatch(), {
        kind: 'applied',
        reason: 'applied',
        cmdId: f.signed.cmd_id,
      })
      assert.equal(readCommandAction(f.journal, f.signed.cmd_id), c.action)
      // A replay of the same signed command never reaches the printer again.
      assert.equal((await f.dispatch()).kind, 'rejected')
    } else {
      const observation = await assertExecuted(f)
      // Only an emergency stop changes what the printer reports afterwards.
      assert.equal(
        observation.printState,
        c.action === 'emergency_stop' ? 'error' : 'printing',
      )
    }
    // One detection read at provisioning, then exactly one command.
    assert.deepEqual(
      commands(f).map((request) => request.method),
      ['printer.objects.list', c.method],
    )
    assert.deepEqual(f.moonraker?.gcodeScripts, c.script ? [c.script] : [])
  })
}

test('Moonraker advertises exactly the actions its detected objects support', async (t) => {
  const full = await world(t, { kind: 'moonraker' }, 'home', { axes: ['z'] })
  assert.deepEqual(full.driver.controls(full.printerBinding), MOONRAKER_ALL)
  const bare = await world(
    t,
    { kind: 'moonraker', mode: { objects: ['gcode_move', 'toolhead'] } },
    'set_light',
    { on: true },
  )
  assert.deepEqual(bare.driver.controls(bare.printerBinding), [
    ...LIFECYCLE,
    'emergency_stop',
    'set_fan',
    'home',
    'set_speed',
  ])
  assert.deepEqual(await bare.dispatch(), {
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  assert.deepEqual(
    commands(bare).map((request) => request.method),
    ['printer.objects.list'],
  )
})

test('Moonraker without support detection stays on lifecycle actions', async (t) => {
  const f = await world(
    t,
    { kind: 'moonraker' },
    'home',
    { axes: ['x'] },
    { detect: false },
  )
  assert.deepEqual(f.driver.controls(f.printerBinding), LIFECYCLE)
  assert.deepEqual(await f.dispatch(), {
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  assert.equal(f.moonraker?.requests.length, 0)
  assert.deepEqual(await f.driver.detect(f.printerBinding), MOONRAKER_ALL)
})

for (const action of ['start_print', 'firmware_restart'] as const) {
  test(`Moonraker rejects ${action} as unsupported before any command`, async (t) => {
    const f = await world(
      t,
      { kind: 'moonraker' },
      action,
      action === 'start_print' ? { file: 'cube.gcode' } : {},
    )
    assert.deepEqual(await f.dispatch(), {
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    assert.deepEqual(
      commands(f).map((request) => request.method),
      ['printer.objects.list'],
    )
  })
}

test('temperature above the default ceiling is rejected before any command', async (t) => {
  for (const args of [
    { heater: 'extruder', target_c: 301 },
    { heater: 'bed', target_c: 121 },
    { heater: 'chamber', target_c: 66 },
  ]) {
    const f = await world(t, { kind: 'moonraker' }, 'set_temperature', args)
    assert.deepEqual(await f.dispatch(), {
      kind: 'rejected',
      reason: 'invalid-command',
    })
    assert.deepEqual(f.moonraker?.gcodeScripts, [])
  }
})

test('a stricter connector ceiling applies in the dispatcher and in the router', async (t) => {
  const controlLimits = { extruder: 250, bed: 100, chamber: 0 }
  const f = await world(
    t,
    { kind: 'moonraker' },
    'set_temperature',
    { heater: 'extruder', target_c: 260 },
    { controlLimits },
  )
  assert.deepEqual(await f.dispatch(), {
    kind: 'rejected',
    reason: 'invalid-command',
  })
  // The router refuses the same request on a prepared attempt of its own.
  const signal = new AbortController().signal
  await f.driver.prepare({ binding: f.printerBinding, signal })
  let guarded = false
  const request = {
    binding: f.printerBinding,
    beforeSend: () => (guarded = true),
    signal,
  }
  await assert.rejects(
    f.driver.execute(
      'set_temperature',
      { heater: 'extruder', target_c: 260 },
      request,
    ),
    /unavailable/,
  )
  await assert.rejects(
    f.driver.execute('start_print', { file: 'cube.gcode' }, request),
    /unavailable/,
  )
  assert.equal(guarded, false)
  assert.deepEqual(f.moonraker?.gcodeScripts, [])
  await f.driver.closeAttempt(f.printerBinding)
  const allowed = await world(
    t,
    { kind: 'moonraker' },
    'set_temperature',
    { heater: 'extruder', target_c: 250 },
    { controlLimits },
  )
  await assertExecuted(allowed)
  assert.deepEqual(allowed.moonraker?.gcodeScripts, [
    'SET_HEATER_TEMPERATURE HEATER=extruder TARGET=250',
  ])
})

const bambuCases: Array<{
  action: Action
  args: Args
  command: string
  state?: Record<string, unknown>
  initialState?: 'RUNNING' | 'PAUSE' | 'IDLE'
}> = [
  { action: 'pause', args: {}, command: 'pause' },
  { action: 'resume', args: {}, command: 'resume' },
  { action: 'cancel', args: {}, command: 'stop' },
  {
    action: 'set_temperature',
    args: { heater: 'extruder', target_c: 220 },
    command: 'gcode_line',
    state: { M104: 220 },
  },
  {
    action: 'set_temperature',
    args: { heater: 'bed', target_c: 65 },
    command: 'gcode_line',
    state: { M140: 65 },
  },
  {
    action: 'set_fan',
    args: { fan: 'aux', percent: 100 },
    command: 'gcode_line',
    state: { 'M106 P2': 255 },
  },
  {
    action: 'home',
    args: { axes: ['x', 'y', 'z'] },
    command: 'gcode_line',
    state: { homed_axes: 'X Y Z' },
  },
  {
    action: 'set_light',
    args: { on: false },
    command: 'ledctrl',
    state: { light: 'off' },
  },
  {
    action: 'set_speed',
    args: { level: 'ludicrous' },
    command: 'print_speed',
    state: { speed: '4' },
  },
  {
    action: 'start_print',
    args: { file: 'cube.3mf' },
    command: 'project_file',
    state: { file: 'file:///sdcard/cube.3mf' },
    initialState: 'IDLE',
  },
]
for (const c of bambuCases) {
  const lifecycle = LIFECYCLE.includes(c.action)
  test(
    `Bambu ${c.action} ${JSON.stringify(c.args)} publishes exactly one request`,
    { timeout: 15000 },
    async (t) => {
      const f = await world(
        t,
        {
          kind: 'bambu',
          model: 'X1C',
          ...(c.initialState ? { initialState: c.initialState } : {}),
        },
        c.action,
        c.args,
      )
      assert.deepEqual(f.driver.controls(f.printerBinding), BAMBU_ALL)
      if (lifecycle) {
        assert.deepEqual(await f.dispatch(), {
          kind: 'applied',
          reason: 'applied',
          cmdId: f.signed.cmd_id,
        })
        assert.equal(readCommandAction(f.journal, f.signed.cmd_id), c.action)
        assert.equal((await f.dispatch()).kind, 'rejected')
      } else await assertExecuted(f)
      assert.deepEqual(f.bambu?.requests, [
        { command: c.command, sequence_id: '1' },
      ])
      assert.deepEqual(f.bambu?.extendedState, c.state ?? {})
      if (c.action === 'start_print')
        assert.equal(f.bambu?.gcodeState, 'RUNNING')
    },
  )
}

test('Bambu advertises extended actions only with control opt-in and a known model', async (t) => {
  const args = { on: true }
  const known = await world(
    t,
    { kind: 'bambu', model: 'P1S' },
    'set_light',
    args,
  )
  assert.deepEqual(known.driver.controls(known.printerBinding), BAMBU_ALL)
  const unknown = await world(t, { kind: 'bambu' }, 'set_light', args)
  assert.deepEqual(unknown.driver.controls(unknown.printerBinding), LIFECYCLE)
  assert.deepEqual(await unknown.dispatch(), {
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  assert.deepEqual(unknown.bambu?.requests, [])
  const optedOut = await world(
    t,
    { kind: 'bambu', model: 'P1S', control: false },
    'set_light',
    args,
  )
  assert.deepEqual(optedOut.driver.controls(optedOut.printerBinding), [])
  assert.deepEqual(await optedOut.dispatch(), {
    kind: 'rejected',
    reason: 'unsupported-action',
  })
  assert.deepEqual(optedOut.bambu?.requests, [])
})

for (const action of ['emergency_stop', 'firmware_restart'] as const) {
  test(`Bambu rejects ${action} as unsupported without publishing`, async (t) => {
    const f = await world(t, { kind: 'bambu', model: 'X1C' }, action)
    assert.deepEqual(await f.dispatch(), {
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    assert.deepEqual(f.bambu?.requests, [])
  })
}

test('Bambu temperature above the ceiling is rejected without publishing', async (t) => {
  const f = await world(t, { kind: 'bambu', model: 'X1C' }, 'set_temperature', {
    heater: 'bed',
    target_c: 121,
  })
  assert.deepEqual(await f.dispatch(), {
    kind: 'rejected',
    reason: 'invalid-command',
  })
  assert.deepEqual(f.bambu?.requests, [])
})

test('a read-only Kobra X binding advertises no action and cannot be prepared', async () => {
  const binding = provisionReadonlyPrinter({
    assignment_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    printer_key: 'kobra-x',
    backend: 'kobralink',
    bridgeInstance: 'synthetic-bridge',
    origin: 'http://127.0.0.1:1',
    deviceId: 'synthetic-device',
    id: 'synthetic-id',
    revision: 1,
  })
  const driver = createPauseDriverRouter({
    allowedOrigins: [],
    limits: LIMITS,
    clock: { monotonicNow },
    observe: () => false,
  })
  assert.deepEqual(driver.controls(binding), [])
  assert.deepEqual(await driver.detect(binding), [])
  await assert.rejects(
    driver.prepare({ binding, signal: new AbortController().signal }),
    /unavailable/,
  )
})
