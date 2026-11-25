import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import { withBrowser } from '../helpers/browser.ts'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'

const material = {
  slot: 'ams:0:0',
  materialType: 'PLA-TESTE',
  colorHex: 'AABBCCFF',
  remainingPercent: 42,
}
const observation = (mono: number) => ({
  historical: false,
  received: { wall: 1000, mono },
  sourceClockComparable: true,
  state: { state: 'printing', observedAt: 1000, materials: [material] },
})

it('hides stale non-historical printer materials', async () => {
  for (const [mono, visible] of [
    [1000, true],
    [-30000, false],
  ] as const) {
    const html = await renderFarmComponent('PrinterWallCard.vue', {
      name: 'Simulador',
      detailHref: '#',
      observation: observation(mono),
      now: { wall: 1000, mono: 1000 },
    })
    expect(html.includes('PLA-TESTE')).toBe(visible)
    expect(html.includes('/spool-art/')).toBe(visible)
  }
})

async function browserBundle() {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'ts',
      contents: `
import { createApp, h, reactive, ref } from 'vue'
import Index from './apps/farm/app/pages/bobinas/index.vue'
import Finder from './apps/farm/app/pages/bobinas/localizar.vue'
import Form from './apps/farm/app/components/spoolman/SpoolmanForm.vue'
const filament = { id: 1, name: 'PLA Azul', material: 'PLA', color_hex: '2463eb', weight: 1000, density: 1.24, diameter: 1.75, extra: {} }
const spool = { id: 12, filament, used_weight: 0, used_length: 0, archived: false, extra: {} }
const route = reactive({ query: {} })
globalThis.routeFixture = route
globalThis.calls = []
globalThis.useRoute = () => route
globalThis.useRouter = () => ({ replace() {} })
globalThis.$fetch = async (url, options) => {
  if (url === '/api/farms') return { farms: [{ farmId: 'fixture' }] }
  if (url.endsWith('/filaments')) return { items: [filament], total: 1 }
  if (url.endsWith('/vendors')) return { items: [], total: 0 }
  if (url.endsWith('/slots')) return { assignments: [] }
  globalThis.calls.push({ url, aborted: options?.signal?.aborted })
  return { items: [spool], total: 1, canWrite: true, canImport: true }
}
const id = ref('')
const App = { render() { return h('main', [h(Index), h(Finder), h(Form, { origin: '', serviceId: id.value, token: '', username: '', password: '', busy: false, connectorCount: 1, 'onUpdate:serviceId': value => id.value = value })]) } }
const app = createApp(App)
app.component('NuxtLink', { props: ['to'], render() { return h('a', { href: '#' }, this.$slots.default?.()) } })
app.mount('#app')`,
    },
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'vue',
        setup(builder) {
          builder.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw errors[0]
            return {
              contents: compileScript(descriptor, {
                id: path,
                inlineTemplate: true,
              }).content,
              loader: 'ts',
              resolveDir: dirname(path),
            }
          })
        },
      },
    ],
  })
  return bundle.outputFiles[0]!.text
}

it('renders inventory reels in both the list and finder', async () => {
  const js = await browserBundle()
  await withBrowser({}, async (browser) => {
    const page = await browser.newPage()
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: js })
    await page.getByText('PLA Azul', { exact: false }).first().waitFor()
    const reels = page.getByRole('img', { name: 'Nível restante desconhecido' })
    await reels.first().waitFor()
    expect(await reels.count()).toBe(2)
    for (const reel of await reels.all()) {
      expect(await reel.getAttribute('data-unknown')).toBe('true')
      expect(
        await reel.locator('img[src="/spool-art/n1-corpo.webp"]').count(),
      ).toBe(1)
      expect(
        await reel.locator('.farm-spool-art').getAttribute('style'),
      ).toContain('#2463eb')
    }
  })
})

it('fetches once when the route search changes', async () => {
  const js = await browserBundle()
  await withBrowser({}, async (browser) => {
    const page = await browser.newPage()
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: js })
    await page.getByText('PLA Azul', { exact: false }).first().waitFor()
    const count = await page.evaluate(() => (globalThis as any).calls.length)
    await page.evaluate(() => {
      ;(globalThis as any).routeFixture.query.q = 'azul'
    })
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).calls.length))
      .toBe(count + 1)
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => (globalThis as any).calls.length)).toBe(
      count + 1,
    )
  })
})

it('trims a pasted Spoolman UUID on blur before validation', async () => {
  const js = await browserBundle()
  await withBrowser({}, async (browser) => {
    const page = await browser.newPage()
    await page.setContent('<div id="app"></div>')
    await page.addScriptTag({ content: js })
    const field = page.locator('#spoolman-service-id')
    const uuid = '00000000-0000-4000-8000-000000000001'
    await field.fill('  ' + uuid + '  ')
    await field.blur()
    expect(await field.inputValue()).toBe(uuid)
    expect(await field.getAttribute('aria-invalid')).toBeNull()
    await field.fill('inválido')
    await field.blur()
    expect(await field.getAttribute('aria-invalid')).toBe('true')
  })
})

it('renders load slot choices from fresh material observations', async () => {
  const html = await renderFarmComponent('../FarmMacrosControls.vue', {
    row: {
      assignment: { printerKey: 'simulador' },
      connection: 'authenticated',
      observation: {
        ...observation(1000),
        state: { ...observation(1000).state, controls: ['load_filament'] },
      },
    },
    keys: { kind: 'unavailable' },
    controlEnabled: false,
    commandInFlight: false,
    now: { wall: 1000, mono: 1000 },
  })
  expect(html).toContain('Bandeja AMS')
  expect(html).toContain('PLA-TESTE')
  expect(html).toContain('value="0"')
})
