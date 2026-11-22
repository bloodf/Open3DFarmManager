import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import AxeBuilder from '@axe-core/playwright'
import { launchBrowser } from '../helpers/browser.ts'
import { farm, longKey, mockApi } from '../helpers/farm-evidence.ts'

it('keeps the three floor routes available and captures their fixtures on request', async () => {
  for (const file of [
    'farm.vue',
    'impressoras.vue',
    'impressoras/[printerKey].vue',
  ]) {
    expect(await readFile(`apps/farm/app/pages/${file}`, 'utf8')).toContain(
      '<template>',
    )
  }
  if (process.env.DESIGN_SCREENSHOTS !== '1') return
  const origin = process.env.DESIGN_BASE_URL ?? 'http://127.0.0.1:31977'
  const browser = await launchBrowser({
    args: ['--disable-background-networking'],
  })
  try {
    for (const [size, width, height] of [
      ['desktop', 1440, 900],
      ['mobile', 390, 844],
    ] as const) {
      for (const theme of ['light', 'dark'] as const) {
        const context = await browser.newContext({
          viewport: { width, height },
          locale: 'pt-BR',
          colorScheme: theme,
          reducedMotion: 'reduce',
        })
        try {
          const page = await context.newPage()
          await mockApi(page, 'populated')
          await page.route('**/api/farms', (route) =>
            route.fulfill({
              json: { farms: [{ farmId: farm }], nextAfter: null },
            }),
          )
          await page.route(`**/api/farms/${farm}/printers`, (route) =>
            route.fulfill({
              json: {
                printers: [
                  {
                    assignmentId: '00000000-0000-4000-8000-0000000000b1',
                    agentId: '00000000-0000-4000-8000-0000000000a1',
                    printerKey: longKey,
                    displayName: 'Ender da bancada',
                    groupName: 'Sala 1',
                    location: 'Bancada A',
                    status: 'active',
                    connectorStatus: 'approved',
                  },
                ],
                nextAfter: null,
                canManage: true,
              },
            }),
          )
          for (const [screen, path, heading] of [
            ['farm', '/farm', 'Minha farm'],
            ['impressoras', '/impressoras', 'Impressoras da farm'],
            [
              'detail',
              `/impressoras/${encodeURIComponent(longKey)}`,
              'Ender da bancada',
            ],
          ] as const) {
            await page.goto(origin + path)
            await page
              .getByRole('heading', { level: 1, name: heading, exact: true })
              .waitFor()
            if (screen === 'farm') {
              const grouping = page.getByLabel('Agrupar por')
              expect(await grouping.inputValue()).toBe('location')
              await grouping.selectOption('')
              await page
                .getByRole('heading', { name: 'Bancada A' })
                .waitFor({ state: 'hidden' })
              await grouping.selectOption('location')
              const trigger = page.getByRole('button', {
                name: /Inspecionar Ender da bancada/,
              })
              await trigger.waitFor()
              await trigger.click()
              const dialog = page.getByRole('dialog', {
                name: 'Inspeção da impressora',
              })
              expect(await dialog.isVisible()).toBe(true)
              expect(
                (
                  await new AxeBuilder({ page })
                    .include('.floor-inspector')
                    .withTags([
                      'wcag2a',
                      'wcag2aa',
                      'wcag21a',
                      'wcag21aa',
                      'wcag22aa',
                    ])
                    .analyze()
                ).violations,
              ).toEqual([])
              expect(
                await dialog
                  .getByRole('link', { name: /Abrir detalhes da impressora/ })
                  .count(),
              ).toBe(1)
              await page.keyboard.press('Escape')
              expect(
                await trigger.evaluate(
                  (node) => document.activeElement === node,
                ),
              ).toBe(true)
              await trigger.evaluate((node) => (node as HTMLElement).blur())
            }
            if (screen === 'impressoras')
              await page.getByLabel('Farm', { exact: true }).selectOption(farm)
            if (screen === 'impressoras')
              await page.getByText(longKey, { exact: true }).first().waitFor()
            expect(
              await page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth,
              ),
            ).toBe(true)
            expect(
              (
                await new AxeBuilder({ page })
                  .include('#conteudo')
                  .withTags([
                    'wcag2a',
                    'wcag2aa',
                    'wcag21a',
                    'wcag21aa',
                    'wcag22aa',
                  ])
                  .analyze()
              ).violations,
            ).toEqual([])
            await page.screenshot({
              path: `docs/fullfarmmanager/design/floor-${screen}-${process.env.DESIGN_PHASE ?? 'after'}-${size}-${theme}.png`,
              fullPage: true,
            })
          }
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 180_000)

it('keeps spool assignment read-only when the printer feed is disconnected or stale', async () => {
  const { renderFarmComponent } =
    await import('../../apps/farm/app/components/farm/render-farm-component.ts')
  const now = { wall: 1_700_000_100_000, mono: 100_000 }
  const assignment = {
    assignmentId: 'a',
    agentId: 'c',
    printerKey: 'p',
    status: 'active',
    connectorStatus: 'approved',
  }
  const observation = {
    state: { printerKey: 'p', state: 'idle', observedAt: now.wall },
    received: now,
    sourceClockComparable: true,
    historical: false,
  }
  for (const [connection, historical, disabled] of [
    ['authenticated', false, false],
    ['closed', false, true],
    ['authenticated', true, true],
  ] as const) {
    const html = await renderFarmComponent('FarmPrinterCard.vue', {
      row: {
        assignment,
        connection,
        observation: { ...observation, historical },
        localOrigin: null,
      },
      farmId: 'farm',
      cameraFor: () => null,
      liveNow: () => now,
    })
    const input = html.match(/<input[^>]*id="spool-slot-p-external"[^>]*>/)?.[0]
    expect(input).toBeDefined()
    expect(input?.includes('disabled')).toBe(disabled)
  }
})
