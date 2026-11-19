import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import type { FarmObservation } from '../../apps/farm/app/utils/farm-view.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

const file = 'PrinterWallCard.vue'
const now = { wall: Date.UTC(2026, 10, 19, 12), mono: 3000 }
const props = { name: 'Impressora 1', detailHref: '/impressoras/1', now }

function observation(
  state: FarmObservation['state']['state'],
): FarmObservation {
  return {
    state: { printerKey: '1', state, observedAt: now.wall - 2000, progress: 0 },
    received: { wall: now.wall - 2000, mono: 1000 },
    historical: false,
    sourceClockComparable: true,
  }
}

it.each([
  ['idle', 'Ociosa'],
  ['printing', 'Imprimindo'],
  ['paused', 'Pausada'],
  ['error', 'Erro'],
  ['offline', 'Indisponível segundo o Connector'],
] as const)('renders %s with a text badge and icon', async (state, label) => {
  const html = await renderFarmComponent(file, {
    ...props,
    observation: observation(state),
  })
  expect(html).toContain(`</span> ${label}`)
  expect(html).toMatch(/aria-hidden="true">[^<]+<\/span>/)
})

it('renders missing data without inventing progress or job details', async () => {
  const html = await renderFarmComponent(file, props)
  expect(html).toContain('Sem dados')
  expect(html).toContain('Nenhuma atualização recebida')
  expect(html).toContain('Indisponível / Indisponível')
  expect(html).not.toMatch(/<progress|<time|<img|<ul/)
})

it('preserves zero and partial readings and suppresses stale finish estimates', async () => {
  const reading = observation('printing')
  reading.historical = true
  reading.state.currentLayer = 0
  reading.state.toolTemperatureCelsius = 0
  reading.state.estimatedRemainingSeconds = 0
  const html = await renderFarmComponent(file, {
    ...props,
    observation: reading,
  })
  expect(html).toContain('value="0"')
  expect(html).toContain('0 °C / Indisponível')
  expect(html).toContain('0 h 0 min')
  expect(html).toContain('Camada</dt><dd>Indisponível')
  expect(html).toContain('Dados desatualizados')
  expect(html).not.toContain('<time')
})

it('renders wall details and passes axe at 320, 768 and 1280 px', async () => {
  const reading = observation('printing')
  Object.assign(reading.state, {
    filename: 'suporte.gcode',
    progress: 0.42,
    currentLayer: 4,
    totalLayer: 10,
    estimatedRemainingSeconds: 120,
    toolTemperatureCelsius: 208,
    bedTemperatureCelsius: 59,
    materials: [
      {
        slot: 'ams:0:0',
        active: true,
        colorHex: 'FF4400FF',
        remainingPercent: 0,
      },
      { slot: 'ace:0:1', remainingPercent: 65 },
    ],
  } satisfies Partial<FarmObservation['state']>)
  const card = await renderFarmComponent(file, {
    ...props,
    observation: reading,
    group: 'Produção',
    location: 'Sala 2',
    nozzleTarget: 210,
    bedTarget: 60,
    thumbnailUrl: '/miniatura.svg',
    activeSpools: [{ slot: 'ams:0:0', name: 'PLA laranja' }],
    alerts: ['Filamento acabando'],
  })
  for (const text of [
    '/impressoras/1',
    'Produção · Sala 2',
    'suporte.gcode',
    'value="42"',
    '4/10',
    '0 h 2 min',
    '2026-11-19T12:01:58.000Z',
    '208 °C / 210 °C',
    '59 °C / 60 °C',
    'miniatura.svg',
    'Cor #FF4400',
    'Em uso',
    '0% restante',
    'ace:0:1',
    '65% restante',
    'PLA laranja',
    'Filamento acabando',
    'há 2 s',
  ]) {
    expect(card).toContain(text)
  }
  const source = await readFile(
    new URL(`../../apps/farm/app/components/farm/${file}`, import.meta.url),
    'utf8',
  )
  const css = parse(source)
    .descriptor.styles.map(({ content }) => content)
    .join('\n')
  const emptyCard = await renderFarmComponent(file, {
    ...props,
    name: 'Impressora 2',
  })
  const server = await startHttpMock({
    port: 0,
    routes: {
      '/': (_req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Mural</title><style>${css}</style><main><h1>Mural</h1>${card}${emptyCard}</main></html>`,
        )
      },
      '/miniatura.svg': (_req, res) => {
        res.setHeader('Content-Type', 'image/svg+xml')
        res.end(
          '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="80"/>',
        )
      },
    },
  })
  try {
    const browser = await launchBrowser({
      args: ['--disable-background-networking'],
    })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.route('**/*', (route) =>
        new URL(route.request().url()).origin === server.origin
          ? route.continue()
          : route.abort(),
      )
      for (const width of [320, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 })
        const response = await page.goto(server.origin)
        expect(response?.ok()).toBe(true)
        await page.getByRole('link', { name: props.name }).waitFor()
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(width)
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
          [],
        )
      }
    } finally {
      await browser.close()
    }
  } finally {
    await server.close()
  }
}, 120_000)
