import { expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { launchBrowser } from '../helpers/browser.ts'

it('captures the control room and history in both themes', async () => {
  if (process.env.DESIGN_SCREENSHOTS !== '1') {
    const source = await readFile('apps/farm/app/pages/painel.vue', 'utf8')
    expect(source).toContain('PrinterKiosk')
    expect(source).toContain('statusSummaryPath(farmId)')
    return
  }
  const browser = await launchBrowser()
  try {
    for (const screen of ['painel', 'historico']) {
      for (const [size, width, height] of [
        ['desktop', 1440, 900],
        ['mobile', 390, 844],
      ] as const) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport: { width, height },
            locale: 'pt-BR',
            reducedMotion: 'reduce',
            colorScheme: theme as 'light' | 'dark',
          })
          await context.addInitScript(
            (value) => localStorage.setItem('farm-theme', value),
            theme,
          )
          const page = await context.newPage()
          await page.route('**/api/**', async (route) => {
            const path = new URL(route.request().url()).pathname
            const body =
              path === '/api/farms'
                ? { farms: [{ farmId: 'farm-demo' }] }
                : path.endsWith('/status-summary')
                  ? {
                      generatedAt: 1795089600000,
                      total: 2,
                      counts: { error: 1, printing: 1 },
                      truncated: false,
                      printers: [
                        {
                          assignmentId: 'a',
                          printerKey: 'a',
                          displayName: 'Impressora A',
                          state: 'error',
                          observedAt: 1795089600000,
                        },
                        {
                          assignmentId: 'b',
                          printerKey: 'b',
                          displayName: 'Impressora B',
                          state: 'printing',
                          progress: 0.5,
                          observedAt: 1795089600000,
                        },
                      ],
                    }
                  : path === '/api/job-history'
                    ? {
                        jobs: [
                          {
                            id: '1',
                            printerKey: 'a',
                            outcome: 'completed',
                            filename: 'peca.gcode',
                            endedAt: 1795089600000,
                            printDurationSeconds: 3600,
                          },
                        ],
                        nextBefore: null,
                      }
                    : {}
            await route.fulfill({ json: body })
          })
          await page.goto(`http://127.0.0.1:31987/${screen}`, {
            waitUntil: 'networkidle',
          })
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(width)
          expect(
            (await new AxeBuilder({ page }).include('#conteudo').analyze())
              .violations,
          ).toEqual([])
          await page.screenshot({
            path: `docs/fullfarmmanager/design/control-room-${screen}-${process.env.DESIGN_PHASE ?? 'before'}-${size}-${theme}.png`,
          })
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 120_000)
