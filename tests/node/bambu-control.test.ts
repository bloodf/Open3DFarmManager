import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startBambuSimulator } from '../../packages/sim-tools/src/bambu-simulator.ts'
import { provisionBambuPrinter } from '../../packages/connector/src/control/printer-binding.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import {
  openCommandJournal,
  closeCommandJournal,
  readCommandOutcome,
} from '../../packages/connector/src/control/command-journal.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { parseBambuBinding } from '../../packages/connector/src/bambu/configuration.ts'
import {
  openFixedBambuControl,
  BambuControlTimeout,
} from '../../packages/connector/src/bambu/control-driver.ts'
import { createBambuRuntimeSubscription } from '../../packages/connector/src/bambu/runtime.ts'
const SECRET = 'synthetic-access-do-not-log'
const monotonicNow = () => performance.now()
async function eventually(condition: () => boolean, what: string) {
  const deadline = performance.now() + 5000
  while (!condition()) {
    if (performance.now() > deadline)
      throw Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
function assertTelemetryBootstrap(
  remote: Awaited<ReturnType<typeof startBambuSimulator>>,
) {
  assert.deepEqual(remote.queries, [
    { command: 'pushall', sequence_id: '' },
    { command: 'get_version', sequence_id: '0' },
  ])
  assert.deepEqual(
    remote.calls.all.map(({ topic, payload }) => [
      topic,
      JSON.parse(payload.toString()),
    ]),
    [
      [
        'device/SYNTHETIC/request',
        { pushing: { command: 'pushall', version: 1, push_target: 1 } },
      ],
      [
        'device/SYNTHETIC/request',
        { info: { command: 'get_version', sequence_id: '0' } },
      ],
    ],
  )
}
async function commandFixture(action: 'pause' | 'resume' | 'cancel') {
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
    args: {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(action: 'pause' | 'resume' | 'cancel') {
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
  action: 'pause' | 'resume' | 'cancel',
  supported = true,
  confirmCommands = true,
  allowedActions: ('pause' | 'pause' | 'resume' | 'cancel')[] = [
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
  const directory = mkdtempSync(join(tmpdir(), 'bambu-control-cb10046d-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const journal = openCommandJournal({ directory, clock: Date.now })
  cleanup.push(() => closeCommandJournal(journal))
  const remote = await startBambuSimulator({
    initialState: action === 'resume' ? 'PAUSE' : 'RUNNING',
    confirmCommands,
  })
  writeFileSync(
    join(directory, 'credentials'),
    JSON.stringify({ accessCode: SECRET }),
    { mode: 0o600 },
  )
  writeFileSync(join(directory, 'ca'), remote.syntheticTrust)
  cleanup.push(async () => {
    await remote.close()
    t.diagnostic('Loopback simulator closed; task credential directory removed')
  })
  const printerBinding = provisionBambuPrinter(
    {
      assignment_id: f.binding.assignment_id,
      farm_id: f.binding.farm_id,
      agent_id: f.binding.agent_id,
      printer_key: f.capability.printer_key,
    },
    {
      printerKey: f.capability.printer_key,
      serial: 'SYNTHETIC',
      host: remote.host,
      port: remote.port,
      allowedEndpoints: [{ host: remote.host, port: remote.port }],
      credentialFile: join(directory, 'credentials'),
      caFile: join(directory, 'ca'),
      control: supported,
    },
  )
  let dispatcher: ReturnType<typeof createPauseDispatcher> | undefined
  const driver = createPauseDriverRouter({
    allowedOrigins: [],
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
    driver,
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

for (const action of ['pause', 'resume', 'cancel'] as const) {
  test(
    `signed opt-in ${action} changes loopback state once`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, action)
      assert.deepEqual(f.driver.controls(f.input.printerBinding), [
        'pause',
        'resume',
        'cancel',
      ])
      assert.deepEqual(await f.dispatcher.dispatch(f.input), {
        kind: 'applied',
        reason: 'applied',
        cmdId: f.signed.cmd_id,
      })
      assert.equal(
        readCommandOutcome(f.journal, f.signed.cmd_id)?.status,
        'applied',
      )
      assert.deepEqual(f.remote.requests, [
        { command: action === 'cancel' ? 'stop' : action, sequence_id: '1' },
      ])
      assert.equal(
        f.remote.gcodeState,
        action === 'pause' ? 'PAUSE' : action === 'resume' ? 'RUNNING' : 'IDLE',
      )
      assert.equal((await f.dispatcher.dispatch(f.input)).kind, 'rejected')
      assert.equal(f.remote.requests.length, 1)
    },
  )
  test(`opt-out ${action} rejects without publish`, async (t) => {
    const f = await fixture(t, action, false)
    assert.deepEqual(f.driver.controls(f.input.printerBinding), [])
    assert.deepEqual(await f.dispatcher.dispatch(f.input), {
      kind: 'rejected',
      reason: 'unsupported-action',
    })
    assert.deepEqual(f.remote.requests, [])
    await assert.rejects(
      f.driver.prepare({
        binding: f.input.printerBinding,
        signal: new AbortController().signal,
      }),
      /unavailable/,
    )
    assert.deepEqual(f.remote.requests, [])
  })
}

test('delivery without state report produces a typed timeout and never retries', async (t) => {
  const f = await fixture(t, 'pause', true, false)
  const owner = new AbortController()
  const fixed = openFixedBambuControl({
    binding: f.input.printerBinding,
    connectionGeneration: 1,
    clock: { monotonicNow },
    publish() {},
    signal: owner.signal,
    timeoutMs: 100,
  })
  t.after(() => fixed.close())
  await fixed.prepare()
  await assert.rejects(
    fixed.driver.pauseOnce({
      binding: f.input.printerBinding,
      beforeSend: () => true,
      signal: owner.signal,
    }),
    BambuControlTimeout,
  )
  assert.deepEqual(f.remote.requests, [{ command: 'pause', sequence_id: '1' }])
})

test('false guard and aborted attempts send no request; credentials stay private', async (t) => {
  const f = await fixture(t, 'pause')
  const fixed = openFixedBambuControl({
    binding: f.input.printerBinding,
    connectionGeneration: 1,
    clock: { monotonicNow },
    publish() {},
    signal: new AbortController().signal,
    timeoutMs: 500,
  })
  t.after(() => fixed.close())
  await fixed.prepare()
  await assert.rejects(
    fixed.driver.pauseOnce({
      binding: f.input.printerBinding,
      beforeSend: () => false,
      signal: new AbortController().signal,
    }),
    (error) => {
      assert.equal(String(error).includes(SECRET), false)
      return true
    },
  )
  assert.deepEqual(f.remote.requests, [])
})

for (const control of [undefined, false, true]) {
  test(
    `telemetry advertises controls only for explicit opt-in ${control}`,
    { timeout: 10000 },
    async (t) => {
      const remote = await startBambuSimulator({ initialState: 'RUNNING' })
      const directory = mkdtempSync(join(tmpdir(), 'bambu-control-telemetry-'))
      const owner = new AbortController()
      t.after(async () => {
        owner.abort()
        await remote.close()
        rmSync(directory, { recursive: true, force: true })
      })
      writeFileSync(
        join(directory, 'credentials'),
        JSON.stringify({ accessCode: SECRET }),
        { mode: 0o600 },
      )
      writeFileSync(join(directory, 'ca'), remote.syntheticTrust)
      const binding = parseBambuBinding({
        host: remote.host,
        port: remote.port,
        serial: 'SYNTHETIC',
        printerKey: 'synthetic',
        credentialFile: join(directory, 'credentials'),
        caFile: join(directory, 'ca'),
        allowedEndpoints: [{ host: remote.host, port: remote.port }],
        ...(control === undefined ? {} : { control }),
      })
      assert.equal(binding.control, control === true)
      const messages: unknown[][] = []
      t.mock.method(console, 'log', (...args: unknown[]) => {
        messages.push(args)
      })
      t.mock.method(console, 'error', (...args: unknown[]) => {
        messages.push(args)
      })
      let resolveSnapshot!: (printer: unknown) => void
      const snapshot = new Promise<unknown>((resolve) => {
        resolveSnapshot = resolve
      })
      const sub = createBambuRuntimeSubscription({
        binding,
        signal: owner.signal,
        onEvent(event) {
          if (event.kind === 'snapshot') resolveSnapshot(event.printer)
        },
      })
      try {
        const printer = await snapshot
        assert.equal(typeof printer, 'object')
        assert.deepEqual(
          Reflect.get(Object(printer), 'controls'),
          control ? ['pause', 'resume', 'cancel'] : [],
        )
        assert.equal(JSON.stringify(printer).includes(SECRET), false)
        assert.deepEqual(remote.requests, [])
        // The read-only startup queries can arrive before or after the first report.
        await eventually(
          () => remote.queries.some(({ command }) => command === 'get_version'),
          'the telemetry version query',
        )
        assertTelemetryBootstrap(remote)
        assert.deepEqual(remote.requests, [])
      } finally {
        sub.close()
        await sub.done
      }
      assert.deepEqual(remote.requests, [])
      assert.equal(JSON.stringify(messages).includes(SECRET), false)
      // Malformed private credential contents cannot escape through diagnostics.
      writeFileSync(
        join(directory, 'credentials'),
        JSON.stringify({ accessCode: SECRET, unexpected: SECRET }),
      )
      const failed = createBambuRuntimeSubscription({
        binding,
        signal: owner.signal,
        onEvent(event) {
          messages.push([event])
        },
      })
      await failed.done
      assert.equal(JSON.stringify(messages).includes(SECRET), false)
    },
  )
}

// Regression for the gate failure where the opt-in telemetry check saw an unexpected
// `get_version` in the printer's command log. It forces the ordering that used to lose the race:
// the version query reaches the printer before the first report is delivered.
test('telemetry version query is not logged as a printer command', async (t) => {
  const remote = await startBambuSimulator({})
  const directory = mkdtempSync(join(tmpdir(), 'bambu-control-version-'))
  const owner = new AbortController()
  t.after(async () => {
    owner.abort()
    await remote.close()
    rmSync(directory, { recursive: true, force: true })
  })
  writeFileSync(
    join(directory, 'credentials'),
    JSON.stringify({ accessCode: SECRET }),
    { mode: 0o600 },
  )
  writeFileSync(join(directory, 'ca'), remote.syntheticTrust)
  const binding = parseBambuBinding({
    host: remote.host,
    port: remote.port,
    serial: 'SYNTHETIC',
    printerKey: 'synthetic',
    credentialFile: join(directory, 'credentials'),
    caFile: join(directory, 'ca'),
    allowedEndpoints: [{ host: remote.host, port: remote.port }],
  })
  const snapshots: unknown[] = []
  const sub = createBambuRuntimeSubscription({
    binding,
    signal: owner.signal,
    onEvent(event) {
      if (event.kind === 'snapshot') snapshots.push(event.printer)
    },
  })
  try {
    // The simulator has no initial print state. The bootstrap response alone
    // cannot produce a snapshot before we publish a report with a state.
    await eventually(
      () =>
        remote.calls.all.some(
          ({ payload }) =>
            JSON.parse(payload.toString()).info?.command === 'get_version',
        ),
      'the telemetry version query at the broker',
    )
    assert.deepEqual(snapshots, [])
    remote.publishReport({ print: { gcode_state: 'RUNNING', mc_percent: 25 } })
    await eventually(() => snapshots.length > 0, 'the first snapshot')
    assert.deepEqual(Reflect.get(Object(snapshots[0]), 'controls'), [])
    assert.deepEqual(remote.requests, [])
    assertTelemetryBootstrap(remote)
  } finally {
    sub.close()
    await sub.done
  }
  assert.deepEqual(remote.requests, [])
})

test('abort before dispatch cannot publish', async (t) => {
  const f = await fixture(t, 'pause')
  const owner = new AbortController()
  owner.abort()
  assert.deepEqual(
    await f.dispatcher.dispatch({ ...f.input, signal: owner.signal }),
    { kind: 'rejected', reason: 'aborted' },
  )
  assert.deepEqual(f.remote.requests, [])
})
