// #605: the browser (signed command v2 over the dispatcher) and API (signed
// envelope over the inbox runner) entry points must make the same state
// decision for every action in every printer state. Fakes only: no printer,
// simulator or network is ever commanded.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeCommandJournal,
  openCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  createPrinterBindingRegistry,
  readPrinterBinding,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  createApiCommandRunner,
  type ApiGrant,
} from '../../packages/connector/src/runtime/api-command.ts'
import {
  API_ENVELOPE_ACTIONS,
  API_ENVELOPE_ISSUER,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  encodeCommandV2,
  signCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import {
  controlPrinterBusy,
  ExtendedControlAction,
} from '../../packages/farm-protocol/src/control-actions.ts'
import { validateBrowserDevicePublicKey } from '../../packages/farm-protocol/src/browser-device-proof.ts'
import * as controls from '../../packages/farm-protocol/src/control-session-binding.ts'
import * as caps from '../../packages/farm-protocol/src/pause-capability.ts'

type Action = ExtendedControlAction
type State = 'idle' | 'printing' | 'paused' | 'cancelled' | 'error' | 'unknown'
const STATES: State[] = [
  'idle',
  'printing',
  'paused',
  'cancelled',
  'error',
  'unknown',
]
/**
 * Plain arguments for every action both entry points carry. The API path
 * takes only `API_ENVELOPE_ACTIONS`; `start_library_print` also needs a
 * library relay, so its state rule is covered by the shared predicate test.
 */
const ARGS: Partial<Record<Action, Record<string, unknown>>> = {
  pause: {},
  resume: {},
  cancel: {},
  emergency_stop: {},
  set_temperature: { heater: 'extruder', target_c: 200 },
  set_tool_temperature: { tool: 0, target_c: 200 },
  set_fan: { fan: 'part', percent: 50 },
  home: { axes: ['x', 'y'] },
  set_light: { on: true },
  set_speed: { level: 'standard' },
  run_macro: { name: 'PARK' },
  load_filament: {},
  unload_filament: {},
}
const CASES = API_ENVELOPE_ACTIONS.filter(
  (action) => action !== 'start_library_print',
).map((action) => {
  const args = ARGS[action]
  assert.ok(args, `parity arguments for ${action}`)
  return [action, args] as const
})
const IDLE_ONLY: Action[] = [
  'home',
  'load_filament',
  'unload_filament',
  'run_macro',
  'start_print',
  'start_library_print',
]
const TOOL_HEATERS = [{ tool: 0, maxC: 250 }] as const
const ORIGIN = 'http://127.0.0.1:7125'
let monotonic = 1000
const monotonicNow = () => (monotonic += 0.001)

type Decision = { sent: boolean; busy: boolean }

/** A fake driver that records a wire write only when the guard permits it. */
function fakeDriver(
  observe: (binding: PrinterBinding) => void,
  writes: string[],
) {
  const send = async (
    action: string,
    input: { beforeSend(): boolean },
  ): Promise<{ acknowledged: boolean }> => {
    if (!input.beforeSend()) return { acknowledged: false }
    writes.push(action)
    return { acknowledged: true }
  }
  return {
    async prepare({ binding }: { binding: PrinterBinding }) {
      observe(binding)
      return { connectionGeneration: 1 }
    },
    async closeAttempt() {},
    controls: () => [...ExtendedControlAction.options],
    macros: () => ['PARK'],
    execute: (
      action: Action,
      _args: Record<string, unknown>,
      input: { beforeSend(): boolean },
    ) => send(action, input),
    pauseOnce: (input: { action?: string; beforeSend(): boolean }) =>
      send(input.action ?? 'pause', input),
    waitForPaused: async () => null,
  }
}

async function browserDecision(
  action: Action,
  args: Record<string, unknown>,
  state: State,
): Promise<Decision> {
  const directory = mkdtempSync(join(tmpdir(), 'idle-gate-browser-'))
  const journal = openCommandJournal({ directory, clock: Date.now })
  const writes: string[] = []
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
  const { publicKey, thumbprint } = await validateBrowserDevicePublicKey({
    kty,
    crv,
    x,
    y,
  })
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
  const digest = () => randomBytes(32).toString('base64url')
  const binding = {
    v: 1 as const,
    purpose: 'pause-rtc' as const,
    transport_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'parity_account',
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
  const printerBinding = createPrinterBindingRegistry({
    allowedOrigins: [ORIGIN],
  }).provision({
    assignment_id: binding.assignment_id,
    farm_id: binding.farm_id,
    agent_id: binding.agent_id,
    printer_key: 'printer-1',
    moonraker_origin: ORIGIN,
  })
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const observe = (b: PrinterBinding) => {
    const mapping = readPrinterBinding(b)!
    const mono = monotonicNow()
    dispatcher!.observe(b, {
      assignmentId: mapping.assignment_id,
      printerKey: mapping.printer_key,
      connectionGeneration: 1,
      sequence: 1,
      ready: true,
      printState: state,
      toolHeaters: TOOL_HEATERS,
      readyObservedMono: mono,
      printStateObservedMono: mono,
      receivedMono: mono,
    })
  }
  dispatcher = createPauseDispatcher({
    authority: {
      issuers: [
        { issuer: 'farm:issuer', kid: 'issuer-1', publicKey: issuer.publicKey },
      ],
    },
    clock: { wallNow: () => Date.now(), monotonicNow },
    journal,
    driver: fakeDriver(observe, writes),
    resultTimeoutMs: 500,
  })
  try {
    const admission = dispatcher.beginAdmission({
      binding,
      printerBinding,
      peer: dispatcher.createPeer(1).peer,
    })
    const nonce = admission.challenge.admissionNonce
    const bindingHash = await controls.controlBindingHash(binding)
    const at = Date.now()
    const capability = await caps.signPauseCapability(
      {
        v: 1,
        purpose: 'pause-authority',
        capability_id: randomUUID(),
        kid: 'issuer-1',
        issuer: 'farm:issuer',
        audience: binding.audience,
        origin: binding.origin,
        issued_at: at,
        expires_at: binding.expires_at,
        account_id: binding.account_id,
        role: 'owner',
        farm_id: binding.farm_id,
        agent_id: binding.agent_id,
        key_id: binding.key_id,
        assignment_id: binding.assignment_id,
        transport_id: binding.transport_id,
        browser_public_key: publicKey,
        browser_thumbprint: thumbprint,
        connector_fingerprint: binding.connector_fingerprint,
        credential_jti: binding.credential_jti,
        printer_key: 'printer-1',
        control_binding_sha256: bindingHash,
        admission_nonce: nonce,
        actions: [action],
      } as never,
      issuer.privateKey,
    )
    const proof = await caps.signPauseAdmissionProof(
      {
        v: 1,
        purpose: 'pause-admission',
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
        admission_nonce: nonce,
        issued_at: at,
        expires_at: at + 8000,
      },
      pair.privateKey,
    )
    const proofFor = async (role: 'browser' | 'connector', key: CryptoKey) =>
      controls.encodeControlProof({
        v: 1,
        role,
        binding,
        signature: await controls.signControlSessionProof(binding, role, key),
      })
    const accepted = await dispatcher.admit(admission.token, {
      capabilityWire: caps.encodePauseCapability(capability),
      admissionProofWire: caps.encodePauseAdmissionProof(proof),
      browserProofWire: await proofFor('browser', pair.privateKey),
      connectorProofWire: await proofFor('connector', connector.privateKey),
    })
    assert.ok(accepted.ok, accepted.ok ? 'admitted' : accepted.reason)
    const commandAt = Date.now()
    const signed = await signCommandV2(
      {
        v: 2,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        cmd_id: randomUUID(),
        farm_id: binding.farm_id,
        agent_id: binding.agent_id,
        account_id: binding.account_id,
        key_id: binding.key_id,
        transport_id: binding.transport_id,
        capability_id: capability.capability_id,
        assignment_id: binding.assignment_id,
        action,
        args,
        issued_at: commandAt,
        expires_at: commandAt + 5000,
        nonce: randomBytes(16).toString('base64url'),
      } as never,
      pair.privateKey,
    )
    const result = await dispatcher.dispatch({
      wire: encodeCommandV2(signed),
      capability: accepted.handle,
      printerBinding,
    })
    return { sent: writes.length > 0, busy: result.reason === 'busy' }
  } finally {
    dispatcher.close()
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
}

async function apiDecision(
  action: Action,
  args: Record<string, unknown>,
  state: State,
): Promise<Decision> {
  const FARM = randomUUID()
  const AGENT = randomUUID()
  const APP = randomUUID()
  const GRANT = randomUUID()
  const ASSIGNMENT = randomUUID()
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'idle-gate-api-'))
  const wall = Date.now()
  const journal = openCommandJournal({ directory, clock: () => wall })
  const binding = createPrinterBindingRegistry({
    allowedOrigins: [ORIGIN],
  }).provision({
    assignment_id: ASSIGNMENT,
    farm_id: FARM,
    agent_id: AGENT,
    printer_key: 'printer-1',
    moonraker_origin: ORIGIN,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall, mono: 1000 }, 1)
  const grant: ApiGrant = {
    grant_id: GRANT,
    app_id: APP,
    farm_id: FARM,
    scopes: [
      'control:basic',
      'control:extended',
      'control:emergency',
      'jobs:start',
    ],
    revoked: false,
  } as ApiGrant
  const writes: string[] = []
  const reports: string[] = []
  const driver = fakeDriver(() => {}, writes)
  const runner = createApiCommandRunner({
    farmId: FARM,
    agentId: AGENT,
    keys: {
      issuer: (name, kid) =>
        name === API_ENVELOPE_ISSUER && kid === 'api-1'
          ? issuer.publicKey
          : undefined,
    },
    grants: {
      lookup: (id) => (id === GRANT ? grant : undefined),
      freshness: authority.freshness,
    },
    journal,
    printer: (id) => (id === ASSIGNMENT ? binding : undefined),
    observe: (b) =>
      b === binding
        ? { ready: true, printState: state, toolHeaters: TOOL_HEATERS }
        : null,
    driver: {
      prepare: driver.prepare,
      controls: driver.controls,
      macros: driver.macros,
      execute: driver.execute,
    },
    report: (wire) => reports.push(wire),
    clock: { wallNow: () => wall, monotonicNow: () => 1000 },
    confirmEffect: async () => true,
  })
  try {
    const wire = encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        {
          v: 1,
          purpose: 'api-envelope',
          issuer: API_ENVELOPE_ISSUER,
          kid: 'api-1',
          app_id: APP,
          grant_id: GRANT,
          farm_id: FARM,
          agent_id: AGENT,
          assignment_id: ASSIGNMENT,
          resource_id: randomUUID(),
          cmd_id: randomUUID(),
          nonce: newApiEnvelopeNonce(),
          issued_at: wall,
          expires_at: wall + 60_000,
          kind: 'action',
          action: { action, args },
        } as never,
        issuer.privateKey,
      ),
    })
    const result = await runner.run(wire)
    return {
      sent: writes.length > 0,
      busy: result.kind === 'refused' && result.code === 'printer-busy',
    }
  } finally {
    closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  }
}

test('the busy rule covers motion, filament, macros, job starts and tool heating', () => {
  for (const action of ExtendedControlAction.options)
    for (const state of STATES)
      assert.equal(
        controlPrinterBusy(action, state),
        (IDLE_ONLY.includes(action) || action === 'set_tool_temperature') &&
          (state === 'printing' || state === 'paused'),
        `${action} while ${state}`,
      )
})

for (const [action, args] of CASES)
  test(`browser and API paths enforce the local state rules for ${action}`, async () => {
    let sentSomewhere = false
    for (const state of STATES) {
      const browser = await browserDecision(action, args, state)
      const api = await apiDecision(action, args, state)
      sentSomewhere ||= browser.sent
      const label = `${action} while ${state}`
      if (action === 'emergency_stop') {
        assert.equal(browser.sent, true, `${label}: browser stop`)
        assert.equal(
          api.sent,
          !['unknown', 'error'].includes(state),
          `${label}: API readiness gate`,
        )
      } else {
        assert.equal(browser.sent, api.sent, `${label}: same send decision`)
      }
      if (action === 'set_tool_temperature')
        assert.equal(browser.sent, state === 'idle', `${label}: idle only`)
      if (
        IDLE_ONLY.includes(action) &&
        ['printing', 'paused'].includes(state)
      ) {
        assert.equal(browser.sent, false, `${label}: never written`)
        assert.equal(browser.busy, true, `${label}: browser says busy`)
        assert.equal(api.busy, true, `${label}: API says printer-busy`)
      }
    }
    assert.ok(sentSomewhere, `${action} is written in some state`)
  })
