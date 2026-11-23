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
          import './apps/farm/app/assets/css/main.css'
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
      // Chrome shutdown is occasionally slow (>30s); close is already
      // requested and the pipe is released when the worker exits.
      await Promise.race([
        browser?.close(),
        new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
      ])
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

  it('captures the gallery at both widths and themes', async () => {
    for (const [name, width, height] of [
      ['desktop', 1440, 900],
      ['mobile', 390, 844],
    ] as const) {
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height })
        await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-theme', value),
          theme,
        )
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        )
        if (process.env.DESIGN_SCREENSHOTS === '1') {
          await page.screenshot({
            path: `docs/fullfarmmanager/design/ui-gallery-gallery-${process.env.DESIGN_PHASE ?? 'after'}-${name}-${theme}.png`,
            fullPage: true,
          })
        }
      }
    }
  }, 120_000)
})
