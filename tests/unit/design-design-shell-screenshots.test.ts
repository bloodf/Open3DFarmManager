import { mkdir, readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import AxeBuilder from '@axe-core/playwright'
import { launchBrowser } from '../helpers/browser.ts'

it('captures shell screens when requested', async () => {
  if (process.env.DESIGN_SCREENSHOTS !== '1') {
    const layout = await readFile('apps/farm/app/layouts/default.vue', 'utf8')
    expect(layout).toContain('aria-keyshortcuts="Control+K Meta+K /"')
    expect(layout).toContain('href="#conteudo-shell"')
    return
  }
  const base = process.env.DESIGN_BASE_URL
  expect(base).toBeTruthy()
  const phase = process.env.DESIGN_PHASE === 'after' ? 'after' : 'before'
  await mkdir('docs/fullfarmmanager/design', { recursive: true })
  const browser = await launchBrowser()
  try {
    for (const [screen, path] of [
      ['farm', '/farm'],
      ['painel', '/painel'],
    ]) {
      for (const [size, viewport] of [
        ['desktop', { width: 1440, height: 900 }],
        ['mobile', { width: 390, height: 844 }],
      ] as const) {
        for (const theme of ['light', 'dark']) {
          const context = await browser.newContext({
            viewport,
            locale: 'pt-BR',
            reducedMotion: 'reduce',
            deviceScaleFactor: 1,
          })
          await context.addInitScript(
            (choice) => localStorage.setItem('farm-theme', choice),
            theme,
          )
          const page = await context.newPage()
          await page.route('**/api/**', async (route) => {
            const url = new URL(route.request().url())
            const now = 1795089600000
            let body: unknown
            if (url.pathname === '/api/auth/me')
              body = { accountId: 'conta-teste' }
            else if (url.pathname === '/api/farms')
              body = { farms: [{ farmId: 'farm-teste' }] }
            else if (url.pathname === '/api/browser-devices')
              body = { currentRole: 'owner' }
            else if (url.pathname.endsWith('/status-summary'))
              body = {
                generatedAt: now,
                total: 2,
                counts: { printing: 1, idle: 1 },
                truncated: false,
                printers: [
                  {
                    assignmentId: 'a',
                    printerKey: 'printer-a',
                    displayName: 'Impressora Alfa',
                    state: 'printing',
                    observedAt: now,
                    temperatures: {},
                  },
                  {
                    assignmentId: 'b',
                    printerKey: 'printer-b',
                    displayName: 'Impressora Beta',
                    state: 'idle',
                    observedAt: now,
                    temperatures: {},
                  },
                ],
              }
            else if (url.pathname.endsWith('/spool-library/spools'))
              body = {
                items: [
                  {
                    id: 42,
                    archived: false,
                    filament: {
                      id: 3,
                      name: 'PLA Azul',
                      material: 'PLA',
                      color_hex: '0055FF',
                      density: 1.24,
                      diameter: 1.75,
                      extra: {},
                    },
                    registered: '2026-01-01',
                    used_weight: 0,
                    used_length: 0,
                    extra: {},
                  },
                ],
                total: 1,
                access: 'read',
                canWrite: false,
                canImport: false,
              }
            else if (url.pathname === '/api/job-history')
              body = {
                jobs: [
                  {
                    id: 'j1',
                    printerKey: 'printer-a',
                    filename: 'suporte.gcode',
                    outcome: 'completed',
                    endedAt: now,
                  },
                ],
                nextBefore: null,
              }
            if (body) await route.fulfill({ json: body })
            else
              await route.fulfill({
                status: 503,
                json: { message: 'Indisponível no teste' },
              })
          })
          await page.addInitScript(() => {
            Date.now = () => 1795089600000
          })
          await page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' })
          if (phase === 'after')
            await page.getByText(/Último trabalho:/).waitFor()
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth),
          ).toBe(viewport.width)
          if (phase === 'after')
            expect(
              (await new AxeBuilder({ page }).analyze()).violations,
            ).toEqual([])
          await page.screenshot({
            path: `docs/fullfarmmanager/design/shell-${screen}-${phase}-${size}-${theme}.png`,
          })
          if (phase === 'before') {
            await context.close()
            continue
          }
          await page.keyboard.press('Control+k')
          const search = page.getByRole('dialog', {
            name: 'Buscar',
            exact: true,
          })
          await search.waitFor({ state: 'visible' })
          const searchInput = page.getByLabel(
            'Buscar páginas, impressoras e bobinas',
          )
          await searchInput.fill('Alfa')
          await page.getByRole('link', { name: 'Impressora Alfa' }).waitFor()
          await searchInput.fill('0055FF')
          await page.getByRole('link', { name: 'PLA Azul · #42' }).waitFor()
          await searchInput.fill('Início')
          await searchInput.press('ArrowDown')
          expect(
            await searchInput.evaluate((el) => el === document.activeElement),
          ).toBe(true)
          expect((await new AxeBuilder({ page }).analyze()).violations).toEqual(
            [],
          )
          await searchInput.fill('')
          await page.keyboard.press('Escape')
          await search.waitFor({ state: 'hidden' })
          if (size === 'mobile') {
            await page
              .getByRole('button', { name: 'Menu', exact: true })
              .click()
            const menu = page.getByRole('dialog', { name: 'Menu', exact: true })
            await menu.waitFor({ state: 'visible' })
            for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
            expect(
              await menu.evaluate((el) => el.contains(document.activeElement)),
            ).toBe(true)
            await page.keyboard.press('Escape')
            await menu.waitFor({ state: 'hidden' })
            expect(
              await page
                .getByRole('button', { name: 'Menu', exact: true })
                .evaluate((el) => el === document.activeElement),
            ).toBe(true)
          }
          await page.keyboard.press('Control+k')
          await search.waitFor({ state: 'visible' })
          await searchInput.fill('Alfa')
          await page.getByRole('link', { name: 'Impressora Alfa' }).waitFor()
          await searchInput.press('ArrowDown')
          await searchInput.press('Enter')
          await page.waitForURL('**/impressoras/printer-a?farm=farm-teste')
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
  }
}, 120_000)
