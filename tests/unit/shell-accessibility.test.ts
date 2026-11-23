import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { build } from 'esbuild'
import { compileScript, compileStyle, parse } from 'vue/compiler-sfc'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchBrowser, type Browser } from '../helpers/browser'

let browser: Browser
let script: string
let styles = ''
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import { createApp, h, reactive } from 'vue'
        import Layout from './apps/farm/app/layouts/default.vue'
        const route = reactive({ path: '/farm', query: {} })
        window.useRoute = () => route
        window.useRouter = () => ({ push: (to) => { window.destination = to; route.path = typeof to === 'string' ? to : to.path } })
        window.useHead = () => {}
        window.$fetch = async (path) => {
          if (path === '/api/auth/me') return {}
          if (path === '/api/farms') return { farms: [{ farmId: 'test' }] }
          if (path === '/api/browser-devices') return { currentRole: 'owner' }
          throw new Error('unavailable')
        }
        const app = createApp(Layout)
        app.component('NuxtLink', { props: ['to'], render() { return h('a', { href: typeof this.to === 'string' ? this.to : this.to.path }, this.$slots.default?.()) } })
        app.mount('#app')
      `,
    },
    bundle: true,
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [
      {
        name: 'vue',
        setup(b) {
          b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
            const { descriptor, errors } = parse(await readFile(path, 'utf8'), {
              filename: path,
            })
            if (errors.length) throw new Error(errors.join('\n'))
            const id = `data-v-${basename(path, '.vue')}`
            const css = descriptor.styles
              .map(
                (style) =>
                  compileStyle({
                    source: style.content,
                    filename: path,
                    id,
                    scoped: !!style.scoped,
                  }).code,
              )
              .join('\n')
            styles =
              basename(path) === 'default.vue' ? styles + css : css + styles
            const code = compileScript(descriptor, {
              id,
              inlineTemplate: true,
              genDefaultAs: 'component',
            }).content
            return {
              loader: 'ts',
              resolveDir: dirname(path),
              contents: `${code}\ncomponent.__scopeId = ${JSON.stringify(id)}\nexport default component`,
            }
          })
        },
      },
    ],
  })
  script = result.outputFiles[0]!.text
  browser = await launchBrowser({ args: ['--disable-background-networking'] })
})
afterAll(async () => {
  await browser?.close()
})

async function mount() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.setContent(
    '<html lang="pt-BR"><head><meta name="theme-color"></head><body><div id="app"></div></body></html>',
  )
  await page.addStyleTag({ content: styles })
  await page.addScriptTag({ content: script })
  return page
}

it('offers all owner pages from a desktop module and preserves the current page', async () => {
  const page = await mount()
  try {
    const menu = page.getByRole('button', { name: 'Menu', exact: true })
    await menu.click({ timeout: 3000 })
    const dialog = page.getByRole('dialog', { name: 'Menu' })
    for (const name of [
      'Sair da conta',
      'Membros',
      'Convidar pessoa',
      'Aprovar Connector',
      'Compatibilidade',
      'Conta Bambu Cloud',
    ]) {
      await expect
        .poll(() => dialog.getByRole('link', { name, exact: true }).count())
        .toBe(1)
    }
    expect(
      await dialog
        .getByRole('link', { name: 'Minha farm', exact: true })
        .getAttribute('aria-current'),
    ).toBe('page')
  } finally {
    await page.close()
  }
})

it('announces search results and exposes the keyboard-selected option', async () => {
  const page = await mount()
  try {
    await page.getByRole('button', { name: /Buscar/ }).click()
    const input = page.getByRole('combobox', {
      name: 'Buscar páginas, impressoras e bobinas',
    })
    await input.fill('conta', { timeout: 3000 })
    expect(await input.getAttribute('aria-expanded')).toBe('true')
    const listId = await input.getAttribute('aria-controls')
    expect(await page.locator(`#${listId}`).getAttribute('role')).toBe(
      'listbox',
    )
    expect(
      await page
        .getByRole('status')
        .filter({ hasText: /resultados? encontrados?/ })
        .count(),
    ).toBe(1)
    await input.press('ArrowDown')
    const active = await input.getAttribute('aria-activedescendant')
    const option = page.locator(`#${active}`)
    expect(await option.getAttribute('role')).toBe('option')
    expect(await option.getAttribute('aria-selected')).toBe('true')
    const href = await option.locator('a').getAttribute('href')
    await input.press('Enter')
    expect(
      await page.evaluate(
        () => (window as unknown as { destination: string }).destination,
      ),
    ).toBe(href)
  } finally {
    await page.close()
  }
})
