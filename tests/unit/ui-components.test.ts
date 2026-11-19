import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { build } from 'esbuild'
import {
  compileScript,
  compileStyle,
  compileTemplate,
  parse,
} from 'vue/compiler-sfc'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest'
import { launchBrowser, type Browser } from '../helpers/browser'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock'

const galleryPath = '/ui-gallery'
const html = `<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Galeria de componentes</title>
<link rel="stylesheet" href="/gallery.css">
<div id="app"></div>
<script src="/gallery.js" defer></script>
</html>`

describe('UI component gallery', () => {
  let browser: Browser | undefined
  let server: Awaited<ReturnType<typeof startHttpMock>> | undefined
  let page: Page

  beforeAll(async () => {
    const bundle = await build({
      stdin: {
        contents: `
          import { createApp } from 'vue'
          import Gallery from './apps/farm/app/pages/ui-gallery.vue'
          import './apps/farm/app/assets/main.css'
          createApp(Gallery).mount('#app')
        `,
        resolveDir: process.cwd(),
      },
      bundle: true,
      write: false,
      outfile: 'gallery.js',
      plugins: [
        {
          name: 'gallery-vue',
          setup(build) {
            build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
              const { descriptor, errors } = parse(
                await readFile(path, 'utf8'),
                { filename: path },
              )
              if (errors.length) throw new Error(errors.join('\n'))
              const id = `data-v-${basename(path, '.vue')}`
              let code: string
              if (descriptor.scriptSetup) {
                code = compileScript(descriptor, {
                  id,
                  inlineTemplate: true,
                  genDefaultAs: 'component',
                }).content
              } else {
                const template = compileTemplate({
                  filename: path,
                  id,
                  source: descriptor.template?.content ?? '',
                })
                if (template.errors.length)
                  throw new Error(template.errors.join('\n'))
                code = `${template.code}\nconst component = { render }`
              }
              const css = descriptor.styles
                .map(({ content, scoped }) => {
                  const style = compileStyle({
                    filename: path,
                    id,
                    source: content,
                    scoped: Boolean(scoped),
                  })
                  if (style.errors.length)
                    throw new Error(style.errors.join('\n'))
                  return style.code
                })
                .join('\n')
              return {
                loader: 'ts',
                resolveDir: dirname(path),
                contents: `${code}
                component.__scopeId = ${JSON.stringify(id)}
                const style = document.createElement('style')
                style.textContent = ${JSON.stringify(css)}
                document.head.append(style)
                export default component
              `,
              }
            })
          },
        },
      ],
    })
    const script = bundle.outputFiles.find((file) => file.path.endsWith('.js'))
    const styles = bundle.outputFiles.find((file) => file.path.endsWith('.css'))
    if (!script || !styles) throw new Error('Missing gallery JavaScript or CSS')
    server = await startHttpMock({
      port: 0,
      routes: {
        [galleryPath](_request, response) {
          response.setHeader('content-type', 'text/html; charset=utf-8')
          response.end(html)
        },
        '/gallery.js'(_request, response) {
          response.setHeader('content-type', 'text/javascript; charset=utf-8')
          response.end(script.text)
        },
        '/gallery.css'(_request, response) {
          response.setHeader('content-type', 'text/css; charset=utf-8')
          response.end(styles.text)
        },
      },
    })
    browser = await launchBrowser({ args: ['--disable-background-networking'] })
  }, 20_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await server?.close()
    }
  })

  beforeEach(async () => {
    if (!browser || !server) throw new Error('Gallery fixture unavailable')
    const origin = server.origin
    const context = await browser.newContext({
      viewport: { width: 375, height: 800 },
    })
    onTestFinished(() => context.close())
    await context.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    )
    page = await context.newPage()
    await page.goto(origin + galleryPath)
    await page
      .getByRole('heading', { name: 'Galeria de componentes' })
      .waitFor()
  })

  it('opens a named modal by keyboard, constrains focus and restores it on Escape', async () => {
    const trigger = page.getByRole('button', { name: 'Ver detalhes' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Detalhes da impressão' })
    await dialog.waitFor()
    expect(await dialog.evaluate((element) => element.matches(':modal'))).toBe(
      true,
    )
    const close = dialog.getByRole('button', { name: 'Fechar' })
    expect(
      await close.evaluate((element) => element === document.activeElement),
    ).toBe(true)
    await page.keyboard.press('Tab')
    expect(
      await trigger.evaluate((element) => element === document.activeElement),
    ).toBe(false)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
    expect(
      await trigger.evaluate((element) => element === document.activeElement),
    ).toBe(true)
  })

  it('moves tab focus and selection and associates each tab with its panel', async () => {
    const jobs = page.getByRole('tab', { name: 'Impressões' })
    const materials = page.getByRole('tab', { name: 'Materiais' })
    await jobs.focus()
    expect(await jobs.getAttribute('tabindex')).toBe('0')
    await page.keyboard.press('ArrowLeft')
    const panel = page.getByRole('tabpanel', { name: 'Materiais' })
    expect(await materials.getAttribute('aria-selected')).toBe('true')
    expect(await materials.getAttribute('aria-controls')).toBe(
      await panel.getAttribute('id'),
    )
    expect(
      await materials.evaluate((element) => element === document.activeElement),
    ).toBe(true)
    expect(await jobs.getAttribute('tabindex')).toBe('-1')
    await page.keyboard.press('Home')
    expect(await jobs.getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('End')
    expect(await materials.getAttribute('aria-selected')).toBe('true')
    await page.keyboard.press('ArrowRight')
    expect(await jobs.getAttribute('aria-selected')).toBe('true')
  })

  it('reaches the named table region by Tab and exposes native column headers', async () => {
    await page.getByRole('tab', { name: 'Impressões' }).focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    const region = page.getByRole('region', { name: 'Fila de impressão' })
    expect(
      await region.evaluate((element) => element === document.activeElement),
    ).toBe(true)
    const table = region.getByRole('table', { name: 'Fila de impressão' })
    expect(await table.getByRole('columnheader').allTextContents()).toEqual([
      'Arquivo',
      'Estado',
    ])
    expect(
      await table
        .getByRole('columnheader', { name: 'Arquivo' })
        .getAttribute('scope'),
    ).toBe('col')
    expect(
      await table.getByRole('cell', { name: 'suporte.gcode' }).count(),
    ).toBe(1)
  })

  it('passes axe with the gallery and with the modal open', async () => {
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'Ver detalhes' }).click()
    await page.getByRole('dialog').waitFor()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  }, 15_000)
})
