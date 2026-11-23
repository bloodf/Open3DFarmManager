// SPDX-License-Identifier: MIT
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { parse } from 'vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { renderFarmComponent } from '../../apps/farm/app/components/farm/render-farm-component.ts'
import {
  DEFAULT_UNSUPPORTED_REASON,
  detailTabs,
} from '../../apps/farm/app/utils/printer-detail-view.ts'
import { startHttpMock } from '../../packages/sim-tools/src/mocks/http-mock.ts'
import { launchBrowser } from '../helpers/browser.ts'

const file = '../printer-detail/PrinterDetailDashboard.vue'
const now = Date.UTC(2026, 10, 19, 12)
const props = {
  name: 'Voron 2.4',
  stateLabel: 'Imprimindo',
  stateTone: 'printing',
  connectorLabel: 'conexão direta ativa',
  live: true,
  capabilities: ['heaters', 'files', 'job-queue'],
  heaters: [
    {
      name: 'extruder',
      temperature: 208,
      target: 210,
      power: 0.4,
      maxTemp: 300,
    },
    {
      name: 'heater_bed',
      temperature: 59,
      target: 60,
      power: 0.1,
      maxTemp: 120,
    },
  ],
  history: {
    extruder: [
      { time: now - 60_000, temperature: 200 },
      { time: now, temperature: 208 },
    ],
  },
  canCommand: true,
  canEmergencyStop: true,
}
const tabLabels = (html: string) =>
  [
    ...html.matchAll(
      /role="tab"[^>]*>\s*(?:<!--\[-->)?([^<]+?)(?:<!--\]-->)?\s*<\/button>/g,
    ),
  ].map((match) => match[1]!.trim())

describe('tab visibility by capability', () => {
  it.each([
    [undefined, ['Painel']],
    [['heaters'], ['Painel']],
    [['console'], ['Painel', 'Console']],
    [['files'], ['Painel', 'Arquivos', 'Configuração']],
    [
      ['job-queue', 'bed-mesh'],
      ['Painel', 'Fila', 'Malha'],
    ],
    [['power'], ['Painel', 'Sistema']],
    [
      ['updates', 'job'],
      ['Painel', 'Sistema', 'Histórico'],
    ],
  ] as const)('%j shows %j', (capabilities, labels) => {
    expect(detailTabs(capabilities).available.map((tab) => tab.label)).toEqual(
      labels,
    )
  })

  it('lists every hidden tab with the catalog reason or the default one', () => {
    const { unavailable } = detailTabs(['heaters'], {
      'bed-mesh': 'O catálogo não lista malha para este modelo.',
    })
    expect(unavailable.map((tab) => tab.id)).toEqual([
      'console',
      'arquivos',
      'fila',
      'timelapse',
      'malha',
      'configuracao',
      'sistema',
      'historico',
    ])
    expect(unavailable.find((tab) => tab.id === 'malha')?.reason).toBe(
      'O catálogo não lista malha para este modelo.',
    )
    expect(unavailable.find((tab) => tab.id === 'console')?.reason).toBe(
      DEFAULT_UNSUPPORTED_REASON,
    )
  })

  it('renders only advertised tabs and the reasons for the others', async () => {
    const html = await renderFarmComponent(file, {
      ...props,
      reasons: { console: 'O Connector desta impressora não expõe o console.' },
    })
    expect(tabLabels(html)).toEqual([
      'Painel',
      'Arquivos',
      'Fila',
      'Configuração',
    ])
    expect(html).toContain('Recursos indisponíveis')
    expect(html).toContain('O Connector desta impressora não expõe o console.')
    expect(html).toContain(
      `<strong>Malha:</strong> ${DEFAULT_UNSUPPORTED_REASON}`,
    )
    expect(html).toContain('Parada de emergência')
    expect(html).toContain('Connector: conexão direta ativa')
  })

  it('shows the heater reason when the printer does not advertise heaters', async () => {
    const html = await renderFarmComponent(file, {
      ...props,
      capabilities: ['files'],
      reasons: { heaters: 'Sem aquecedores no catálogo.' },
    })
    expect(html).toContain('Sem aquecedores no catálogo.')
    expect(html).not.toContain('<form')
  })
})

describe('fallback when the direct connection is down', () => {
  it('keeps the last known values, read-only, with the reason', async () => {
    const html = await renderFarmComponent(file, {
      ...props,
      live: false,
      lastKnownText: 'recebido há 42 s',
      connectorLabel: 'sem conexão direta',
      canCommand: false,
      canEmergencyStop: false,
      commandReason: 'Comando indisponível. Não há conexão direta ao vivo.',
    })
    expect(html).toContain(
      'Sem conexão direta: exibindo o último valor conhecido',
    )
    expect(html).toContain('recebido há 42 s')
    expect(html).toContain('Connector: sem conexão direta')
    expect(html).toContain('208 °C')
    expect(html).toContain('Não há conexão direta ao vivo.')
    expect(html).toContain(
      'Indisponível sem conexão direta atual e autorizada.',
    )
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*>\s*(<!--\[-->)?Parada de emergência/,
    )
    expect(html).toMatch(/<input[^>]*disabled/)
  })

  it('does not call a live page read-only', async () => {
    const html = await renderFarmComponent(file, props)
    expect(html).not.toContain('Somente leitura')
    expect(html).not.toMatch(/<input[^>]*disabled/)
  })
})

describe('accessibility', () => {
  it('passes axe, fits and is keyboard reachable at 320, 768 and 1280 px', async () => {
    const html = await renderFarmComponent(file, props)
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const base = '../../apps/farm/app/components/'
    const styles = (
      await Promise.all(
        [
          'printer-detail/PrinterDetailDashboard.vue',
          'printer-detail/HeaterPanel.vue',
          'ui/Button.vue',
          'ui/StatusBadge.vue',
          'ui/Tabs.vue',
          'ui/charts/LineChart.vue',
        ].map(async (path) =>
          parse(await read(base + path)).descriptor.styles.map(
            (s) => s.content,
          ),
        ),
      )
    )
      .flat()
      .join('\n')
    const css = `${await read('../../apps/farm/app/assets/tokens/tokens.css')}\n${await read('../../apps/farm/app/assets/css/main.css')}\n${styles}`
    const server = await startHttpMock({
      port: 0,
      routes: {
        '/': (_req, res) => {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(
            `<!doctype html><html lang="pt-BR"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Impressora</title><style>${css}</style><main>${html}</main></html>`,
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
          // Keyboard: the emergency stop comes first, then the selected tab.
          await page.keyboard.press('Tab')
          expect(
            await page.evaluate(() =>
              document.activeElement?.textContent?.trim(),
            ),
          ).toBe('Parada de emergência')
          await page.keyboard.press('Tab')
          expect(
            await page.evaluate(() => [
              document.activeElement?.getAttribute('role'),
              document.activeElement?.getAttribute('aria-selected'),
              document.activeElement?.textContent?.trim(),
            ]),
          ).toEqual(['tab', 'true', 'Painel'])
        }
      } finally {
        await browser.close()
      }
    } finally {
      await server.close()
    }
  }, 120_000)
})

describe('configuration editor placement', () => {
  it('fills the Configuração tab, not the Painel tab', async () => {
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const page = await read(
      '../../apps/farm/app/pages/impressoras/[printerKey].vue',
    )
    const dashboard = await read(
      '../../apps/farm/app/components/printer-detail/PrinterDetailDashboard.vue',
    )
    expect(page).toMatch(/<template #configuracao>\s*<ConfigEditorPanel/)
    expect(page).not.toContain('#config-editor')
    expect(dashboard).not.toContain('config-editor')
  })
})

describe('Bambu alarm placement', () => {
  it('keeps the status slot outside the tabs that hide inactive panels', async () => {
    const read = (path: string) =>
      readFile(new URL(path, import.meta.url), 'utf8')
    const dashboard = await read(
      '../../apps/farm/app/components/printer-detail/PrinterDetailDashboard.vue',
    )
    const page = await read(
      '../../apps/farm/app/pages/impressoras/[printerKey].vue',
    )

    const statusSlot = dashboard.indexOf('<slot name="status" />')
    const tabs = dashboard.indexOf('<Tabs')
    expect(statusSlot).toBeGreaterThan(-1)
    expect(statusSlot).toBeLessThan(tabs)
    expect(page).toMatch(/<template #status>\s*<BambuAlarmStatus/)
  })
})

describe('Bambu alarm status', () => {
  it('renders current, unavailable, and cleared alarm states accessibly', async () => {
    const file = '../printer-detail/BambuAlarmStatus.vue'
    const active = await renderFarmComponent(file, {
      message: 'Erro de impressão: 0300-8005.',
    })
    expect(active).toContain('role="status"')
    expect(active).toContain('aria-live="polite"')
    expect(active).toContain('Alertas da impressora')
    expect(active).toContain('0300-8005')
    const unavailable = await renderFarmComponent(file, {
      message: 'Alertas ainda não informados pela impressora.',
    })
    expect(unavailable).toContain(
      'Alertas ainda não informados pela impressora.',
    )
    expect(unavailable).not.toContain('0300-8005')
    const cleared = await renderFarmComponent(file, { message: '' })
    expect(cleared).toContain('Nenhum alerta informado.')
  })
})
