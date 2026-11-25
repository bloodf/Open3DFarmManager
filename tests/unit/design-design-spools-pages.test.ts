import { readFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { build } from 'esbuild'
import { compileScript, compileStyle, parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import AxeBuilder from '@axe-core/playwright'
import { launchBrowser } from '../helpers/browser'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'

it('renders spool screens without overflow and accessibility violations', async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import { createApp, h } from 'vue'
      import Index from './apps/farm/app/pages/bobinas/index.vue'
      import Stock from './apps/farm/app/pages/bobinas/estoque.vue'
      import Finder from './apps/farm/app/pages/bobinas/localizar.vue'
      import './apps/farm/app/assets/css/main.css'
      const filament = { id: 1, name: 'Azul Royal', material: 'PLA', color_hex: '1F4FE0', density: 1.24, diameter: 1.75, weight: 1000, extra: {} }
      const spool = { id: 12, filament, remaining_weight: 120, used_weight: 880, used_length: 0, location: 'Prateleira A1', archived: false, extra: {} }
      globalThis.useRoute = () => ({ query: {} })
      globalThis.useRouter = () => ({ replace() {} })
      globalThis.$fetch = async (url) => {
        if (url === '/api/farms') return { farms: [{ farmId: 'fixture' }] }
        if (url.endsWith('/low-stock')) return { defaultLowStockThresholdGrams: 200, filaments: [{ filamentId: 1, name: 'Azul Royal', material: 'PLA', remainingGrams: 120, thresholdGrams: null, effectiveThresholdGrams: 200, low: true }] }
        if (url.endsWith('/filaments')) return { items: [filament], total: 1, canWrite: true }
        if (url.endsWith('/vendors')) return { items: [], total: 0 }
        if (url.endsWith('/slots')) return { assignments: [] }
        return { items: [spool], total: 1, canWrite: true, canImport: true }
      }
      const app = createApp(location.pathname === '/estoque' ? Stock : location.pathname === '/localizar' ? Finder : Index)
      app.component('NuxtLink', { props: ['to'], render() { return h('a', { href: typeof this.to === 'string' ? this.to : this.to.path }, this.$slots.default?.()) } })
      app.mount('#app')
    `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    outfile: 'spools.js',
    plugins: [
      {
        name: 'vue',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw new Error(errors.join('\n'))
            const id = `data-v-${basename(path, '.vue')}`
            const code = compileScript(descriptor, {
              id,
              inlineTemplate: true,
              genDefaultAs: 'component',
            }).content
            const css = descriptor.styles
              .map(
                ({ content, scoped }) =>
                  compileStyle({
                    filename: path,
                    id,
                    source: content,
                    scoped: Boolean(scoped),
                  }).code,
              )
              .join('\n')
            return {
              loader: 'ts',
              resolveDir: dirname(path),
              contents: `${code}\ncomponent.__scopeId = ${JSON.stringify(id)}; const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.append(style); export default component`,
            }
          })
        },
      },
    ],
  })
  // Vite-only APIs (for example import.meta.glob) compile to empty values in
  // this esbuild bundle and blank the page; fail on the warning, not a timeout.
  expect(bundle.warnings.map((warning) => warning.text)).toEqual([])
  const js = bundle.outputFiles.find((f) => f.path.endsWith('.js'))!
  const css = bundle.outputFiles.find((f) => f.path.endsWith('.css'))!
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/spools.js': (_, res) => {
        res.setHeader('content-type', 'text/javascript')
        res.end(js.text)
      },
      '/spools.css': (_, res) => {
        res.setHeader('content-type', 'text/css')
        res.end(css.text)
      },
      ...Object.fromEntries(
        ['/index', '/estoque', '/localizar'].map((path) => [
          path,
          (_: unknown, res: import('node:http').ServerResponse) => {
            res.setHeader('content-type', 'text/html')
            res.end(
              '<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Bobinas</title><link rel="stylesheet" href="/spools.css"><div id="app"></div><script src="/spools.js"></script></html>',
            )
          },
        ]),
      ),
    },
  })
  const browser = await launchBrowser({
    args: ['--disable-background-networking'],
  })
  try {
    for (const screen of ['index', 'estoque', 'localizar'])
      for (const [size, width, height] of [
        ['desktop', 1440, 900],
        ['mobile', 390, 844],
      ] as const)
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height },
            locale: 'pt-BR',
            reducedMotion: 'reduce',
            colorScheme: theme as 'light' | 'dark',
          })
          try {
            const page = await context.newPage()
            const pageErrors: string[] = []
            page.on('pageerror', (error) => pageErrors.push(error.message))
            await page.addInitScript((theme) => {
              // Init scripts run before <html> exists; apply once it does.
              const apply = () =>
                document.documentElement?.setAttribute('data-theme', theme)
              if (document.documentElement) return apply()
              new MutationObserver((_, observer) => {
                if (!document.documentElement) return
                apply()
                observer.disconnect()
              }).observe(document, { childList: true })
            }, theme)
            await page.goto(`${server.origin}/${screen}`)
            await page
              .getByText(
                screen === 'estoque' ? 'Azul Royal · PLA' : 'Azul Royal',
                { exact: false },
              )
              .first()
              .waitFor()
              .catch((error: Error) => {
                throw new Error(
                  `${screen} ${size} ${theme}: ${error.message}\npage errors: ${pageErrors.join(' | ') || 'none'}`,
                )
              })
            expect(pageErrors).toEqual([])
            expect(
              await page.evaluate(() =>
                document.documentElement.getAttribute('data-theme'),
              ),
            ).toBe(theme)
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth),
            ).toBe(width)
            expect(
              (await new AxeBuilder({ page }).analyze()).violations,
            ).toEqual([])
            if (process.env.DESIGN_SCREENSHOTS === '1') {
              await mkdir('docs/fullfarmmanager/design', { recursive: true })
              await page.screenshot({
                path: `docs/fullfarmmanager/design/spools-${screen}-${process.env.DESIGN_PHASE ?? 'before'}-${size}-${theme}.png`,
              })
            }
          } finally {
            await context.close()
          }
        }
  } finally {
    await browser.close()
    await server.close()
  }
}, 120_000)
