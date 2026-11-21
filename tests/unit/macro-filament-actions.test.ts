import { DatabaseSync } from 'node:sqlite'
import { readCommandAction } from '../../packages/connector/src/control/command-journal.ts'
import assert from 'node:assert/strict'
import { describe, it, expect, vi, type TestContext } from 'vitest'
import {
  ControlArguments,
  ExtendedControlAction,
  controlRoleAllowed,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { PrinterState } from '../../packages/farm-protocol/src/state.ts'
import {
  PauseCapabilityV1,
  SignedPauseCapabilityV1,
} from '../../packages/farm-protocol/src/pause-capability.ts'
import { actionsForControlRole } from '../../apps/farm/server/utils/pause-authority/role-policy.ts'
import { advertisedMoonrakerMacros } from '../../packages/connector/src/control/macro-support.ts'
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
async function commandFixture(action: ExtendedControlAction) {
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
    args: action === 'run_macro' ? { name: 'PARK' } : {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(action: ExtendedControlAction) {
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
    role: 'owner' as const,
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
  action: ExtendedControlAction,
  supported = true,
  mode: Parameters<typeof pauseFixture>[0] = {},
  allowedActions: ExtendedControlAction[] = [...ExtendedControlAction.options],
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
  if (action === 'emergency_stop') await router.detect(printerBinding)
  const driver = {
    ...router,
    controls: () => [...ExtendedControlAction.options],
    macros: vi.fn(() => ['PARK']),
    execute: vi.fn(async () => ({ acknowledged: true })),
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

describe('macro and filament arguments', () => {
  it.each([
    ['run_macro', { name: 'PARK' }],
    ['run_macro', { name: 'A' + '_'.repeat(63) }],
    ['load_filament', {}],
    ['load_filament', { tray: 0 }],
    ['load_filament', { tray: 15 }],
    ['unload_filament', {}],
  ])('accepts %s with strict arguments', (action, args) => {
    expect(ControlArguments.safeParse({ action, args }).success).toBe(true)
    expect(
      ControlArguments.safeParse({ action, args: { ...args, extra: true } })
        .success,
    ).toBe(false)
  })
  it.each([
    ['run_macro', {}],
    ['run_macro', { name: '_PRIVATE' }],
    ['run_macro', { name: '9macro' }],
    ['run_macro', { name: 'A'.repeat(65) }],
    ['run_macro', { name: 'PARK\nM112' }],
    ['run_macro', { name: 'PARK X=1' }],
    ['load_filament', { tray: -1 }],
    ['load_filament', { tray: 16 }],
    ['load_filament', { tray: 1.5 }],
    ['load_filament', { tray: '1' }],
    ['unload_filament', { tray: 1 }],
  ])('rejects malformed %s arguments', (action, args) => {
    expect(ControlArguments.safeParse({ action, args }).success).toBe(false)
  })
})
it('authorizes macros only for owner/admin and filament for control roles', () => {
  for (const role of ['owner', 'admin', 'operator', 'viewer', 'unknown']) {
    const actions = actionsForControlRole(role, ExtendedControlAction.options)
    expect(actions.includes('run_macro')).toBe(
      ['owner', 'admin'].includes(role),
    )
    for (const action of ['load_filament', 'unload_filament'] as const) {
      expect(actions.includes(action)).toBe(
        ['owner', 'admin', 'operator'].includes(role),
      )
      expect(controlRoleAllowed(role, action)).toBe(actions.includes(action))
    }
  }
})
it('bounds optional snapshot macros and filters public Moonraker objects', () => {
  const printer = {
    printerKey: 'printer',
    state: 'idle',
    progress: 0,
    observedAt: 1,
  }
  expect(PrinterState.parse(printer)).not.toHaveProperty('macros')
  expect(PrinterState.parse({ ...printer, macros: ['PARK'] }).macros).toEqual([
    'PARK',
  ])
  expect(
    PrinterState.safeParse({ ...printer, macros: Array(51).fill('PARK') })
      .success,
  ).toBe(false)
  expect(
    PrinterState.safeParse({ ...printer, macros: ['PARK\nM112'] }).success,
  ).toBe(false)
  expect(advertisedMoonrakerMacros(undefined)).toBeUndefined()
  expect(
    advertisedMoonrakerMacros([
      'extruder',
      'gcode_macro Z',
      'gcode_macro A',
      'gcode_macro _PRIVATE',
      'gcode_macro LOAD_FILAMENT',
      'gcode_macro unload_filament',
      'gcode_macro A',
      'gcode_macro BAD X=1',
    ]),
  ).toEqual(['A', 'Z'])
  expect(
    advertisedMoonrakerMacros(
      Array.from({ length: 60 }, (_, i) => `gcode_macro MACRO_${i}`),
    ),
  ).toHaveLength(50)
})
it('rejects unadvertised macros before preparing or executing the driver', async (t) => {
  const f = await fixture(t, 'run_macro')
  const { sig, ...unsigned } = f.signed
  const signed = await signCommandV2(
    { ...unsigned, args: { name: 'UNADVERTISED' } },
    f.f.pair.privateKey,
  )
  expect(
    await f.dispatcher.dispatch({ ...f.input, wire: encodeCommandV2(signed) }),
  ).toEqual({ kind: 'rejected', reason: 'unsupported-action' })
  expect(f.driver.prepare).not.toHaveBeenCalled()
  expect(f.driver.execute).not.toHaveBeenCalled()
  expect(f.remote.requests).toEqual([])
})
for (const action of ['run_macro', 'load_filament', 'unload_filament'] as const)
  it(`dispatches advertised ${action} through signed authority`, async (t) => {
    const f = await fixture(t, action)
    await f.dispatcher.dispatch(f.input)
    expect(f.driver.execute).toHaveBeenCalledWith(
      action,
      action === 'run_macro' ? { name: 'PARK' } : {},
      expect.anything(),
    )
  })
it('rejects an operator capability claiming run_macro at unsigned and signed boundaries', async () => {
  const f = await authorityFixture('run_macro')
  expect(
    PauseCapabilityV1.safeParse({
      ...f.capability,
      actions: ['run_macro'],
      role: 'operator',
    }).success,
  ).toBe(false)
  expect(
    SignedPauseCapabilityV1.safeParse({
      ...f.capability,
      actions: ['run_macro'],
      role: 'operator',
      signature: 'A'.repeat(86),
    }).success,
  ).toBe(false)
  expect(
    PauseCapabilityV1.safeParse({
      ...f.capability,
      actions: [...ExtendedControlAction.options],
    }).success,
  ).toBe(true)
})

it('migrates a v3 journal without discarding recorded actions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'macro-journal-'))
  try {
    closeCommandJournal(openCommandJournal({ directory, clock: Date.now }))
    const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      db.exec(
        "DROP INDEX pause_active_assignment; DROP INDEX pause_active_printer; CREATE UNIQUE INDEX pause_active_assignment ON pause_commands(assignment_id) WHERE status IN ('claimed','write-started','outcome-unknown'); CREATE UNIQUE INDEX pause_active_printer ON pause_commands(farm_id,printer_key) WHERE status IN ('claimed','write-started','outcome-unknown'); DROP TABLE control_command_actions; CREATE TABLE control_command_actions (cmd_id TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('pause','resume','cancel','emergency_stop','firmware_restart','set_temperature','set_fan','home','set_light','set_speed','start_print'))) STRICT; INSERT INTO control_command_actions VALUES ('retained', 'firmware_restart'); PRAGMA user_version=3;",
      )
    } finally {
      db.close()
    }
    const journal = openCommandJournal({ directory, clock: Date.now })
    try {
      expect(readCommandAction(journal, 'retained')).toBe('firmware_restart')
    } finally {
      closeCommandJournal(journal)
    }
    const migrated = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
    try {
      for (const action of ['run_macro', 'load_filament', 'unload_filament'])
        migrated
          .prepare('INSERT INTO control_command_actions VALUES (?,?)')
          .run(action, action)
      expect(() =>
        migrated.exec(
          "INSERT INTO control_command_actions VALUES ('invalid', 'invalid')",
        ),
      ).toThrow()
    } finally {
      migrated.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
it('delivers extended signed capabilities through the browser issuer', async () => {
  const f = await authorityFixture('run_macro')
  const caps =
    await import('../../packages/farm-protocol/src/pause-capability.ts')
  const { createPauseCommandIssuer } =
    await import('../../apps/farm/app/utils/webrtc/pause-command-issuer.ts')
  const capability = await caps.signPauseCapability(
    { ...f.capability, actions: [...ExtendedControlAction.options] },
    f.issuer.privateKey,
  )
  expect(
    caps.decodePauseCapability(caps.encodePauseCapability(capability)),
  ).toEqual(capability)
  const issuer = createPauseCommandIssuer({
    currentOrigin: 'https://farm.example',
    fetch: async () =>
      new Response(JSON.stringify({ capability }), { status: 200 }),
  })
  const proof = await caps.signPauseAdmissionProof(
    f.challenge,
    f.pair.privateKey,
  )
  expect(
    await issuer.capability({
      admissionProofWire: caps.encodePauseAdmissionProof(proof),
      signal: new AbortController().signal,
    }),
  ).toEqual(capability)
})

it('rechecks macro advertisement before the driver write', async (t) => {
  const f = await fixture(t, 'run_macro')
  const prepare = f.driver.prepare.getMockImplementation()
  assert.ok(prepare)
  f.driver.prepare.mockImplementation(async (input) => {
    const prepared = await prepare(input)
    f.driver.macros.mockReturnValue([])
    return prepared
  })
  await f.dispatcher.dispatch(f.input)
  expect(f.driver.prepare).toHaveBeenCalledOnce()
  expect(f.driver.execute).not.toHaveBeenCalled()
})
it('rejects new actions with printer-pause purpose', async () => {
  for (const action of [
    'run_macro',
    'load_filament',
    'unload_filament',
  ] as const) {
    const f = await commandFixture(action)
    await expect(
      signCommandV2(
        { ...f.command, purpose: 'printer-pause' },
        f.pair.privateKey,
      ),
    ).rejects.toThrow()
  }
})
it('publishes only locally detected macros in snapshots', async () => {
  const { createFarmSnapshotSource } =
    await import('../../packages/connector/src/runtime/farm-snapshot-provider.ts')
  const f = await authorityFixture('run_macro')
  const refs = [
    {
      assignmentId: f.binding.assignment_id,
      agentId: f.binding.agent_id,
      printerKey: 'printer',
    },
  ]
  let macros: readonly string[] | undefined = ['PARK']
  const source = createFarmSnapshotSource({
    assignmentRefs: refs,
    nowMono: () => 100,
    macrosFor: () => macros,
  })
  const received: unknown[] = []
  const controller = new AbortController()
  const open = () =>
    source.open({
      binding: {
        ...f.binding,
        purpose: 'read-only-rtc',
        commands_enabled: false,
      },
      deadlineMonoMs: 1000,
      assignmentRefs: refs,
      signal: controller.signal,
      onComplete: (snapshot) => {
        received.push(snapshot)
      },
      onUnavailable: () => {},
    })
  try {
    source.observe({
      printerKey: 'printer',
      epoch: 1,
      printer: {
        printerKey: 'printer',
        state: 'printing',
        progress: 0,
        observedAt: 1,
        macros: ['UNTRUSTED'],
      },
      status: {
        webhooks: { state: 'ready' },
        print_stats: { state: 'printing' },
        virtual_sdcard: { progress: 0 },
      },
      fieldObservedAtMonoMs: { webhooks: 100, printState: 100, progress: 100 },
      receivedAtMonoMs: 100,
    })
    const session = open()
    expect(received.at(-1)).toMatchObject({ printers: [{ macros: ['PARK'] }] })
    macros = undefined
    session.close()
    open().close()
    expect(received.at(-1)).toMatchObject({
      printers: [{ printerKey: 'printer' }],
    })
    expect(received.at(-1)).not.toMatchObject({
      printers: [{ macros: expect.anything() }],
    })
  } finally {
    controller.abort()
    source.close()
  }
})
