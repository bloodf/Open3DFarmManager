// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../helpers/render-farm-component.ts'
import {
  clampTarget,
  commandHeaterName,
  fieldText,
  heatersFromObservation,
  mergeSamples,
  powerText,
  HISTORY_WINDOW_MS,
} from '../../apps/farm/app/utils/printer-detail-view.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

const file = '../printer-detail/HeaterPanel.vue'
const now = Date.UTC(2026, 10, 19, 12)
const heaters = [
  { name: 'extruder', temperature: 208, target: 210, power: 0.5, maxTemp: 300 },
  { name: 'heater_bed', temperature: 0, target: 0, power: 0, maxTemp: 120 },
  { name: 'heater_generic caixa', temperature: 41.25 },
]
const history = {
  extruder: [
    { time: now - 120_000, temperature: 190 },
    { time: now - 60_000, temperature: 200 },
    { time: now, temperature: 208 },
  ],
}
const base = { heaters, history, canCommand: true }

describe('heater temperature rules', () => {
  it('clamps targets to max_temp and rejects unusable input', () => {
    expect(clampTarget('500', 300)).toBe(300)
    expect(clampTarget(-5, 300)).toBe(0)
    expect(clampTarget('59.6', 120)).toBe(60)
    expect(clampTarget('', 120)).toBeUndefined()
    expect(clampTarget('abc', 120)).toBeUndefined()
    expect(clampTarget(0, 120)).toBe(0)
    expect(clampTarget(80, undefined)).toBe(80)
  })

  it('reads a typed number field as text (v-model casts type=number to a number)', () => {
    expect(fieldText(200)).toBe('200')
    expect(fieldText(' 59.6 ')).toBe('59.6')
    expect(fieldText('')).toBe('')
    expect(fieldText(undefined)).toBe('')
    expect(fieldText(null)).toBe('')
  })

  it('names the command heater and reads limits from the machine profile', () => {
    expect(commandHeaterName('heater_bed')).toBe('bed')
    expect(commandHeaterName('heater_generic caixa')).toBe(
      'heater_generic caixa',
    )
    expect(
      heatersFromObservation({
        toolTemperatureCelsius: 0,
        bedTemperatureCelsius: 55,
        machine: { maxHotendCelsius: 285 },
      }),
    ).toEqual([
      { name: 'extruder', temperature: 0, maxTemp: 285 },
      { name: 'heater_bed', temperature: 55, maxTemp: 120 },
    ])
    expect(heatersFromObservation({})).toEqual([])
  })

  it('keeps ten minutes of unique, ordered samples', () => {
    const merged = mergeSamples(
      { extruder: [{ time: now - HISTORY_WINDOW_MS - 1, temperature: 1 }] },
      'extruder',
      [
        { time: now - 1000, temperature: 20 },
        { time: now - 2000, temperature: 19 },
        { time: now - 1000, temperature: 21 },
        { time: now + 5000, temperature: 99 },
      ],
      now,
    )
    expect(merged.extruder).toEqual([
      { time: now - 2000, temperature: 19 },
      { time: now - 1000, temperature: 21 },
    ])
    expect(powerText(0.456)).toBe('46 %')
    expect(powerText(undefined)).toBe('Indisponível')
  })
})

describe('HeaterPanel', () => {
  it('shows every heater with current, target, power and the graph', async () => {
    const html = await renderFarmComponent(file, base)
    for (const text of [
      'Bico',
      'Mesa',
      'heater_generic caixa',
      '208 °C',
      '210 °C',
      '50 %',
      '41,3 °C',
      'Temperatura de Bico nos últimos 10 minutos',
      'Máximo: 300 °C.',
      'Máximo: 120 °C.',
      'Limite não informado.',
      'max="300"',
      'max="120"',
    ])
      expect(html).toContain(text)
    expect(html).toContain('<dd>0 °C</dd>')
    expect(html).toContain('Indisponível')
    expect(html.match(/<svg[^>]*viewBox="0 0 600 172"/g)).toHaveLength(1)
    expect(html.match(/Sem dados para exibir\./g)).toHaveLength(2)
    expect(html).not.toContain('disabled')
  })

  it('disables commands and says why in degraded mode, keeping the readings', async () => {
    const html = await renderFarmComponent(file, {
      ...base,
      canCommand: false,
      disabledReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain('Não há conexão direta ao vivo.')
    expect(html).toContain('208 °C')
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(6)
  })

  it('says so when the printer reports no heater', async () => {
    const html = await renderFarmComponent(file, { ...base, heaters: [] })
    expect(html).toContain('Nenhum aquecedor informado por esta impressora.')
    expect(html).not.toContain('<form')
  })

  it('passes axe, fits and is keyboard reachable at 320, 768 and 1280 px', async () => {
    const html = await renderFarmComponent(file, base)
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const styles = async (paths: string[]) =>
      (
        await Promise.all(
          paths.map(async (path) =>
            parse(await read(path)).descriptor.styles.map((s) => s.content),
          ),
        )
      )
        .flat()
        .join('\n')
    const css = `${await read('../../apps/farm/app/assets/tokens/tokens.css')}\n${await read('../../apps/farm/app/assets/css/main.css')}\n${await styles(
      [
        '../../apps/farm/app/components/printer-detail/HeaterPanel.vue',
        '../../apps/farm/app/components/ui/Button.vue',
        '../../apps/farm/app/components/ui/charts/LineChart.vue',
      ],
    )}`
    const server = await startHttpMock({
      port: 0,
      routes: {
        '/': (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Aquecedores</title><style>${css}</style><main><h1>Impressora</h1>${html}</main></html>`,
          )
        },
      },
    })
    try {
      const browser = await launchBrowser({
        args: ['--disable-background-networking'],
      })
      try {
        const page = await (await browser.newContext()).newPage()
        await page.route('**/*', (route) =>
          new URL(route.request().url()).origin === server.origin
            ? route.continue()
            : route.abort(),
        )
        for (const width of [320, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 })
          expect((await page.goto(server.origin))?.ok()).toBe(true)
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
            [],
          )
          // Keyboard: the first heater's input, then its button, take focus in order.
          const input = page.getByLabel('Nova temperatura de Bico (°C)')
          await input.focus()
          await page.keyboard.press('Tab')
          expect(
            await page.evaluate(() => document.activeElement?.textContent),
          ).toBe('Definir Bico')
        }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  }, 120_000)
})
