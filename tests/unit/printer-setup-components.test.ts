import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const app = resolve('apps/farm')
const dir = join(app, 'app/components/printer-setup')
const names = readdirSync(dir)
  .filter((file) => file.endsWith('.vue'))
  .map((file) => file.slice(0, -4))
const sfc = createRequire(join(app, 'package.json'))('vue/compiler-sfc')

// Bundle the real components with a tiny Vue SFC plugin and render them on the server.
const vuePlugin: Plugin = {
  name: 'vue-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\.vue$/ }, ({ path }) => {
      const { descriptor, errors } = sfc.parse(readFileSync(path, 'utf8'), {
        filename: path,
      })
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

type State = Record<string, { value: any }>
type Renderer = (
  name: string,
  configure?: (state: State) => void,
) => Promise<string>
let render: Renderer
let scratch: string

beforeAll(async () => {
  const entry = `
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createPrinterSetupState, printerSetupKey } from '${join(app, 'app/utils/printer-setup-state.ts')}'
import { printerSetupActionsKey } from '${join(app, 'app/utils/printer-setup-actions.ts')}'
${names.map((name) => `import ${name} from '${join(dir, name)}.vue'`).join('\n')}
const components = { ${names.join(', ')} }
export async function render(name, configure, provideState = true) {
  const state = createPrinterSetupState()
  configure?.(state)
  const app = createSSRApp(components[name])
  app.component('NuxtLink', { props: ['to'], render() { return h('a', { href: this.to }, this.$slots.default?.()) } })
  const errors = []
  app.config.errorHandler = (error) => errors.push(error)
  if (provideState) {
    app.provide(printerSetupKey, state)
    app.provide(printerSetupActionsKey, new Proxy({}, { get: () => () => {} }))
  }
  const html = await renderToString(app)
  if (errors.length) throw errors[0]
  return html
}`
  const result = await build({
    stdin: { contents: entry, loader: 'ts', resolveDir: app },
    plugins: [vuePlugin],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    nodePaths: [join(app, 'node_modules')],
    logLevel: 'silent',
  })
  scratch = mkdtempSync(join(tmpdir(), 'printer-setup-'))
  const file = join(scratch, 'bundle.cjs')
  writeFileSync(file, result.outputFiles[0]!.text)
  render = createRequire(file)(file).render
}, 60_000)

afterAll(() => scratch && rmSync(scratch, { recursive: true, force: true }))

const ids = (html: string) =>
  [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
const family = (value: string) => (state: State) => {
  state.onboardingFamily!.value = value
}

describe('printer setup split', () => {
  it('keeps the printers page under 600 lines', () => {
    const page = readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8')
    expect(page.split('\n').length).toBeLessThan(600)
  })

  it('declares one component per vendor form and the discovery list', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'AnycubicFields',
        'BambuFields',
        'CrealityFields',
        'DiscoveryPanel',
        'KobraXFields',
        'MoonrakerFields',
        'SetupForm',
      ]),
    )
  })

  it('never reuses an element id across the page and its components', () => {
    const sources = [
      readFileSync('apps/farm/app/pages/impressoras.vue', 'utf8'),
      ...names.map((name) => readFileSync(join(dir, `${name}.vue`), 'utf8')),
    ]
    const all = sources.flatMap((source) =>
      [...source.matchAll(/(?<![:\w-])id="([^"]+)"/g)].map((match) => match[1]),
    )
    expect(new Set(all).size).toBe(all.length)
  })

  it('refuses to render without the provided setup state', async () => {
    await expect(
      (
        render as unknown as (
          n: string,
          c: undefined,
          p: boolean,
        ) => Promise<string>
      )('SetupForm', undefined, false),
    ).rejects.toThrow('Printer setup state was not provided')
  })
})

describe.each([
  [
    'klipper-moonraker',
    'Origem HTTP(S) do Moonraker',
    'Preparar Klipper / Moonraker',
  ],
  [
    'bambu-lan',
    'Endereço IPv4 da Bambu Lab na LAN',
    'Preparar Bambu Lab (LAN)',
  ],
  ['creality-native', 'Endereço IPv4 da Creality na LAN', 'Preparar Creality'],
  ['anycubic-lan', 'Endereço IPv4 na LAN', 'Preparar Anycubic (LAN)'],
  [
    'anycubic-kobra-x',
    'Endereço IPv4 da Kobra X na LAN',
    'Preparar Anycubic Kobra X',
  ],
])('setup form for %s', (value, label, submit) => {
  it('shows only that vendor, with labelled unique controls', async () => {
    const html = await render('SetupForm', family(value))
    expect(html).toContain(label)
    expect(html).toContain(submit)
    for (const [other, otherLabel] of [
      ['klipper-moonraker', 'Origem HTTP(S) do Moonraker'],
      ['bambu-lan', 'Endereço IPv4 da Bambu Lab na LAN'],
      ['creality-native', 'Endereço IPv4 da Creality na LAN'],
      ['anycubic-lan', 'Endereço IPv4 na LAN'],
    ] as const)
      if (other !== value) expect(html).not.toContain(otherLabel)
    const present = ids(html)
    expect(new Set(present).size).toBe(present.length)
    for (const id of present.filter((id) =>
      /^(moonraker|anycubic|creality|bambu|kobra-ip)/.test(id!),
    ))
      if (!id!.endsWith('-help')) expect(html).toContain(`for="${id}"`)
  })
})

describe('vendor secrets', () => {
  it('renders credential inputs as password fields and never prints them as text', async () => {
    const html = await render('SetupForm', (state) => {
      family('klipper-moonraker')(state)
      state.moonrakerApiKey!.value = 'secret-key'
      state.moonrakerPassword!.value = 'secret-password'
    })
    expect(html).toMatch(
      /id="moonraker-api-key"[^>]*type="password"|type="password"[^>]*id="moonraker-api-key"/,
    )
    expect(html).toMatch(
      /id="moonraker-password"[^>]*type="password"|type="password"[^>]*id="moonraker-password"/,
    )
    expect(html).toContain('Chave configurada.')
    const text = html.replace(/<[^>]*>/g, '')
    expect(text).not.toContain('secret-password')
    expect(text).not.toContain('secret-key')
  })
})

describe('discovery panel and assignments', () => {
  it('lists discovered printers and keeps probing disabled without a ready Connector', async () => {
    const html = await render('DiscoveryPanel', (state) => {
      state.discoveryPrinters!.value = [
        { vendor: 'bambu', host: '192.168.1.21', name: 'Bambu' },
      ]
      state.discoveryMessage!.value = '1 impressora encontrada'
    })
    expect(html).toContain('Selecionar Bambu')
    expect(html).toContain('1 impressora encontrada')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>\s*Procurar impressoras/)
  })

  it('offers revocation only to managers of active assignments', async () => {
    const printers = [
      {
        assignmentId: 'a1',
        agentId: 'agent',
        printerKey: 'moonraker-one',
        status: 'active',
        connectorStatus: 'approved',
      },
      {
        assignmentId: 'a2',
        agentId: 'agent',
        printerKey: 'old',
        status: 'revoked',
        connectorStatus: 'approved',
      },
    ]
    const manager = await render('AssignmentList', (state) => {
      state.farmId!.value = 'farm'
      state.canManage!.value = true
      state.printers!.value = printers
    })
    expect(manager).toContain('Revogar atribuição de moonraker-one')
    expect(manager).not.toContain('Revogar atribuição de old')
    expect(manager).toContain('Revogada permanentemente')
    const viewer = await render('AssignmentList', (state) => {
      state.farmId!.value = 'farm'
      state.printers!.value = printers
    })
    expect(viewer).not.toContain('Revogar atribuição')
    expect(viewer).toContain('Somente proprietários e administradores')
  })

  it('renders nothing for the register and revoke sections until they apply', async () => {
    expect(await render('RegisterAssignment')).not.toContain(
      'Cadastrar atribuição',
    )
    expect(await render('RevokeConfirmation')).not.toContain(
      'Confirmar revogação',
    )
  })
})
