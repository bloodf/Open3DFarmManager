import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'
import { longKey, prepare } from '../helpers/farm-evidence.ts'

// Isolated UI checks for the camera display (CameraDisplay.vue) and the
// printer-detail webcams panel on mocked /api routes. No real printer,
// database, auth service, camera or external network is involved.
//
// The authenticated RTC feed that produces a MediaStream cannot be driven from
// mocked HTTP, so only the "no camera" state is reached through the real /farm
// page. The stream states and the webcams panel are the real .vue sources,
// compiled on demand by this spec (vue/compiler-sfc + typescript, both pure
// JavaScript) and mounted on a page that carries the application stylesheet
// (taken from the served app) with stub media: a moving canvas for live video
// and an empty MediaStream that never plays for "connecting".
//
// Screenshots are always captured by the last test and saved outside the
// repository (POLISH_CAMERAS_SHOTS_DIR or a temporary directory).
const viewports = [
  { name: '360', width: 360, height: 800 },
  { name: 'desktop', width: 1280, height: 900 },
] as const
const themes = ['light', 'dark'] as const
const scenarios = [
  'connecting',
  'live',
  'offline',
  'error',
  'reduced-motion',
  'no-camera',
  'panel-live',
  'panel-connecting',
  'panel-unavailable',
  'panel-disabled',
  'panel-empty',
] as const

type Viewport = (typeof viewports)[number]
type Theme = (typeof themes)[number]
type Scenario = (typeof scenarios)[number]

const printerName = 'impressora-1'
const displayRegion = `Câmera da impressora ${printerName}`
const longCameraName = `Câmera lateral com um nome muito longo ${'x'.repeat(60)}`
const webcams = [
  {
    uid: 'cam-1',
    name: 'Câmera principal',
    enabled: true,
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
  },
  {
    uid: 'cam-2',
    name: longCameraName,
    enabled: false,
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
  },
]

// ---- On-demand SFC server for the harness page -----------------------------
const app = resolve(import.meta.dirname, '../../apps/farm')
const appSource = join(app, 'app')
const requireApp = createRequire(join(app, 'package.json'))
const sfc = requireApp('vue/compiler-sfc') as {
  parse(
    source: string,
    options: { filename: string },
  ): {
    descriptor: { styles: { content: string }[] }
    errors: unknown[]
  }
  compileScript(
    descriptor: unknown,
    options: { id: string; inlineTemplate: boolean },
  ): { content: string }
}
const ts = requireApp('typescript') as {
  transpileModule(
    source: string,
    options: { compilerOptions: Record<string, unknown> },
  ): { outputText: string }
  ScriptTarget: { ES2022: number }
  ModuleKind: { ESNext: number }
}
const vueRuntime = join(
  dirname(requireApp.resolve('vue/package.json')),
  'dist/vue.runtime.esm-browser.prod.js',
)

function transpile(source: string) {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText
}

function compile(path: string) {
  const source = readFileSync(path, 'utf8')
  if (!path.endsWith('.vue')) return transpile(source)
  const { descriptor, errors } = sfc.parse(source, { filename: path })
  if (errors.length) throw new Error(`Cannot parse ${path}: ${errors}`)
  const script = sfc.compileScript(descriptor, {
    id: path,
    inlineTemplate: true,
  })
  // Scoped styles become global ones for the harness; :deep() is just a combinator.
  const css = descriptor.styles
    .map((style) => style.content.replace(/:deep\(([^)]*)\)/g, '$1'))
    .join('\n')
  return transpile(
    `${script.content.replace('export default', 'const __component =')}
const __style = document.createElement('style')
__style.textContent = ${JSON.stringify(css)}
document.head.append(__style)
export default __component`,
  )
}

let appCss: Promise<string> | undefined
/** Stylesheets of the served application (tokens included), linked or inline. */
function applicationCss(page: Page) {
  appCss ??= page.request.get('/farm').then(async (response) => {
    const html = await response.text()
    const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/g)]
      .map((match) => match[0].match(/href="([^"]+)"/)?.[1])
      .filter((href): href is string => Boolean(href))
      .map((href) => `<link rel="stylesheet" href="${href}">`)
    const inline = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/g)].map(
      (match) => match[0],
    )
    return [...links, ...inline].join('\n')
  })
  return appCss
}

const harnessScript = `
import { createApp, h, shallowRef } from 'vue'
import CameraDisplay from '/__src/components/CameraDisplay.vue'
import WebcamsPanel from '/__src/components/printer-detail/WebcamsPanel.vue'
const stream = shallowRef(null)
const panel = shallowRef({ webcams: [], streams: {} })
window.harness = {
  mountDisplay(element, printerName) {
    createApp({ render: () => h(CameraDisplay, { stream: stream.value, printerName }) }).mount(element)
  },
  setStream(next) { stream.value = next },
  mountPanel(element) {
    createApp({
      render: () => h(WebcamsPanel, {
        webcams: panel.value.webcams,
        streamFor: (uid) => panel.value.streams[uid] ?? null,
      }),
    }).mount(element)
  },
  setPanel(webcams, streams) { panel.value = { webcams, streams } },
}
`

async function mockHarnessRoutes(page: Page) {
  // Anything not mocked below never leaves the test.
  await page.route(
    (url) => !['127.0.0.1', 'localhost'].includes(url.hostname),
    (route) => route.abort(),
  )
  const css = await applicationCss(page)
  await page.route('**/__vue.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: readFileSync(vueRuntime, 'utf8'),
    }),
  )
  await page.route('**/__src/**', (route) => {
    const relative = decodeURIComponent(
      new URL(route.request().url()).pathname.slice('/__src/'.length),
    )
    const path = resolve(appSource, relative)
    if (!path.startsWith(appSource + sep)) return route.abort()
    return route.fulfill({
      contentType: 'text/javascript',
      body: compile(path),
    })
  })
  await page.route('**/camera-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Câmeras</title>${css}<script type="importmap">{"imports":{"vue":"/__vue.js"}}</script></head><body><main><h1>Câmeras</h1><div id="root"></div></main><script type="module">${harnessScript}</script></body></html>`,
    }),
  )
}

type Harness = {
  harness: {
    mountDisplay(element: Element | null, printerName: string): void
    setStream(stream: MediaStream | null): void
    mountPanel(element: Element | null): void
    setPanel(
      webcams: readonly unknown[],
      streams: Record<string, MediaStream | null>,
    ): void
  }
  stubs: { live: MediaStream; connecting: MediaStream }
}
type StubName = keyof Harness['stubs']

/** Collects every console error and uncaught exception of the page. */
function watchErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function mountHarness(page: Page, kind: 'display' | 'panel') {
  await page.goto('/camera-harness')
  await page.waitForFunction(() => 'harness' in window)
  await page.evaluate(
    ({ kind, printerName }) => {
      const w = window as unknown as Window & Harness
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      const context = canvas.getContext('2d')!
      let x = 0
      setInterval(() => {
        context.fillStyle = '#243b53'
        context.fillRect(0, 0, 320, 180)
        context.fillStyle = '#f0b429'
        context.fillRect((x = (x + 6) % 320), 70, 40, 40)
      }, 50)
      w.stubs = {
        live: canvas.captureStream(10),
        // Never plays: the display stays in its connecting state.
        connecting: new MediaStream(),
      }
      const root = document.getElementById('root')!
      const section = document.createElement(
        kind === 'display' ? 'section' : 'div',
      )
      if (kind === 'display') {
        section.setAttribute('aria-label', 'Impressora de teste')
        section.innerHTML = '<h2>Impressora de teste</h2><div id="mount"></div>'
        root.append(section)
        w.harness.mountDisplay(document.getElementById('mount'), printerName)
      } else {
        root.append(section)
        section.id = 'mount'
        w.harness.mountPanel(section)
      }
    },
    { kind, printerName },
  )
}

const useStub = (page: Page, name: StubName) =>
  page.evaluate(
    (name) =>
      (window as unknown as Window & Harness).harness.setStream(
        (window as unknown as Window & Harness).stubs[name],
      ),
    name,
  )
const setPanel = (page: Page, list: readonly unknown[], live?: StubName) =>
  page.evaluate(
    ({ list, live }) => {
      const w = window as unknown as Window & Harness
      w.harness.setPanel(list, live ? { 'cam-1': w.stubs[live] } : {})
    },
    { list, live },
  )

const camera = (page: Page) => page.getByRole('region', { name: displayRegion })
const panel = (page: Page) => page.getByRole('region', { name: 'Câmeras' })

async function open(
  page: Page,
  scenario: Scenario,
  viewport: Viewport,
  theme: Theme,
) {
  if (scenario === 'no-camera') {
    await prepare(page, 'populated', viewport, theme)
    const region = page.getByRole('region', {
      name: `Câmera da impressora ${longKey}`,
    })
    await expect(region.getByRole('status')).toHaveText('Câmera indisponível.')
    return
  }
  await page.setViewportSize(viewport)
  // Live video only starts on its own when motion is not reduced.
  await page.emulateMedia({
    colorScheme: theme,
    reducedMotion: scenario === 'reduced-motion' ? 'reduce' : 'no-preference',
  })
  await mockHarnessRoutes(page)
  if (!scenario.startsWith('panel-')) {
    await mountHarness(page, 'display')
    await settle(page, scenario)
    return
  }
  await mountHarness(page, 'panel')
  await settle(page, scenario)
}

async function settle(page: Page, scenario: Scenario) {
  switch (scenario) {
    case 'connecting':
      await useStub(page, 'connecting')
      await expect(camera(page).getByRole('status')).toHaveText(
        'Carregando câmera…',
      )
      await expect(camera(page)).toHaveAttribute('aria-busy', 'true')
      break
    case 'live':
      await useStub(page, 'live')
      await expect(camera(page).getByRole('status')).toHaveText(
        'Câmera ao vivo.',
      )
      await expect(camera(page).locator('video')).toBeVisible()
      break
    case 'offline':
      await useStub(page, 'live')
      await expect(camera(page).getByRole('status')).toHaveText(
        'Câmera ao vivo.',
      )
      await page.evaluate(() =>
        (window as unknown as Window & Harness).harness.setStream(null),
      )
      await expect(camera(page).getByRole('status')).toHaveText(
        'Câmera indisponível.',
      )
      break
    case 'error':
      await useStub(page, 'connecting')
      await expect(camera(page).getByRole('status')).toHaveText(
        'Carregando câmera…',
      )
      await camera(page)
        .locator('video')
        .evaluate((video) => video.dispatchEvent(new Event('error')))
      await expect(camera(page).getByRole('status')).toHaveText(
        'Não foi possível exibir a câmera. A visualização foi encerrada.',
      )
      break
    case 'reduced-motion':
      await useStub(page, 'live')
      await expect(camera(page).getByRole('status')).toContainText(
        'movimento reduzido',
      )
      break
    case 'panel-live':
      await setPanel(page, webcams, 'live')
      await expect(
        panel(page).getByRole('status').filter({ hasText: 'ao vivo' }),
      ).toHaveText('Câmera ao vivo.')
      break
    case 'panel-connecting':
      await setPanel(page, webcams, 'connecting')
      await expect(
        panel(page).getByRole('status').filter({ hasText: 'Carregando' }),
      ).toBeVisible()
      break
    case 'panel-unavailable':
      await setPanel(page, webcams)
      await expect(panel(page).getByRole('status')).toHaveText(
        'Imagem indisponível para esta câmera.',
      )
      break
    case 'panel-disabled':
      await setPanel(page, webcams)
      await panel(page).getByLabel('Câmera', { exact: true }).selectOption('1')
      await expect(panel(page).getByRole('status')).toHaveText(
        'Imagem indisponível para esta câmera.',
      )
      await expect(panel(page)).toContainText('Esta câmera está desativada.')
      break
    case 'panel-empty':
      await setPanel(page, [])
      await expect(panel(page).getByRole('status')).toHaveText(
        'Nenhuma câmera cadastrada.',
      )
      break
  }
}

async function violations(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze()
  return result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    nodes: violation.nodes.map((node) => ({
      target: node.target,
      failureSummary: node.failureSummary,
    })),
  }))
}

const fits = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

for (const scenario of scenarios)
  for (const viewport of viewports)
    for (const theme of themes)
      test(`${scenario} state is accessible and fits at ${viewport.name} in the ${theme} theme`, async ({
        page,
      }) => {
        const errors = watchErrors(page)
        await open(page, scenario, viewport, theme)
        expect(await fits(page)).toBe(true)
        expect(await violations(page)).toEqual([])
        // /farm mocks the integration approvals as 403 (not allowed), which the
        // browser logs; that mocked denial is not a page error.
        expect(
          errors.filter((error) => !error.includes('status of 403')),
        ).toEqual([])
      })

test('the camera is a named region with silent, labelled video and one status', async ({
  page,
}) => {
  await open(page, 'live', viewports[1], 'light')
  const region = camera(page)
  await expect(region.getByRole('status')).toHaveCount(1)
  const video = region.locator('video')
  await expect(video).toHaveAttribute(
    'aria-label',
    `Imagem ao vivo da impressora ${printerName}, sem áudio`,
  )
  expect(
    await video.evaluate((node: HTMLVideoElement) => ({
      muted: node.muted,
      autoplay: node.autoplay,
      controls: node.controls,
    })),
  ).toEqual({ muted: true, autoplay: false, controls: false })
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  await expect(page.getByRole('main')).toHaveCount(1)
})

test('without a stream the camera says it is unavailable and has no control', async ({
  page,
}) => {
  await open(page, 'no-camera', viewports[0], 'light')
  const region = page.getByRole('region', {
    name: `Câmera da impressora ${longKey}`,
  })
  await expect(region.getByRole('button')).toHaveCount(0)
  await expect(region.locator('video')).toBeHidden()
  expect(
    await region.evaluate((node) => node.scrollWidth <= node.clientWidth),
  ).toBe(true)
})

test('live video can always be stopped and shown again, and stopping detaches it', async ({
  page,
}) => {
  await open(page, 'live', viewports[0], 'dark')
  const region = camera(page)
  const video = region.locator('video')
  await region.getByRole('button', { name: 'Parar imagem ao vivo' }).click()
  await expect(region.getByRole('status')).toHaveText('Imagem ao vivo parada.')
  expect(
    await video.evaluate((node: HTMLVideoElement) => node.srcObject),
  ).toBeNull()
  expect(await violations(page)).toEqual([])
  await region.getByRole('button', { name: 'Mostrar imagem ao vivo' }).click()
  await expect(region.getByRole('status')).toHaveText('Câmera ao vivo.')
  await expect(video).toBeVisible()
})

test('with reduced motion the video waits for the user', async ({ page }) => {
  await open(page, 'reduced-motion', viewports[0], 'light')
  const region = camera(page)
  await expect(region.getByRole('status')).toHaveText(
    'Câmera disponível. A imagem não inicia sozinha porque o movimento reduzido está ativado.',
  )
  await expect(region.locator('video')).toBeHidden()
  await region.getByRole('button', { name: 'Mostrar imagem ao vivo' }).click()
  await expect(region.getByRole('status')).toHaveText('Câmera ao vivo.')
})

test('connecting is announced as busy and times out into the error state', async ({
  page,
}) => {
  await page.clock.install()
  await open(page, 'connecting', viewports[0], 'light')
  const region = camera(page)
  await expect(region).toHaveAttribute('aria-busy', 'true')
  await page.clock.fastForward(10_001)
  await expect(region.getByRole('status')).toHaveText(
    'Não foi possível exibir a câmera. A visualização foi encerrada.',
  )
  await expect(region).toHaveAttribute('aria-busy', 'false')
  await expect(region.locator('video')).toBeHidden()
})

test('the webcams panel has a labelled camera picker and marks disabled cameras', async ({
  page,
}) => {
  await open(page, 'panel-live', viewports[0], 'light')
  const section = panel(page)
  await expect(
    section.getByRole('heading', { level: 2, name: 'Câmeras' }),
  ).toBeVisible()
  const picker = section.getByLabel('Câmera', { exact: true })
  await expect(picker.locator('option')).toHaveText([
    'Câmera principal',
    `${longCameraName} (desativada)`,
  ])
  await expect(
    section.getByRole('button', { name: 'Tela cheia' }),
  ).toBeVisible()
  await picker.selectOption('1')
  await expect(section.getByRole('status')).toHaveText(
    'Imagem indisponível para esta câmera.',
  )
  await expect(section.getByRole('button')).toHaveCount(0)
  expect(await fits(page)).toBe(true)
})

test('a fullscreen failure is announced', async ({ page }) => {
  await open(page, 'panel-live', viewports[1], 'light')
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = () =>
      Promise.reject(new Error('blocked'))
  })
  await panel(page).getByRole('button', { name: 'Tela cheia' }).click()
  await expect(
    panel(page)
      .getByRole('status')
      .filter({ hasText: 'Não foi possível abrir a tela cheia.' }),
  ).toBeVisible()
  expect(await violations(page)).toEqual([])
})

test('keyboard reaches picker, fullscreen and stop in order with a visible focus ring', async ({
  page,
}) => {
  await open(page, 'panel-live', viewports[1], 'light')
  await panel(page).getByLabel('Câmera', { exact: true }).focus()
  const seen: string[] = []
  for (let step = 0; step < 3; step++) {
    const focus = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement
      const style = getComputedStyle(element)
      return {
        label:
          element.tagName === 'SELECT'
            ? 'Câmera'
            : element.textContent?.trim().slice(0, 40) || 'sem nome',
        outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
      }
    })
    expect(focus.outline, `${focus.label} has no focus ring`).toBe(true)
    seen.push(focus.label)
    await page.keyboard.press('Tab')
  }
  expect(seen).toEqual(['Câmera', 'Tela cheia', 'Parar imagem ao vivo'])
})

test('makes no request outside the loopback host', async ({ page }) => {
  const external: string[] = []
  page.on('request', (request) => {
    const { hostname, protocol } = new URL(request.url())
    if (
      protocol.startsWith('http') &&
      !['127.0.0.1', 'localhost'].includes(hostname)
    )
      external.push(request.url())
  })
  await open(page, 'panel-live', viewports[1], 'dark')
  expect(external).toEqual([])
})

test('screenshots of real screen states', async ({ page }, testInfo) => {
  testInfo.setTimeout(240_000)
  const dir =
    process.env.POLISH_CAMERAS_SHOTS_DIR ??
    (await mkdtemp(join(tmpdir(), 'openfarm-cameras-shots-')))
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  for (const scenario of scenarios)
    for (const viewport of viewports)
      for (const theme of themes) {
        await page.unrouteAll({ behavior: 'ignoreErrors' })
        await open(page, scenario, viewport, theme)
        const path = join(dir, `${scenario}-${viewport.name}-${theme}.png`)
        await page.screenshot({
          path,
          fullPage: true,
          animations: 'disabled',
        })
        expect((await stat(path)).size).toBeGreaterThan(0)
        written.push(path)
      }
  expect(written).toHaveLength(
    scenarios.length * viewports.length * themes.length,
  )
  expect((await readdir(dir)).filter((name) => name.endsWith('.png'))).toEqual(
    expect.arrayContaining(written.map((path) => path.split('/').pop()!)),
  )
})
