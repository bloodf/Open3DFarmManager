import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  API_ENVELOPE_ISSUER,
  decodeApiEnvelopeResultFrame,
  encodeApiEnvelopeFrame,
  newApiEnvelopeNonce,
  signApiEnvelope,
} from '../../packages/farm-protocol/src/api-envelope.ts'
import {
  claimCommand,
  closeCommandJournal,
  openCommandJournal,
  readCommandOutcome,
  type CommandJournalHandle,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  createPrinterBindingRegistry,
  type PrinterBinding,
} from '../../packages/connector/src/control/printer-binding.ts'
import { createOfflineAuthority } from '../../packages/connector/src/auth/offline-authority.ts'
import {
  createApiCommandRunner,
  receiveApiCommand,
  type ApiGrant,
  type ApiPrinterObservation,
} from '../../packages/connector/src/runtime/api-command.ts'

const FARM = '22222222-2222-4222-8222-222222222222'
const AGENT = '44444444-4444-4444-8444-444444444444'
const APP = '66666666-6666-4666-8666-666666666666'
const GRANT = '77777777-7777-4777-8777-777777777777'
const ASSIGNMENT = '88888888-8888-4888-8888-888888888888'
const ORIGIN = 'http://127.0.0.1:7125'

const withoutUndefined = (value: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined))

type Sent = { action: string; args: unknown }

async function fixture() {
  const issuer = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const directory = mkdtempSync(join(tmpdir(), 'open3dfarm-api-envelope-'))
  let wall = Date.now()
  let mono = 1000
  const clock = { wallNow: () => wall, monotonicNow: () => mono }
  const journal = openCommandJournal({ directory, clock: () => wall })
  const registry = createPrinterBindingRegistry({ allowedOrigins: [ORIGIN] })
  const binding = registry.provision({
    assignment_id: ASSIGNMENT,
    farm_id: FARM,
    agent_id: AGENT,
    printer_key: 'printer-1',
    moonraker_origin: ORIGIN,
  })
  const authority = createOfflineAuthority()
  authority.confirm({ wall, mono }, 1)
  const state = {
    grant: {
      grant_id: GRANT,
      app_id: APP,
      farm_id: FARM,
      scopes: ['control:basic', 'control:extended', 'jobs:start'],
      revoked: false,
    } as ApiGrant,
    observation: {
      ready: true,
      printState: 'printing',
    } as ApiPrinterObservation | null,
    controls: ['pause', 'resume', 'cancel', 'set_temperature', 'home'],
    driverResult: 'ack' as 'ack' | 'reject' | 'throw',
  }
  const sent: Sent[] = []
  const reports: ReturnType<typeof decodeApiEnvelopeResultFrame>[] = []
  let preparations = 0
  const runnerConfig = {
    farmId: FARM,
    agentId: AGENT,
    keys: {
      issuer: (name, kid) =>
        name === API_ENVELOPE_ISSUER && kid === 'api-1'
          ? issuer.publicKey
          : undefined,
    },
    grants: {
      lookup: (id) => (id === GRANT ? state.grant : undefined),
      freshness: authority.freshness,
    },
    journal,
    printer: (id) => (id === ASSIGNMENT ? binding : undefined),
    observe: (b: PrinterBinding) => (b === binding ? state.observation : null),
    driver: {
      async prepare() {
        preparations++
        return { connectionGeneration: 1 }
      },
      controls: () => state.controls as never,
      macros: () => [],
      async execute(action, args, input) {
        if (!input.beforeSend()) return { acknowledged: false }
        sent.push({ action, args })
        if (state.driverResult === 'throw') throw new Error('socket lost')
        return { acknowledged: state.driverResult === 'ack' }
      },
    },
    report(wire: string) {
      reports.push(decodeApiEnvelopeResultFrame(wire))
    },
    clock,
  } satisfies Parameters<typeof createApiCommandRunner>[0]
  const runner = createApiCommandRunner(runnerConfig)
  const envelope = async (
    action: Record<string, unknown> = { action: 'pause', args: {} },
    extra: Record<string, unknown> = {},
  ) =>
    encodeApiEnvelopeFrame({
      v: 1,
      t: 'api-envelope.command',
      envelope: await signApiEnvelope(
        withoutUndefined({
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
          action,
          ...extra,
        }),
        issuer.privateKey,
      ),
    })
  return {
    runner,
    runnerConfig,
    preparations: () => preparations,
    journal,
    authority,
    state,
    sent,
    reports,
    envelope,
    now: () => wall,
    advance(ms: number) {
      wall += ms
      mono += ms
    },
    cleanup() {
      closeCommandJournal(journal)
      for (const filename of readdirSync(directory))
        unlinkSync(join(directory, filename))
      rmdirSync(directory)
    },
  }
}

async function expectRefusal(
  f: Awaited<ReturnType<typeof fixture>>,
  wire: string,
  code: string,
) {
  const result = await f.runner.run(wire)
  assert.equal(result.kind, 'refused')
  assert.equal(result.kind === 'refused' && result.code, code)
  assert.equal(f.sent.length, 0, 'a refused command never reaches the driver')
  const last = f.reports.at(-1)
  assert.equal(last?.outcome, 'refused')
  assert.equal(last?.refusal_code, code)
}

test('a valid action runs once and reports completed', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const wire = await f.envelope()
  assert.deepEqual(await f.runner.run(wire), { kind: 'completed' })
  assert.deepEqual(f.sent, [{ action: 'pause', args: {} }])
  assert.equal(f.reports.at(-1)?.outcome, 'completed')
})

test('refusal printer-busy: another command holds the printer in the shared journal', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  // A browser command claimed in the same journal and still unresolved.
  const browser = claimCommand(f.journal, {
    command: {
      v: 2,
      purpose: 'printer-pause',
      cmd_id: randomUUID(),
      farm_id: FARM,
      agent_id: AGENT,
      account_id: 'text_account',
      transport_id: randomUUID(),
      capability_id: randomUUID(),
      key_id: randomUUID(),
      assignment_id: ASSIGNMENT,
      action: 'pause',
      args: {},
      issued_at: f.now(),
      expires_at: f.now() + 5000,
      nonce: randomBytes(16).toString('base64url'),
      sig: 'A'.repeat(86),
    } as never,
    printerKey: 'printer-1',
    wireSha256: randomBytes(32).toString('hex'),
  })
  assert.ok(browser.ok)
  await expectRefusal(f, await f.envelope(), 'printer-busy')
})

test('refusal printer-busy: motion while a print runs', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await expectRefusal(
    f,
    await f.envelope({ action: 'home', args: { axes: ['x'] } }),
    'printer-busy',
  )
})

test('refusal not-ready: printer offline or not ready', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.observation = { ready: false, printState: 'printing' }
  await expectRefusal(f, await f.envelope(), 'not-ready')
})

test('refusal wrong-state: resume while printing', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await expectRefusal(
    f,
    await f.envelope({ action: 'resume', args: {} }),
    'wrong-state',
  )
})

test('refusal grant-revoked: revoked grant', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.grant = { ...f.state.grant, revoked: true }
  await expectRefusal(f, await f.envelope(), 'grant-revoked')
})

test('refusal grant-revoked: grant not confirmed within the offline lifetime', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const wire = await f.envelope()
  f.advance(31_000)
  await expectRefusal(f, wire, 'grant-revoked')
})

test('an action outside the granted scope never reaches a driver', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.grant = { ...f.state.grant, scopes: ['control:basic'] }
  await expectRefusal(
    f,
    await f.envelope({
      action: 'set_temperature',
      args: { heater: 'bed', target_c: 60 },
    }),
    'grant-revoked',
  )
  assert.match(f.reports.at(-1)?.detail ?? '', /scope/)
})

test('refusal expired: envelope past its expiry', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const wire = await f.envelope(undefined, {
    expires_at: f.now() + 2000,
  })
  f.advance(3000)
  await expectRefusal(f, wire, 'expired')
})

test('refusal unsupported: action the printer driver does not offer', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  await expectRefusal(
    f,
    await f.envelope({ action: 'set_light', args: { on: true } }),
    'unsupported',
  )
})

test('refusal unsupported: jobs wait for file download support', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.observation = { ready: true, printState: 'idle' }
  await expectRefusal(
    f,
    await f.envelope(undefined, {
      kind: 'job',
      action: undefined,
      job: {
        file_url: 'https://files.example.invalid/benchy.gcode',
        sha256: 'a'.repeat(64),
        size_bytes: 1234,
        display_name: 'benchy.gcode',
      },
    }),
    'unsupported',
  )
})

test('replays (same cmd_id, or same kid and nonce) are dropped through the shared journal', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const wire = await f.envelope()
  assert.equal((await f.runner.run(wire)).kind, 'completed')
  assert.deepEqual(await f.runner.run(wire), {
    kind: 'dropped',
    reason: 'replay',
  })
  const nonce = JSON.parse(wire).envelope.nonce
  f.state.observation = { ready: true, printState: 'paused' }
  const reused = await f.envelope({ action: 'resume', args: {} }, { nonce })
  assert.deepEqual(await f.runner.run(reused), {
    kind: 'dropped',
    reason: 'replay',
  })
  assert.equal(f.sent.length, 1)
  assert.equal(f.reports.length, 1)
})

test('an acknowledged write without confirmed printer state is not retried', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const runner = createApiCommandRunner({
    ...f.runnerConfig,
    async confirmEffect() {
      return false
    },
  })
  const wire = await f.envelope()
  assert.deepEqual(await runner.run(wire), { kind: 'outcome-unknown' })
  assert.deepEqual(await runner.run(wire), {
    kind: 'dropped',
    reason: 'replay',
  })
  assert.equal(f.sent.length, 1)
  assert.equal(f.reports.length, 0)
})

test('an uncertain send is journaled outcome-unknown, unreported and never retried', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.driverResult = 'throw'
  const wire = await f.envelope()
  assert.deepEqual(await f.runner.run(wire), { kind: 'outcome-unknown' })
  const cmdId = JSON.parse(wire).envelope.cmd_id
  assert.equal(readCommandOutcome(f.journal, cmdId)?.status, 'outcome-unknown')
  assert.deepEqual(await f.runner.run(wire), {
    kind: 'dropped',
    reason: 'replay',
  })
  // The unresolved row keeps holding the printer for browser and API commands alike.
  f.state.driverResult = 'ack'
  await f.runner.run(await f.envelope())
  assert.equal(f.reports.at(-1)?.refusal_code, 'printer-busy')
  assert.equal(f.sent.length, 1)
})

test('forged, foreign or malformed envelopes are dropped without a report', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const wire = await f.envelope()
  const forged = wire.replace('"pause"', '"cancel"')
  assert.deepEqual(await f.runner.run(forged), {
    kind: 'dropped',
    reason: 'invalid',
  })
  assert.deepEqual(await f.runner.run('{}'), {
    kind: 'dropped',
    reason: 'invalid',
  })
  assert.deepEqual(
    await f.runner.run(await f.envelope(undefined, { farm_id: randomUUID() })),
    { kind: 'dropped', reason: 'invalid' },
  )
  assert.equal(f.reports.length, 0)
  assert.equal(f.sent.length, 0)
})

test('journal handle stays shared: API claims block browser claims on the same printer', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  f.state.driverResult = 'throw'
  await f.runner.run(await f.envelope())
  const browser = claimCommand(f.journal as CommandJournalHandle, {
    command: {
      v: 2,
      purpose: 'printer-pause',
      cmd_id: randomUUID(),
      farm_id: FARM,
      agent_id: AGENT,
      account_id: 'text_account',
      transport_id: randomUUID(),
      capability_id: randomUUID(),
      key_id: randomUUID(),
      assignment_id: randomUUID(),
      action: 'pause',
      args: {},
      issued_at: f.now(),
      expires_at: f.now() + 5000,
      nonce: randomBytes(16).toString('base64url'),
      sig: 'A'.repeat(86),
    } as never,
    printerKey: 'printer-1',
    wireSha256: randomBytes(32).toString('hex'),
  })
  assert.deepEqual(browser, { ok: false, reason: 'assignment-busy' })
})

test('the authenticated inbox claim binds scope and its own offline lifetime', async (t) => {
  const f = await fixture()
  t.after(f.cleanup)
  const inbox = new AbortController()
  const authority = createOfflineAuthority()
  const options = {
    signal: inbox.signal,
    report: f.runnerConfig.report,
    freshness: authority.freshness,
  }
  const confirmed_at = f.now()
  f.advance(30_000)
  // Renewal of credential authority does not refresh this claim.
  authority.confirm(
    { wall: f.now(), mono: f.runnerConfig.clock.monotonicNow() },
    2,
  )
  const frame = {
    v: 1,
    t: 'connector.api-command',
    wire: await f.envelope(),
    scope: 'control:basic',
    confirmed_at,
  } as const
  assert.equal(
    (await receiveApiCommand(f.runnerConfig, frame, options)).kind,
    'refused',
  )
  assert.equal(f.reports.at(-1)?.refusal_code, 'grant-revoked')
  assert.equal(
    (
      await receiveApiCommand(
        f.runnerConfig,
        {
          ...frame,
          confirmed_at: f.now(),
          scope: 'control:extended',
        },
        options,
      )
    ).kind,
    'refused',
  )
  assert.equal(f.reports.at(-1)?.refusal_code, 'grant-revoked')
  assert.equal(f.preparations(), 0)
  assert.equal(f.sent.length, 0)
  assert.equal(
    (
      await receiveApiCommand(
        f.runnerConfig,
        {
          ...frame,
          confirmed_at: f.now(),
        },
        options,
      )
    ).kind,
    'completed',
  )
  assert.equal(f.preparations(), 1)
  assert.equal(f.sent.length, 1)
})
