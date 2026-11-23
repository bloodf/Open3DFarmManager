import assert from 'node:assert/strict'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import {
  DEFAULT_KOBRA_X_SETUP_MODE,
  KOBRA_X_BRIDGE_CHOICE_LABEL,
  KOBRA_X_MODE_INVALID_MESSAGE,
  KOBRA_X_NATIVE_CHOICE_LABEL,
  gateKobraXSetup,
} from '../../apps/farm/app/utils/kobra-x-setup-mode.ts'
import {
  describeKobraXNativeError,
  validateKobraXTargetInput,
} from '../../apps/farm/app/utils/kobralink-onboarding.ts'
import { sanitizeTargetForClientStorage } from '../../apps/farm/app/utils/kobra-client-cert-ui.ts'
import { discoveryPrefill } from '../../apps/farm/app/utils/printer-discovery-view.ts'
import { captureAnycubicPeerPin } from '../../packages/connector/src/anycubic/tls-trust.ts'
import {
  readKobraXOnboardedConfig,
  kobraXBindingsPath,
} from '../../packages/connector/src/config/kobra-x.ts'
import {
  assignmentKobraCertPath,
  readKobraClientCertMaterial,
  stagedKobraCertPath,
} from '../../packages/connector/src/config/kobra-x-cert.ts'
import { discoverPrinters } from '../../packages/connector/src/discovery/index.ts'
import { kobraXCtrlQuery } from '../../packages/connector/src/kobra-x/discovery.ts'
import { recoverKobraXCredentials } from '../../packages/connector/src/kobra-x/discovery.ts'
import {
  createProvisioningEngine,
  trustProvisioningAuthority,
} from '../../packages/connector/src/provisioning/index.ts'
import {
  kobraXTrustPath,
  probeKobraXLan,
} from '../../packages/connector/src/provisioning/kobra-x.ts'
import { createKobraXCollection } from '../../packages/connector/src/runtime/kobra-x-collection.ts'
import { connectorFingerprintFromSpki } from '../../packages/farm-protocol/src/configuration-binding.ts'
import { deriveConfigurationAssignmentIdentity } from '../../packages/farm-protocol/src/configuration-inventory.ts'
import { configurationReceiptHash } from '../../packages/farm-protocol/src/configuration-receipt.ts'
import {
  ConfigurationTarget,
  configurationTargetHash,
} from '../../packages/farm-protocol/src/configuration-target.ts'
import { base64url } from '../../packages/farm-protocol/src/encoding.ts'
import {
  generateWrongKobraXClientCert,
  installNetworkGuard,
  startKobraXMock,
  uninstallNetworkGuard,
} from '../../packages/sim-tools/src/mocks/index.ts'

const app = resolve('apps/farm')
const dir = join(app, 'app/components/printer-setup')
const utils = join(app, 'app/utils')
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')
const read = (path) => readFileSync(path, 'utf8')

// Bundles the real SFCs and state modules once; everything runs in-process.
const vuePlugin = {
  name: 'vue-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const { descriptor, errors } = sfc.parse(read(path), { filename: path })
      if (errors.length) throw errors[0]
      return {
        contents: sfc.compileScript(descriptor, {
          id: path,
          inlineTemplate: true,
        }).content,
        loader: 'ts',
        resolveDir: join(path, '..'),
      }
    })
  },
}

let scratch
let harness

before(async () => {
  const entry = `
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPrinterSetupState, printerSetupKey } from '${join(utils, 'printer-setup-state.ts')}'
import { printerSetupActionsKey } from '${join(utils, 'printer-setup-actions.ts')}'
import { createPendingOperationStore } from '${join(utils, 'printer-setup-session.ts')}'
import SetupForm from '${join(dir, 'SetupForm.vue')}'
import AssignmentList from '${join(dir, 'AssignmentList.vue')}'
const components = { SetupForm, AssignmentList }
export async function render(name, configure) {
  const state = createPrinterSetupState()
  configure?.(state)
  const vue = createSSRApp(components[name])
  vue.component('NuxtLink', { props: ['to'], render() { return h('a', { href: this.to }, this.$slots.default?.()) } })
  const errors = []
  vue.config.errorHandler = (error) => errors.push(error)
  vue.provide(printerSetupKey, state)
  vue.provide(printerSetupActionsKey, new Proxy({}, { get: () => () => {} }))
  const html = await renderToString(vue)
  if (errors.length) throw errors[0]
  return html
}
export { createPrinterSetupState, createPendingOperationStore }`
  const result = await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: app },
    plugins: [vuePlugin],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(app, '../../node_modules')],
    logLevel: 'silent',
  })
  scratch = mkdtempSync(join(tmpdir(), 'e16-369-'))
  const file = join(scratch, 'bundle.cjs')
  writeFileSync(file, result.outputFiles[0].text)
  harness = createRequire(file)(file)
})

after(() => {
  delete globalThis.window
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const kobraX = (mode) => (state) => {
  state.onboardingFamily.value = 'anycubic-kobra-x'
  state.kobraBootstrap.value = {
    kind: 'ready',
    data: { bootstrap: { revision: 1 } },
  }
  if (mode) state.kobraSetupMode.value = mode
}
const submitTag = (html) =>
  html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? ''
const inputTag = (html, id) =>
  html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))[0]

// --- Synthetic vectors from the owner's clean-room spec -------------------

test('spec vectors: signature and credential payload agree with the supplied synthetic values', async (t) => {
  assert.equal(
    kobraXCtrlQuery(
      'abcdefghijklmnopqrstuvwxyz012345',
      '1700000000000',
      'AbC123',
    ).toString(),
    'ts=1700000000000&nonce=AbC123&sign=aea435b5fbd0d0731ac51b4510e8c163&did=random',
  )
  const info =
    'MVKiXl3ql2/w4yj4fxCdaHwbtBLzgliMf3qIt1xiq2lolTgXVSm9OEh0ARykh/VrVUYJJBS4ppKEwweZlT3kdD57+5kos/UXv1gKXdzKMcUosUfyPmRJKctigF/mSO090xxCV+wccHrFoUY5o75h+WuLvOj2hwktsQQndzbtqOcwgu8dn+IWxJWThQi0bsDVJZ8WYVG3CLEC2HLZHs36Mw=='
  const serve = async (body) => {
    const server = createServer((_, res) =>
      res.writeHead(200).end(JSON.stringify(body)),
    )
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
    t.after(() => server.close())
    return server.address().port
  }
  const port = await serve({
    code: 200,
    data: { info, token: 'fedcba9876543210' },
  })
  const recovered = await recoverKobraXCredentials(
    { address: '127.0.0.1', token: 'abcdefghijklmnopqrstuvwxyz012345' },
    port,
  )
  assert.deepEqual(recovered, {
    username: 'user_demo',
    password: 'pass_demo',
    modeId: '20030',
    deviceId: '0123456789abcdef0123456789abcdef',
  })
  // Fail closed: wrong IV (bad padding or garbage) is a refusal, never a guess.
  const wrongIv = await serve({
    code: 200,
    data: { info, token: '0123456789abcdef' },
  })
  await assert.rejects(
    recoverKobraXCredentials(
      { address: '127.0.0.1', token: 'abcdefghijklmnopqrstuvwxyz012345' },
      wrongIv,
    ),
    /credential recovery failed/,
  )
})

// --- Configuration backend schema -----------------------------------------

test('native backend schema: explicit, strict, no bridge, no secrets beyond the transit certificate', async () => {
  const native = validateKobraXTargetInput({ ipv4: '192.168.1.50' })
  assert.equal(native.ok, true)
  assert.equal(native.target.backend, 'kobra-x')
  assert.equal('bridge' in native.target, false)
  assert.deepEqual(native.target.endpoint, {
    ipv4: '192.168.1.50',
    port: 18910,
  })

  const legacy = validateKobraXTargetInput({
    ipv4: '192.168.1.50',
    mode: 'kobralink-bridge',
  })
  assert.equal(legacy.target.backend, 'kobralink-anycubic')
  assert.deepEqual(legacy.target.bridge, { kind: 'connector-managed' })
  assert.notEqual(
    await configurationTargetHash(native.target),
    await configurationTargetHash(legacy.target),
  )

  for (const extra of [
    { bridge: { kind: 'connector-managed' } },
    { password: 'x' },
    { username: 'x' },
    { url: 'http://192.168.1.50:18910' },
    { token: 'a'.repeat(32) },
  ])
    assert.equal(
      ConfigurationTarget.safeParse({ ...native.target, ...extra }).success,
      false,
      JSON.stringify(Object.keys(extra)),
    )
  assert.equal(
    validateKobraXTargetInput({ ipv4: '8.8.8.8' }).ok,
    false,
    'public addresses are rejected before any dispatch',
  )
  const withCert = {
    ...native.target,
    client_certificate: {
      kind: 'inline',
      format: 'pem',
      certificate_pem: 'CERT',
      key_pem: 'PRIVATE-KEY-MATERIAL',
    },
  }
  assert.equal(ConfigurationTarget.safeParse(withCert).success, true)
  const stored = sanitizeTargetForClientStorage(withCert)
  assert.equal('client_certificate' in stored, false)
  assert.equal(JSON.stringify(stored).includes('PRIVATE-KEY'), false)
  assert.equal(
    discoveryPrefill({
      vendor: 'kobra-x',
      host: '192.168.1.50',
      port: 18910,
    }).family,
    'anycubic-kobra-x',
  )
})

// --- Web: native by default, bridge only by explicit choice ---------------

test('new Kobra X setup is native by default and prepares without any further choice', async () => {
  assert.equal(DEFAULT_KOBRA_X_SETUP_MODE, 'native')
  assert.deepEqual(gateKobraXSetup('native'), { ok: true, mode: 'native' })
  assert.deepEqual(gateKobraXSetup('kobralink-bridge'), {
    ok: true,
    mode: 'kobralink-bridge',
  })
  for (const bad of ['unselected', undefined, '', 'bridge'])
    assert.deepEqual(gateKobraXSetup(bad), {
      ok: false,
      error: KOBRA_X_MODE_INVALID_MESSAGE,
    })

  const html = await harness.render('SetupForm', kobraX())
  assert.match(inputTag(html, 'kobra-mode-native'), /checked/)
  assert.doesNotMatch(inputTag(html, 'kobra-mode-native'), /disabled/)
  assert.doesNotMatch(inputTag(html, 'kobra-mode-bridge'), /checked|disabled/)
  assert.match(
    html,
    new RegExp(
      `for="kobra-mode-native">${KOBRA_X_NATIVE_CHOICE_LABEL.replace(/[()]/g, '\\$&')}<`,
    ),
  )
  assert.match(
    html,
    new RegExp(
      `for="kobra-mode-bridge">${KOBRA_X_BRIDGE_CHOICE_LABEL.replace(/[()]/g, '\\$&')}<`,
    ),
  )
  assert.match(KOBRA_X_BRIDGE_CHOICE_LABEL, /legado/)
  assert.doesNotMatch(submitTag(html), /disabled/)
  assert.doesNotMatch(html, /kobra-submit-help/)
  const text = html.replace(/<[^>]*>/g, '')
  assert.match(text, /sem Docker e sem ponte/)
  assert.match(text, /não comprova conexão/)
  assert.doesNotMatch(text, /conectad[ao] com sucesso/i)
  for (const id of ['kobra-ip', 'kobra-cert-source', 'kobra-cert-file'])
    assert.ok(html.includes(`id="${id}"`), `${id} reused`)
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length)

  const bridge = await harness.render('SetupForm', kobraX('kobralink-bridge'))
  assert.match(inputTag(bridge, 'kobra-mode-bridge'), /checked/)
  assert.doesNotMatch(inputTag(bridge, 'kobra-mode-native'), /checked/)
  assert.doesNotMatch(submitTag(bridge), /disabled/)
})

test('prepare guard gates the mode before validation and hands it to the target builder', () => {
  const page = read(join(app, 'app/pages/impressoras.vue'))
  const prepare = page.slice(page.indexOf('async function prepareKobraX()'))
  const body = prepare.slice(0, prepare.indexOf('\nasync function '))
  assert.ok(
    body.indexOf('gateKobraXSetup(kobraSetupMode.value)') <
      body.indexOf('validateKobraXTargetInput('),
  )
  assert.match(body, /mode: gate\.ok \? gate\.mode : 'native'/)
  assert.ok(
    body.indexOf('!certOption.ok') < body.indexOf('configurationTargetHash('),
  )
  assert.ok(page.split('\n').length < 600, 'page stays under 600 lines')
  const state = read(join(utils, 'printer-setup-state.ts'))
  assert.match(state, /ref<KobraXSetupChoice>\(DEFAULT_KOBRA_X_SETUP_MODE\)/)
  assert.ok(harness.createPrinterSetupState().kobraSetupMode.value === 'native')
})

test('native operation wording names the printer, never a bridge', () => {
  for (const code of ['bridge-unavailable', 'not-available'])
    assert.doesNotMatch(describeKobraXNativeError(code), /ponte/i)
  assert.match(describeKobraXNativeError('bridge-unavailable'), /Modo LAN/)
  assert.equal(describeKobraXNativeError('revision-conflict'), null)
})

test('existing KobraLink assignments and pending bridge operations still load unchanged', async () => {
  const printerKey = `kobra-x-${'A'.repeat(42)}A`
  const html = await harness.render('AssignmentList', (state) => {
    state.farmId.value = 'farm'
    state.printers.value = [
      {
        assignmentId: 'a1',
        agentId: 'agent',
        printerKey,
        status: 'active',
        connectorStatus: 'approved',
      },
    ]
  })
  assert.ok(html.includes(printerKey))
  assert.ok(html.includes('Anycubic Kobra X'))
  assert.match(html, /somente\s+leitura/)

  const store = new Map()
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  }
  const target = validateKobraXTargetInput({
    ipv4: '192.168.1.50',
    mode: 'kobralink-bridge',
  }).target
  const operation = {
    accountId: 'account',
    operationId: '00000000-0000-4000-8000-000000000369',
    farmId: 'farm',
    agentId: 'agent',
    keyId: 'key',
    target,
    targetSha256: 'a'.repeat(64),
    expectedRevision: 3,
    displayLabel: 'Bancada',
    preparedReceipt: null,
    preparedReceiptSha256: null,
  }
  const saved = harness.createPrinterSetupState()
  harness
    .createPendingOperationStore(saved)
    .persistPendingOperation(operation, 'awaiting-reconcile')
  assert.equal(store.size, 1)
  const reloaded = harness.createPrinterSetupState()
  reloaded.kobraKeyState.value = {
    kind: 'available',
    accountId: 'account',
    choices: [],
  }
  harness
    .createPendingOperationStore(reloaded)
    .restorePersistedOperation('farm', 'agent', 'key')
  assert.equal(
    reloaded.kobraOperation.value.target.backend,
    'kobralink-anycubic',
  )
  assert.equal(reloaded.kobraOperation.value.expectedRevision, 3)
  assert.equal(reloaded.kobraStage.value, 'awaiting-reconcile')
  // A restored bridge operation is reconciled as a bridge operation.
  assert.equal(reloaded.isKobraXNativeOperation.value, false)
})

// --- Connector: provisioning, persistence and confirmation on the mock ----

const ids = {
  farm: '22222222-2222-4222-8222-222222222222',
  agent: '33333333-3333-4333-8333-333333333333',
  key: '44444444-4444-4444-8444-444444444444',
  jti: '55555555-5555-4555-8555-555555555555',
  transport: '11111111-1111-4111-8111-111111111111',
}
const PRINTER_IP = '10.0.0.5'
const PASSWORD = 'synthetic-kobra-x-password'

const inlineCert = (cert, key) => ({
  kind: 'inline',
  format: 'pem',
  certificate_pem: cert.toString('utf8'),
  key_pem: key.toString('utf8'),
})
const nativeTarget = (clientCertificate, extra = {}) => ({
  v: 1,
  protocol: 'config-v1',
  backend: 'kobra-x',
  model: { family: 'anycubic-kobra-x', provisional: true },
  endpoint: { ipv4: PRINTER_IP, port: 18910 },
  ...(clientCertificate ? { client_certificate: clientCertificate } : {}),
  ...extra,
})

function treeText(dir) {
  let text = ''
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    text += entry.isDirectory()
      ? treeText(path)
      : `\n#${entry.name}\n${readFileSync(path, 'utf8')}`
  }
  return text
}

async function engineWorld(t, { runtime, mock }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'e16-369-engine-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const stateDir = join(root, 'state')
  const runtimePath = join(root, 'runtime.json')
  const runtimeBody = JSON.stringify(
    runtime ?? {
      version: 1,
      collection: { version: 1, allowedOrigins: [], printers: [] },
      assignments: [],
      telemetry: { endpoint: 'https://farm.example/telemetry', audience: 't' },
    },
  )
  writeFileSync(runtimePath, runtimeBody, { mode: 0o600 })
  const keys = await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])
  const spki = base64url(
    new Uint8Array(await crypto.subtle.exportKey('spki', keys.publicKey)),
  )
  const fingerprint = await connectorFingerprintFromSpki(spki)
  const probes = []
  const engine = createProvisioningEngine({
    stateDirectory: stateDir,
    runtime: {
      runtimeConfigPath: runtimePath,
      agent_id: ids.agent,
      farm_id: ids.farm,
    },
    connector: { fingerprint, receiptKey: keys.privateKey },
    authority: trustProvisioningAuthority({
      async isCurrent() {
        return true
      },
      async acceptsInventoryAck() {
        return true
      },
    }),
    managedBridge: null,
    printerNetworks: ['10.0.0.0/24'],
    // The loopback mock stands in for the printer; nothing leaves the host.
    kobraXProbe: (input) => {
      probes.push(input.host)
      return probeKobraXLan({
        ...input,
        address: '127.0.0.1',
        httpPort: mock.httpPort,
        mqttPort: mock.mqttPort,
      })
    },
  })
  let nonce = 1
  const context = (action) => ({
    account_id: 'account_1',
    role: 'owner',
    farm_id: ids.farm,
    agent_id: ids.agent,
    key_id: ids.key,
    credential_jti: ids.jti,
    transport_id: ids.transport,
    connector_fingerprint: fingerprint,
    capability_id: randomUUID(),
    admission_nonce: base64url(new Uint8Array(32).fill(++nonce % 250)),
    action,
  })
  const prepare = (target, revision = 0, operationId = randomUUID()) =>
    engine
      .handle({
        frame: {
          v: 1,
          protocol: 'config-v1',
          type: 'prepare',
          request_id: randomUUID(),
          operation_id: operationId,
          expected_revision: revision,
          target,
        },
        context: context('prepare'),
      })
      .then((response) => ({ response, operationId }))
  return {
    root,
    stateDir,
    runtimePath,
    runtimeBody,
    engine,
    context,
    prepare,
    probes,
  }
}

test('native onboarding: certificate, real login on the mock, private persistence, inventory confirmation', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({ reportIntervalMs: 0 })
  t.after(() => mock.close())
  const server = new X509Certificate(mock.tls.serverCert)
  const expectedPin = createHash('sha256')
    .update(server.publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
  assert.equal(
    await captureAnycubicPeerPin(
      {
        host: '127.0.0.1',
        port: mock.mqttPort,
        cert: mock.tls.clientCert,
        key: mock.tls.clientKey,
      },
      AbortSignal.timeout(3000),
    ),
    expectedPin,
  )
  assert.equal(mock.calls().CONNECT ?? 0, 0)
  assert.equal(mock.calls.all.length, 0)
  const world = await engineWorld(t, { mock })
  const cert = inlineCert(mock.tls.clientCert, mock.tls.clientKey)

  // Unsupported behavior is refused before any certificate or network work.
  for (const target of [
    nativeTarget(cert, { endpoint: { ipv4: PRINTER_IP, port: 9883 } }),
    nativeTarget(cert, { endpoint: { ipv4: '10.9.9.9', port: 18910 } }),
  ]) {
    const refused = await world.prepare(target)
    assert.equal(refused.response.type, 'error')
    assert.equal(refused.response.code, 'invalid-request')
    assert.equal(
      existsSync(stagedKobraCertPath(world.stateDir, refused.operationId)),
      false,
    )
  }
  assert.deepEqual(world.probes, [])

  // A mismatching expected identity fails closed and leaves nothing behind.
  const wrongId = await world.prepare(
    nativeTarget(cert, { device_id: 'not-this-printer' }),
  )
  assert.equal(wrongId.response.code, 'identity-conflict')
  assert.equal(
    existsSync(stagedKobraCertPath(world.stateDir, wrongId.operationId)),
    false,
  )
  assert.equal(
    existsSync(kobraXTrustPath(world.stateDir, wrongId.operationId)),
    false,
  )

  const target = nativeTarget(cert)
  const { response: prepared, operationId } = await world.prepare(target)
  assert.equal(prepared.type, 'result')
  assert.equal(prepared.state, 'prepared')
  assert.deepEqual(world.probes.slice(-1), [PRINTER_IP])
  const staged = stagedKobraCertPath(world.stateDir, operationId)
  assert.equal(statSync(staged).mode & 0o777, 0o600)
  assert.equal(prepared.receipt.observed.support, 'unqualified')
  assert.match(prepared.receipt.observed.device_id, /^kx-/)

  // The journal and receipt never hold credentials, certificate or token.
  const secrets = [
    PASSWORD,
    'synthetic-kobra-x"',
    mock.credentials.token,
    mock.tls.clientKey.toString('utf8'),
    'client_certificate',
  ]
  const journal = readFileSync(
    join(world.stateDir, 'operations', `${operationId}.json`),
    'utf8',
  )
  for (const secret of secrets)
    assert.equal(journal.includes(secret), false, secret.slice(0, 12))
  assert.equal(JSON.stringify(prepared).includes(PASSWORD), false)

  const targetSha256 = await configurationTargetHash(target)
  const preparedHash = await configurationReceiptHash(prepared.receipt)
  const commitFrame = (id = operationId) => ({
    v: 1,
    protocol: 'config-v1',
    type: 'commit',
    request_id: randomUUID(),
    operation_id: id,
    expected_revision: 0,
    target_sha256: targetSha256,
    prepared_receipt_sha256: preparedHash,
  })
  // Nothing is persisted before the commit.
  assert.equal(existsSync(kobraXBindingsPath(world.runtimePath)), false)
  const committed = await world.engine.handle({
    frame: commitFrame(),
    context: world.context('commit'),
  })
  assert.equal(committed.type, 'result')
  assert.equal(committed.state, 'local-committed')

  const identity = await deriveConfigurationAssignmentIdentity({
    account_id: 'account_1',
    farm_id: ids.farm,
    agent_id: ids.agent,
    bridge_instance_id: committed.receipt.target.bridge_instance_id,
    device_id: committed.receipt.target.device_id,
  })
  assert.match(identity.printer_key, /^kobra-x-/)
  const certFile = assignmentKobraCertPath(
    world.stateDir,
    identity.assignment_id,
  )
  assert.equal(statSync(certFile).mode & 0o777, 0o600)
  assert.equal(readKobraClientCertMaterial(certFile).ok, true)
  assert.equal(existsSync(staged), false)
  assert.equal(existsSync(kobraXTrustPath(world.stateDir, operationId)), false)

  // The runtime file and every KobraLink row stay byte-identical.
  assert.equal(readFileSync(world.runtimePath, 'utf8'), world.runtimeBody)
  const bindings = readKobraXOnboardedConfig(world.runtimePath, {
    agent_id: ids.agent,
    farm_id: ids.farm,
  })
  assert.equal(bindings.printers.length, 1)
  const [binding] = bindings.printers
  assert.equal(binding.printerKey, identity.printer_key)
  assert.equal(binding.host, PRINTER_IP)
  assert.equal(binding.deviceId, mock.credentials.deviceId)
  assert.equal(binding.clientCertFile, certFile)
  assert.equal(binding.pinSha256, expectedPin)
  // Recovered credentials and the /info token are never written anywhere; the
  // private key lives only in the 0600 client-certificate files.
  const files = (secret) =>
    treeText(world.root)
      .split(/\n(?=#)/)
      .filter((chunk) => chunk.includes(secret))
      .map((chunk) => chunk.split('\n')[0])
  for (const secret of [PASSWORD, mock.credentials.token])
    assert.deepEqual(files(secret), [], secret.slice(0, 8))
  assert.deepEqual(
    files(mock.tls.clientKey.toString('utf8').split('\n')[1]).sort(),
    [
      '#kobra-x-client-cert.json',
      `#${identity.assignment_id}.kobra-cert.json`,
    ].sort(),
  )
  assert.equal(
    statSync(kobraXBindingsPath(world.runtimePath)).mode & 0o777,
    0o600,
  )

  const confirmed = await world.engine.confirmInventory({
    ack: {
      operation_id: operationId,
      local_committed_receipt_sha256: await configurationReceiptHash(
        committed.receipt,
      ),
      committed_revision: committed.receipt.committed_revision,
    },
    attestation: 'ack',
    context: world.context('commit'),
  })
  assert.equal(confirmed.ok, true)

  // The same printer is already claimed: no second assignment, no takeover.
  const again = await world.prepare(nativeTarget(cert), 1)
  assert.equal(again.response.type, 'error')
  assert.equal(again.response.code, 'identity-conflict')
  assert.deepEqual(
    readKobraXOnboardedConfig(world.runtimePath, {
      agent_id: ids.agent,
      farm_id: ids.farm,
    }),
    bindings,
  )

  // Collection reads only the confirmed binding and fails closed on drift.
  const endpoints = {
    address: '127.0.0.1',
    httpPort: mock.httpPort,
    mqttPort: mock.mqttPort,
  }
  const run = async (override, until) => {
    const controller = new AbortController()
    const seen = []
    const unavailable = []
    const collection = createKobraXCollection({
      binding: { ...binding, ...override },
      signal: controller.signal,
      endpoints,
      retryMinMs: 30,
      pollMs: 30,
      onObservation: (value) => seen.push(value),
      onUnavailable: (epoch) => unavailable.push(epoch),
    })
    for (let i = 0; i < 150 && !until(seen, unavailable); i++)
      await new Promise((r) => setTimeout(r, 20))
    controller.abort()
    await collection.done
    return { seen, unavailable }
  }
  const healthy = await run({}, (seen) =>
    seen.some((o) => o.printer.state === 'idle'),
  )
  const first = healthy.seen.find((o) => o.printer.state === 'idle')
  assert.ok(first, 'confirmed binding reports the mock printer')
  assert.equal(first.printer.printerKey, binding.printerKey)
  assert.ok('anycubic' in first.fieldObservedAtMonoMs)

  const pinned = await run(
    { pinSha256: 'f'.repeat(64) },
    (_, gone) => gone.length > 0,
  )
  assert.equal(
    pinned.seen.some((o) => o.printer.state === 'idle'),
    false,
  )
  assert.ok(
    pinned.unavailable.length > 0,
    'a changed server certificate is never trusted',
  )

  const foreign = await run({ deviceId: 'a'.repeat(32) }, (seen) =>
    seen.some((o) => o.printer.state === 'offline'),
  )
  assert.equal(
    foreign.seen.some((o) => o.printer.state === 'idle'),
    false,
  )
  assert.ok(foreign.seen.some((o) => o.printer.state === 'offline'))

  const missing = await run(
    { clientCertFile: join(world.root, 'gone.json') },
    (seen) =>
      seen.some((o) => o.printer.statusReason === 'client-certificate-missing'),
  )
  assert.equal(
    missing.seen.some((o) => o.printer.state === 'idle'),
    false,
  )
})

test('native onboarding fails closed: bad certificate, refused certificate, LAN mode off, unreachable printer', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({ reportIntervalMs: 0 })
  t.after(() => mock.close())
  const world = await engineWorld(t, { mock })
  const untrusted = generateWrongKobraXClientCert('AnycubicSlicer')
  t.after(() => untrusted.cleanup())
  const wrongSubject = generateWrongKobraXClientCert('NotTheSlicer')
  t.after(() => wrongSubject.cleanup())

  const expectFailure = async (target, code, label) => {
    const { response, operationId } = await world.prepare(target)
    assert.equal(response.type, 'error', label)
    assert.equal(response.code, code, label)
    assert.equal(
      existsSync(stagedKobraCertPath(world.stateDir, operationId)),
      false,
      label,
    )
    assert.equal(
      existsSync(kobraXTrustPath(world.stateDir, operationId)),
      false,
      label,
    )
    assert.equal(
      existsSync(kobraXBindingsPath(world.runtimePath)),
      false,
      label,
    )
  }
  await expectFailure(
    nativeTarget(inlineCert(wrongSubject.cert, wrongSubject.key)),
    'client-cert-wrong-subject',
    'certificate with another subject',
  )
  await expectFailure(
    nativeTarget({ kind: 'install-path', path: join(world.root, 'nope') }),
    'client-cert-missing',
    'missing certificate',
  )
  // Right subject but not the identity the printer trusts: the printer refuses.
  await expectFailure(
    nativeTarget(inlineCert(untrusted.cert, untrusted.key)),
    'client-cert-wrong-subject',
    'printer refuses the certificate',
  )
  // No certificate imported and none reusable: nothing to present, nothing sent.
  await expectFailure(
    nativeTarget(undefined),
    'client-cert-missing',
    'no certificate',
  )

  // LAN mode off: /info without a 32-character token.
  const off = await startKobraXMock({ reportIntervalMs: 0, token: 'short' })
  t.after(() => off.close())
  const lanOff = await engineWorld(t, { mock: off })
  const offResult = await lanOff.prepare(
    nativeTarget(inlineCert(off.tls.clientCert, off.tls.clientKey)),
  )
  assert.equal(offResult.response.type, 'error')
  assert.equal(offResult.response.code, 'not-available')
  assert.equal(existsSync(kobraXBindingsPath(lanOff.runtimePath)), false)

  // Unreachable: the port is closed.
  const closed = await startKobraXMock({ reportIntervalMs: 0 })
  const closedHttp = closed.httpPort
  const closedMqtt = closed.mqttPort
  await closed.close()
  const down = await engineWorld(t, {
    mock: { httpPort: closedHttp, mqttPort: closedMqtt },
  })
  const downResult = await down.prepare(
    nativeTarget(inlineCert(closed.tls.clientCert, closed.tls.clientKey)),
  )
  assert.equal(downResult.response.type, 'error')
  assert.equal(downResult.response.code, 'bridge-unavailable')
  assert.equal(existsSync(kobraXBindingsPath(down.runtimePath)), false)
})

test('a printer already assigned through the KobraLink bridge is never claimed twice', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({ reportIntervalMs: 0 })
  t.after(() => mock.close())
  const bridgeRuntime = {
    version: 2,
    collection: {
      version: 2,
      allowedOrigins: ['http://127.0.0.1:7100'],
      printers: [],
      kobralink: {
        allowedOrigins: ['http://127.0.0.1:7100'],
        printers: [
          {
            deviceId: mock.credentials.deviceId,
            id: 'p1',
            bridgeInstance: 'b1',
          },
        ],
      },
    },
    assignments: [],
  }
  const world = await engineWorld(t, { mock, runtime: bridgeRuntime })
  const { response } = await world.prepare(
    nativeTarget(inlineCert(mock.tls.clientCert, mock.tls.clientKey)),
  )
  assert.equal(response.type, 'error')
  assert.equal(response.code, 'identity-conflict')
  assert.equal(readFileSync(world.runtimePath, 'utf8'), world.runtimeBody)
  assert.equal(existsSync(kobraXBindingsPath(world.runtimePath)), false)
})

test('discovery finds the mock by SSDP and exposes only address, port and a clean name', async (t) => {
  installNetworkGuard()
  t.after(uninstallNetworkGuard)
  const mock = await startKobraXMock({ reportIntervalMs: 0 })
  t.after(() => mock.close())
  const found = await discoverPrinters({
    timeout: 150,
    bindAddress: '127.0.0.1',
    bambuPorts: [0],
    mdnsPort: 0,
    queryAddress: '127.0.0.1',
    queryPort: 9,
    kobraX: {
      target: '127.0.0.1',
      ssdpPort: mock.ssdpPort,
      httpPort: mock.httpPort,
    },
  })
  const kobra = found.filter((printer) => printer.vendor === 'kobra-x')
  assert.equal(kobra.length, 1)
  assert.equal(kobra[0].host, '127.0.0.1')
  assert.equal(kobra[0].port, 18910)
  assert.equal(JSON.stringify(found).includes(mock.credentials.token), false)
})
