import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { build } from 'esbuild'
import {
  KOBRA_X_BRIDGE_CHOICE_LABEL,
  KOBRA_X_BRIDGE_REQUIRED_MESSAGE,
  KOBRA_X_NATIVE_UNAVAILABLE_REASON,
  gateKobraXSetup,
} from '../../apps/farm/app/utils/kobra-x-setup-mode.ts'
import { validateKobraXTargetInput } from '../../apps/farm/app/utils/kobralink-onboarding.ts'
import { ConfigurationTarget } from '../../packages/farm-protocol/src/configuration-target.ts'

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

test('new Kobra X setup requires the explicit KobraLink bridge choice', async () => {
  assert.deepEqual(gateKobraXSetup('kobralink-bridge'), {
    ok: true,
    mode: 'kobralink-bridge',
  })
  const unselected = gateKobraXSetup('unselected')
  assert.equal(unselected.ok, false)
  assert.equal(unselected.error, KOBRA_X_BRIDGE_REQUIRED_MESSAGE)

  const html = await harness.render('SetupForm', kobraX())
  assert.match(
    html,
    new RegExp(`for="kobra-mode-bridge">${KOBRA_X_BRIDGE_CHOICE_LABEL}<`),
  )
  assert.doesNotMatch(
    html.match(/<input[^>]*id="kobra-mode-bridge"[^>]*>/)[0],
    /checked/,
  )
  assert.match(submitTag(html), /disabled/)
  assert.match(submitTag(html), /aria-describedby="kobra-submit-help"/)
  assert.match(html, /id="kobra-submit-help"/)
  assert.ok(html.includes(KOBRA_X_BRIDGE_REQUIRED_MESSAGE))

  const chosen = await harness.render('SetupForm', kobraX('kobralink-bridge'))
  assert.match(
    chosen.match(/<input[^>]*id="kobra-mode-bridge"[^>]*>/)[0],
    /checked/,
  )
  assert.doesNotMatch(submitTag(chosen), /disabled/)
  assert.doesNotMatch(chosen, /id="kobra-submit-help"/)
})

test('bridge choice reuses the IPv4 and certificate import controls and does not claim a connection', async () => {
  const html = await harness.render('SetupForm', kobraX('kobralink-bridge'))
  for (const id of ['kobra-ip', 'kobra-cert-source', 'kobra-cert-file'])
    assert.ok(html.includes(`id="${id}"`), `${id} reused`)
  const text = html.replace(/<[^>]*>/g, '')
  assert.match(
    text,
    /Descobrir a impressora ou validar o certificado não comprova conexão/,
  )
  assert.doesNotMatch(text, /conectad[ao] com sucesso/i)
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids.filter((value) => /^kobra-(ip|mode)/.test(value)))
    if (!id.endsWith('-help')) assert.ok(html.includes(`for="${id}"`), id)
})

test('native Kobra X activation is unavailable and gives a pt-BR reason', async () => {
  const gate = gateKobraXSetup('native')
  assert.equal(gate.ok, false)
  assert.equal(gate.error, KOBRA_X_NATIVE_UNAVAILABLE_REASON)
  assert.match(gate.error, /indisponível/)

  for (const mode of [undefined, 'kobralink-bridge']) {
    const html = await harness.render('SetupForm', kobraX(mode))
    const native = html.match(/<input[^>]*id="kobra-mode-native"[^>]*>/)[0]
    assert.match(native, /disabled/)
    assert.doesNotMatch(native, /checked/)
    assert.match(native, /aria-describedby="kobra-mode-native-help"/)
    assert.ok(html.includes(KOBRA_X_NATIVE_UNAVAILABLE_REASON))
  }

  // No native backend can be constructed: the only Kobra X target is the bridge.
  const validated = validateKobraXTargetInput({ ipv4: '192.168.1.50' })
  assert.equal(validated.ok, true)
  assert.equal(validated.target.backend, 'kobralink-anycubic')
  assert.deepEqual(validated.target.bridge, { kind: 'connector-managed' })
  assert.equal(
    ConfigurationTarget.safeParse({ ...validated.target, backend: 'kobra-x' })
      .success,
    false,
  )
})

test('prepare guard blocks unselected setup before any validation or dispatch', () => {
  const page = read(join(app, 'app/pages/impressoras.vue'))
  const prepare = page.slice(page.indexOf('async function prepareKobraX()'))
  const body = prepare.slice(0, prepare.indexOf('\nasync function '))
  assert.ok(
    body.indexOf('gateKobraXSetup(kobraSetupMode.value)') <
      body.indexOf('validateKobraXTargetInput('),
  )
  assert.ok(body.indexOf('!gate.ok') < body.indexOf('configurationTargetHash('))
  assert.ok(page.split('\n').length < 600, 'page stays under 600 lines')
  const setupForm = read(join(dir, 'SetupForm.vue'))
  assert.match(setupForm, /kobraSetupMode\.value = 'unselected'/)
})

test('existing KobraLink assignments and pending bridge operations still load without a new choice', async () => {
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
  const target = validateKobraXTargetInput({ ipv4: '192.168.1.50' }).target
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
  // Restoring an operation neither pre-selects nor bypasses the choice for a new setup.
  assert.equal(reloaded.kobraSetupMode.value, 'unselected')
  assert.equal(gateKobraXSetup(reloaded.kobraSetupMode.value).ok, false)
})
