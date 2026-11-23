import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { build } from 'esbuild'
import { compileScript, parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import { INTEGRATION_SCOPES } from '../../apps/farm/server/services/integration-apps.ts'
import { launchBrowser } from '../helpers/browser'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'

it('renders every grantable scope and limits stock forms to managers', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createApp, h, ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
        import Integrations from './apps/farm/app/pages/integracoes.vue'
        import Stock from './apps/farm/app/pages/bobinas/estoque.vue'
        Object.assign(globalThis, { ref, watch, onMounted, onBeforeUnmount, computed })
        globalThis.useRoute = () => ({ query: { farm: 'fixture' } })
        globalThis.useRouter = () => ({ replace() {} })
        globalThis.$fetch = async (url) => {
          if (url === '/api/farms') return { farms: [{ farmId: 'fixture' }] }
          if (url.endsWith('/integrations/apps')) return { apps: [{ id: 'app', name: 'Aplicativo', revokedAt: null }], printers: [] }
          if (url.endsWith('/grants')) return { grants: [] }
          if (url.endsWith('/low-stock')) return { defaultLowStockThresholdGrams: 200, filaments: [{ filamentId: 1, name: 'Azul', material: 'PLA', remainingGrams: 120, thresholdGrams: null, effectiveThresholdGrams: 200, low: true }] }
          return { items: [], canWrite: true, canImport: location.pathname === '/manager' }
        }
        const app = createApp(location.pathname === '/integrations' ? Integrations : Stock)
        app.component('NuxtLink', { props: ['to'], render() { return h('a', this.$slots.default?.()) } })
        app.mount('#app')
      `,
      resolveDir: process.cwd(),
    },
    bundle: true,
    write: false,
    outfile: 'permissions.js',
    plugins: [
      {
        name: 'vue',
        setup(build) {
          build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw new Error(errors.join('\n'))
            const code = compileScript(descriptor, {
              id: basename(path),
              inlineTemplate: true,
              genDefaultAs: 'component',
            }).content
            return {
              loader: 'ts',
              resolveDir: dirname(path),
              contents: `${code}\nexport default component`,
            }
          })
        },
      },
    ],
  })
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/permissions.js': (_, res) => {
        res.setHeader('content-type', 'text/javascript')
        res.end(bundle.outputFiles[0]!.text)
      },
      ...Object.fromEntries(
        ['/integrations', '/operator', '/manager'].map((path) => [
          path,
          (_: unknown, res: import('node:http').ServerResponse) => {
            res.setHeader('content-type', 'text/html')
            res.end(
              '<!doctype html><html lang="pt-BR"><div id="app"></div><script src="/permissions.js"></script></html>',
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
    const page = await browser.newPage()
    page.on('pageerror', (error) => console.error('PAGE ERROR', error))
    page.setDefaultTimeout(5000)
    await page.goto(`${server.origin}/integrations`)
    const scopes = page
      .locator('fieldset')
      .filter({ hasText: 'Escopos para conceder' })
      .locator('input[type=checkbox]')
    await scopes.first().waitFor()
    expect(
      (
        await scopes.evaluateAll((nodes) =>
          nodes.map((node) => (node as HTMLInputElement).value),
        )
      ).sort(),
    ).toEqual([...INTEGRATION_SCOPES].sort())
    for (const path of ['operator', 'manager']) {
      await page.goto(`${server.origin}/${path}`)
      await page.getByText('Azul · PLA').first().waitFor()
      const visible = path === 'manager'
      expect(
        await page
          .getByRole('button', { name: 'Salvar limite padrão' })
          .count(),
      ).toBe(visible ? 1 : 0)
      expect(
        await page
          .getByRole('textbox', { name: 'Limite em gramas para Azul · PLA' })
          .count(),
      ).toBe(visible ? 1 : 0)
      expect(
        await page
          .getByRole('button', { name: 'Salvar limite de Azul · PLA' })
          .count(),
      ).toBe(visible ? 1 : 0)
    }
  } finally {
    await browser.close()
    await server.close()
  }
})
