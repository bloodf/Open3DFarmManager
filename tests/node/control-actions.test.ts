import test, { afterEach, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
  readCommandAction,
  claimCommand,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import { createPrinterBindingRegistry } from '../../packages/connector/src/control/printer-binding.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { pauseFixture } from '../../packages/connector/test/moonraker-pause-fixture.ts'
import { createHash } from 'node:crypto'

// Dispatch, driver and command deadlines run on clocks the tests control: wall
// time and timers move only when a test ticks them, and the shared monotonic
// clock advances 1 µs per read so ordering checks stay strict. A descheduled
// process therefore cannot turn a slow loopback round trip into a deadline.
let monotonic = 0
const monotonicNow = () => (monotonic += 0.001)
beforeEach(() => {
  monotonic = performance.now()
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
})
afterEach(() => mock.timers.reset())

// Synthetic issuer and provisioned mapping; no DB, browser, control RTC or simulator authority proof.
async function commandFixture(action: 'resume' | 'cancel') {
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
    args: {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(action: 'resume' | 'cancel') {
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
    actions: ['pause', 'resume', 'cancel'],
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
  t: test.TestContext,
  action: 'resume' | 'cancel',
  supported = true,
  mode: Parameters<typeof pauseFixture>[0] = {},
  allowedActions: ('pause' | 'resume' | 'cancel')[] = [
    'pause',
    'resume',
    'cancel',
  ],
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
    t.diagnostic(`Closed ${remote.origin}; removed ${directory}`)
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
  const driver = createPauseDriverRouter({
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

for (const action of ['resume', 'cancel'] as const) {
  test(`signed ${action} executes one fixed loopback RPC and journals the action`, async (t) => {
    const f = await fixture(t, action)
    assert.deepEqual(await f.dispatcher.dispatch(f.input), {
      kind: 'applied',
      reason: 'applied',
      cmdId: f.signed.cmd_id,
    })
    assert.equal(
      readCommandOutcome(f.journal, f.signed.cmd_id)?.status,
      'applied',
    )
    assert.equal(readCommandAction(f.journal, f.signed.cmd_id), action)
    assert.deepEqual(
      f.remote.requests
        .filter((r) => r.method.startsWith('printer.print.'))
        .map((r) => r.method),
      [`printer.print.${action}`],
    )
  })
  test(`${action} is rejected when unsupported`, async (t) => {
    const f = await fixture(t, action, false)
    assert.deepEqual(await f.dispatcher.dispatch(f.input), {
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    assert.equal(f.remote.requests.length, 0)
  })
  test(`${action} is rejected when expired`, async (t) => {
    const f = await fixture(t, action)
    // Signing accepts only unsigned fields.
    const { sig, ...unsigned } = f.signed
    const command = await signCommandV2(
      {
        ...unsigned,
        issued_at: Date.now() - 6000,
        expires_at: Date.now() - 1000,
      },
      f.f.pair.privateKey,
    )
    assert.deepEqual(
      await f.dispatcher.dispatch({
        ...f.input,
        wire: encodeCommandV2(command),
      }),
      { kind: 'rejected', reason: 'expired' },
    )
    assert.equal(f.remote.requests.length, 0)
  })
  test(`${action} rejects a forged browser signature`, async (t) => {
    const f = await fixture(t, action)
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )
    const { sig, ...unsigned } = f.signed
    const forged = await signCommandV2(unsigned, pair.privateKey)
    assert.deepEqual(
      await f.dispatcher.dispatch({
        ...f.input,
        wire: encodeCommandV2(forged),
      }),
      { kind: 'rejected', reason: 'signature' },
    )
    assert.equal(f.remote.requests.length, 0)
  })
}

test('resume cannot use a pause-only capability', async (t) => {
  const f = await fixture(t, 'resume', true, {}, ['pause'])
  assert.deepEqual(await f.dispatcher.dispatch(f.input), {
    kind: 'rejected',
    reason: 'scope',
  })
  assert.equal(f.remote.requests.length, 0)
})
test('cancel is allowed while paused', async (t) => {
  const f = await fixture(t, 'cancel', true, { initialState: 'paused' })
  assert.equal((await f.dispatcher.dispatch(f.input)).kind, 'applied')
})
test('cancel acknowledgement and unrelated idle state cannot prove cancellation', async (t) => {
  const f = await fixture(t, 'cancel', true, {
    query(index, socket, id) {
      if (index === 1) return false
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: {
            eventtime: index,
            status: {
              webhooks: { state: 'ready' },
              print_stats: { state: 'complete' },
            },
          },
        }),
      )
      return true
    },
  })
  assert.equal((await f.dispatcher.dispatch(f.input)).kind, 'outcome-unknown')
  assert.equal(readCommandAction(f.journal, f.signed.cmd_id), 'cancel')
})

test('legacy journal migration preserves retained pause commands and replay guards', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'control-actions-migration-'))
  let journal: ReturnType<typeof openCommandJournal> | undefined
  t.after(() => {
    if (journal) closeCommandJournal(journal)
    rmSync(directory, { recursive: true, force: true })
  })
  journal = openCommandJournal({ directory, clock: Date.now })
  const f = await commandFixture('resume')
  const { action, purpose, ...base } = f.command
  const command = await signCommandV2(
    { ...base, action: 'pause', purpose: 'printer-pause' },
    f.pair.privateKey,
  )
  const input = {
    command,
    printerKey: 'legacy',
    wireSha256: createHash('sha256')
      .update(encodeCommandV2(command))
      .digest('hex'),
  }
  assert.equal(claimCommand(journal, input).ok, true)
  closeCommandJournal(journal)
  journal = undefined
  const db = new DatabaseSync(join(directory, 'pause-commands.sqlite'))
  try {
    db.exec('DROP TABLE control_command_actions; PRAGMA user_version=1')
  } finally {
    db.close()
  }
  journal = openCommandJournal({ directory, clock: Date.now })
  assert.equal(readCommandAction(journal, command.cmd_id), 'pause')
  assert.deepEqual(claimCommand(journal, input), {
    ok: false,
    reason: 'replay',
  })
  assert.ok(readCommandOutcome(journal, command.cmd_id))
})
