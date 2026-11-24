// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createKobraXRequests,
  type KobraXReport,
} from '../../packages/connector/src/kobra-x/requests.ts'
import { createKobraXFacts } from '../../packages/connector/src/kobra-x/facts.ts'

test('only an exact report envelope can settle a request', async () => {
  let requestId = ''
  let sends = 0
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      requestId = JSON.parse(payload).msgid
      sends++
    },
    resultTimeoutMs: 30,
  })
  const report = (overrides: Partial<KobraXReport> = {}): KobraXReport => ({
    type: 'light',
    action: 'control',
    msgid: requestId,
    state: 'done',
    code: 200,
    data: { status: 1 },
    ...overrides,
  })
  const pending = requests.send({
    type: 'light',
    action: 'control',
    beforeSend: () => true,
  })
  requests.handleAck({ msgid: requestId, code: 200 })
  requests.handleReport(report({ type: 'fan' }))
  requests.handleReport(report({ action: 'query' }))
  requests.handleReport(report({ msgid: 'another-client' }))
  requests.handleReport(report({ msgid: '' }))
  assert.deepEqual(await pending, { kind: 'received' })
  assert.equal(sends, 1)
  const matched = requests.send({
    type: 'light',
    action: 'control',
    beforeSend: () => true,
  })
  requests.handleReport(report())
  assert.equal((await matched).kind, 'confirmed')
  assert.equal(sends, 2)
})

test('failed reports cannot change control facts', () => {
  const facts = createKobraXFacts()
  const report: KobraXReport = {
    type: 'info',
    action: 'report',
    msgid: 'q',
    state: 'done',
    code: 200,
    data: { state: 'busy' },
  }
  facts.report(report)
  facts.report({ ...report, code: 500, data: { state: 'free' } })
  assert.equal(facts.get().infoState, 'busy')
  facts.report({ ...report, data: { state: 'free' } })
  assert.equal(facts.get().infoState, 'free')
})

test('simulator marks only the latest matching info response as current', async (t) => {
  const { connectKobraX } =
    await import('../../packages/connector/src/kobra-x/index.ts')
  const { startKobraXMock, installNetworkGuard, uninstallNetworkGuard } =
    await import('../../packages/sim-tools/src/mocks/index.ts')
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
  })
  t.after(() => mock.close())
  const observed: { report: KobraXReport; current: boolean }[] = []
  const adapter = await connectKobraX({
    address: '127.0.0.1',
    printerKey: 'correlation-test',
    clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
    pinSha256: mock.tls.serverFingerprintSha256!,
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    onReport: (report, _snapshot, _facts, current) =>
      observed.push({ report, current }),
  })
  t.after(() => adapter.close())
  async function until(predicate: () => boolean) {
    for (let i = 0; i < 100; i++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail('report did not arrive')
  }
  await until(() => observed.some(({ current }) => current))
  const before = observed.filter(({ current }) => current).length
  mock.control.publishTypedReport(
    'info',
    'report',
    { state: 'free' },
    { msgid: 'other-client', state: 'done', code: 500 },
  )
  mock.control.publishTypedReport(
    'info',
    'report',
    { state: 'free' },
    { msgid: 'other-client', state: 'done', code: 200 },
  )
  await until(
    () =>
      observed.filter(({ report }) => report.msgid === 'other-client')
        .length === 2,
  )
  assert.ok(
    observed
      .filter(({ report }) => report.msgid === 'other-client')
      .every(({ current }) => !current),
  )
  adapter.refreshControlState()
  await until(() => observed.filter(({ current }) => current).length > before)
  assert.equal(
    observed.filter(({ current }) => current).at(-1)?.report.code,
    200,
  )
})

import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  openCommandJournal,
  closeCommandJournal,
} from '../../packages/connector/src/control/command-journal.ts'
import { createPauseDispatcher } from '../../packages/connector/src/control/pause-dispatcher.ts'
import type { PrinterBinding } from '../../packages/connector/src/control/printer-binding.ts'
import {
  importKobraClientCertFromInput,
  writeKobraClientCertFile,
} from '../../packages/connector/src/config/kobra-x-cert.ts'
import { kobraXBindingsPath } from '../../packages/connector/src/config/kobra-x.ts'
import { readAgentRuntimeConfig } from '../../packages/connector/src/config/runtime.ts'
import {
  signCommandV2,
  encodeCommandV2,
} from '../../packages/farm-protocol/src/command-v2.ts'
import { createPauseDriverRouter } from '../../packages/connector/src/runtime/pause-driver-router.ts'
import { connectKobraX } from '../../packages/connector/src/kobra-x/index.ts'
import { startKobraXMock } from '../../packages/sim-tools/src/mocks/kobra-x-mock.ts'
import {
  installNetworkGuard,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/network-guard.ts'
import { openFixedKobraXControl } from '../../packages/connector/src/kobra-x/control-driver.ts'
import type { ControlObservation } from '../../packages/connector/src/control/pause-dispatcher.ts'
import type { ExtendedControlAction } from '../../packages/farm-protocol/src/control-actions.ts'

async function commandFixture() {
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
    purpose: 'printer-pause' as const,
    cmd_id: randomUUID(),
    farm_id: randomUUID(),
    agent_id: randomUUID(),
    account_id: 'legacy_account',
    key_id: randomUUID(),
    transport_id: randomUUID(),
    capability_id: randomUUID(),
    assignment_id: randomUUID(),
    action: 'pause' as const,
    args: {},
    issued_at: now,
    expires_at: now + 5000,
    nonce: randomBytes(16).toString('base64url'),
  }
  return { pair, publicKey, command }
}

async function authorityFixture(actions: ExtendedControlAction[] = ['pause']) {
  const { pair, publicKey, command } = await commandFixture()
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
    actions,
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

async function admitFixture(
  active: ReturnType<typeof createPauseDispatcher>,
  f: Awaited<ReturnType<typeof authorityFixture>>,
  printerBinding: PrinterBinding,
) {
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
  return accepted.handle
}

async function nativeSignedFixture(t: test.TestContext) {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const printer = await startKobraXMock({
    ssdp: false,
    camera: false,
    spoolHolder: true,
    preparationPhases: [],
    requireMqttAuth: true,
    requireExactClientCert: true,
  })
  t.after(() => printer.close())
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'native-kx-signed-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const f = await authorityFixture([
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'set_light',
    'start_print',
    'load_filament',
    'unload_filament',
  ])
  const scope = { agent_id: f.binding.agent_id, farm_id: f.binding.farm_id }
  const clientCertFile = join(dir, 'client-cert.json')
  const imported = await importKobraClientCertFromInput({
    kind: 'inline',
    format: 'pem',
    certificate_pem: printer.tls.clientCert.toString(),
    key_pem: printer.tls.clientKey.toString(),
  })
  assert.ok(imported.ok)
  writeKobraClientCertFile(clientCertFile, imported.cert)
  const pinSha256 = printer.tls.serverFingerprintSha256
  assert.ok(pinSha256)
  const configPath = join(dir, 'runtime.json')
  const writeJson = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  writeJson(configPath, {
    version: 1,
    collection: { version: 1, allowedOrigins: [], printers: [] },
    assignments: [],
    telemetry: {
      endpoint: 'https://farm.example/telemetry',
      audience: 'test-telemetry',
    },
    pause: {
      version: 1,
      issuers: [
        {
          issuer: f.capability.issuer,
          kid: f.capability.kid,
          publicKeySpki: Buffer.from(
            await crypto.subtle.exportKey('spki', f.issuer.publicKey),
          ).toString('base64url'),
        },
      ],
      control: { assignmentIds: [f.binding.assignment_id] },
      signalling: {
        endpoint: 'wss://farm.example/api/signalling/pause-connector',
        origin: 'https://farm.example',
        audience: f.binding.audience,
        credentialAudience: 'test-credential',
      },
    },
  })
  writeJson(kobraXBindingsPath(configPath), {
    version: 1,
    printers: [
      {
        printerKey: f.capability.printer_key,
        host: '127.0.0.1',
        modelId: printer.credentials.modeId,
        deviceId: printer.credentials.deviceId,
        clientCertFile,
        pinSha256,
      },
    ],
    assignments: [
      {
        ...scope,
        assignment_id: f.binding.assignment_id,
        printer_key: f.capability.printer_key,
      },
    ],
  })
  const config = readAgentRuntimeConfig(configPath, scope)
  const printerBinding = config.bindingFor(f.binding.assignment_id)
  assert.ok(printerBinding)
  assert.deepEqual(config.assignments, [
    {
      ...scope,
      assignment_id: f.binding.assignment_id,
      printer_key: f.capability.printer_key,
      backend: 'kobra-x',
    },
  ])
  assert.equal(config.kobraX?.length, 1)
  assert.deepEqual(config.pause?.control?.assignmentIds, [
    f.binding.assignment_id,
  ])
  const journal = openCommandJournal({
    directory: join(dir, 'journal'),
    clock: Date.now,
  })
  t.after(() => closeCommandJournal(journal))
  const clock = { wallNow: Date.now, monotonicNow: () => performance.now() }
  let dispatcher: ReturnType<typeof createPauseDispatcher>
  const driver = createPauseDriverRouter({
    clock,
    allowedOrigins: config.collection.allowedOrigins,
    limits: config.collection.limits,
    connectKobraX: (options) =>
      connectKobraX({
        ...options,
        httpPort: printer.httpPort,
        mqttPort: printer.mqttPort,
      }),
    observe: (binding, observation) => dispatcher.observe(binding, observation),
  })
  dispatcher = createPauseDispatcher({
    clock,
    journal,
    driver,
    authority: {
      issuers: [
        {
          issuer: f.capability.issuer,
          kid: f.capability.kid,
          publicKey: f.issuer.publicKey,
        },
      ],
    },
  })
  t.after(async () => {
    dispatcher.close()
    await driver.closeAttempt(printerBinding)
  })
  assert.deepEqual(await driver.detect(printerBinding), [
    'pause',
    'resume',
    'cancel',
    'set_temperature',
    'set_fan',
    'set_light',
    'start_print',
    'load_filament',
    'unload_filament',
  ])
  const capability = await admitFixture(dispatcher, f, printerBinding)
  async function signed(
    action: ExtendedControlAction,
    args: Record<string, unknown>,
  ) {
    const now = Date.now()
    return signCommandV2(
      {
        ...f.command,
        purpose: action === 'pause' ? 'printer-pause' : 'printer-control',
        action,
        args,
        cmd_id: randomUUID(),
        nonce: randomBytes(16).toString('base64url'),
        issued_at: now,
        expires_at: now + 5000,
      },
      f.pair.privateKey,
    )
  }
  const dispatch = async (
    action: ExtendedControlAction,
    args: Record<string, unknown> = {},
  ) =>
    dispatcher.dispatch({
      wire: encodeCommandV2(await signed(action, args)),
      capability,
      printerBinding,
    })
  const commands = () =>
    printer.calls.all
      .filter(({ topic }) =>
        /\/slicer\/printer\/[^/]+\/[^/]+\/[^/]+$/.test(topic),
      )
      .map(({ payload }) => JSON.parse(payload.toString()))
      .filter(
        ({ action }) => !['query', 'getInfo', 'listLocal'].includes(action),
      )
      .map(({ type, action, data }) => ({ type, action, data }))
  return {
    printer,
    dispatcher,
    capability,
    printerBinding,
    signed,
    dispatch,
    commands,
    journal,
  }
}

test(
  'signed light command stays uncertain if its effect changes before state confirmation',
  { timeout: 20000 },
  async (t) => {
    const { printer, dispatch, commands } = await nativeSignedFixture(t)
    printer.control.faults.addFault({
      fault: { type: 'refuse' },
      topic: /\/light\/report$/,
      method: 'REPORT',
      count: 1,
    })
    const pending = dispatch('set_light', { on: true })
    let command: { msgid: string } | undefined
    for (let i = 0; i < 500; i++) {
      const call = printer.calls.all.find(({ topic }) =>
        /\/slicer\/printer\/[^/]+\/[^/]+\/light$/.test(topic),
      )
      if (call) {
        command = JSON.parse(call.payload.toString())
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(command)
    printer.control.publishTypedReport(
      'light',
      'control',
      { status: 1 },
      { msgid: command.msgid },
    )
    printer.control.publishTypedReport(
      'light',
      'report',
      { status: 0 },
      { msgid: 'other' },
    )
    assert.equal((await pending).kind, 'outcome-unknown')
    assert.equal(commands().length, 1)
  },
)

test(
  'signed start remains uncertain for a same-file old or unrelated job report',
  { timeout: 20000 },
  async (t) => {
    const { printer, dispatch, commands } = await nativeSignedFixture(t)
    printer.control.seedFile('plate.gcode', '; synthetic\n')
    printer.control.faults.addFault({
      fault: { type: 'refuse' },
      topic: /\/print\/report$/,
      method: 'REPORT',
      count: 1,
    })
    const pending = dispatch('start_print', { file: 'plate.gcode' })
    let command: { msgid: string } | undefined
    for (let i = 0; i < 500; i++) {
      const call = printer.calls.all.find(
        ({ topic, payload }) =>
          /\/slicer\/printer\/[^/]+\/[^/]+\/print$/.test(topic) &&
          JSON.parse(payload.toString()).action === 'start',
      )
      if (call) {
        command = JSON.parse(call.payload.toString())
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(command)
    const oldJob = { filename: 'plate.gcode', taskid: '-1' }
    printer.control.publishTypedReport('print', 'start', oldJob, {
      msgid: command.msgid,
      state: 'printing',
    })
    printer.control.publishTypedReport(
      'print',
      'start',
      { ...oldJob, taskid: 'old-job' },
      { msgid: 'other-client', state: 'printing' },
    )
    assert.equal((await pending).kind, 'outcome-unknown')
    assert.equal(commands().length, 1)
  },
)

test(
  'a cached job phase cannot authorize readiness before the print reply',
  { timeout: 20000 },
  async (t) => {
    const { printer, printerBinding, commands } = await nativeSignedFixture(t)
    const events: string[] = []
    const published: ControlObservation[] = []
    const abort = new AbortController()
    t.after(() => abort.abort())
    const control = openFixedKobraXControl({
      binding: printerBinding,
      connectionGeneration: 1,
      clock: { monotonicNow: () => performance.now() },
      publish: (observation) => {
        if (!observation) return
        published.push(observation)
        events.push(
          `publish:${observation.printState}:${observation.ready ? 'ready' : 'unready'}`,
        )
      },
      signal: abort.signal,
      connect: (options) =>
        connectKobraX({
          ...options,
          httpPort: printer.httpPort,
          mqttPort: printer.mqttPort,
          onReport(report, snapshot, facts, current) {
            events.push(
              `report:${report.type}:${report.action}:${report.state}${current ? ':current' : ''}`,
            )
            options.onReport?.(report, snapshot, facts, current)
          },
        }),
    })
    t.after(() => control.close())
    await control.prepare()
    // An earlier job is printing on this connection: the cached phase is
    // `printing`.
    await printer.control.startPrint('old.gcode', {
      preparationPhases: [],
      taskid: 'old-job',
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    // The printer moves on to another job and its print reports are lost, so
    // only the old job's cached phase is left. The printer is busy with a project, so the info reply
    // arrives first and says so, while the print reply comes after it.
    printer.control.faults.addFault({
      fault: { type: 'refuse' },
      topic: /\/print\/report$/,
      method: 'REPORT',
      count: 1,
    })
    await printer.control.startPrint('new.gcode', {
      preparationPhases: [],
      taskid: 'new-job',
    })
    events.length = 0
    const result = await control.driver.execute?.(
      'set_light',
      { on: true },
      {
        binding: printerBinding,
        beforeSend: () => true,
        signal: abort.signal,
      },
    )
    assert.ok(result)
    const firstPublish = events.findIndex((event) =>
      /^publish:(printing|paused):ready$/.test(event),
    )
    const phaseReply = events.findIndex((event) =>
      /^report:print:query:printing/.test(event),
    )
    assert.notEqual(phaseReply, -1, events.join('\n'))
    assert.ok(
      firstPublish === -1 || phaseReply < firstPublish,
      `readiness published before the print reply:\n${events.join('\n')}`,
    )
    assert.equal(commands().filter(({ type }) => type === 'light').length, 1)
  },
)

test('a correlated print reply without a usable phase cannot make busy info current', async (t) => {
  const { connectKobraX } =
    await import('../../packages/connector/src/kobra-x/index.ts')
  const { startKobraXMock, installNetworkGuard, uninstallNetworkGuard } =
    await import('../../packages/sim-tools/src/mocks/index.ts')
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({
    ssdp: false,
    camera: false,
    reportIntervalMs: 0,
  })
  t.after(() => mock.close())
  const observed: { report: KobraXReport; current: boolean }[] = []
  const adapter = await connectKobraX({
    address: '127.0.0.1',
    printerKey: 'phase-test',
    clientIdentity: { cert: mock.tls.clientCert, key: mock.tls.clientKey },
    pinSha256: mock.tls.serverFingerprintSha256!,
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
    onReport: (report, _snapshot, _facts, current) =>
      observed.push({ report, current }),
  })
  t.after(() => adapter.close())
  async function until(predicate: () => boolean, what: string) {
    for (let i = 0; i < 150; i++) {
      if (predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.fail(what)
  }
  const printQueries = () =>
    mock.calls.all.filter(
      ({ topic, payload }) =>
        topic.endsWith('/print') &&
        JSON.parse(payload.toString()).action === 'query',
    )
  const busyInfo = ({ report }: { report: KobraXReport }) =>
    report.type === 'info' &&
    report.action === 'report' &&
    report.data.state === 'busy'

  await until(() => observed.some(({ current }) => current), 'initial state')
  // A job is running, so a busy info reply may only be trusted once the print
  // reply of the same refresh names the phase.
  await mock.control.startPrint('phase.gcode', {
    preparationPhases: [],
    taskid: 'phase-job',
  })
  await new Promise((resolve) => setTimeout(resolve, 100))

  // The real print reply is withheld; the printer instead answers the exact
  // print query with a success code, the job's file and task, and no phase.
  mock.control.faults.addFault({
    fault: { type: 'refuse' },
    topic: /\/print\/report$/,
    method: 'REPORT',
    count: 1,
  })
  const askedBefore = printQueries().length
  const seen = observed.length
  adapter.refreshControlState()
  await until(() => printQueries().length > askedBefore, 'print query')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const query = JSON.parse(printQueries().at(-1)!.payload.toString())
  mock.control.publishTypedReport(
    'print',
    'query',
    { filename: 'phase.gcode', taskid: 'phase-job' },
    { msgid: query.msgid, state: 'unrecognized-phase', code: 200 },
  )
  // The reply re-asks info; wait for its busy answer.
  await until(
    () => observed.slice(seen).filter(busyInfo).length >= 2,
    'busy info after the phase-less print reply',
  )
  assert.equal(
    observed.slice(seen).filter(({ current }) => current).length,
    0,
    'no reply of the phase-less refresh may be current',
  )

  // A later refresh whose print reply names the phase restores readiness.
  const restored = observed.length
  adapter.refreshControlState()
  await until(
    () =>
      observed
        .slice(restored)
        .some((entry) => busyInfo(entry) && entry.current),
    'busy info current after a valid phase',
  )
  const phase = observed
    .slice(restored)
    .findIndex(
      ({ report }) =>
        report.type === 'print' &&
        report.action === 'query' &&
        report.state === 'printing',
    )
  const current = observed
    .slice(restored)
    .findIndex((entry) => busyInfo(entry) && entry.current)
  assert.ok(phase !== -1 && phase < current)
})

function printerAssigned() {
  const sent: { msgid: string; type: string; action: string }[] = []
  const requests = createKobraXRequests({
    topic: (type) => type,
    publish(_topic, payload) {
      sent.push(JSON.parse(payload))
    },
    resultTimeoutMs: 40,
    reportIdentity: 'printer-assigned',
  })
  const report = (overrides: Partial<KobraXReport> = {}): KobraXReport => ({
    type: 'light',
    action: 'control',
    msgid: 'printer-chosen',
    state: 'done',
    code: 200,
    data: { status: 1 },
    ...overrides,
  })
  const light = (extra: { accept?: (r: KobraXReport) => boolean } = {}) =>
    requests.send({
      type: 'light',
      action: 'control',
      beforeSend: () => true,
      ...extra,
    })
  const ack = (msgid = sent.at(-1)!.msgid) =>
    requests.handleAck({ msgid, code: 0 })
  return { sent, requests, report, light, ack }
}

test('printer-assigned ids never settle an unacknowledged request', async () => {
  const { requests, report, light } = printerAssigned()
  const silent = light()
  requests.handleReport(report())
  assert.equal((await silent).kind, 'unanswered')
})

test('printer-assigned ids still need the same type, action and an id we did not issue', async () => {
  const { sent, requests, report, light, ack } = printerAssigned()
  const done = light()
  ack()
  requests.handleReport(report({ msgid: sent[0]!.msgid }))
  assert.equal((await done).kind, 'confirmed', 'its own id is an exact match')
  const next = light()
  ack()
  requests.handleReport(report({ type: 'fan' }))
  requests.handleReport(report({ action: 'query' }))
  // An id this connection issued belongs to an earlier request of ours.
  requests.handleReport(report({ msgid: sent[0]!.msgid }))
  assert.deepEqual(await next, { kind: 'received' })
})

test('printer-assigned ids do not settle with a rival request, acknowledged or not', async () => {
  const both = printerAssigned()
  const first = both.light()
  const second = both.light()
  for (const { msgid } of both.sent) both.ack(msgid)
  both.requests.handleReport(both.report())
  both.requests.handleReport(both.report({ msgid: '' }))
  assert.deepEqual(await first, { kind: 'received' })
  assert.deepEqual(await second, { kind: 'received' })

  // The rival's acknowledgement was lost; its report cannot settle the other.
  const lost = printerAssigned()
  const unacked = lost.light()
  const acked = lost.light()
  lost.ack(lost.sent[1]!.msgid)
  lost.requests.handleReport(lost.report({ msgid: '' }))
  assert.deepEqual(await acked, { kind: 'received' })
  assert.equal((await unacked).kind, 'unanswered')
})

test('printer-assigned ids do not let a late report of a finished request settle the next one', async () => {
  const late = printerAssigned()
  const earlier = late.light()
  late.ack()
  assert.deepEqual(await earlier, { kind: 'received' })
  const next = late.light()
  late.ack()
  late.requests.handleReport(late.report({ msgid: '' }))
  assert.deepEqual(await next, { kind: 'received' })
})

test('printer-assigned ids settle one acknowledged request, with an id or without', async () => {
  for (const msgid of ['printer-chosen', '']) {
    const { requests, report, light, ack } = printerAssigned()
    const alone = light()
    ack()
    requests.handleReport(report({ msgid }))
    assert.equal((await alone).kind, 'confirmed')
  }
  // A failure report with no payload still refuses; the accept filter holds.
  const refused = printerAssigned()
  const pending = refused.light()
  refused.ack()
  refused.requests.handleReport(refused.report({ code: 500, data: {} }))
  assert.equal((await pending).kind, 'refused')
  const filtered = printerAssigned()
  const rejected = filtered.light({ accept: (r) => r.data.status === 0 })
  filtered.ack()
  filtered.requests.handleReport(filtered.report())
  assert.deepEqual(await rejected, { kind: 'received' })
})
